// Validación del certificado de AFP con el validador público de cada AFP.
// Solo se consulta automáticamente donde el validador no tiene captcha; en el resto se deja el link para el equipo.
// Nunca se declara un certificado "falso": si la AFP no lo reconoce, queda para revisión manual.
const crypto = require('node:crypto');
const { limpiarRut } = require('./utils');

const VALIDADORES = {
  Uno: 'https://www.uno.cl/ayuda/validador-certificados',
  Capital: 'https://www.afpcapital.cl/empresas/validar-certificados',
  Cuprum: 'https://www6.cuprum.cl/ayuda/validacion-de-certificados',
  Habitat: 'https://www.afphabitat.cl/herramientas-y-servicios/validar-certificados/',
  Modelo: 'https://nueva.afpmodelo.cl/servicios-en-linea/validar-certificados/',
  PlanVital: 'https://www.planvital.cl/afiliado/asesoria/certificados/validacion-de-certificados',
  Provida: 'https://www.provida.cl/tramites-servicios/certificados-de-afp/validador/',
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function consultarUno({ rut, folio }, fetchFn) {
  const res = await fetchFn('https://www.uno.cl/api/afiliado-certificado/validar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ payload: { idPersona: limpiarRut(rut), FolioCertificado: folio } }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!json) return { estado: 'no_verificado', detalle: `AFP Uno respondió ${res.status}` };
  if (String(json.codigo) === '0' && json.data?.bytes) {
    return { estado: 'valido', detalle: 'AFP Uno reconoce el folio y entregó el certificado original.', pdf: Buffer.from(json.data.bytes, 'base64') };
  }
  return { estado: 'no_reconocido', detalle: json.mensaje || json.message || 'AFP Uno no reconoció el folio con ese RUT.' };
}

async function consultarHabitat({ folio }, fetchFn) {
  const res = await fetchFn('https://www.afphabitat.cl/wp-admin/admin-ajax.php?action=ajax_call&funcion=getValidaCertificado', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ folio }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!json) return { estado: 'no_verificado', detalle: `AFP Habitat respondió ${res.status}` };
  if (String(json.resultado) === '0') {
    return { estado: 'valido', detalle: 'AFP Habitat reconoce el folio.', urlOriginal: /^https?:\/\//.test(json.mensaje || '') ? json.mensaje : null };
  }
  return { estado: 'no_reconocido', detalle: 'AFP Habitat indica que el folio no es válido o expiró (vigencia 30 días).' };
}

const CONSULTAS = { Uno: consultarUno, Habitat: consultarHabitat };

/**
 * @returns {{estado: 'valido'|'no_reconocido'|'no_verificado'|'manual', detalle, validador, mismoArchivo?, urlOriginal?}}
 * `archivo` (Buffer) es el PDF que subió el interesado: si la AFP devuelve el original, se comparan.
 */
async function validarCertificado({ afp, rut, folio, archivo }, { fetchFn = fetch } = {}) {
  const validador = VALIDADORES[afp] || null;
  if (!validador) return { estado: 'manual', detalle: 'No se identificó la AFP del certificado.', validador };
  if (!folio) return { estado: 'manual', detalle: 'No se pudo leer el folio del certificado.', validador };
  if (afp === 'Provida' && /^\d{16,18}$/.test(folio)) {
    return { estado: 'manual', detalle: 'Certificado emitido en sucursal: Provida solo lo valida llamando al 600 201 0150.', validador };
  }
  const consulta = CONSULTAS[afp];
  if (!consulta) return { estado: 'manual', detalle: `AFP ${afp} no permite validar automáticamente (pide captcha). Valídalo en su página.`, validador };
  try {
    const r = await consulta({ rut, folio }, fetchFn);
    const resultado = { estado: r.estado, detalle: r.detalle, validador, urlOriginal: r.urlOriginal || null };
    if (r.pdf && archivo) resultado.mismoArchivo = sha256(r.pdf) === sha256(archivo);
    if (r.pdf) resultado.pdfOriginal = r.pdf;
    return resultado;
  } catch (e) {
    return { estado: 'no_verificado', detalle: `No se pudo consultar a AFP ${afp} (${e.name === 'TimeoutError' ? 'no respondió' : 'error de conexión'}).`, validador };
  }
}

module.exports = { validarCertificado, VALIDADORES };
