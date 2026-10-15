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

test('archivos grandes: se adjunta lo que cabe y el resto va como link', async (t) => {
  const ctx = await preparar({ EMAIL_MAX_ADJUNTOS_MB: '1' });
  t.after(() => ctx.server.close());
  const fd = new FormData();
  for (const [k, v] of Object.entries(DATOS)) fd.append(k, v);
  const grande = new Blob([Buffer.alloc(800 * 1024, 1)], { type: 'application/pdf' });
  const chico = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
  fd.append('cedula', grande, 'cedula.pdf');
  fd.append('liquidaciones', grande, 'liq.pdf');
  fd.append('afp', chico, 'afp.pdf');
  fd.append('dicom', chico, 'dicom.pdf');
  const r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: fd });
  assert.strictEqual(r.status, 200);
  const correo = ctx.correos.find((c) => [].concat(c.to).includes('sdopropiedades@sdorent.cl'));
  assert.strictEqual(correo.attachments.length, 3);
  assert.match(correo.html, /1 archivo\(s\) no se adjuntaron/);
});

test('el máximo por archivo por defecto es 30 MB', () => {
  assert.strictEqual(cargarConfig({}).archivos.maxMB, 30);
});

test('panel: ficha con documentos, ZIP y calendario de visitas', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const auth = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}` };
  let r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(DATOS, DOCS_DEP) });
  assert.strictEqual(r.status, 200);
  const lead = ctx.db.leadPorTelefono('56987654321');

  // Sin clave no se accede a nada del panel
  for (const ruta of [`/admin/lead/${lead.id}`, `/admin/calendario`, `/admin/lead/${lead.id}/documentos.zip`, `/admin/documento/1`]) {
    assert.strictEqual((await fetch(ctx.url + ruta)).status, 401, ruta);
  }

  const ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: auth })).text();
  assert.match(ficha, /Descargar todo \(ZIP\)/);
  assert.match(ficha, /3 últimas liquidaciones de sueldo/);
  assert.strictEqual((ficha.match(/\/admin\/documento\/\d+\?descargar=1/g) || []).length, 6);
  assert.match(ficha, /Aprobar y enviar calendario/);

  const doc = ctx.db.documentosDeLead(lead.id)[0];
  r = await fetch(`${ctx.url}/admin/documento/${doc.id}?descargar=1`, { headers: auth });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /^attachment/);
  assert.strictEqual(await r.text(), '%PDF-1.4 prueba');

  r = await fetch(`${ctx.url}/admin/lead/${lead.id}/documentos.zip`, { headers: auth });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /Juan_Perez_Soto_11.111.111-1\.zip/);
  const zip = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(zip.subarray(0, 2).toString(), 'PK');
  const texto = zip.toString('latin1');
  assert.ok(texto.includes('1 - Cédula de identidad/'.normalize()) || texto.includes('1 - C'), 'carpeta por requisito');
  assert.ok(texto.includes('2 - 3 '), 'liquidaciones en carpeta 2');
  assert.ok(texto.includes('liq1.pdf') && texto.includes('liq3.pdf'));

  // Calendario del panel muestra la visita
  ctx.db.actualizarLead(lead.id, { estado: 'aprobado' });
  r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|15' }), redirect: 'manual' });
  assert.strictEqual(r.status, 303);
  const cal = await (await fetch(`${ctx.url}/admin/calendario`, { headers: auth })).text();
  assert.match(cal, /1 visita\(s\) esta semana/);
  assert.match(cal, new RegExp(`href="/admin/lead/${lead.id}"[^>]*>\\s*<strong>Juan Pérez Soto</strong>`));
  const sig = await (await fetch(`${ctx.url}/admin/calendario?semana=1`, { headers: auth })).text();
  assert.match(sig, /Sin visitas esta semana/);
});

test('formulario: liquidaciones en 3 casillas (solo la primera obligatoria)', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const html = await (await fetch(`${ctx.url}/postular`)).text();
  assert.match(html, /Liquidación 1 \(la más reciente\)/);
  assert.match(html, /Liquidación 2/);
  assert.match(html, /Liquidación 3/);
  assert.strictEqual((html.match(/name="liquidaciones"/g) || []).length, 3);
  assert.strictEqual((html.match(/name="liquidaciones"\s+accept="[^"]+"\s+data-opcional/g) || []).length, 2);
  // Con una sola liquidación (PDF con las 3) también se acepta
  const r = await fetch(`${ctx.url}/postular`, {
    method: 'POST',
    body: formulario(DATOS, [['cedula', 'c.pdf'], ['liquidaciones', 'las3.pdf'], ['afp', 'a.pdf'], ['dicom', 'd.pdf']]),
  });
  assert.strictEqual(r.status, 200);
});

test('panel: resultado de visita, cancelar y eliminar interesado', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const post = (ruta, datos = {}, extra = {}) =>
    fetch(ctx.url + ruta, { method: 'POST', headers: { ...h, ...extra }, body: new URLSearchParams(datos), redirect: 'manual' });

  await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(DATOS, DOCS_DEP) });
  let lead = ctx.db.leadPorTelefono('56987654321');
  ctx.db.actualizarLead(lead.id, { estado: 'aprobado' });
  await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|9' }) });

  let ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /¿Cómo fue la visita\?/);
  assert.match(ficha, /Viernes 16 de octubre a las 09:00 hrs/);

  // Desde otro sitio no se puede ejecutar acciones
  assert.strictEqual((await post(`/admin/lead/${lead.id}/eliminar`, { confirmo: '1' }, { origin: 'https://otro-sitio.com' })).status, 403);

  // Cancelar con aviso -> libera el horario y avisa al interesado
  let r = await post(`/admin/lead/${lead.id}/visita/cancelar`, { avisar: '1' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'aprobado');
  assert.ok(ctx.correos.some((c) => c.to === 'juan@example.com' && /fue cancelada/.test(c.subject)));
  assert.match(ctx.wa.at(-1).texto, /cancelar tu visita/);
  assert.strictEqual(ctx.db.contarBloque('2026-10-16', 9), 0);

  // Reagenda y se registra el resultado
  await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|11' }) });
  r = await post(`/admin/lead/${lead.id}/visita`, { resultado: 'no_continua', notas: 'Busca algo más grande' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'no_continua');
  ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}?ok=resultado`, { headers: h })).text();
  assert.match(ficha, /Resultado de la visita guardado/);
  assert.match(ficha, /Busca algo más grande/);
  assert.match(ficha, /Este interesado no continúa/);

  // Eliminar: pide confirmación y borra datos y archivos
  const carpeta = path.join(ctx.config.uploadsDir, String(lead.id));
  assert.ok(fs.existsSync(carpeta));
  assert.match(await (await fetch(`${ctx.url}/admin/lead/${lead.id}/eliminar`, { headers: h })).text(), /6 documento\(s\)/);
  r = await post(`/admin/lead/${lead.id}/eliminar`, {});
  assert.strictEqual(r.status, 303);
  assert.ok(ctx.db.leadPorId(lead.id), 'sin confirmar no borra');
  r = await post(`/admin/lead/${lead.id}/eliminar`, { confirmo: '1' });
  assert.strictEqual(r.status, 303);
  assert.match(r.headers.get('location'), /eliminado=Juan/);
  assert.strictEqual(ctx.db.leadPorId(lead.id), undefined);
  assert.strictEqual(ctx.db.documentosDeLead(lead.id).length, 0);
  assert.strictEqual(ctx.db.contarBloque('2026-10-16', 11), 0);
  assert.ok(!fs.existsSync(carpeta));
  const panel = await (await fetch(`${ctx.url}/admin?eliminado=Juan%20P%C3%A9rez%20Soto`, { headers: h })).text();
  assert.match(panel, /Se eliminó a <strong>Juan Pérez Soto/);

  // Si vuelve a escribir por WhatsApp después de "no continúa", parte como interesado nuevo
  await postWebhook(ctx, mensajeWA('wamid.x', '56987654321', 'Hola de nuevo'));
  assert.match(ctx.wa.at(-1).texto, /\/postular\//);
});
