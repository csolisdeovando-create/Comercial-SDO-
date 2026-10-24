const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { pareceLink, propiedadDesdeLink } = require('./publicacion');

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

CREATE TABLE IF NOT EXISTS bloqueos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  hora INTEGER,            -- NULL = día completo
  motivo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bloqueos_fecha ON bloqueos(fecha);

-- Horas que el equipo abre en días que normalmente no se trabaja (sábados)
CREATE TABLE IF NOT EXISTS horas_habilitadas (
  fecha TEXT NOT NULL,
  hora INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (fecha, hora)
);

-- Lectura automática de liquidaciones y certificado de AFP (una fila por interesado)
CREATE TABLE IF NOT EXISTS revisiones (
  lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
  estado TEXT NOT NULL,      -- leyendo | listo | error | sin_config
  datos TEXT,                -- JSON con lo leído de cada documento
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  // 'equipo' = ingresada a mano desde el panel (agendada por teléfono u otro medio)
  if (!visitas.includes('origen')) db.exec('ALTER TABLE visitas ADD COLUMN origen TEXT');
  // Post-visita: cuándo se le pidió el resultado al equipo, y quién canceló (equipo o interesado)
  if (!visitas.includes('resultado_pedido_at')) db.exec('ALTER TABLE visitas ADD COLUMN resultado_pedido_at TEXT');
  if (!visitas.includes('cancelada_por')) db.exec('ALTER TABLE visitas ADD COLUMN cancelada_por TEXT');
  if (!visitas.includes('motivo_cancelacion')) db.exec('ALTER TABLE visitas ADD COLUMN motivo_cancelacion TEXT');
  // Bárbara marca cuándo registró la visita en Breal (contacto, interesado, negocio potencial y visita)
  if (!visitas.includes('breal_at')) db.exec('ALTER TABLE visitas ADD COLUMN breal_at TEXT');
  // Motivo cuando no continúa (mismos valores de "Resultado de la Visita" en Breal)
  if (!visitas.includes('motivo_resultado')) db.exec('ALTER TABLE visitas ADD COLUMN motivo_resultado TEXT');
  const leads = columnas('leads');
  if (!leads.includes('url_publicacion')) db.exec('ALTER TABLE leads ADD COLUMN url_publicacion TEXT');
  if (!leads.includes('plazo_cambio')) db.exec('ALTER TABLE leads ADD COLUMN plazo_cambio TEXT');
  // Valor mensual del arriendo (lo ingresa el equipo): base del requisito de renta de 2,5 veces
  if (!leads.includes('valor_arriendo')) db.exec('ALTER TABLE leads ADD COLUMN valor_arriendo INTEGER');
  // Recordatorios del equipo para que agende (aprobados que aún no eligen horario)
  if (!leads.includes('aviso_agenda_at')) db.exec('ALTER TABLE leads ADD COLUMN aviso_agenda_at TEXT');
  if (!leads.includes('avisos_agenda')) db.exec('ALTER TABLE leads ADD COLUMN avisos_agenda INTEGER DEFAULT 0');
  if (!leads.includes('datos_pedidos_at')) db.exec('ALTER TABLE leads ADD COLUMN datos_pedidos_at TEXT');
  if (!leads.includes('rechazado_at')) db.exec('ALTER TABLE leads ADD COLUMN rechazado_at TEXT');
  // Persona que complementa renta o es aval, y datos personales completos de ambos
  const personales = ['doc_tipo', 'nacionalidad', 'fecha_nacimiento', 'estado_civil', 'profesion', 'direccion_actual', 'comuna'];
  for (const col of [
    'complementa INTEGER DEFAULT 0', 'comp_tipo TEXT', 'comp_nombre TEXT', 'comp_rut TEXT', 'comp_email TEXT', 'comp_telefono TEXT', 'comp_relacion TEXT',
    'comp_rol TEXT',
    ...personales.map((c) => `${c} TEXT`),
    ...personales.map((c) => `comp_${c} TEXT`),
  ]) {
    if (!leads.includes(col.split(' ')[0])) db.exec(`ALTER TABLE leads ADD COLUMN ${col}`);
  }
  // El interesado pegó el link del aviso en la dirección: el link pasa a "Link de publicación"
  // y en la dirección queda un texto legible para el calendario (nada se pierde)
  for (const l of db.prepare(`SELECT id, propiedad, url_publicacion, comentarios FROM leads WHERE propiedad LIKE '%http%' OR propiedad LIKE 'www.%'`).all()) {
    if (!pareceLink(l.propiedad)) continue;
    const link = l.propiedad.trim();
    const cambios = { propiedad: propiedadDesdeLink(link), url_publicacion: l.url_publicacion || link, comentarios: l.comentarios };
    if (l.url_publicacion && l.url_publicacion !== link) cambios.comentarios = [l.comentarios, `Link indicado como dirección: ${link}`].filter(Boolean).join('\n');
    db.prepare('UPDATE leads SET propiedad = ?, url_publicacion = ?, comentarios = ? WHERE id = ?').run(cambios.propiedad, cambios.url_publicacion, cambios.comentarios, l.id);
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
             (SELECT datos FROM revisiones r WHERE r.lead_id = l.id AND r.estado = 'listo') AS revision_datos,
             (SELECT GROUP_CONCAT(o.id) FROM leads o WHERE o.id <> l.id AND (o.telefono = l.telefono OR (l.rut IS NOT NULL AND o.rut = l.rut))) AS duplicados
           FROM leads l ORDER BY l.updated_at DESC, l.id DESC LIMIT ?`
        )
        .all(limite),

    revisionDe: (leadId) => {
      const r = db.prepare('SELECT * FROM revisiones WHERE lead_id = ?').get(leadId);
      return r ? { ...r, datos: r.datos ? JSON.parse(r.datos) : null } : null;
    },
    guardarRevision: (leadId, { estado, datos = null, error = null }) =>
      db
        .prepare(
          `INSERT INTO revisiones (lead_id, estado, datos, error, updated_at) VALUES (?,?,?,?,datetime('now'))
           ON CONFLICT(lead_id) DO UPDATE SET estado = excluded.estado, datos = COALESCE(excluded.datos, revisiones.datos),
             error = excluded.error, updated_at = excluded.updated_at`
        )
        .run(leadId, estado, datos ? JSON.stringify(datos) : null, error),

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

    // Visitas confirmadas + horarios bloqueados por el equipo (un bloqueo ocupa el bloque completo)
    // `duracionHoras`: una visita ocupa también los bloques que se le cruzan (si dura más de 1 hora)
    ocupacionBloques(desde, hasta, horasDe = () => [], duracionHoras = 1) {
      const filas = db
        .prepare(
          `SELECT fecha, hora, COUNT(*) AS n FROM visitas
           WHERE estado = 'confirmada' AND fecha BETWEEN ? AND ? GROUP BY fecha, hora`
        )
        .all(desde, hasta);
      const mapa = new Map();
      for (const f of filas) {
        for (let k = 1 - duracionHoras; k < duracionHoras; k++) {
          const clave = `${f.fecha} ${f.hora + k}`;
          mapa.set(clave, (mapa.get(clave) || 0) + f.n);
        }
      }
      for (const b of repo.bloqueosEntre(desde, hasta)) {
        const horas = b.hora === null ? horasDe(b.fecha) : [b.hora];
        for (const h of horas) mapa.set(`${b.fecha} ${h}`, 9999);
      }
      return mapa;
    },
    horasHabilitadas: (fecha) => db.prepare('SELECT hora FROM horas_habilitadas WHERE fecha = ? ORDER BY hora').all(fecha).map((r) => r.hora),
    habilitarHoras: (fecha, horas) => {
      const st = db.prepare('INSERT OR IGNORE INTO horas_habilitadas (fecha, hora) VALUES (?, ?)');
      for (const h of horas) st.run(fecha, h);
    },
    deshabilitarHoras: (fecha, horas) => {
      const st = db.prepare('DELETE FROM horas_habilitadas WHERE fecha = ? AND hora = ?');
      for (const h of horas) st.run(fecha, h);
    },
    bloqueosEntre: (desde, hasta) =>
      db.prepare('SELECT * FROM bloqueos WHERE fecha BETWEEN ? AND ? ORDER BY fecha, hora').all(desde, hasta),
    bloqueado: (fecha, hora) =>
      Boolean(db.prepare('SELECT 1 FROM bloqueos WHERE fecha = ? AND (hora IS NULL OR hora = ?) LIMIT 1').get(fecha, hora)),
    bloquear: (fecha, hora, motivo) =>
      Number(db.prepare('INSERT INTO bloqueos (fecha, hora, motivo) VALUES (?,?,?)').run(fecha, hora ?? null, motivo || null).lastInsertRowid),
    desbloquear: (id) => db.prepare('DELETE FROM bloqueos WHERE id = ?').run(id),
    visitaVigente: (leadId) =>
      db
        .prepare(`SELECT * FROM visitas WHERE lead_id = ? AND estado = 'confirmada' ORDER BY id DESC LIMIT 1`)
        .get(leadId),
    // Visitas vigentes que se cruzan con una visita en `fecha` `hora` (sin contar las de `excluirLead`)
    cruces: (fecha, hora, duracionHoras = 1, excluirLead = 0) =>
      db
        .prepare(
          `SELECT v.*, l.nombre FROM visitas v JOIN leads l ON l.id = v.lead_id
           WHERE v.estado = 'confirmada' AND v.fecha = ? AND v.hora > ? AND v.hora < ? AND v.lead_id != ? ORDER BY v.hora`
        )
        .all(fecha, hora - duracionHoras, hora + duracionHoras, excluirLead || 0),
    contarBloque: (fecha, hora, duracionHoras = 1, excluirLead = 0) =>
      repo.bloqueado(fecha, hora) ? 9999 : repo.cruces(fecha, hora, duracionHoras, excluirLead).length,
    cancelarVisitasDeLead: (leadId) =>
      db.prepare(`UPDATE visitas SET estado = 'reagendada' WHERE lead_id = ? AND estado = 'confirmada'`).run(leadId),
    crearVisita(leadId, fecha, hora, origen = null) {
      const r = db.prepare('INSERT INTO visitas (lead_id, fecha, hora, origen) VALUES (?,?,?,?)').run(leadId, fecha, hora, origen);
      return db.prepare('SELECT * FROM visitas WHERE id = ?').get(Number(r.lastInsertRowid));
    },
    listarVisitas: (desde) =>
      db
        .prepare(
          `SELECT v.*, l.nombre, l.telefono, l.email, l.propiedad, l.tipo, l.portal FROM visitas v
           JOIN leads l ON l.id = v.lead_id WHERE v.estado = 'confirmada' AND v.fecha >= ?
           ORDER BY v.fecha, v.hora`
        )
        .all(desde),

    visitasEntre: (desde, hasta) =>
      db
        .prepare(
          `SELECT v.*, l.nombre, l.telefono, l.email, l.propiedad, l.tipo, l.portal FROM visitas v
           JOIN leads l ON l.id = v.lead_id WHERE v.estado = 'confirmada' AND v.fecha BETWEEN ? AND ?
           ORDER BY v.fecha, v.hora`
        )
        .all(desde, hasta),

    ultimaVisita: (leadId) =>
      db.prepare(`SELECT * FROM visitas WHERE lead_id = ? AND estado IN ('confirmada', 'cancelada') ORDER BY id DESC LIMIT 1`).get(leadId),
    registrarResultadoVisita: (visitaId, resultado, notas, motivo = null) =>
      db
        .prepare(`UPDATE visitas SET resultado = ?, notas = ?, motivo_resultado = ?, resultado_at = datetime('now') WHERE id = ?`)
        .run(resultado, notas || null, resultado === 'no_continua' ? motivo : null, visitaId),
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
    cancelarVisita: (visitaId, { por = 'equipo', motivo = null } = {}) =>
      db.prepare(`UPDATE visitas SET estado = 'cancelada', cancelada_por = ?, motivo_cancelacion = ? WHERE id = ?`).run(por, motivo, visitaId),
    // Visitas que ya ocurrieron (hasta `fecha` incluida) y aún no tienen resultado
    visitasSinResultado: (hastaFecha, desdeFecha = '0000-00-00') =>
      db
        .prepare(
          `SELECT v.*, l.nombre, l.telefono, l.email, l.propiedad, l.portal FROM visitas v JOIN leads l ON l.id = v.lead_id
           WHERE v.estado = 'confirmada' AND v.resultado IS NULL AND v.fecha BETWEEN ? AND ? ORDER BY v.fecha DESC, v.hora DESC`
        )
        .all(desdeFecha, hastaFecha),
    marcarResultadoPedido: (visitaId) => db.prepare(`UPDATE visitas SET resultado_pedido_at = datetime('now') WHERE id = ?`).run(visitaId),
    visitaPorId: (id) => db.prepare('SELECT * FROM visitas WHERE id = ?').get(id),
    todasLasVisitas: () => db.prepare('SELECT * FROM visitas ORDER BY id').all(),
    todosLosLeads: () => db.prepare('SELECT * FROM leads ORDER BY id').all(),
    marcarBreal: (visitaId, registrada) =>
      db.prepare(`UPDATE visitas SET breal_at = ${registrada ? "datetime('now')" : 'NULL'} WHERE id = ?`).run(visitaId),
    marcarAvisoAgenda: (leadId) =>
      db.prepare(`UPDATE leads SET aviso_agenda_at = datetime('now'), avisos_agenda = COALESCE(avisos_agenda, 0) + 1 WHERE id = ?`).run(leadId),

    // Elimina al interesado con todo su historial; devuelve las rutas de sus archivos para borrarlos del disco
    eliminarLead(leadId) {
      return repo.transaccion(() => {
        const rutas = db.prepare('SELECT ruta FROM documentos WHERE lead_id = ?').all(leadId).map((d) => d.ruta);
        db.prepare('DELETE FROM documentos WHERE lead_id = ?').run(leadId);
        db.prepare('DELETE FROM revisiones WHERE lead_id = ?').run(leadId);
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
