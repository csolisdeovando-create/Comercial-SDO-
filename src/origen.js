// Origen de cada interesado: de qué canal llegó (portal, anuncio de Meta, WhatsApp…) para medir resultados por canal.
// Se toma, en este orden: el link por canal (?origen=…), el portal del aviso que pegó, y lo que respondió en el formulario.

const ORIGENES = {
  yapo: 'Yapo',
  mercadolibre: 'Mercado Libre',
  portalinmobiliario: 'Portal Inmobiliario',
  toctoc: 'TocToc',
  meta: 'Anuncio Instagram/Facebook',
  marketplace: 'Facebook Marketplace',
  whatsapp: 'WhatsApp',
  web: 'Sitio web SDO',
  recomendacion: 'Recomendación',
  otro: 'Otro',
};

// Lo que se pregunta en el formulario ("¿Dónde viste el aviso?")
const OPCIONES_DONDE_VIO = [
  ['yapo', 'Yapo'],
  ['mercadolibre', 'Mercado Libre'],
  ['portalinmobiliario', 'Portal Inmobiliario'],
  ['toctoc', 'TocToc'],
  ['meta', 'Anuncio en Instagram o Facebook'],
  ['marketplace', 'Facebook Marketplace'],
  ['web', 'Sitio web de SDO'],
  ['recomendacion', 'Me lo recomendaron'],
  ['otro', 'Otro'],
];

// Nombres cortos que se pueden usar en los links (?origen=ig, ?origen=ml…)
const ALIAS = {
  instagram: 'meta', facebook: 'meta', ig: 'meta', fb: 'meta', metaads: 'meta', ads: 'meta',
  ml: 'mercadolibre', meli: 'mercadolibre', mercado: 'mercadolibre',
  pi: 'portalinmobiliario', portal: 'portalinmobiliario',
  wa: 'whatsapp', wsp: 'whatsapp',
  sitio: 'web', sdo: 'web', referido: 'recomendacion',
};

/**
 * "meta-sanmiguel" → { canal: 'meta', nombre: 'Anuncio Instagram/Facebook', campana: 'sanmiguel' }
 * @returns {{canal, nombre, campana}|null}
 */
function origenDesdeParam(valor) {
  const t = String(valor || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60);
  if (!t) return null;
  const [base, ...resto] = t.split(/[-_]/);
  const canal = ORIGENES[base] ? base : ALIAS[base];
  if (!canal) return null;
  return { canal, nombre: ORIGENES[canal], campana: resto.join('-') || null };
}

// Clave del formulario a partir de un portal ya conocido (para dejar marcada la respuesta)
function claveDePortal(portal) {
  const p = String(portal || '').toLowerCase();
  if (/yapo/.test(p)) return 'yapo';
  if (/mercado/.test(p)) return 'mercadolibre';
  if (/portal inmob/.test(p)) return 'portalinmobiliario';
  if (/toctoc/.test(p)) return 'toctoc';
  if (/anuncio|instagram/.test(p)) return 'meta';
  if (/marketplace/.test(p)) return 'marketplace';
  return null;
}

/**
 * Origen final de una postulación.
 * @param {object} p
 * @param {string|null} p.param valor de ?origen= (link por canal)
 * @param {string|null} p.portalActual portal que ya tenía el interesado (WhatsApp, visita a mano)
 * @param {string|null} p.portalAviso portal del link del aviso que pegó
 * @param {string|null} p.respuesta lo que eligió en "¿Dónde viste el aviso?"
 */
function origenFinal({ param, portalActual, portalAviso, respuesta }) {
  const desdeLink = origenDesdeParam(param);
  const conocido = portalActual && portalActual !== 'Formulario web' ? portalActual : null;
  return {
    portal: desdeLink?.nombre || conocido || portalAviso || ORIGENES[respuesta] || 'Formulario web',
    campana: desdeLink?.campana || null,
  };
}

// Links para pegar en cada canal (saludos de WhatsApp, anuncios, descripciones de avisos)
function linksPorCanal(baseUrl, ruta) {
  return [
    ['WhatsApp (mensaje de bienvenida)', 'whatsapp'],
    ['Anuncios de Instagram / Facebook', 'meta'],
    ['Yapo', 'yapo'],
    ['Mercado Libre', 'mercadolibre'],
    ['Portal Inmobiliario', 'portalinmobiliario'],
    ['Sitio web de SDO', 'web'],
  ].map(([nombre, clave]) => ({ nombre, url: `${baseUrl}${ruta}?origen=${clave}` }));
}

module.exports = { ORIGENES, OPCIONES_DONDE_VIO, origenDesdeParam, origenFinal, claveDePortal, linksPorCanal };
