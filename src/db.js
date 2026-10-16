const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  telefono TEXT,
  nombre TEXT,
  email TEXT,
  rut TEXT,
  tipo TEXT,
  razon_social TEXT,
  rut_empresa TEXT,
  propiedad TEXT,
  portal TEXT,
  mensaje_inicial TEXT,
  comentarios TEXT,
  estado TEXT NOT NULL DEFAULT 'contactado',
  motivo_rechazo TEXT,
  ultimo_autoreply_at TEXT,
  documentos_at TEXT,
  aprobado_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_telefono ON leads(telefono);

CREATE TABLE IF NOT EXISTS documentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  requisito TEXT NOT NULL,
  nombre_original TEXT NOT NULL,
  ruta TEXT NOT NULL,
  mime TEXT,
  tamano INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visitas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  fecha TEXT NOT NULL,
  hora INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'confirmada',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visitas_bloque ON visitas(fecha, hora, estado);

CREATE TABLE IF NOT EXISTS mensajes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  wa_id TEXT UNIQUE,
  direccion TEXT NOT NULL,
  contenido TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function abrirDB(archivo) {
  if (archivo !== ':memory:') fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const db = new DatabaseSync(archivo);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(ESQUEMA);
  migrar(db);
  return crearRepositorio(db);
}

// Agrega columnas nuevas a bases ya existentes (sin perder datos)
function migrar(db) {
  const columnas = (tabla) => db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
  const visitas = columnas('visitas');
  if (!visitas.includes('resultado')) db.exec('ALTER TABLE visitas ADD COLUMN resultado TEXT');
  if (!visitas.includes('notas')) db.exec('ALTER TABLE visitas ADD COLUMN notas TEXT');
  if (!visitas.includes('resultado_at')) db.exec('ALTER TABLE visitas ADD COLUMN resultado_at TEXT');
  if (!visitas.includes('confirmada_at')) db.exec('ALTER TABLE visitas ADD COLUMN confirmada_at TEXT');
  if (!visitas.includes('recordatorio_at')) db.exec('ALTER TABLE visitas ADD COLUMN recordatorio_at TEXT');
  const leads = columnas('leads');
  if (!leads.includes('url_publicacion')) db.exec('ALTER TABLE leads ADD COLUMN url_publicacion TEXT');
  // Persona que complementa renta
  for (const col of ['complementa INTEGER DEFAULT 0', 'comp_tipo TEXT', 'comp_nombre TEXT', 'comp_rut TEXT', 'comp_email TEXT', 'comp_telefono TEXT', 'comp_relacion TEXT']) {
    if (!leads.includes(col.split(' ')[0])) db.exec(`ALTER TABLE leads ADD COLUMN ${col}`);
  }
}

function crearRepositorio(db) {
  const nuevoToken = () => crypto.randomBytes(18).toString('base64url');

  const repo = {
    db,

    transaccion(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    crearLead(datos = {}) {
      const campos = { token: nuevoToken(), ...datos };
      const cols = Object.keys(campos);
      const r = db
        .prepare(`INSERT INTO leads (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map((c) => campos[c] ?? null));
      return repo.leadPorId(Number(r.lastInsertRowid));
    },

    actualizarLead(id, cambios) {
      const cols = Object.keys(cambios);
      if (!cols.length) return repo.leadPorId(id);
      db.prepare(
        `UPDATE leads SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
      ).run(...cols.map((c) => cambios[c] ?? null), id);
      return repo.leadPorId(id);
    },

    leadPorId: (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id),
    leadPorToken: (token) => db.prepare('SELECT * FROM leads WHERE token = ?').get(String(token)),
    leadPorRut: (rut) => (rut ? db.prepare('SELECT * FROM leads WHERE rut = ? ORDER BY id DESC LIMIT 1').get(rut) : undefined),
    leadPorTelefono: (tel) =>
      db.prepare('SELECT * FROM leads WHERE telefono = ? ORDER BY id DESC LIMIT 1').get(tel),

    listarLeads: (limite = 200) =>
      db
        .prepare(
          `SELECT l.*, (SELECT COUNT(*) FROM documentos d WHERE d.lead_id = l.id) AS n_documentos,
             (SELECT fecha || ' ' || hora FROM visitas v WHERE v.lead_id = l.id AND v.estado = 'confirmada'
              ORDER BY v.id DESC LIMIT 1) AS visita,
             (SELECT resultado FROM visitas v WHERE v.lead_id = l.id AND v.estado = 'confirmada'
              ORDER BY v.id DESC LIMIT 1) AS resultado_visita,
             (SELECT GROUP_CONCAT(o.id) FROM leads o WHERE o.id <> l.id AND (o.telefono = l.telefono OR (l.rut IS NOT NULL AND o.rut = l.rut))) AS duplicados
           FROM leads l ORDER BY l.updated_at DESC, l.id DESC LIMIT ?`
        )
        .all(limite),

    agregarDocumento(doc) {
      const r = db
        .prepare(
          'INSERT INTO documentos (lead_id, requisito, nombre_original, ruta, mime, tamano) VALUES (?,?,?,?,?,?)'
        )
        .run(doc.lead_id, doc.requisito, doc.nombre_original, doc.ruta, doc.mime, doc.tamano);
      return Number(r.lastInsertRowid);
    },
    documentosDeLead: (leadId) =>
      db.prepare('SELECT * FROM documentos WHERE lead_id = ? ORDER BY id').all(leadId),
    documentoPorId: (id) => db.prepare('SELECT * FROM documentos WHERE id = ?').get(id),

    ocupacionBloques(desde, hasta) {
      const filas = db
        .prepare(
          `SELECT fecha, hora, COUNT(*) AS n FROM visitas
           WHERE estado = 'confirmada' AND fecha BETWEEN ? AND ? GROUP BY fecha, hora`
        )
        .all(desde, hasta);
      const mapa = new Map();
      for (const f of filas) mapa.set(`${f.fecha} ${f.hora}`, f.n);
      return mapa;
    },
    visitaVigente: (leadId) =>
      db
        .prepare(`SELECT * FROM visitas WHERE lead_id = ? AND estado = 'confirmada' ORDER BY id DESC LIMIT 1`)
        .get(leadId),
    contarBloque: (fecha, hora) =>
      db
        .prepare(`SELECT COUNT(*) AS n FROM visitas WHERE estado = 'confirmada' AND fecha = ? AND hora = ?`)
        .get(fecha, hora).n,
    cancelarVisitasDeLead: (leadId) =>
      db.prepare(`UPDATE visitas SET estado = 'reagendada' WHERE lead_id = ? AND estado = 'confirmada'`).run(leadId),
    crearVisita(leadId, fecha, hora) {
      const r = db.prepare('INSERT INTO visitas (lead_id, fecha, hora) VALUES (?,?,?)').run(leadId, fecha, hora);
      return db.prepare('SELECT * FROM visitas WHERE id = ?').get(Number(r.lastInsertRowid));
    },
    listarVisitas: (desde) =>
      db
        .prepare(
          `SELECT v.*, l.nombre, l.telefono, l.email, l.propiedad, l.tipo FROM visitas v
           JOIN leads l ON l.id = v.lead_id WHERE v.estado = 'confirmada' AND v.fecha >= ?
           ORDER BY v.fecha, v.hora`
        )
        .all(desde),

    visitasEntre: (desde, hasta) =>
      db
        .prepare(
          `SELECT v.*, l.nombre, l.telefono, l.email, l.propiedad, l.tipo FROM visitas v
           JOIN leads l ON l.id = v.lead_id WHERE v.estado = 'confirmada' AND v.fecha BETWEEN ? AND ?
           ORDER BY v.fecha, v.hora`
        )
        .all(desde, hasta),

    ultimaVisita: (leadId) =>
      db.prepare(`SELECT * FROM visitas WHERE lead_id = ? AND estado IN ('confirmada', 'cancelada') ORDER BY id DESC LIMIT 1`).get(leadId),
    registrarResultadoVisita: (visitaId, resultado, notas) =>
      db
        .prepare(`UPDATE visitas SET resultado = ?, notas = ?, resultado_at = datetime('now') WHERE id = ?`)
        .run(resultado, notas || null, visitaId),
    visitasParaRecordar: (fecha) =>
      db
        .prepare(
          `SELECT * FROM visitas WHERE estado = 'confirmada' AND fecha = ? AND recordatorio_at IS NULL AND resultado IS NULL`
        )
        .all(fecha),
    confirmarAsistencia: (visitaId) =>
      db.prepare(`UPDATE visitas SET confirmada_at = datetime('now') WHERE id = ? AND confirmada_at IS NULL`).run(visitaId),
    marcarRecordatorio: (visitaId) =>
      db.prepare(`UPDATE visitas SET recordatorio_at = datetime('now') WHERE id = ?`).run(visitaId),
    cancelarVisita: (visitaId) => db.prepare(`UPDATE visitas SET estado = 'cancelada' WHERE id = ?`).run(visitaId),

    // Elimina al interesado con todo su historial; devuelve las rutas de sus archivos para borrarlos del disco
    eliminarLead(leadId) {
      return repo.transaccion(() => {
        const rutas = db.prepare('SELECT ruta FROM documentos WHERE lead_id = ?').all(leadId).map((d) => d.ruta);
        db.prepare('DELETE FROM documentos WHERE lead_id = ?').run(leadId);
        db.prepare('DELETE FROM visitas WHERE lead_id = ?').run(leadId);
        db.prepare('DELETE FROM mensajes WHERE lead_id = ?').run(leadId);
        db.prepare('DELETE FROM leads WHERE id = ?').run(leadId);
        return rutas;
      });
    },

    // Devuelve false si el mensaje de WhatsApp ya fue procesado (Meta reintenta webhooks)
    registrarMensaje({ lead_id, wa_id, direccion, contenido }) {
      try {
        db.prepare('INSERT INTO mensajes (lead_id, wa_id, direccion, contenido) VALUES (?,?,?,?)').run(
          lead_id ?? null,
          wa_id ?? null,
          direccion,
          contenido ?? null
        );
        return true;
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return false;
        throw e;
      }
    },
  };
  return repo;
}

module.exports = { abrirDB };
