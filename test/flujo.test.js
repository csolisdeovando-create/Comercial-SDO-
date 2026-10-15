// Prueba de punta a punta: WhatsApp -> formulario -> revisión -> agenda
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.SDO_SKIP_ENV_FILE = '1';
const { cargarConfig } = require('../src/config');
const { abrirDB } = require('../src/db');
const { crearApp } = require('../src/app');

const AHORA = new Date('2026-10-15T13:00:00Z'); // jueves 10:00 Chile

function preparar(envExtra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdo-test-'));
  const config = cargarConfig({ DATA_DIR: dataDir, APP_SECRET: 'secreto-test', ADMIN_CLAVE: 'clave', ...envExtra });
  const db = abrirDB(':memory:');
  const correos = [];
  const wa = [];
  const mailer = {
    modoPrueba: true,
    async enviar(m) {
      // consume los streams de adjuntos para no dejar archivos abiertos
      for (const a of m.attachments || []) if (a.content?.pipe) for await (const _ of a.content);
      correos.push(m);
    },
  };
  const whatsapp = {
    configurado: true,
    async enviarTexto(to, texto) { wa.push({ to, texto }); },
    async enviarPlantilla(to, nombre, params) { wa.push({ to, plantilla: nombre, params }); },
    async marcarLeido() {},
  };
  const app = crearApp({ config, db, mailer, whatsapp, ahora: () => AHORA });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      config.baseUrl = url;
      resolve({ app, server, url, db, config, correos, wa });
    });
  });
}

const mensajeWA = (id, from, texto, nombre = 'Juan Pérez') => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: nombre } }], messages: [{ id, from, type: 'text', text: { body: texto } }] } }] }],
});

async function postWebhook(ctx, cuerpo, headers = {}) {
  const r = await fetch(`${ctx.url}/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(cuerpo),
  });
  await ctx.app.locals.esperarTareas();
  return r;
}

function formulario(campos, archivos) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  for (const [campo, nombre] of archivos) fd.append(campo, new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), nombre);
  return fd;
}

const DATOS = { tipo: 'dependiente', nombre: 'Juan Pérez Soto', rut: '11.111.111-1', email: 'juan@example.com', telefono: '+56 9 8765 4321', consentimiento: '1' };
const DOCS_DEP = [['cedula', 'cédula.pdf'], ['liquidaciones', 'liq1.pdf'], ['liquidaciones', 'liq2.pdf'], ['liquidaciones', 'liq3.pdf'], ['afp', 'afp.pdf'], ['dicom', 'dicom.pdf']];

test('flujo completo de un lead', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());

  // 1) Llega mensaje desde el botón de Mercado Libre
  await postWebhook(ctx, mensajeWA('wamid.1', '56987654321', 'Hola! Me interesa este aviso de Mercado Libre https://departamento.mercadolibre.cl/MLC-123'));
  assert.strictEqual(ctx.wa.length, 1);
  assert.strictEqual(ctx.wa[0].to, '56987654321');
  assert.match(ctx.wa[0].texto, /Mercado Libre/);
  assert.match(ctx.wa[0].texto, /Certificado de cotizaciones \(AFP\)/);
  const lead0 = ctx.db.leadPorTelefono('56987654321');
  assert.ok(ctx.wa[0].texto.includes(`/postular/${lead0.token}`));
  assert.strictEqual(lead0.propiedad, 'https://departamento.mercadolibre.cl/MLC-123');

  // Reintento del mismo webhook y nuevo mensaje dentro del enfriamiento: no responde de nuevo
  await postWebhook(ctx, mensajeWA('wamid.1', '56987654321', 'Hola!'));
  await postWebhook(ctx, mensajeWA('wamid.2', '56987654321', '¿Sigue disponible?'));
  assert.strictEqual(ctx.wa.length, 1);

  // 2) Formulario precargado
  const form = await (await fetch(`${ctx.url}/postular/${lead0.token}`)).text();
  assert.match(form, /Juan Pérez/);
  assert.match(form, /\+56987654321/);

  // Falta un documento -> error
  let r = await fetch(`${ctx.url}/postular/${lead0.token}`, { method: 'POST', body: formulario(DATOS, DOCS_DEP.slice(0, 4)) });
  assert.strictEqual(r.status, 422);
  assert.match(await r.text(), /Falta adjuntar: Certificado de cotizaciones/);

  r = await fetch(`${ctx.url}/postular/${lead0.token}`, { method: 'POST', body: formulario(DATOS, DOCS_DEP) });
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /Postulación enviada/);

  let lead = ctx.db.leadPorId(lead0.id);
  assert.strictEqual(lead.estado, 'documentos_recibidos');
  assert.strictEqual(ctx.db.documentosDeLead(lead.id).length, 6);
  assert.ok(ctx.db.documentosDeLead(lead.id).some((d) => d.nombre_original === 'cédula.pdf'));

  const aBarbara = ctx.correos.find((c) => [].concat(c.to).includes('sdopropiedades@sdorent.cl'));
  assert.ok(aBarbara, 'debe llegar correo a sdopropiedades');
  assert.strictEqual(aBarbara.attachments.length, 6);
  assert.match(aBarbara.html, /Aprobar y enviar calendario/);
  const linkAprobar = aBarbara.html.match(/href="([^"]+\/aprobar\?firma=[^"]+)"/)[1];

  // Aún no puede agendar
  assert.match(await (await fetch(`${ctx.url}/agendar/${lead.token}`)).text(), /Aún no puedes agendar/);

  // 3) Revisión: link inválido y luego aprobación
  r = await fetch(`${ctx.url}/revision/${lead.id}/aprobar?firma=malo`);
  assert.strictEqual(r.status, 403);
  r = await fetch(linkAprobar);
  assert.match(await r.text(), /Aprobar y enviar calendario/);
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'documentos_recibidos', 'GET no debe aprobar');
  r = await fetch(linkAprobar, { method: 'POST' });
  assert.match(await r.text(), /Postulación aprobada/);
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'aprobado');
  const correoAgenda = ctx.correos.find((c) => c.to === 'juan@example.com' && /Agenda tu visita/.test(c.subject));
  assert.ok(correoAgenda.html.includes(`/agendar/${lead.token}`));
  assert.ok(ctx.wa.at(-1).texto.includes(`/agendar/${lead.token}`));

  // 4) Calendario y reserva
  const cal = await (await fetch(`${ctx.url}/agendar/${lead.token}`)).text();
  assert.match(cal, /value="2026-10-16\|9"/);
  assert.doesNotMatch(cal, /value="2026-10-17\|/); // sábado

  r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-17|9' }) });
  assert.strictEqual(r.status, 422);

  r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|9' }), redirect: 'manual' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'agendado');
  const aEquipo = ctx.correos.find((c) => /Nueva visita agendada/.test(c.subject));
  assert.deepStrictEqual(aEquipo.to, ['julio.mendoza@sdorent.cl', 'barbara.diaz@sdorent.cl', 'csolisdeovando@sdocapital.cl']);
  assert.match(aEquipo.subject, /Viernes 16 de octubre a las 09:00/);
  assert.match(aEquipo.icalEvent.content, /DTSTART;TZID=America\/Santiago:20261016T090000/);
  assert.match(ctx.wa.at(-1).texto, /Viernes 16 de octubre a las 09:00/);

  // Otro lead aprobado no puede tomar el mismo bloque
  const otro = ctx.db.crearLead({ telefono: '56911112222', nombre: 'Ana', email: 'ana@example.com', estado: 'aprobado' });
  r = await fetch(`${ctx.url}/agendar/${otro.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|9' }) });
  assert.strictEqual(r.status, 409);
  assert.match(await r.text(), /se acaba de ocupar/);
  assert.doesNotMatch(await (await fetch(`${ctx.url}/agendar/${otro.token}`)).text(), /value="2026-10-16\|9"/);

  // Reagendar libera el bloque anterior
  r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|11' }), redirect: 'manual' });
  assert.strictEqual(r.status, 303);
  assert.ok(ctx.correos.some((c) => /REAGENDADA/.test(c.subject)));
  assert.match(await (await fetch(`${ctx.url}/agendar/${otro.token}`)).text(), /value="2026-10-16\|9"/);

  // Panel interno
  assert.strictEqual((await fetch(`${ctx.url}/admin`)).status, 401);
  const panel = await fetch(`${ctx.url}/admin`, { headers: { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}` } });
  assert.match(await panel.text(), /Juan Pérez Soto/);
});

test('rechazo permite volver a subir documentos', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  let r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(DATOS, DOCS_DEP) });
  assert.strictEqual(r.status, 200);
  const lead = ctx.db.leadPorTelefono('56987654321');
  const firma = ctx.correos[0].html.match(/rechazar\?firma=([^"]+)"/)[1];
  r = await fetch(`${ctx.url}/revision/${lead.id}/rechazar?firma=${firma}`, {
    method: 'POST',
    body: new URLSearchParams({ motivo: 'Falta liquidación de septiembre', reenviar: '1' }),
  });
  assert.match(await r.text(), /Respuesta enviada/);
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'rechazado');
  assert.ok(ctx.correos.some((c) => c.to === 'juan@example.com' && c.html.includes('Falta liquidación de septiembre')));
  assert.match(await (await fetch(`${ctx.url}/postular/${lead.token}`)).text(), /Enviar postulación/);
});

test('modo agenda automática envía el calendario apenas se suben los documentos', async (t) => {
  const ctx = await preparar({ AGENDA_AUTOMATICA: 'true' });
  t.after(() => ctx.server.close());
  const r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(DATOS, DOCS_DEP), redirect: 'manual' });
  assert.strictEqual(r.status, 303);
  assert.match(r.headers.get('location'), /^\/agendar\//);
  assert.strictEqual(ctx.db.leadPorTelefono('56987654321').estado, 'aprobado');
});

test('webhook: verificación y firma de Meta', async (t) => {
  const ctx = await preparar({ WHATSAPP_VERIFY_TOKEN: 'verif', WHATSAPP_APP_SECRET: 'app-secret' });
  t.after(() => ctx.server.close());
  let r = await fetch(`${ctx.url}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verif&hub.challenge=123`);
  assert.strictEqual(await r.text(), '123');
  r = await fetch(`${ctx.url}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=123`);
  assert.strictEqual(r.status, 403);

  const cuerpo = mensajeWA('wamid.9', '56900000000', 'hola yapo');
  r = await postWebhook(ctx, cuerpo, { 'x-hub-signature-256': 'sha256=mala' });
  assert.strictEqual(r.status, 401);
  const firma = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(JSON.stringify(cuerpo)).digest('hex');
  r = await postWebhook(ctx, cuerpo, { 'x-hub-signature-256': firma });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(ctx.wa.length, 1);
  assert.match(ctx.wa[0].texto, /Yapo/);
});
