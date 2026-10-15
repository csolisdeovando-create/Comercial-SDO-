const crypto = require('node:crypto');

// Cliente mínimo de WhatsApp Cloud API (Meta)
function crearWhatsapp(config) {
  const wa = config.whatsapp;
  const configurado = Boolean(wa.token && wa.phoneNumberId);

  async function llamar(cuerpo) {
    if (!configurado) {
      console.log('[whatsapp:prueba]', JSON.stringify(cuerpo));
      return { prueba: true };
    }
    const res = await fetch(`https://graph.facebook.com/${wa.graphVersion}/${wa.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...cuerpo }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`WhatsApp API ${res.status}: ${json?.error?.message || 'error'}`);
      err.respuesta = json;
      throw err;
    }
    return json;
  }

  return {
    configurado,
    enviarTexto: (to, texto) => llamar({ to, type: 'text', text: { body: texto, preview_url: true } }),
    // Plantilla aprobada por Meta, necesaria si pasaron más de 24 h desde el último mensaje del cliente
    enviarPlantilla: (to, nombre, parametros = []) =>
      llamar({
        to,
        type: 'template',
        template: {
          name: nombre,
          language: { code: wa.plantillaIdioma },
          components: parametros.length
            ? [{ type: 'body', parameters: parametros.map((p) => ({ type: 'text', text: String(p) })) }]
            : [],
        },
      }),
    marcarLeido: (messageId) =>
      configurado ? llamar({ status: 'read', message_id: messageId }).catch(() => {}) : Promise.resolve(),
  };
}

// Valida la firma X-Hub-Signature-256 que envía Meta
function firmaValida(appSecret, cuerpoCrudo, firma) {
  if (!appSecret) return true; // sin secreto configurado no se valida (solo desarrollo)
  if (!firma || !cuerpoCrudo) return false;
  const esperada = 'sha256=' + crypto.createHmac('sha256', appSecret).update(cuerpoCrudo).digest('hex');
  const a = Buffer.from(esperada);
  const b = Buffer.from(String(firma));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Identifica el portal de origen a partir del mensaje prellenado del botón "Contactar por WhatsApp"
function detectarPortal(texto = '') {
  const t = texto.toLowerCase();
  const portales = [
    [/portal\s?inmobiliario|portalinmobiliario/, 'Portal Inmobiliario'],
    [/mercado\s?libre|mercadolibre|meli\b|mlc-?\d/, 'Mercado Libre'],
    [/yapo/, 'Yapo'],
    [/toctoc/, 'TocToc'],
    [/marketplace|facebook/, 'Facebook Marketplace'],
    [/instagram/, 'Instagram'],
  ];
  for (const [re, nombre] of portales) if (re.test(t)) return nombre;
  return null;
}

function extraerUrl(texto = '') {
  const m = String(texto).match(/https?:\/\/\S+/i);
  return m ? m[0].replace(/[).,;]+$/, '') : null;
}

module.exports = { crearWhatsapp, firmaValida, detectarPortal, extraerUrl };
