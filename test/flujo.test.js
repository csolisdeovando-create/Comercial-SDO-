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

function preparar(envExtra = {}, { whatsappConfigurado = true, ahoraFn = () => AHORA } = {}) {
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
    configurado: whatsappConfigurado,
    async enviarTexto(to, texto) { wa.push({ to, texto }); },
    async enviarPlantilla(to, nombre, params) { wa.push({ to, plantilla: nombre, params }); },
    async marcarLeido() {},
  };
  const app = crearApp({ config, db, mailer, whatsapp, ahora: ahoraFn });
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
  assert.strictEqual(lead0.url_publicacion, 'https://departamento.mercadolibre.cl/MLC-123');
  assert.strictEqual(lead0.portal, 'Mercado Libre');

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
  // Los documentos llegan a sdopropiedades y Cristian; Julio y José no los reciben
  assert.deepStrictEqual(aBarbara.to, ['sdopropiedades@sdorent.cl', 'csolisdeovando@sdocapital.cl']);
  assert.ok(!ctx.correos.some((c) => [].concat(c.to).includes('julio.mendoza@sdorent.cl') && /postulaci/i.test(c.subject)));
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
  assert.match(cal, /value="2026-10-17\|9"/); // sábado disponible
  assert.doesNotMatch(cal, /value="2026-10-18\|/); // domingo no

  r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-18|9' }) });
  assert.strictEqual(r.status, 422); // domingo

  r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|9' }), redirect: 'manual' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'agendado');
  const aEquipo = ctx.correos.find((c) => /Nueva visita/.test(c.subject));
  assert.deepStrictEqual(aEquipo.to, ['julio.mendoza@sdorent.cl', 'sdopropiedades@sdorent.cl', 'csolisdeovando@sdocapital.cl', 'josecano@sdorent.cl']);
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
  const sinSesion = await fetch(`${ctx.url}/admin`, { redirect: 'manual' });
  assert.strictEqual(sinSesion.status, 303);
  assert.strictEqual(sinSesion.headers.get('location'), '/ingresar?volver=%2Fadmin');
  assert.strictEqual(sinSesion.headers.get('www-authenticate'), null, 'no debe pedir la ventana del navegador');
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
    assert.strictEqual((await fetch(ctx.url + ruta, { redirect: 'manual' })).status, 303, ruta);
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

test('link de la publicación: identifica la propiedad y el portal', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const url = 'https://departamento.mercadolibre.cl/MLC-2754123456-se-arrienda-depto-providencia-2d-2b-_JM#position=3';
  const r = await (await fetch(`${ctx.url}/api/publicacion?url=${encodeURIComponent(url)}`)).json();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.portal, 'Mercado Libre');
  assert.strictEqual(r.codigo, 'MLC-2754123456');
  assert.match(r.descripcion, /^Se arrienda depto providencia 2D 2B$/);
  assert.strictEqual((await fetch(`${ctx.url}/api/publicacion?url=hola`)).status, 422);

  // Al postular solo con el link, la propiedad y el origen se completan solos
  const res = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, url_publicacion: url }, DOCS_DEP) });
  assert.strictEqual(res.status, 200);
  const lead = ctx.db.leadPorTelefono('56987654321');
  assert.strictEqual(lead.portal, 'Mercado Libre');
  assert.match(lead.propiedad, /providencia 2D 2B \(MLC-2754123456\)/);
  assert.strictEqual(lead.url_publicacion, url.replace(/#.*/, ''));
  const correo = ctx.correos.find((c) => [].concat(c.to).includes('sdopropiedades@sdorent.cl'));
  assert.ok(correo.html.includes('Ver aviso'));
});

test('seguridad: webhook desactivado si WhatsApp no está conectado; encabezados', async (t) => {
  const ctx = await preparar({}, { whatsappConfigurado: false });
  t.after(() => ctx.server.close());
  const r = await postWebhook(ctx, mensajeWA('w1', '56911112222', 'hola'));
  assert.strictEqual(r.status, 404);
  assert.strictEqual(ctx.db.leadPorTelefono('56911112222'), undefined);
  const f = await fetch(`${ctx.url}/postular`);
  assert.strictEqual(f.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(f.headers.get('referrer-policy'), 'same-origin');
});

test('duplicados: reenvío en revisión suma documentos; aprobado reenvía su link', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(DATOS, DOCS_DEP) });
  const lead = ctx.db.leadPorTelefono('56987654321');

  // Mismo teléfono y correo mientras está en revisión -> misma postulación, aviso de actualización
  let r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(DATOS, DOCS_DEP.slice(0, 1).concat([['liquidaciones', 'l.pdf'], ['afp', 'a.pdf'], ['dicom', 'd.pdf']])) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(ctx.db.listarLeads().length, 1);
  assert.strictEqual(ctx.db.documentosDeLead(lead.id).length, 10);
  assert.ok(ctx.correos.some((c) => /^Actualización de documentos/.test(c.subject)));

  // Ya aprobado -> no se crea otro; se reenvía el link al correo registrado
  ctx.db.actualizarLead(lead.id, { estado: 'aprobado' });
  const antes = ctx.correos.length;
  r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(DATOS, DOCS_DEP) });
  assert.match(await r.text(), /Ya tienes una postulación aprobada/);
  assert.strictEqual(ctx.db.listarLeads().length, 1);
  const reenvio = ctx.correos.slice(antes).find((c) => c.to === 'juan@example.com');
  assert.ok(reenvio.html.includes(`/agendar/${lead.token}`));

  // Mismo RUT con otro correo -> se crea, marcado como posible duplicado
  r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, email: 'otro@example.com', telefono: '+56 9 1111 2222' }, DOCS_DEP) });
  assert.strictEqual(r.status, 200);
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}` };
  const panel = await (await fetch(`${ctx.url}/admin`, { headers: h })).text();
  assert.match(panel, /Posible duplicado de <a href="\/admin\/lead\/1">#1<\/a>/);
});

test('panel: buscador, filtro por estado y exportar a Excel', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}` };
  await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, propiedad: 'Rosario Sur 91' }, DOCS_DEP) });
  ctx.db.crearLead({ telefono: '56900000001', nombre: 'Ana Muñoz', email: 'ana@example.com', estado: 'aprobado' });

  let html = await (await fetch(`${ctx.url}/admin?q=munoz`, { headers: h })).text();
  assert.match(html, /1 resultado\(s\)/);
  assert.match(html, /Ana Muñoz/);
  assert.doesNotMatch(html, /Juan Pérez Soto/);
  html = await (await fetch(`${ctx.url}/admin?q=11111111`, { headers: h })).text();
  assert.match(html, /Juan Pérez Soto/);
  html = await (await fetch(`${ctx.url}/admin?estado=documentos_recibidos`, { headers: h })).text();
  assert.match(html, /Juan Pérez Soto/);
  assert.doesNotMatch(html, /Ana Muñoz/);

  const r = await fetch(`${ctx.url}/admin/exportar.csv`, { headers: h });
  assert.match(r.headers.get('content-disposition'), /interesados-sdo-2026-10-15\.csv/);
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM para Excel');
  const lineas = bytes.subarray(3).toString('utf8').split('\r\n');
  assert.strictEqual(lineas.length, 3);
  assert.match(lineas[0], /^N°;Fecha postulación;Nombre;RUT/);
  assert.ok(lineas.some((l) => l.includes('Juan Pérez Soto;11.111.111-1;Trabajador dependiente') && l.includes('Rosario Sur 91')));
  assert.strictEqual((await fetch(`${ctx.url}/admin/exportar.csv`, { redirect: 'manual' })).status, 303);
});

test('recordatorio de visita el día anterior', async (t) => {
  let ahora = new Date('2026-10-15T13:00:00Z'); // jueves 10:00 Chile
  const ctx = await preparar({}, { ahoraFn: () => ahora });
  t.after(() => ctx.server.close());
  const lead = ctx.db.crearLead({ telefono: '56900000002', nombre: 'Pedro Soto', email: 'pedro@example.com', estado: 'agendado' });
  const visita = ctx.db.crearVisita(lead.id, '2026-10-16', 11);
  ctx.db.db.prepare("UPDATE visitas SET created_at = '2026-10-13 12:00:00' WHERE id = ?").run(visita.id);
  // Antes de las 10:00 no envía
  ahora = new Date('2026-10-15T12:00:00Z');
  assert.strictEqual(await ctx.app.locals.enviarRecordatorios(), 0);
  ahora = new Date('2026-10-15T13:30:00Z');
  assert.strictEqual(await ctx.app.locals.enviarRecordatorios(), 1);
  const correo = ctx.correos.find((c) => c.to === 'pedro@example.com');
  assert.match(correo.subject, /Recordatorio: tu visita es mañana – Viernes 16 de octubre a las 11:00 hrs/);
  assert.ok(correo.html.includes(`/agendar/${lead.token}`), 'botón reagendar');
  assert.ok(correo.html.includes(`/visita/${lead.token}/confirmar`), 'botón confirmar');
  assert.match(correo.html, /Confirmar asistencia/);
  // No se repite
  assert.strictEqual(await ctx.app.locals.enviarRecordatorios(), 0);
});

test('complemento de renta: datos y mismos documentos de quien complementa', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}` };

  const html = await (await fetch(`${ctx.url}/postular`)).text();
  assert.match(html, /Voy a complementar renta con otra persona/);
  assert.match(html, /name="comp_cedula"/);
  assert.match(html, /name="comp_carpeta_tributaria"/);

  const COMP = { complementa: '1', comp_tipo: 'independiente', comp_nombre: 'María Soto', comp_rut: '76.086.428-5', comp_relacion: 'Pareja' };
  const DOCS_COMP = [['comp_carnet_representante', 'carnet_maria.pdf'], ['comp_carpeta_tributaria', 'carpeta.pdf'], ['comp_declaraciones_renta', 'f22.pdf'], ['comp_dicom_empresa', 'dicom_maria.pdf']];

  // Falta un documento de quien complementa -> error
  let r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, ...COMP }, [...DOCS_DEP, ...DOCS_COMP.slice(0, 3)]) });
  assert.strictEqual(r.status, 422);
  assert.match(await r.text(), /Falta adjuntar \(complemento\): Reporte Dicom/);

  // Mismo RUT que quien postula -> error
  r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, ...COMP, comp_rut: DATOS.rut }, [...DOCS_DEP, ...DOCS_COMP]) });
  assert.match(await r.text(), /debe ser otra persona/);

  r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, ...COMP }, [...DOCS_DEP, ...DOCS_COMP]) });
  assert.strictEqual(r.status, 200);
  const lead = ctx.db.leadPorTelefono('56987654321');
  assert.strictEqual(lead.complementa, 1);
  assert.strictEqual(lead.comp_tipo, 'independiente');
  assert.strictEqual(lead.comp_rut, '760864285');
  assert.strictEqual(ctx.db.documentosDeLead(lead.id).length, 10);

  const correo = ctx.correos.find((c) => [].concat(c.to).includes('sdopropiedades@sdorent.cl'));
  assert.match(correo.html, /Complementa renta/);
  assert.match(correo.html, /María Soto/);
  assert.match(correo.html, /Complemento · Carpeta tributaria/);
  assert.strictEqual(correo.attachments.length, 10);

  const ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /Complemento de renta · María Soto \(Independiente o empresa\)/);
  assert.match(ficha, /carnet_maria\.pdf/);
  const panel = await (await fetch(`${ctx.url}/admin`, { headers: h })).text();
  assert.match(panel, /\+ complemento/);

  const zip = Buffer.from(await (await fetch(`${ctx.url}/admin/lead/${lead.id}/documentos.zip`, { headers: h })).arrayBuffer()).toString('latin1');
  assert.ok(zip.includes('Complemento renta - Mar'), 'carpeta del complemento en el ZIP');
  assert.ok(zip.includes('f22.pdf'));

  // Si no marca la casilla, no se guarda complemento aunque lleguen archivos
  const otro = await fetch(`${ctx.url}/postular`, {
    method: 'POST',
    body: formulario({ ...DATOS, telefono: '+56 9 3333 4444', email: 'x@example.com', rut: '76.086.428-5' }, [...DOCS_DEP, ...DOCS_COMP]),
  });
  assert.strictEqual(otro.status, 200);
  const sinComp = ctx.db.leadPorTelefono('56933334444');
  assert.strictEqual(sinComp.complementa, 0);
  assert.strictEqual(ctx.db.documentosDeLead(sinComp.id).length, 6);
});

test('evento de calendario del equipo: información completa, confirmación, reagendar y cancelar', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const lead = ctx.db.crearLead({
    telefono: '56987654321', nombre: 'Juan Pérez Soto', email: 'juan@example.com', rut: '111111111', tipo: 'dependiente',
    propiedad: 'Rosario Sur 91, depto 504, Las Condes', url_publicacion: 'https://departamento.mercadolibre.cl/MLC-1-x-_JM', estado: 'aprobado',
  });
  await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|9' }) });
  const ev1 = ctx.correos.find((c) => /Nueva visita/.test(c.subject)).icalEvent.content.replace(/\r\n /g, '');
  assert.match(ev1, /SUMMARY:Visita 09:00 · Rosario Sur 91\\, depto 504\\, Las Condes · Juan Pérez Soto \+56987654321/);
  assert.match(ev1, /LOCATION:Rosario Sur 91\\, depto 504\\, Las Condes/);
  assert.match(ev1, /wa\.me\/56987654321/);
  assert.match(ev1, /google\.com\/maps/);
  assert.match(ev1, /Ficha y documentos: http/);
  assert.match(ev1, /TRIGGER:-PT60M/);
  const uid = ev1.match(/UID:(.*)/)[1];
  assert.doesNotMatch(ev1, /ATTENDEE.*juan@example\.com/, 'el interesado no va en el evento interno');

  // Confirmar asistencia: GET solo muestra el botón; POST confirma y actualiza el evento del equipo
  let r = await fetch(`${ctx.url}/visita/${lead.token}/confirmar`);
  assert.match(await r.text(), /Sí, confirmo mi asistencia/);
  assert.strictEqual(ctx.db.visitaVigente(lead.id).confirmada_at, null);
  r = await fetch(`${ctx.url}/visita/${lead.token}/confirmar`, { method: 'POST', redirect: 'manual' });
  assert.strictEqual(r.status, 303);
  assert.ok(ctx.db.visitaVigente(lead.id).confirmada_at);
  const conf = ctx.correos.find((c) => /CONFIRMADA por el interesado/.test(c.subject));
  const ev2 = conf.icalEvent.content.replace(/\r\n /g, '');
  assert.match(ev2, /SUMMARY:✅ CONFIRMADA · Visita 09:00/);
  assert.strictEqual(ev2.match(/UID:(.*)/)[1], uid, 'mismo evento');
  assert.match(await (await fetch(`${ctx.url}/visita/${lead.token}/confirmar`)).text(), /Ya confirmaste/);
  assert.match(await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text(), /El interesado confirmó su asistencia/);

  // Reagendar actualiza el mismo evento (no crea uno nuevo)
  await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|13' }) });
  const ev3 = ctx.correos.find((c) => /REAGENDADA/.test(c.subject)).icalEvent.content.replace(/\r\n /g, '');
  assert.strictEqual(ev3.match(/UID:(.*)/)[1], uid);
  assert.match(ev3, /DTSTART;TZID=America\/Santiago:20261016T130000/);
  assert.ok(Number(ev3.match(/SEQUENCE:(\d+)/)[1]) >= Number(ev1.match(/SEQUENCE:(\d+)/)[1]));

  // Cancelar desde el panel quita el evento del calendario del equipo
  r = await fetch(`${ctx.url}/admin/lead/${lead.id}/visita/cancelar`, { method: 'POST', headers: h, body: new URLSearchParams({}), redirect: 'manual' });
  assert.strictEqual(r.status, 303);
  const canc = ctx.correos.find((c) => /Visita CANCELADA/.test(c.subject));
  assert.strictEqual(canc.icalEvent.method, 'CANCEL');
  assert.match(canc.icalEvent.content, /METHOD:CANCEL/);
  assert.match(canc.icalEvent.content, /STATUS:CANCELLED/);
  assert.strictEqual(canc.icalEvent.content.replace(/\r\n /g, '').match(/UID:(.*)/)[1], uid);
});

test('inicio de sesión del panel con página propia (sirve en el ícono del iPhone)', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  let r = await fetch(`${ctx.url}/ingresar?volver=/admin/calendario`);
  assert.match(await r.text(), /Panel comercial/);

  // Clave incorrecta
  r = await fetch(`${ctx.url}/ingresar`, { method: 'POST', body: new URLSearchParams({ usuario: 'admin', clave: 'mala', volver: '/admin' }), redirect: 'manual' });
  assert.strictEqual(r.status, 401);
  assert.match(await r.text(), /Usuario o clave incorrectos/);

  // Correcta -> cookie y vuelve a donde iba
  r = await fetch(`${ctx.url}/ingresar`, { method: 'POST', body: new URLSearchParams({ usuario: 'admin', clave: 'clave', volver: '/admin/calendario' }), redirect: 'manual' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.headers.get('location'), '/admin/calendario');
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /sdo_sesion=.*HttpOnly/i);
  const galleta = cookie.split(';')[0];
  r = await fetch(`${ctx.url}/admin`, { headers: { cookie: galleta } });
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /href="\/salir"/);

  // No redirige a otros sitios
  r = await fetch(`${ctx.url}/ingresar`, { method: 'POST', body: new URLSearchParams({ usuario: 'admin', clave: 'clave', volver: 'https://malo.com' }), redirect: 'manual' });
  assert.strictEqual(r.headers.get('location'), '/admin');

  // Cookie alterada no sirve
  r = await fetch(`${ctx.url}/admin`, { headers: { cookie: galleta.replace(/.$/, 'x') }, redirect: 'manual' });
  assert.strictEqual(r.status, 303);

  // Salir
  r = await fetch(`${ctx.url}/salir`, { headers: { cookie: galleta }, redirect: 'manual' });
  assert.match(r.headers.get('set-cookie'), /sdo_sesion=;/);
});

test('sábados para Xiomara, bloqueos del equipo y reagendar desde el panel', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const post = (ruta, datos) => fetch(ctx.url + ruta, { method: 'POST', headers: h, body: new URLSearchParams(datos), redirect: 'manual' });
  const lead = ctx.db.crearLead({ telefono: '56987654321', nombre: 'Ana Rojas', email: 'ana@example.com', propiedad: 'Rosario Sur 91', estado: 'aprobado' });

  // Julio no puede el viernes 16 a las 15 y el lunes 19 completo: el equipo los bloquea
  assert.strictEqual((await post('/admin/bloqueos', { fecha: '2026-10-16', hora: '15', semana: '0' })).status, 303);
  await post('/admin/bloqueos', { fecha: '2026-10-19', hora: '', semana: '1' });
  let cal = await (await fetch(`${ctx.url}/agendar/${lead.token}`)).text();
  assert.doesNotMatch(cal, /value="2026-10-16\|15"/, 'bloqueado no se ofrece');
  assert.match(cal, /value="2026-10-16\|17"/);
  assert.doesNotMatch(cal, /value="2026-10-19\|/, 'día bloqueado');
  let r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|15' }) });
  assert.strictEqual(r.status, 409);
  const panel = await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text();
  assert.match(panel, /🔒 Bloqueado/);
  assert.match(panel, /Xiomara/);

  // El interesado agenda viernes 17:00 -> equipo de semana (Julio)
  await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|17' }) });
  let aviso = ctx.correos.find((c) => /Nueva visita/.test(c.subject));
  assert.ok(aviso.to.includes('julio.mendoza@sdorent.cl'));
  assert.ok(!aviso.to.includes('xiomara@tricapitals.com'));

  // Julio no puede: el equipo la reagenda al sábado 17 a las 11 -> pasa a Xiomara y se quita del calendario de Julio
  const ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /Reagendar: elegir nueva fecha y hora/);
  assert.match(ficha, /value="2026-10-17\|11"/);
  const antes = ctx.correos.length;
  r = await post(`/admin/lead/${lead.id}/visita/agendar`, { bloque: '2026-10-17|11', avisar: '1' });
  assert.strictEqual(r.status, 303);
  assert.match(r.headers.get('location'), /ok=reagendada_aviso/);
  const nuevos = ctx.correos.slice(antes);
  const aEquipo = nuevos.find((c) => /REAGENDADA por el equipo/.test(c.subject));
  assert.ok(aEquipo.to.includes('xiomara@tricapitals.com'));
  assert.ok(!aEquipo.to.includes('julio.mendoza@sdorent.cl'));
  assert.match(aEquipo.icalEvent.content, /DTSTART;TZID=America\/Santiago:20261017T110000/);
  const aJulio = nuevos.find((c) => /Visita movida/.test(c.subject));
  assert.deepStrictEqual(aJulio.to, ['julio.mendoza@sdorent.cl']);
  assert.strictEqual(aJulio.icalEvent.method, 'CANCEL');
  const aInteresado = nuevos.find((c) => c.to === 'ana@example.com');
  assert.match(aInteresado.subject, /Reagendamos tu visita: Sábado 17 de octubre a las 11:00 hrs/);
  assert.strictEqual(ctx.db.visitaVigente(lead.id).fecha, '2026-10-17');
  assert.strictEqual(ctx.db.contarBloque('2026-10-16', 17), 0, 'el horario anterior quedó libre');

  // No se puede reagendar a un horario bloqueado
  r = await post(`/admin/lead/${lead.id}/visita/agendar`, { bloque: '2026-10-16|15' });
  assert.match(r.headers.get('location'), /ok=bloque_ocupado/);

  // Desbloquear vuelve a ofrecer el horario
  const b = ctx.db.bloqueosEntre('2026-10-16', '2026-10-16')[0];
  await post(`/admin/bloqueos/${b.id}/eliminar`, { semana: '0' });
  cal = await (await fetch(`${ctx.url}/agendar/${lead.token}`)).text();
  assert.match(cal, /value="2026-10-16\|15"/);
});
