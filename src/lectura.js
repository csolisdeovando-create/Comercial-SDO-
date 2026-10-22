// Lectura automática de documentos con Claude: liquidaciones de sueldo y certificado de cotizaciones AFP.
// Devuelve datos estructurados (montos, periodos, RUT, folio) para la revisión del equipo; nunca decide sola.
const fs = require('node:fs');
const Anthropic = require('@anthropic-ai/sdk');

const MODELO = 'claude-opus-5-5';
const AFPS = ['Uno', 'Capital', 'Cuprum', 'Habitat', 'Modelo', 'PlanVital', 'Provida'];
const TIPOS_IMAGEN = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const texto = { type: 'string' };
const textoONulo = { type: ['string', 'null'] };

const ESQUEMA_LIQUIDACIONES = {
  type: 'object',
  properties: {
    liquidaciones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          periodo: { ...textoONulo, description: 'Mes de la remuneración, formato YYYY-MM' },
          nombre_trabajador: textoONulo,
          rut_trabajador: { ...textoONulo, description: 'RUT tal como aparece, ej: 12.345.678-9' },
          empleador: textoONulo,
          liquido_a_pagar: {
            type: ['integer', 'null'],
            description: 'Monto líquido a pagar/recibir en pesos chilenos, solo dígitos (ej: 812345)',
          },
          legible: { type: 'boolean' },
        },
        required: ['periodo', 'nombre_trabajador', 'rut_trabajador', 'empleador', 'liquido_a_pagar', 'legible'],
        additionalProperties: false,
      },
    },
    observaciones: texto,
  },
  required: ['liquidaciones', 'observaciones'],
  additionalProperties: false,
};

const ESQUEMA_AFP = {
  type: 'object',
  properties: {
    es_certificado_afp: { type: 'boolean' },
    afp: { type: 'string', enum: [...AFPS, 'Otra', 'No identificada'] },
    rut_afiliado: textoONulo,
    nombre_afiliado: textoONulo,
    folio: { ...textoONulo, description: 'Folio o código de verificación del certificado, exactamente como está impreso' },
    fecha_emision: { ...textoONulo, description: 'Formato YYYY-MM-DD' },
    ultimo_periodo_cotizado: { ...textoONulo, description: 'Formato YYYY-MM' },
    empleador_actual: textoONulo,
    observaciones: texto,
  },
  required: ['es_certificado_afp', 'afp', 'rut_afiliado', 'nombre_afiliado', 'folio', 'fecha_emision', 'ultimo_periodo_cotizado', 'empleador_actual', 'observaciones'],
  additionalProperties: false,
};

const INSTRUCCIONES = {
  liquidaciones: `Estos archivos son liquidaciones de sueldo chilenas que subió un postulante a arriendo.
Extrae una entrada por cada liquidación (un PDF puede traer varias). Para cada una indica el periodo (mes de la remuneración), el nombre y RUT del trabajador, el empleador y el monto "líquido a pagar" (también llamado "líquido a recibir", "alcance líquido" o "total líquido"): el monto final que recibe el trabajador, no el total de haberes ni la renta imponible.
Si un dato no se ve o no se puede leer con seguridad, déjalo en null y marca legible=false; no adivines. En observaciones anota en una frase cualquier cosa rara (documentos que no son liquidaciones, montos tachados o editados, meses repetidos).`,
  afp: `Este archivo es (o debería ser) un certificado de cotizaciones previsionales de una AFP chilena que subió un postulante a arriendo.
Indica qué AFP lo emite, el RUT y nombre del afiliado, el folio o código de verificación exactamente como está impreso (respeta letras, números y guiones), la fecha de emisión, el último periodo cotizado y el empleador más reciente.
Si un dato no aparece o no se lee con seguridad, déjalo en null; no adivines. En observaciones anota en una frase cualquier cosa rara (no es un certificado de AFP, está incompleto, parece editado).`,
};

// Bloques de contenido para la API (PDF como documento, fotos como imagen)
function bloquesDeArchivos(docs) {
  const bloques = [];
  const omitidos = [];
  for (const d of docs) {
    if (!fs.existsSync(d.ruta)) {
      omitidos.push(d.nombre_original);
      continue;
    }
    const data = fs.readFileSync(d.ruta).toString('base64');
    if (d.mime === 'application/pdf') {
      bloques.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: d.nombre_original });
    } else if (TIPOS_IMAGEN.includes(d.mime)) {
      bloques.push({ type: 'image', source: { type: 'base64', media_type: d.mime, data } });
    } else {
      omitidos.push(d.nombre_original); // HEIC u otros formatos que la API no lee
    }
  }
  return { bloques, omitidos };
}

function crearLector({ apiKey, cliente } = {}) {
  const claude = cliente || (apiKey ? new Anthropic.Anthropic({ apiKey }) : null);

  async function leer(tipo, docs) {
    const { bloques, omitidos } = bloquesDeArchivos(docs);
    if (!bloques.length) return { ok: false, error: omitidos.length ? `Formato no legible: ${omitidos.join(', ')}` : 'Sin archivos' };
    const pedido = {
      model: MODELO,
      max_tokens: 8000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: tipo === 'afp' ? ESQUEMA_AFP : ESQUEMA_LIQUIDACIONES } },
      messages: [{ role: 'user', content: [...bloques, { type: 'text', text: INSTRUCCIONES[tipo] }] }],
    };
    let respuesta;
    try {
      // Si el modelo declina por seguridad, la API reintenta sola con otro modelo
      respuesta = await claude.beta.messages.create({ ...pedido, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError)) throw e;
      respuesta = await claude.beta.messages.create(pedido); // por si la cuenta no tiene habilitado el reintento
    }
    if (respuesta.stop_reason === 'refusal') return { ok: false, error: 'La lectura automática no pudo procesar el documento' };
    const bloque = respuesta.content.find((b) => b.type === 'text');
    if (!bloque) return { ok: false, error: 'Respuesta vacía' };
    return { ok: true, datos: JSON.parse(bloque.text), omitidos };
  }

  return {
    activo: Boolean(claude),
    leerLiquidaciones: (docs) => leer('liquidaciones', docs),
    leerCertificadoAfp: (docs) => leer('afp', docs),
  };
}

module.exports = { crearLector, AFPS, MODELO };
