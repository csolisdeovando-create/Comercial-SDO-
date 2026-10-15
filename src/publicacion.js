// Interpreta el link de una publicación (Mercado Libre, Portal Inmobiliario, Yapo, TocToc…)
// para identificar la propiedad de interés sin que el interesado tenga que escribir la dirección.

const PORTALES = [
  [/(^|\.)portalinmobiliario\.com$/, 'Portal Inmobiliario'],
  [/(^|\.)mercadolibre\.cl$/, 'Mercado Libre'],
  [/(^|\.)mercadolibre\.com$/, 'Mercado Libre'],
  [/(^|\.)yapo\.cl$/, 'Yapo'],
  [/(^|\.)toctoc\.com$/, 'TocToc'],
  [/(^|\.)facebook\.com$/, 'Facebook Marketplace'],
  [/(^|\.)fb\.me$/, 'Facebook Marketplace'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)sdorent\.cl$/, 'SDO Rent'],
];

// Palabras que no aportan a la descripción de la propiedad
const RUIDO = new Set(['jm', 'p', 'up', 'html', 'www', 'item', 'items', 'publicacion', 'aviso', 'inmuebles', 'bienes', 'raices']);

const ABREVIATURAS = { depto: 'depto', dpto: 'depto', d: 'D', b: 'B', e: 'E', m2: 'm²', mts: 'm²', '2d': '2D', '1d': '1D', '3d': '3D', '4d': '4D', '1b': '1B', '2b': '2B', '3b': '3B' };

function normalizarUrl(texto) {
  let t = String(texto || '').trim();
  // Acepta también links pegados sin "https://" (ej: www.yapo.cl/...)
  if (!/https?:\/\//i.test(t) && /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*/i.test(t)) t = `https://${t}`;
  const m = t.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  try {
    const u = new URL(m[0].replace(/[).,;]+$/, ''));
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

function portalDeHost(host) {
  const h = host.toLowerCase();
  for (const [re, nombre] of PORTALES) if (re.test(h)) return nombre;
  return null;
}

// Convierte "se-arrienda-depto-providencia-2d-2b" en "Se arrienda depto providencia 2D 2B"
function slugATexto(slug) {
  const palabras = decodeURIComponent(slug)
    .toLowerCase()
    .split(/[-_+/\s]+/)
    .filter((w) => w && !RUIDO.has(w) && !/^\d{5,}$/.test(w) && !/^mlc\d*$/.test(w))
    .map((w) => ABREVIATURAS[w] || w);
  if (!palabras.length || palabras.every((w) => /^\d+$/.test(w))) return '';
  const texto = palabras.join(' ');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Interpreta solo el link (no hace consultas por internet). */
function interpretarUrl(texto) {
  const u = normalizarUrl(texto);
  if (!u) return null;
  const portal = portalDeHost(u.hostname);
  const ruta = u.pathname;
  let codigo = null;
  let descripcion = '';

  // Mercado Libre / Portal Inmobiliario: /MLC-1234567890-texto-del-aviso-_JM
  const ml = ruta.match(/MLC-?(\d{6,})(?:-([^/]*))?/i);
  if (ml) {
    codigo = `MLC-${ml[1]}`;
    descripcion = slugATexto((ml[2] || '').replace(/-?_JM.*$/i, ''));
  } else {
    // Otros portales: tomar los segmentos de la ruta con texto y algún número largo como código
    const segmentos = ruta.split('/').filter(Boolean);
    const num = segmentos.map((s) => s.match(/(\d{6,})/)).find(Boolean);
    if (num) codigo = num[1];
    const conTexto = segmentos.filter((s) => /[a-z]{3,}/i.test(s) && !/^(arriendo|venta|inmuebles)$/i.test(s));
    descripcion = slugATexto(conTexto.slice(-2).join('-'));
  }

  return {
    url: u.toString(),
    portal,
    codigo,
    descripcion,
    titulo: null,
    direccion: null,
  };
}

const decodificar = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re) || html.match(re2);
  return m ? decodificar(m[1]) : null;
}

function direccionJsonLd(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const datos = [].concat(JSON.parse(m[1]));
      for (const d of datos) {
        const a = d?.address || d?.offers?.itemOffered?.address || d?.itemOffered?.address;
        if (a && typeof a === 'object') {
          return [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(', ') || null;
        }
        if (typeof a === 'string') return a;
      }
    } catch {}
  }
  return null;
}

const cache = new Map();

/**
 * Interpreta el link y, si el portal lo permite, lee el título y la dirección del aviso.
 * Solo consulta portales conocidos (nunca otras direcciones) y con tiempo límite.
 */
async function leerPublicacion(texto, { timeoutMs = 5000, fetchFn = fetch } = {}) {
  const base = interpretarUrl(texto);
  if (!base) return null;
  if (!base.portal || base.portal === 'SDO Rent') return base;
  if (cache.has(base.url)) return cache.get(base.url);

  const resultado = { ...base };
  try {
    const res = await fetchFn(base.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SDORentComercial/1.0)', 'Accept-Language': 'es-CL,es' },
    });
    const final = new URL(res.url || base.url);
    if (res.ok && portalDeHost(final.hostname) && /text\/html/.test(res.headers.get('content-type') || '')) {
      const html = (await res.text()).slice(0, 1_500_000);
      const titulo = meta(html, 'og:title') || decodificar(html.match(/<title>([^<]*)<\/title>/i)?.[1]);
      if (titulo && !/just a moment|verificaci|access denied|robot/i.test(titulo)) {
        resultado.titulo = titulo.replace(/\s*[|–-]\s*(Mercado Libre|Portal Inmobiliario|Yapo|TocToc).*$/i, '').slice(0, 200);
        resultado.direccion = direccionJsonLd(html) || meta(html, 'og:street-address');
      }
    }
  } catch {
    // Portal bloqueó la consulta o no respondió: se usa lo que trae el link
  }
  cache.set(base.url, resultado);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return resultado;
}

// Texto corto para mostrar como "propiedad de interés"
function resumenPropiedad(p) {
  if (!p) return '';
  const partes = [p.direccion || p.titulo || p.descripcion, p.codigo && `(${p.codigo})`].filter(Boolean);
  return partes.join(' ').slice(0, 300);
}

module.exports = { interpretarUrl, leerPublicacion, resumenPropiedad, portalDeHost };
