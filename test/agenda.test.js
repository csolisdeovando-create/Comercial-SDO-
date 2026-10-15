const test = require('node:test');
const assert = require('node:assert');
const { construirCalendario, bloqueValido, describirBloque, generarICS } = require('../src/agenda');
const { rutValido, formatearRut, normalizarTelefono } = require('../src/utils');
const { detectarPortal, extraerUrl } = require('../src/whatsapp');
const { interpretarUrl, leerPublicacion } = require('../src/publicacion');

const cfg = {
  zonaHoraria: 'America/Santiago',
  horas: [9, 11, 13, 15, 17],
  diasHabiles: 10,
  anticipacionHoras: 2,
  cuposPorBloque: 1,
  feriados: ['2026-10-19'],
};
// Jueves 15-oct-2026 10:00 hora de Chile (UTC-3)
const AHORA = new Date('2026-10-15T13:00:00Z');

test('ofrece solo días hábiles, sin feriados, con las horas configuradas', () => {
  const cal = construirCalendario(cfg, new Map(), AHORA);
  const dias = cal.semanas.flatMap((s) => s.dias.filter((d) => d.habilitado));
  assert.strictEqual(dias.length, 10);
  for (const d of dias) {
    const dow = new Date(`${d.fecha}T00:00:00Z`).getUTCDay();
    assert.ok(dow >= 1 && dow <= 5, `${d.fecha} no es día hábil`);
    assert.deepStrictEqual(d.bloques.map((b) => b.hora), [9, 11, 13, 15, 17]);
  }
  assert.ok(!dias.some((d) => d.fecha === '2026-10-19'), 'no debe incluir feriado');
  assert.strictEqual(cal.semanas[0].lunes, '2026-10-12');
});

test('bloquea horarios pasados y con poca anticipación', () => {
  const cal = construirCalendario(cfg, new Map(), AHORA);
  const hoy = cal.semanas[0].dias.find((d) => d.fecha === '2026-10-15');
  const disp = Object.fromEntries(hoy.bloques.map((b) => [b.hora, b.disponible]));
  // 10:00 + 2 h de anticipación -> 9 y 11 no; 13 en adelante sí
  assert.deepStrictEqual(disp, { 9: false, 11: false, 13: true, 15: true, 17: true });
  assert.strictEqual(cal.semanas[0].dias[0].habilitado, false); // lunes 12 ya pasó
});

test('bloques ocupados no se ofrecen', () => {
  const cal = construirCalendario(cfg, new Map([['2026-10-16 9', 1]]), AHORA);
  const vie = cal.semanas[0].dias.find((d) => d.fecha === '2026-10-16');
  assert.strictEqual(vie.bloques.find((b) => b.hora === 9).disponible, false);
  assert.strictEqual(vie.bloques.find((b) => b.hora === 11).disponible, true);
});

test('bloqueValido rechaza fin de semana, horas no ofrecidas y fechas pasadas', () => {
  assert.strictEqual(bloqueValido(cfg, '2026-10-16', 9, AHORA), true);
  assert.strictEqual(bloqueValido(cfg, '2026-10-17', 9, AHORA), false); // sábado
  assert.strictEqual(bloqueValido(cfg, '2026-10-16', 10, AHORA), false);
  assert.strictEqual(bloqueValido(cfg, '2026-10-14', 9, AHORA), false);
  assert.strictEqual(bloqueValido(cfg, 'x', 9, AHORA), false);
});

test('describe bloques en español y genera ICS', () => {
  assert.strictEqual(describirBloque('2026-10-16', 9), 'Viernes 16 de octubre a las 09:00 hrs');
  const ics = generarICS({ uid: 'u1', fecha: '2026-10-16', hora: 17, duracionMinutos: 60, zona: 'America/Santiago', titulo: 'Visita', descripcion: 'a, b' });
  assert.match(ics, /DTSTART;TZID=America\/Santiago:20261016T170000/);
  assert.match(ics, /DTEND;TZID=America\/Santiago:20261016T180000/);
  assert.match(ics, /DESCRIPTION:a\\, b/);
});

test('utilidades: RUT, teléfono y detección de portal', () => {
  assert.ok(rutValido('11.111.111-1'));
  assert.ok(rutValido('76.086.428-5'));
  assert.ok(!rutValido('11.111.111-2'));
  assert.strictEqual(formatearRut('123456785'), '12.345.678-5');
  assert.strictEqual(normalizarTelefono('+56 9 6121 6962'), '56961216962');
  assert.strictEqual(normalizarTelefono('961216962'), '56961216962');
  assert.strictEqual(detectarPortal('Hola, vi tu aviso en Mercado Libre'), 'Mercado Libre');
  assert.strictEqual(detectarPortal('https://www.yapo.cl/arriendo/123'), 'Yapo');
  assert.strictEqual(detectarPortal('https://www.portalinmobiliario.com/MLC-123'), 'Portal Inmobiliario');
  assert.strictEqual(extraerUrl('mira https://articulo.mercadolibre.cl/MLC-1). gracias'), 'https://articulo.mercadolibre.cl/MLC-1');
});

test('interpreta links de distintos portales', async () => {
  const pi = interpretarUrl('Mira este: https://www.portalinmobiliario.com/MLC-1523456789-departamento-en-arriendo-santiago-centro-_JM');
  assert.strictEqual(pi.portal, 'Portal Inmobiliario');
  assert.strictEqual(pi.codigo, 'MLC-1523456789');
  assert.strictEqual(pi.descripcion, 'Departamento en arriendo santiago centro');
  const yapo = interpretarUrl('www.yapo.cl/inmuebles/arriendo/depto-amoblado-en-nunoa/92837465');
  assert.strictEqual(yapo.portal, 'Yapo');
  assert.strictEqual(yapo.codigo, '92837465');
  assert.match(yapo.descripcion, /amoblado en nunoa/);
  assert.strictEqual(interpretarUrl('sin link'), null);

  // Si el portal permite leer la página, se usa el título y la dirección
  const html = `<html><head><meta property="og:title" content="Depto 2D 2B en Providencia | Mercado Libre">
    <script type="application/ld+json">{"@type":"Product","address":{"streetAddress":"Av. Providencia 1234","addressLocality":"Providencia"}}</script></head></html>`;
  const fetchFn = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  const leido = await leerPublicacion('https://departamento.mercadolibre.cl/MLC-111111111-x-_JM', { fetchFn });
  assert.strictEqual(leido.titulo, 'Depto 2D 2B en Providencia');
  assert.strictEqual(leido.direccion, 'Av. Providencia 1234, Providencia');

  // Nunca consulta sitios que no son portales conocidos
  let consultado = false;
  await leerPublicacion('http://169.254.169.254/latest/meta-data', { fetchFn: async () => { consultado = true; } });
  assert.strictEqual(consultado, false);
});
