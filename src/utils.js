const crypto = require('node:crypto');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function limpiarRut(rut) {
  return String(rut || '').replace(/[^0-9kK]/g, '').toUpperCase();
}

// Validación módulo 11 del RUT chileno
function rutValido(rut) {
  const r = limpiarRut(rut);
  if (r.length < 2) return false;
  const cuerpo = r.slice(0, -1);
  const dv = r.slice(-1);
  if (!/^\d+$/.test(cuerpo)) return false;
  let suma = 0;
  let mult = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const res = 11 - (suma % 11);
  const esperado = res === 11 ? '0' : res === 10 ? 'K' : String(res);
  return dv === esperado;
}

function formatearRut(rut) {
  const r = limpiarRut(rut);
  if (r.length < 2) return r;
  const cuerpo = r.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cuerpo}-${r.slice(-1)}`;
}

// Normaliza a formato internacional sin "+": 56912345678
function normalizarTelefono(tel) {
  let t = String(tel || '').replace(/\D/g, '');
  if (t.length === 9 && t.startsWith('9')) t = `56${t}`;
  if (t.length === 8) t = `569${t}`;
  return t;
}

const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());

function firmar(secret, ...partes) {
  return crypto.createHmac('sha256', secret).update(partes.join('|')).digest('base64url').slice(0, 32);
}

function firmaCorrecta(secret, firma, ...partes) {
  const a = Buffer.from(firmar(secret, ...partes));
  const b = Buffer.from(String(firma || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const tamanoLegible = (bytes) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

module.exports = { esc, rutValido, formatearRut, limpiarRut, normalizarTelefono, emailValido, firmar, firmaCorrecta, tamanoLegible };
