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

function preparar(envExtra = {}, { whatsappConfigurado = true, ahoraFn = () => AHORA, lector = null, fetchAfp } = {}) {
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
  const app = crearApp({ config, db, mailer, whatsapp, ahora: ahoraFn, lector, fetchAfp });
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

const PERSONALES = { doc_tipo: 'rut', nacionalidad: 'Chilena', fecha_nacimiento: '1990-05-10', estado_civil: 'Soltero/a', profesion: 'Ingeniero comercial', direccion_actual: 'Av. Providencia 1234, depto 51', comuna: 'Providencia' };
const DATOS = { tipo: 'dependiente', nombre: 'Juan Pérez Soto', rut: '11.111.111-1', email: 'juan@example.com', telefono: '+56 9 8765 4321', consentimiento: '1', plazo_cambio: '15_dias', propiedad: 'Rosario Sur 91, depto 504, Las Condes', url_publicacion: 'https://www.sdorent.cl/propiedad/91', ...PERSONALES };
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
  assert.doesNotMatch(cal, /value="2026-10-17\|/); // sábado cerrado hasta que el equipo lo abra
  assert.doesNotMatch(cal, /value="2026-10-18\|/); // domingo no

  r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-18|9' }) });
  assert.strictEqual(r.status, 422); // domingo

  r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|9' }), redirect: 'manual' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'agendado');
  const aEquipo = ctx.correos.find((c) => /Nueva visita/.test(c.subject));
  assert.deepStrictEqual(aEquipo.to, ['julio.mendoza@sdorent.cl', 'barbara.diaz@sdorent.cl', 'sdopropiedades@sdorent.cl', 'csolisdeovando@sdocapital.cl', 'josecano@sdorent.cl']);
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

test('el máximo por archivo por defecto es 50 MB', () => {
  assert.strictEqual(cargarConfig({}).archivos.maxMB, 50);
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
  assert.match(cal, new RegExp(`class="nombre" href="/admin/lead/${lead.id}">Juan Pérez Soto</a>`));
  assert.doesNotMatch(cal, /✉️/, 'el correo no ocupa espacio en el calendario');
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

  // La dirección y el link del aviso son obligatorios
  let res = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, url_publicacion: '', propiedad: '' }, DOCS_DEP) });
  assert.strictEqual(res.status, 422);
  const errores = await res.text();
  assert.match(errores, /Ingresa la dirección de la propiedad que quieres arrendar/);
  assert.match(errores, /Pega el link del aviso/);
  assert.match(errores, /name="url_publicacion"[^>]*required/);

  // Con el link se identifica el portal
  res = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, url_publicacion: url, propiedad: 'Av. Providencia 2000' }, DOCS_DEP) });
  assert.strictEqual(res.status, 200);
  const lead = ctx.db.leadPorTelefono('56987654321');
  assert.strictEqual(lead.portal, 'Mercado Libre');
  assert.strictEqual(lead.propiedad, 'Av. Providencia 2000');
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
  assert.match(html, /Voy a complementar renta o tengo un aval/);
  assert.match(html, /name="comp_cedula"/);
  assert.match(html, /name="comp_carpeta_tributaria"/);

  const COMP = {
    complementa: '1', comp_tipo: 'independiente', comp_nombre: 'María Soto', comp_rut: '76.086.428-5', comp_relacion: 'Pareja',
    comp_doc_tipo: 'rut', comp_nacionalidad: 'Chilena', comp_fecha_nacimiento: '1988-02-20', comp_estado_civil: 'Casado/a',
    comp_profesion: 'Arquitecta', comp_direccion_actual: 'Los Leones 100', comp_comuna: 'Providencia', comp_telefono: '+56 9 2222 3333', comp_email: 'maria@example.com',
  };
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
  assert.match(ficha, /Complementa renta · María Soto \(Independiente o empresa\)/);
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
  assert.match(ev1, /SUMMARY:🏠 Rosario Sur 91\\, depto 504\\, Las Condes · Juan Pérez Soto · \+56987654321/);
  assert.match(ev1, /LOCATION:Rosario Sur 91\\, depto 504\\, Las Condes/);
  assert.match(ev1, /wa\.me\/56987654321/);
  assert.match(ev1, /google\.com\/maps/);
  assert.match(ev1, /Ficha y documentos: http/);
  assert.match(ev1, /TRIGGER:-PT60M/);
  const uid = ev1.match(/UID:(.*)/)[1];
  assert.doesNotMatch(ev1, /ATTENDEE.*juan@example\.com/, 'el interesado no va en el evento interno');

  // El correo de la visita le pide confirmar; el calendario la muestra sin confirmar
  const agendadaInteresado = ctx.correos.find((c) => c.to === 'juan@example.com' && /visita/i.test(c.subject) && /Confirmar asistencia/.test(c.html));
  assert.ok(agendadaInteresado, 'el correo de visita agendada trae el botón para confirmar');
  assert.match(await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text(), /⏳ Sin confirmar/);

  // Confirmar asistencia: GET solo muestra el botón; POST la marca en verde y actualiza el evento del equipo
  let r = await fetch(`${ctx.url}/visita/${lead.token}/confirmar`);
  assert.match(await r.text(), /Sí, confirmo mi asistencia/);
  assert.strictEqual(ctx.db.visitaVigente(lead.id).confirmada_at, null);
  r = await fetch(`${ctx.url}/visita/${lead.token}/confirmar`, { method: 'POST', redirect: 'manual' });
  assert.strictEqual(r.status, 303);
  assert.ok(ctx.db.visitaVigente(lead.id).confirmada_at);
  const conf = ctx.correos.find((c) => /CONFIRMADA por el interesado/.test(c.subject));
  const ev2 = conf.icalEvent.content.replace(/\r\n /g, '');
  assert.match(ev2, /SUMMARY:✅ 🏠 Rosario Sur 91/);
  assert.strictEqual(ev2.match(/UID:(.*)/)[1], uid, 'mismo evento');
  assert.match(await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text(), /<span class="res">✅ Confirmó<\/span>/);
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

test('sábados con el mismo equipo, bloqueos y reagendar desde el panel', async (t) => {
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
  assert.doesNotMatch(panel, /Xiomara/);

  // El interesado agenda viernes 17:00 -> le llega a Bárbara (sdopropiedades), Julio, José y Cristian
  const EQUIPO = ['julio.mendoza@sdorent.cl', 'barbara.diaz@sdorent.cl', 'sdopropiedades@sdorent.cl', 'csolisdeovando@sdocapital.cl', 'josecano@sdorent.cl'];
  await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|17' }) });
  let aviso = ctx.correos.find((c) => /Nueva visita/.test(c.subject));
  assert.deepStrictEqual([...aviso.to].sort(), [...EQUIPO].sort());

  // El equipo abre el sábado 17 y la reagenda a las 11 -> mismo equipo, mismo evento movido
  assert.strictEqual((await post('/admin/sabado', { fecha: '2026-10-17', hora: 'todas', accion: 'abrir', semana: '0' })).status, 303);
  const ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /Reagendar: elegir nueva fecha y hora/);
  assert.match(ficha, /value="2026-10-17\|11"/);
  const antes = ctx.correos.length;
  r = await post(`/admin/lead/${lead.id}/visita/agendar`, { bloque: '2026-10-17|11', avisar: '1' });
  assert.strictEqual(r.status, 303);
  assert.match(r.headers.get('location'), /ok=reagendada_aviso/);
  const nuevos = ctx.correos.slice(antes);
  const aEquipo = nuevos.find((c) => /REAGENDADA por el equipo/.test(c.subject));
  assert.deepStrictEqual([...aEquipo.to].sort(), [...EQUIPO].sort());
  assert.ok(!aEquipo.to.includes('xiomara@tricapitals.com'));
  assert.match(aEquipo.icalEvent.content, /DTSTART;TZID=America\/Santiago:20261017T110000/);
  assert.ok(!nuevos.some((c) => /Visita movida/.test(c.subject)), 'nadie sale del evento');
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

test('horarios cada 1 hora: lunes a viernes de 9 a 18; sábado cerrado salvo las horas que abre el equipo (hasta las 18), sin cruces', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const sabado = (datos) => fetch(`${ctx.url}/admin/sabado`, { method: 'POST', headers: h, body: new URLSearchParams({ fecha: '2026-10-17', semana: '0', ...datos }), redirect: 'manual' });
  const lead = ctx.db.crearLead({ telefono: '56911110000', nombre: 'Luis', email: 'l@example.com', estado: 'aprobado' });
  const agenda = async () => (await fetch(`${ctx.url}/agendar/${lead.token}`)).text();
  let cal = await agenda();
  for (let h = 9; h <= 18; h++) assert.match(cal, new RegExp(`value="2026-10-16\\|${h}"`), `viernes ${h}:00`);
  assert.doesNotMatch(cal, /value="2026-10-16\|19"/);
  assert.doesNotMatch(cal, /value="2026-10-17\|/, 'el sábado parte cerrado');
  let r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-17|10' }) });
  assert.strictEqual(r.status, 422);

  // En el calendario del panel se ve para abrirlo
  let panel = await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text();
  assert.match(panel, /🟢 Abrir sábado/);

  // El equipo abre solo las 16 y las 18
  assert.strictEqual((await sabado({ hora: '16', accion: 'abrir' })).status, 303);
  await sabado({ hora: '18', accion: 'abrir' });
  await sabado({ hora: '19', accion: 'abrir' }); // fuera del rango: no hace nada
  cal = await agenda();
  assert.match(cal, /value="2026-10-17\|16"/);
  assert.match(cal, /value="2026-10-17\|18"/);
  assert.doesNotMatch(cal, /value="2026-10-17\|(9|10|19)"/);
  // Abrir todo el sábado: de 9 a 18; cerrar las 18 la vuelve a quitar
  await sabado({ hora: 'todas', accion: 'abrir' });
  await sabado({ hora: '18', accion: 'cerrar' });
  cal = await agenda();
  for (let h = 9; h <= 17; h++) assert.match(cal, new RegExp(`value="2026-10-17\\|${h}"`), `sábado ${h}:00`);
  assert.doesNotMatch(cal, /value="2026-10-17\|18"/);
  panel = await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text();
  assert.match(panel, /Cerrar sábado/);
  r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-17|17' }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(ctx.db.visitaVigente(lead.id).hora, 17);
  // Un sábado que ya pasó no se puede abrir
  await fetch(`${ctx.url}/admin/sabado`, { method: 'POST', headers: h, body: new URLSearchParams({ fecha: '2026-10-10', hora: 'todas', accion: 'abrir' }), redirect: 'manual' });
  assert.deepStrictEqual(ctx.db.horasHabilitadas('2026-10-10'), []);
  ctx.db.cancelarVisitasDeLead(lead.id); // el resto de la prueba parte sin visita

  // Una hora ya tomada no se ofrece ni se puede reservar
  const otra = ctx.db.crearLead({ telefono: '56922220000', nombre: 'Rosa', email: 'r@example.com', estado: 'aprobado' });
  r = await fetch(`${ctx.url}/agendar/${otra.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|10' }) });
  assert.strictEqual(r.status, 200);
  assert.doesNotMatch(await (await fetch(`${ctx.url}/agendar/${lead.token}`)).text(), /value="2026-10-16\|10"/);
  r = await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|10' }) });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(ctx.db.visitaVigente(lead.id), undefined);
});

test('visitas de más de 1 hora bloquean las horas que se cruzan', async (t) => {
  const ctx = await preparar({ AGENDA_DURACION_MINUTOS: '90' });
  t.after(() => ctx.server.close());
  const a = ctx.db.crearLead({ telefono: '56911110000', nombre: 'Luis', email: 'l@example.com', estado: 'aprobado' });
  const b = ctx.db.crearLead({ telefono: '56922220000', nombre: 'Rosa', email: 'r@example.com', estado: 'aprobado' });
  await fetch(`${ctx.url}/agendar/${a.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|11' }) });
  const cal = await (await fetch(`${ctx.url}/agendar/${b.token}`)).text();
  for (const h of [10, 11, 12]) assert.doesNotMatch(cal, new RegExp(`value="2026-10-16\\|${h}"`), `${h}:00 se cruza`);
  assert.match(cal, /value="2026-10-16\|13"/);
  const r = await fetch(`${ctx.url}/agendar/${b.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|12' }) });
  assert.strictEqual(r.status, 409);
});

test('aprobar/rechazar: botón para volver al panel y no se notifica dos veces', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(DATOS, DOCS_DEP) });
  const lead = ctx.db.leadPorTelefono('56987654321');
  const firma = ctx.correos[0].html.match(/aprobar\?firma=([^"]+)"/)[1];
  const url = (a) => `${ctx.url}/revision/${lead.id}/${a}?firma=${firma}`;

  // Rechazar dos veces con el mismo motivo (volver atrás y reenviar) -> un solo aviso
  const motivo = { motivo: 'Falta la liquidación de agosto', reenviar: '1' };
  let r = await fetch(url('rechazar'), { method: 'POST', body: new URLSearchParams(motivo), redirect: 'manual' });
  assert.strictEqual(r.status, 303, 'redirige a la página de resultado');
  let html = await (await fetch(ctx.url + r.headers.get('location'))).text();
  assert.match(html, /Respuesta enviada/);
  assert.match(html, /href="\/admin">Volver al panel/);
  assert.match(html, new RegExp(`href="/admin/lead/${lead.id}"`));
  const avisos = () => ctx.correos.filter((c) => c.to === 'juan@example.com' && /Sobre tu postulación/.test(c.subject)).length;
  assert.strictEqual(avisos(), 1);
  r = await fetch(url('rechazar'), { method: 'POST', body: new URLSearchParams(motivo), redirect: 'manual' });
  assert.match(r.headers.get('location'), /r=ya_rechazada/);
  assert.strictEqual(avisos(), 1, 'no se repite el aviso');

  // Aprobar dos veces -> un solo calendario enviado; volver a abrir el link no muestra el botón
  ctx.db.actualizarLead(lead.id, { estado: 'documentos_recibidos' });
  await fetch(url('aprobar'), { method: 'POST' });
  await fetch(url('aprobar'), { method: 'POST' });
  const agendas = ctx.correos.filter((c) => c.to === 'juan@example.com' && /Agenda tu visita/.test(c.subject)).length;
  assert.strictEqual(agendas, 1);
  html = await (await fetch(url('aprobar'))).text();
  assert.match(html, /Ya estaba aprobada/);
  assert.doesNotMatch(html, /Aprobar y enviar calendario<\/button>/);
  html = await (await fetch(url('rechazar'))).text();
  assert.match(html, /No se puede rechazar/);
});

test('datos personales completos: pasaporte, mayoría de edad, aval y ficha', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}` };
  const form = await (await fetch(`${ctx.url}/postular`)).text();
  for (const campo of ['nacionalidad', 'fecha_nacimiento', 'estado_civil', 'profesion', 'direccion_actual', 'comuna', 'comp_nacionalidad', 'comp_profesion']) {
    assert.match(form, new RegExp(`name="${campo}"`), campo);
  }
  assert.match(form, /Es aval/);

  // Faltan datos -> errores claros
  let r = await fetch(`${ctx.url}/postular`, {
    method: 'POST',
    body: formulario({ ...DATOS, nacionalidad: '', estado_civil: '', fecha_nacimiento: '2015-01-01' }, DOCS_DEP),
  });
  assert.strictEqual(r.status, 422);
  const err = await r.text();
  assert.match(err, /Indica la nacionalidad/);
  assert.match(err, /Selecciona el estado civil/);
  assert.match(err, /debe ser mayor de edad/);

  // Extranjero con pasaporte + aval
  const AVAL = {
    complementa: '1', comp_rol: 'aval', comp_relacion: 'Madre', comp_tipo: 'dependiente', comp_nombre: 'Rosa Díaz', comp_rut: '11.111.111-1', comp_doc_tipo: 'rut',
    comp_nacionalidad: 'Chilena', comp_fecha_nacimiento: '1965-07-01', comp_estado_civil: 'Viudo/a', comp_profesion: 'Profesora',
    comp_direccion_actual: 'Irarrázaval 2000', comp_comuna: 'Ñuñoa', comp_telefono: '+56 9 4444 5555', comp_email: 'rosa@example.com',
  };
  const DOCS_AVAL = [['comp_cedula', 'c.pdf'], ['comp_liquidaciones', 'l.pdf'], ['comp_afp', 'a.pdf'], ['comp_dicom', 'd.pdf']];
  r = await fetch(`${ctx.url}/postular`, {
    method: 'POST',
    body: formulario({ ...DATOS, doc_tipo: 'pasaporte', rut: 'ab1234567', nacionalidad: 'Venezolana', estado_civil: 'Casado/a', ...AVAL }, [...DOCS_DEP, ...DOCS_AVAL]),
  });
  assert.strictEqual(r.status, 200);
  const lead = ctx.db.leadPorTelefono('56987654321');
  assert.strictEqual(lead.doc_tipo, 'pasaporte');
  assert.strictEqual(lead.rut, 'AB1234567');
  assert.strictEqual(lead.nacionalidad, 'Venezolana');
  assert.strictEqual(lead.comuna, 'Providencia');
  assert.strictEqual(lead.comp_rol, 'aval');
  assert.strictEqual(lead.comp_comuna, 'Ñuñoa');

  const ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /Pasaporte AB1234567/);
  assert.match(ficha, /Venezolana/);
  assert.match(ficha, /10-05-1990 \(\d+ años\)/);
  assert.match(ficha, /Casado\/a/);
  assert.match(ficha, /Ingeniero comercial/);
  assert.match(ficha, /Av\. Providencia 1234, depto 51, Providencia/);
  assert.match(ficha, /👥 Aval/);
  assert.match(ficha, /RUT 11\.111\.111-1/);
  assert.match(ficha, /Irarrázaval 2000, Ñuñoa/);
  assert.match(ficha, /Profesora/);

  const correo = ctx.correos.find((c) => [].concat(c.to).includes('sdopropiedades@sdorent.cl'));
  assert.match(correo.html, /Fecha de nacimiento/);
  assert.match(correo.html, /👥 Aval/);
  assert.match(correo.html, /rosa@example\.com/);

  const csv = Buffer.from(await (await fetch(`${ctx.url}/admin/exportar.csv`, { headers: h })).arrayBuffer()).toString('utf8');
  assert.match(csv, /Nacionalidad;Fecha nacimiento;Estado civil;Profesión;Dirección actual;Comuna/);
  assert.match(csv, /Venezolana;1990-05-10;Casado\/a;Ingeniero comercial/);
});

test('formulario completo como lo envía el navegador (todos los campos, con aval) se acepta', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const html = await (await fetch(`${ctx.url}/postular`)).text();
  // Todos los campos de texto del formulario real, vacíos salvo los que llenamos
  const nombres = [...new Set([...html.matchAll(/<(?:input|select|textarea)[^>]*name="([^"]+)"/g)].map((m) => m[1]))];
  const textos = nombres.filter((n) => !/^(comp_)?(cedula|liquidaciones|afp|dicom|carnet_representante|carpeta_tributaria|declaraciones_renta|dicom_empresa)$/.test(n));
  assert.ok(textos.length > 30, `el formulario tiene ${textos.length} campos de texto`);
  const datos = Object.fromEntries(textos.map((n) => [n, '']));
  Object.assign(datos, DATOS, {
    complementa: '1', comp_rol: 'aval', comp_relacion: 'Madre', comp_tipo: 'dependiente', comp_nombre: 'Rosa Díaz', comp_rut: '76.086.428-5', comp_doc_tipo: 'rut',
    comp_nacionalidad: 'Chilena', comp_fecha_nacimiento: '1965-07-01', comp_estado_civil: 'Viudo/a', comp_profesion: 'Profesora',
    comp_direccion_actual: 'Irarrázaval 2000', comp_comuna: 'Ñuñoa', comp_telefono: '+56 9 4444 5555', comp_email: 'rosa@example.com',
  });
  const DOCS_AVAL = [['comp_cedula', 'c.pdf'], ['comp_liquidaciones', 'l.pdf'], ['comp_afp', 'a.pdf'], ['comp_dicom', 'd.pdf']];
  const r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(datos, [...DOCS_DEP, ...DOCS_AVAL]) });
  const cuerpo = await r.text();
  assert.strictEqual(r.status, 200, cuerpo.match(/<ul>.*?<\/ul>/s)?.[0]);
  assert.match(cuerpo, /Postulación enviada/);
});

test('fecha de cambio: se pide, se guarda y se ve en ficha, panel, correo y Excel', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}` };
  const form = await (await fetch(`${ctx.url}/postular`)).text();
  assert.match(form, /¿Para cuándo te quieres cambiar\?/);
  for (const v of ['5_dias', '15_dias', '1_mes', 'mas_1_mes']) assert.match(form, new RegExp(`name="plazo_cambio" value="${v}"`));

  let r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, plazo_cambio: '' }, DOCS_DEP) });
  assert.strictEqual(r.status, 422);
  assert.match(await r.text(), /Indica para cuándo te quieres cambiar/);

  r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, plazo_cambio: '5_dias' }, DOCS_DEP) });
  assert.strictEqual(r.status, 200);
  const lead = ctx.db.leadPorTelefono('56987654321');
  assert.strictEqual(lead.plazo_cambio, '5_dias');

  assert.match(await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text(), /Fecha de cambio<\/th><td>Dentro de los próximos 5 días/);
  assert.match(await (await fetch(`${ctx.url}/admin`, { headers: h })).text(), /🚚 5 días/);
  const correo = ctx.correos.find((c) => /Fecha de cambio/.test(c.html || ""));
  assert.ok(correo, 'el correo de documentos muestra la fecha de cambio');
  const csv = await (await fetch(`${ctx.url}/admin/exportar.csv`, { headers: h })).text();
  assert.match(csv, /Fecha de cambio/);
  assert.match(csv, /Dentro de los próximos 5 días/);
});

test('visita ingresada a mano desde el panel (agendada por otro medio)', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const post = (datos) => fetch(`${ctx.url}/admin/visita/nueva`, { method: 'POST', headers: h, body: new URLSearchParams(datos), redirect: 'manual' });

  // El calendario tiene el botón y el formulario viene con la fecha y hora elegidas
  let cal = await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text();
  assert.match(cal, /Ingresar visita/);
  assert.match(cal, /href="\/admin\/visita\/nueva\?fecha=2026-10-16&amp;hora=11"/);
  const form = await (await fetch(`${ctx.url}/admin/visita/nueva?fecha=2026-10-16&hora=11`, { headers: h })).text();
  assert.match(form, /value="2026-10-16"/);
  assert.match(form, /<option value="11" selected>/);

  // Faltan datos
  let r = await post({ fecha: '2026-10-16', hora: '11', nombre: '', telefono: '12' });
  assert.strictEqual(r.status, 422);
  assert.match(await r.text(), /Ingresa el nombre/);

  // Visita nueva por teléfono: crea la ficha, avisa al equipo con evento de calendario y al interesado
  r = await post({ fecha: '2026-10-16', hora: '11', nombre: 'Pedro Soto', telefono: '+56 9 1111 2222', email: 'pedro@example.com', origen: 'Llamada telefónica', propiedad: 'Rosario Sur 91', notas: 'Viene con su pareja', avisar: '1' });
  assert.strictEqual(r.status, 303);
  assert.match(r.headers.get('location'), /\/admin\/calendario\?semana=0&ok=manual&lead=\d+/);
  const lead = ctx.db.leadPorTelefono('56911112222');
  assert.strictEqual(lead.estado, 'agendado');
  assert.strictEqual(lead.portal, 'Llamada telefónica');
  assert.strictEqual(lead.comentarios, 'Viene con su pareja');
  const visita = ctx.db.visitaVigente(lead.id);
  assert.deepStrictEqual([visita.fecha, visita.hora, visita.origen], ['2026-10-16', 11, 'equipo']);
  const equipo = ctx.correos.find((c) => /Nueva visita por el equipo/.test(c.subject));
  assert.ok(equipo.to.includes('julio.mendoza@sdorent.cl'));
  assert.match(equipo.icalEvent.content, /Pedro Soto/);
  assert.ok(ctx.correos.some((c) => c.to === 'pedro@example.com'), 'confirmación al interesado');
  cal = await (await fetch(`${ctx.url}${r.headers.get('location')}`, { headers: h })).text();
  assert.match(cal, /Visita de <strong>Pedro Soto<\/strong> ingresada/);
  assert.match(cal, /Ingresada a mano \(Llamada telefónica\)/);

  // El horario queda ocupado para quienes agendan por el link
  const otro = ctx.db.crearLead({ telefono: '56933334444', nombre: 'Ana', email: 'ana@example.com', estado: 'aprobado' });
  assert.doesNotMatch(await (await fetch(`${ctx.url}/agendar/${otro.token}`)).text(), /value="2026-10-16\|11"/);

  // Mismo horario ocupado: nunca se cruza, ni aunque se insista
  const datosAna = { fecha: '2026-10-16', hora: '11', nombre: 'Ana', telefono: '+56 9 3333 4444' };
  r = await post(datosAna);
  assert.strictEqual(r.status, 409);
  const choque = await r.text();
  assert.match(choque, /se cruza con la visita de <a href="\/admin\/lead\/\d+"><strong>Pedro Soto<\/strong><\/a> a las 11:00/);
  assert.doesNotMatch(choque, /name="forzar"/);
  assert.strictEqual((await post({ ...datosAna, forzar: '1' })).status, 409);
  assert.strictEqual(ctx.db.visitaVigente(otro.id), undefined);
  // Un horario bloqueado sí se puede usar si se confirma
  ctx.db.bloquear('2026-10-16', 12, 'Reunión');
  r = await post({ ...datosAna, hora: '12' });
  assert.strictEqual(r.status, 409);
  assert.match(await r.text(), /name="forzar"/);
  r = await post({ ...datosAna, hora: '12', forzar: '1' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(ctx.db.visitaVigente(otro.id).hora, 12);
  assert.strictEqual(ctx.db.leadPorTelefono('56933334444').id, otro.id, 'usa la ficha existente, no duplica');

  // Hora fuera del horario normal (10:00) también se puede y aparece en el calendario
  const antes = ctx.correos.length;
  r = await post({ fecha: '2026-10-16', hora: '10', nombre: 'Pedro Soto', telefono: '+56 9 1111 2222' });
  assert.strictEqual(r.status, 409, 'ya tenía visita: pide confirmar el cambio');
  assert.match(await r.text(), /se <strong>reagenda<\/strong>/);
  r = await post({ fecha: '2026-10-16', hora: '10', nombre: 'Pedro Soto', telefono: '+56 9 1111 2222', confirmo_existente: '1' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(ctx.db.visitaVigente(lead.id).hora, 10);
  assert.ok(ctx.correos.slice(antes).some((c) => /REAGENDADA/.test(c.subject)));
  cal = await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text();
  assert.match(cal, /<th class="hora">10:00<\/th>/);

  // Visita pasada: queda como registro, sin avisos
  const n = ctx.correos.length;
  r = await post({ fecha: '2026-10-13', hora: '9', nombre: 'Luis', telefono: '+56 9 5555 6666' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(ctx.correos.length, n);
});

test('dirección de la propiedad: no se confunde con la del interesado y se corrige desde la ficha', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };

  // Puso su propia dirección como la de la propiedad -> se le explica
  let r = await fetch(`${ctx.url}/postular`, {
    method: 'POST',
    body: formulario({ ...DATOS, direccion_actual: 'La Tapera 2762', propiedad: 'la tapera 2762, Maipú' }, DOCS_DEP),
  });
  assert.strictEqual(r.status, 422);
  assert.match(await r.text(), /no tu dirección actual/);

  // Visita agendada con la dirección equivocada; el equipo la corrige y el evento se actualiza
  const lead = ctx.db.crearLead({ telefono: '56926131418', nombre: 'Chris Vivanco', email: 'chris@example.com', propiedad: 'La Tapera 2762', direccion_actual: 'La Tapera 2762', estado: 'agendado' });
  const visita = ctx.db.crearVisita(lead.id, '2026-10-16', 17);
  const ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /Corregir la dirección de la propiedad a visitar/);
  assert.match(ficha, /Es igual a su dirección actual/);
  assert.match(ficha, /Link de publicación<\/th><td class="nota">No lo indicó/);
  const antes = ctx.correos.length;
  r = await fetch(`${ctx.url}/admin/lead/${lead.id}/propiedad`, {
    method: 'POST', headers: h, redirect: 'manual', body: new URLSearchParams({ propiedad: 'Rosario Sur 91, depto 504, Las Condes', avisar: '1' }),
  });
  assert.strictEqual(r.status, 303);
  assert.match(r.headers.get('location'), /ok=propiedad_evento/);
  assert.strictEqual(ctx.db.leadPorId(lead.id).propiedad, 'Rosario Sur 91, depto 504, Las Condes');
  const nuevos = ctx.correos.slice(antes);
  const equipo = nuevos.find((c) => /Dirección corregida/.test(c.subject));
  assert.ok(equipo.to.includes('julio.mendoza@sdorent.cl'));
  const ics = equipo.icalEvent.content.replace(/\r\n /g, '');
  assert.match(ics, new RegExp(`UID:visita-interesado-${lead.id}@sdorent.cl`), 'mismo evento: se reemplaza');
  assert.match(ics, /SUMMARY:🏠 Rosario Sur 91\\, depto 504\\, Las Condes · Chris Vivanco · \+56926131418/);
  assert.match(ics, /LOCATION:Rosario Sur 91/);
  assert.match(ics, /Vive en \(dirección actual del interesado\): La Tapera 2762/);
  assert.ok(nuevos.some((c) => c.to === 'chris@example.com'), 'el interesado recibe su evento corregido');
  const cal = await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text();
  assert.match(cal, /🏠 Rosario Sur 91/);
  assert.ok(visita);
});

test('link pegado en la dirección: se corrige en las fichas existentes y se rechaza en el formulario', async (t) => {
  // Fichas guardadas antes: el link pasa a "Link de publicación" y la dirección queda legible
  const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdo-mig-')), 'c.db');
  const ML = 'https://departamento.mercadolibre.cl/MLC-4545912406-edificio-cicarelli-ll-1d1b-piso-14-185176-_JM';
  const YAPO = 'https://www.yapo.cl/bienes-raices-alquiler-apartamentos/edificio-torre-mayor-2d1b-piso-20/33089831';
  let db = abrirDB(archivo);
  const a = db.crearLead({ telefono: '56996704082', nombre: 'Nicolas Millares', propiedad: ML });
  const b = db.crearLead({ telefono: '56995818737', nombre: 'Marcelo Rivera', propiedad: YAPO, url_publicacion: YAPO });
  const c = db.crearLead({ telefono: '56911110000', nombre: 'Otra', propiedad: 'Rosario Sur 91' });
  db = abrirDB(archivo);
  const la = db.leadPorId(a.id);
  assert.strictEqual(la.url_publicacion, ML);
  assert.strictEqual(la.propiedad, 'Edificio cicarelli ll 1d1b piso 14 · Mercado Libre (falta dirección)');
  assert.strictEqual(db.leadPorId(b.id).propiedad, 'Edificio torre mayor 2d1b piso 20 · Yapo (falta dirección)');
  assert.strictEqual(db.leadPorId(c.id).propiedad, 'Rosario Sur 91', 'una dirección normal no se toca');

  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };

  // En el formulario: el link se mueve a su campo y se pide la dirección
  const r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, url_publicacion: '', propiedad: ML }, DOCS_DEP) });
  assert.strictEqual(r.status, 422);
  const html = await r.text();
  assert.match(html, /escribe la dirección \(calle, número y comuna\)/);
  assert.match(html, new RegExp(`name="url_publicacion"[^>]*value="${ML.replace(/[.?]/g, '\\$&')}"`));

  // En el calendario y la ficha se ve la advertencia, nunca el link
  const lead = ctx.db.crearLead({ telefono: '56996704082', nombre: 'Nicolas', propiedad: 'Edificio cicarelli · Mercado Libre (falta dirección)', url_publicacion: ML, estado: 'agendado' });
  ctx.db.crearVisita(lead.id, '2026-10-16', 17);
  const cal = await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text();
  assert.match(cal, /🔗 Ver aviso · Edificio cicarelli/); // el link se abre con un toque, sin mostrarse como texto
  assert.doesNotMatch(cal, />[^<]*mercadolibre\.cl/);
  const ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /Falta la dirección exacta/);
  assert.match(ficha, /<details class="editar-propiedad" open>/);
  // Corregir con un link tampoco se acepta
  const rr = await fetch(`${ctx.url}/admin/lead/${lead.id}/propiedad`, { method: 'POST', headers: h, redirect: 'manual', body: new URLSearchParams({ propiedad: ML }) });
  assert.match(rr.headers.get('location'), /ok=propiedad_link/);
});

test('revisión automática: liquidaciones 2,5 veces el arriendo y certificado AFP Uno', async (t) => {
  const liq = (periodo, monto) => ({ periodo, nombre_trabajador: 'Juan Pérez Soto', rut_trabajador: '11.111.111-1', empleador: 'Empresa SpA', liquido_a_pagar: monto, legible: true });
  const leidos = [];
  const lector = {
    activo: true,
    async leerLiquidaciones(docs) {
      leidos.push(['liq', docs.length]);
      return { ok: true, datos: { liquidaciones: [liq('2026-09', 820000), liq('2026-08', 800000), liq('2026-07', 780000)], observaciones: '' } };
    },
    async leerCertificadoAfp(docs) {
      leidos.push(['afp', docs.length]);
      return { ok: true, datos: { es_certificado_afp: true, afp: 'Uno', rut_afiliado: '11.111.111-1', nombre_afiliado: 'Juan', folio: 'ABC-123', fecha_emision: '2026-10-10', ultimo_periodo_cotizado: '2026-09', empleador_actual: 'Empresa SpA', observaciones: '' } };
    },
  };
  const consultas = [];
  const fetchAfp = async (url, opts) => {
    consultas.push({ url, body: JSON.parse(opts.body) });
    return { status: 200, json: async () => ({ codigo: '0', data: { bytes: Buffer.from('%PDF-1.4 prueba').toString('base64') } }) };
  };
  const ctx = await preparar({ REVISION_AUTOMATICA: 'true' }, { lector, fetchAfp });
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };

  const r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(DATOS, DOCS_DEP) });
  assert.strictEqual(r.status, 200);
  await ctx.app.locals.esperarTareas();
  const lead = ctx.db.leadPorTelefono('56987654321');
  assert.deepStrictEqual(leidos.sort(), [['afp', 1], ['liq', 3]]);
  assert.strictEqual(ctx.db.revisionDe(lead.id).estado, 'listo');
  assert.deepStrictEqual(consultas[0], { url: 'https://www.uno.cl/api/afiliado-certificado/validar', body: { payload: { idPersona: '111111111', FolioCertificado: 'ABC-123' } } });

  let ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /Revisión automática/);
  assert.match(ficha, /Falta el valor del arriendo/);
  assert.match(ficha, /✅ Válido en AFP Uno/);
  assert.match(ficha, /idéntico al original de la AFP/);

  // Arriendo $300.000 -> requiere $750.000 líquidos: los 3 meses cumplen
  const post = (ruta, datos) => fetch(ctx.url + ruta, { method: 'POST', headers: h, redirect: 'manual', body: new URLSearchParams(datos) });
  assert.match((await post(`/admin/lead/${lead.id}/arriendo`, { valor_arriendo: '$300.000' })).headers.get('location'), /ok=arriendo/);
  ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /Renta líquida requerida: <strong>\$750\.000<\/strong>/);
  assert.match(ficha, /✅ Cumple 2,5 veces el arriendo en las 3 liquidaciones/);
  assert.match(await (await fetch(`${ctx.url}/admin`, { headers: h })).text(), /💰 Cumple/);

  // Arriendo $320.000 -> requiere $800.000: julio ($780.000) no alcanza
  await post(`/admin/lead/${lead.id}/arriendo`, { valor_arriendo: '320000' });
  ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /❌ No cumple 2,5 veces el arriendo/);
  assert.match(ficha, /❌ faltan \$20\.000/);
  assert.match(await (await fetch(`${ctx.url}/admin`, { headers: h })).text(), /💰 No cumple/);
});

test('revisión automática: sin clave queda manual; AFP con captcha deja el link; complemento suma', async (t) => {
  const { evaluarRenta } = require('../src/evaluacionRenta');
  const { validarCertificado } = require('../src/validacionAfp');
  const ctx = await preparar({ REVISION_AUTOMATICA: 'true' });
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}` };
  await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(DATOS, DOCS_DEP) });
  await ctx.app.locals.esperarTareas();
  const lead = ctx.db.leadPorTelefono('56987654321');
  assert.match(await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text(), /falta la clave ANTHROPIC_API_KEY/);

  // Capital usa captcha: no se consulta, se deja el validador
  let llamado = false;
  const v = await validarCertificado({ afp: 'Capital', rut: '11.111.111-1', folio: 'X' }, { fetchFn: async () => { llamado = true; } });
  assert.strictEqual(v.estado, 'manual');
  assert.strictEqual(llamado, false);
  assert.match(v.validador, /afpcapital\.cl/);
  // Provida de sucursal: por teléfono
  assert.match((await validarCertificado({ afp: 'Provida', folio: '1234567890123456' })).detalle, /600 201 0150/);
  // AFP que no responde: no se marca como falso
  assert.strictEqual((await validarCertificado({ afp: 'Habitat', folio: '99' }, { fetchFn: async () => { throw new Error('caída'); } })).estado, 'no_verificado');

  // Complemento de renta: se suma el líquido del mismo mes
  const l = (periodo, monto, rut = '11.111.111-1') => ({ periodo, liquido_a_pagar: monto, rut_trabajador: rut, legible: true });
  const r = evaluarRenta({
    valorArriendo: 400000,
    titular: { rut: '11.111.111-1', liquidaciones: [l('2026-09', 600000), l('2026-08', 600000), l('2026-07', 600000)] },
    comp: { rut: '22.222.222-2', liquidaciones: [l('2026-09', 450000, '22.222.222-2'), l('2026-08', 450000, '22.222.222-2'), l('2026-07', 350000, '22.222.222-2')] },
    hoy: new Date('2026-10-15T12:00:00'),
  });
  assert.strictEqual(r.requerido, 1000000);
  assert.deepStrictEqual(r.meses.map((m) => [m.total, m.cumple]), [[1050000, true], [1050000, true], [950000, false]]);
  assert.strictEqual(r.cumple, false);
  // Menos de 3 liquidaciones y RUT distinto quedan como alerta
  const r2 = evaluarRenta({ valorArriendo: 100000, titular: { rut: '11.111.111-1', liquidaciones: [l('2026-09', 900000, '9.999.999-9')] }, hoy: new Date('2026-10-15T12:00:00') });
  assert.strictEqual(r2.cumple, false);
  assert.ok(r2.alertas.some((a) => /1 de 3/.test(a)));
  assert.ok(r2.alertas.some((a) => /RUT distinto/.test(a)));
});

test('lector: arma la consulta a Claude con PDF e imágenes y salida en JSON', async () => {
  const { crearLector, MODELO } = require('../src/lectura');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdo-lector-'));
  fs.writeFileSync(path.join(dir, 'a.pdf'), '%PDF-1.4 x');
  fs.writeFileSync(path.join(dir, 'b.jpg'), 'jpg');
  fs.writeFileSync(path.join(dir, 'c.heic'), 'heic');
  let pedido = null;
  const cliente = { beta: { messages: { create: async (p) => { pedido = p; return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"liquidaciones":[],"observaciones":""}' }] }; } } } };
  const lector = crearLector({ cliente });
  const r = await lector.leerLiquidaciones([
    { ruta: path.join(dir, 'a.pdf'), mime: 'application/pdf', nombre_original: 'a.pdf' },
    { ruta: path.join(dir, 'b.jpg'), mime: 'image/jpeg', nombre_original: 'b.jpg' },
    { ruta: path.join(dir, 'c.heic'), mime: 'image/heic', nombre_original: 'c.heic' },
  ]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.omitidos, ['c.heic']);
  assert.strictEqual(pedido.model, MODELO);
  assert.strictEqual(pedido.output_config.format.type, 'json_schema');
  assert.deepStrictEqual(pedido.messages[0].content.map((b) => b.type), ['document', 'image', 'text']);
  assert.strictEqual(crearLector({}).activo, false);
});

test('esperando agenda: el equipo le recuerda agendar (uno o todos, sin repetir en 24 horas)', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const post = (ruta) => fetch(ctx.url + ruta, { method: 'POST', headers: h, redirect: 'manual' });
  const ana = ctx.db.crearLead({ telefono: '56900000001', nombre: 'Ana Muñoz', email: 'ana@example.com', estado: 'aprobado' });
  ctx.db.crearLead({ telefono: '56900000002', nombre: 'Luis Rojas', email: 'luis@example.com', estado: 'aprobado' });

  let panel = await (await fetch(`${ctx.url}/admin`, { headers: h })).text();
  assert.match(panel, /Esperando agenda<\/h1>/);
  assert.match(panel, /Recordar a todos que agenden/);
  let ficha = await (await fetch(`${ctx.url}/admin/lead/${ana.id}`, { headers: h })).text();
  assert.match(ficha, /Recordarle que agende/);

  let r = await post(`/admin/lead/${ana.id}/recordar-agenda`);
  assert.match(r.headers.get('location'), /ok=recordado/);
  const correo = ctx.correos.find((c) => c.to === 'ana@example.com');
  assert.match(correo.subject, /Recordatorio: aún puedes agendar tu visita/);
  assert.match(correo.html, new RegExp(`/agendar/${ana.token}`));
  assert.strictEqual(ctx.db.leadPorId(ana.id).avisos_agenda, 1);

  // A todos: Ana ya fue recordada hoy, solo se le envía a Luis
  r = await post('/admin/recordar-agenda');
  assert.match(r.headers.get('location'), /recordados=1/);
  assert.strictEqual(ctx.correos.filter((c) => /Recordatorio: aún puedes agendar/.test(c.subject)).length, 2);
  panel = await (await fetch(`${ctx.url}${r.headers.get('location')}`, { headers: h })).text();
  assert.match(panel, /Se envió el recordatorio para agendar a 1 interesado/);
  assert.match((await post('/admin/recordar-agenda')).headers.get('location'), /recordados=0/);
});

test('el interesado puede reprogramar o cancelar la visita que le agendó el equipo', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const lead = ctx.db.crearLead({ telefono: '56987654321', nombre: 'Ana Rojas', email: 'ana@example.com', propiedad: 'Rosario Sur 91', estado: 'aprobado' });
  await fetch(`${ctx.url}/admin/lead/${lead.id}/visita/agendar`, { method: 'POST', headers: h, redirect: 'manual', body: new URLSearchParams({ bloque: '2026-10-16|11', avisar: '1' }) });
  const aviso = ctx.correos.find((c) => c.to === 'ana@example.com');
  assert.match(aviso.html, new RegExp(`/agendar/${lead.token}`), 'link para cambiar horario');
  assert.match(aviso.html, new RegExp(`/visita/${lead.token}/cancelar`), 'link para cancelar');

  let pagina = await (await fetch(`${ctx.url}/visita/${lead.token}/cancelar`)).text();
  assert.match(pagina, /¿Cancelar tu visita\?/);
  assert.match(pagina, /Prefiero cambiar el horario/);
  const antes = ctx.correos.length;
  const r = await fetch(`${ctx.url}/visita/${lead.token}/cancelar`, { method: 'POST', body: new URLSearchParams({ motivo: 'Encontré otra propiedad' }) });
  assert.match(await r.text(), /cancelamos tu visita y avisamos al equipo/);
  const visita = ctx.db.ultimaVisita(lead.id);
  assert.deepStrictEqual([visita.estado, visita.cancelada_por, visita.motivo_cancelacion], ['cancelada', 'interesado', 'Encontré otra propiedad']);
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'aprobado');
  const nuevos = ctx.correos.slice(antes);
  const equipo = nuevos.find((c) => /Visita CANCELADA/.test(c.subject));
  assert.ok(equipo.to.includes('julio.mendoza@sdorent.cl'));
  assert.match(equipo.html, /El interesado canceló la visita: “Encontré otra propiedad”/);
  assert.strictEqual(equipo.icalEvent.method, 'CANCEL');
  assert.ok(nuevos.some((c) => c.to === 'ana@example.com' && /Cancelaste tu visita/.test(c.subject)));
  // El horario queda libre y el interesado puede volver a agendar
  assert.match(await (await fetch(`${ctx.url}/agendar/${lead.token}`)).text(), /value="2026-10-16\|11"/);
  const ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /cancelada por el interesado/);
  assert.match(ficha, /Motivo: “Encontré otra propiedad”/);
  // Sin visita vigente, el link lleva a elegir horario
  assert.match(await (await fetch(`${ctx.url}/visita/${lead.token}/cancelar`)).text(), /No tienes una visita agendada/);
});

test('post-visita: al terminar se pide el resultado al equipo y se avisa al interesado', async (t) => {
  let ahora = new Date('2026-10-15T13:00:00Z'); // jueves 10:00 Chile
  const ctx = await preparar({}, { ahoraFn: () => ahora });
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const lead = ctx.db.crearLead({ telefono: '56987654321', nombre: 'Ana Rojas', email: 'ana@example.com', propiedad: 'Rosario Sur 91', estado: 'agendado' });
  const visita = ctx.db.crearVisita(lead.id, '2026-10-15', 9);

  // 10:00: la visita de las 9 aún no termina (+30 min de margen)
  assert.strictEqual(await ctx.app.locals.pedirResultados(), 0);
  ahora = new Date('2026-10-15T13:45:00Z'); // 10:45
  assert.strictEqual(await ctx.app.locals.pedirResultados(), 1);
  assert.strictEqual(await ctx.app.locals.pedirResultados(), 0, 'se pide una sola vez');
  const pedido = ctx.correos.find((c) => /¿Cómo fue la visita\?/.test(c.subject));
  assert.deepStrictEqual(pedido.to, ['julio.mendoza@sdorent.cl'], 'solo a quien hizo la visita');
  const links = [...pedido.html.matchAll(/href="([^"]*\/resultado\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.strictEqual(links.length, 3);

  let panel = await (await fetch(`${ctx.url}/admin`, { headers: h })).text();
  assert.match(panel, /Visitas por registrar resultado/);

  // Link sin firma válida
  assert.strictEqual((await fetch(`${ctx.url}/resultado/${visita.id}?r=realizada&firma=mala`)).status, 403);
  // Un toque en "Visitó y continúa": abre la página con la opción marcada (no guarda solo con abrir el correo)
  const url = new URL(links[0]);
  const pagina = await (await fetch(`${ctx.url}${url.pathname}${url.search}`)).text();
  assert.match(pagina, /value="realizada" checked/);
  assert.strictEqual(ctx.db.visitaPorId(visita.id).resultado, null);
  const r = await fetch(`${ctx.url}${url.pathname}`, { method: 'POST', body: new URLSearchParams({ firma: url.searchParams.get('firma'), resultado: 'realizada', notas: 'Le gustó', avisar: '1' }) });
  assert.match(await r.text(), /Resultado guardado/);
  assert.deepStrictEqual([ctx.db.visitaPorId(visita.id).resultado, ctx.db.visitaPorId(visita.id).notas], ['realizada', 'Le gustó']);
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'visitado');
  assert.ok(ctx.correos.some((c) => c.to === 'ana@example.com' && /Gracias por visitar/.test(c.subject)));
  // El resto del equipo recibe la respuesta de Julio, lista para Breal
  const respuesta = ctx.correos.find((c) => /^✅ Visitó y continúa: Ana Rojas/.test(c.subject));
  assert.ok(respuesta.to.includes('barbara.diaz@sdorent.cl'));
  assert.ok(!respuesta.to.includes('julio.mendoza@sdorent.cl'));
  assert.match(respuesta.html, /Para registrar en Breal/);
  assert.match(respuesta.html, /Cumple requerimiento/);
  assert.match(respuesta.html, /Le gustó/);
  panel = await (await fetch(`${ctx.url}/admin`, { headers: h })).text();
  assert.doesNotMatch(panel, /Visitas por registrar resultado/);

  // Desde el panel: "No asistió" con aviso manda el link para reagendar
  const otro = ctx.db.crearLead({ telefono: '56911110000', nombre: 'Luis', email: 'luis@example.com', estado: 'agendado' });
  ctx.db.crearVisita(otro.id, '2026-10-14', 15);
  const antesPanel = ctx.correos.length;
  await fetch(`${ctx.url}/admin/lead/${otro.id}/visita`, { method: 'POST', headers: h, redirect: 'manual', body: new URLSearchParams({ resultado: 'no_asistio', avisar: '1' }) });
  assert.ok(!ctx.correos.slice(antesPanel).some((c) => /No asistió:/.test(c.subject)), 'desde el panel no se reenvía al equipo');
  const seguimiento = ctx.correos.find((c) => c.to === 'luis@example.com');
  assert.match(seguimiento.subject, /No pudimos verte/);
  assert.match(seguimiento.html, new RegExp(`/agendar/${otro.token}`));
});

test('revisión automática en pausa: no lee documentos ni muestra la sección', async (t) => {
  let leido = false;
  const lector = { activo: true, leerLiquidaciones: async () => { leido = true; }, leerCertificadoAfp: async () => { leido = true; } };
  const ctx = await preparar({}, { lector });
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}` };
  await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario(DATOS, DOCS_DEP) });
  await ctx.app.locals.esperarTareas();
  const lead = ctx.db.leadPorTelefono('56987654321');
  assert.strictEqual(leido, false);
  assert.doesNotMatch(await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text(), /Revisión automática/);
});

test('próximas visitas: casilla "Registrado en Breal" que marca Bárbara', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const lead = ctx.db.crearLead({ telefono: '56987654321', nombre: 'Ana Rojas', email: 'ana@example.com', propiedad: 'Rosario Sur 91', estado: 'agendado' });
  const visita = ctx.db.crearVisita(lead.id, '2026-10-16', 11);
  let panel = await (await fetch(`${ctx.url}/admin`, { headers: h })).text();
  assert.match(panel, /1 por registrar en Breal/);
  assert.match(panel, new RegExp(`action="/admin/visita/${visita.id}/breal"`));
  const r = await fetch(`${ctx.url}/admin/visita/${visita.id}/breal`, { method: 'POST', headers: h, redirect: 'manual', body: new URLSearchParams({ registrada: '1' }) });
  assert.strictEqual(r.status, 303);
  assert.ok(ctx.db.visitaPorId(visita.id).breal_at);
  panel = await (await fetch(`${ctx.url}/admin`, { headers: h })).text();
  assert.match(panel, /Todas registradas en Breal/);
  assert.match(panel, /casilla-breal hecha/);
  // Se puede desmarcar
  await fetch(`${ctx.url}/admin/visita/${visita.id}/breal`, { method: 'POST', headers: h, redirect: 'manual', body: new URLSearchParams({ registrada: '0' }) });
  assert.strictEqual(ctx.db.visitaPorId(visita.id).breal_at, null);
});

test('resultado "no continúa" con el motivo de Breal', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const lead = ctx.db.crearLead({ telefono: '56987654321', nombre: 'Ana Rojas', email: 'ana@example.com', estado: 'agendado' });
  const v = ctx.db.crearVisita(lead.id, '2026-10-14', 11);
  let ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /<option>Precio muy alto<\/option>/);
  await fetch(`${ctx.url}/admin/lead/${lead.id}/visita`, { method: 'POST', headers: h, redirect: 'manual', body: new URLSearchParams({ resultado: 'no_continua', motivo: 'Precio muy alto' }) });
  assert.strictEqual(ctx.db.visitaPorId(v.id).motivo_resultado, 'Precio muy alto');
  ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /Para Breal · Resultado de la Visita: <strong>Precio muy alto<\/strong>/);
  // Un motivo inventado no se guarda
  await fetch(`${ctx.url}/admin/lead/${lead.id}/visita`, { method: 'POST', headers: h, redirect: 'manual', body: new URLSearchParams({ resultado: 'no_continua', motivo: 'otra cosa' }) });
  assert.strictEqual(ctx.db.visitaPorId(v.id).motivo_resultado, null);
});

test('datos incompletos: el equipo le pide al interesado que los complete (sin volver a subir documentos)', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  // Postuló antes de que se pidieran todos los datos
  const lead = ctx.db.crearLead({ telefono: '56998241698', nombre: 'ANDRES TAMAYO LOPEZ', email: 'andres@example.com', rut: '94889766', estado: 'agendado', tipo: 'dependiente' });

  let ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /Faltan datos para Breal:<\/strong> Nacionalidad, Fecha de nacimiento, Estado civil/);
  assert.match(await (await fetch(`${ctx.url}/admin`, { headers: h })).text(), /Datos incompletos/);

  const r = await fetch(`${ctx.url}/admin/lead/${lead.id}/pedir-datos`, { method: 'POST', headers: h, redirect: 'manual' });
  assert.match(r.headers.get('location'), /ok=datos_pedidos/);
  const correo = ctx.correos.find((c) => c.to === 'andres@example.com');
  assert.match(correo.subject, /Completa tus datos/);
  assert.match(correo.html, new RegExp(`/datos/${lead.token}`));
  assert.match(correo.html, /<li>Nacionalidad<\/li>/);

  // El formulario viene con lo que ya tenemos
  const form = await (await fetch(`${ctx.url}/datos/${lead.token}`)).text();
  assert.match(form, /value="ANDRES TAMAYO LOPEZ"/);
  assert.match(form, /value="9\.488\.976-6"/);
  assert.doesNotMatch(form, /type="file"/);

  // Faltan datos -> se vuelven a pedir
  let res = await fetch(`${ctx.url}/datos/${lead.token}`, { method: 'POST', body: new URLSearchParams({ nombre: 'ANDRES TAMAYO LOPEZ', rut: '9.488.976-6', doc_tipo: 'rut' }) });
  assert.strictEqual(res.status, 422);
  assert.match(await res.text(), /Indica la nacionalidad/);

  res = await fetch(`${ctx.url}/datos/${lead.token}`, {
    method: 'POST',
    body: new URLSearchParams({
      nombre: 'ANDRES TAMAYO LOPEZ', doc_tipo: 'rut', rut: '9.488.976-6', nacionalidad: 'Chilena', fecha_nacimiento: '1963-06-25', estado_civil: 'Separado/a',
      profesion: 'Ingeniero', direccion_actual: 'Paso el Roble 50', comuna: 'La Florida', telefono: '+56 9 9824 1698', email: 'andres@example.com',
      url_publicacion: 'https://www.yapo.cl/bienes-raices-alquiler-apartamentos/vicuna-mackenna-5862/180528', propiedad: 'Vicuña Mackenna 5862, depto 905', plazo_cambio: '5_dias',
    }),
  });
  assert.match(await res.text(), /Datos guardados/);
  const actualizado = ctx.db.leadPorId(lead.id);
  assert.strictEqual(actualizado.comuna, 'La Florida');
  assert.strictEqual(actualizado.propiedad, 'Vicuña Mackenna 5862, depto 905');
  assert.strictEqual(actualizado.estado, 'agendado', 'no cambia su estado');
  assert.ok(ctx.correos.some((c) => /completó sus datos/.test(c.subject) && c.to.includes('sdopropiedades@sdorent.cl')));
  ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.doesNotMatch(ficha, /Faltan datos para Breal/);
});

test('postulación: la relación de quien complementa renta o es aval es obligatoria', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const form = await (await fetch(`${ctx.url}/postular`)).text();
  assert.match(form, /Todos los datos son obligatorios/);
  const r = await fetch(`${ctx.url}/postular`, { method: 'POST', body: formulario({ ...DATOS, complementa: '1', comp_rol: 'aval', comp_tipo: 'dependiente' }, DOCS_DEP) });
  assert.strictEqual(r.status, 422);
  assert.match(await r.text(), /Indica qué relación tiene quien es aval/);
});

test('usuarios del panel: Cristian entra con su propio usuario y clave', async (t) => {
  const ctx = await preparar({ PANEL_USUARIOS: 'cristian:clave-de-cristian' });
  t.after(() => ctx.server.close());
  const entrar = (usuario, clave) => fetch(`${ctx.url}/ingresar`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ usuario, clave, volver: '/admin' }) });
  assert.strictEqual((await entrar('cristian', 'otra')).status, 401);
  assert.strictEqual((await entrar('admin', 'clave-de-cristian')).status, 401, 'cada uno con su clave');
  const r = await entrar('Cristian', 'clave-de-cristian');
  assert.strictEqual(r.status, 303);
  const galleta = r.headers.get('set-cookie').split(';')[0];
  const panel = await fetch(`${ctx.url}/admin`, { headers: { cookie: galleta } });
  assert.strictEqual(panel.status, 200);
  assert.match(await panel.text(), /Desarrollado por José Cano/);
  // El usuario principal sigue igual
  assert.strictEqual((await entrar('admin', 'clave')).status, 303);
  // Una cookie alterada (otro usuario con la firma de Cristian) no sirve
  const [, exp, firma] = galleta.split('=')[1].split('.');
  const falsa = `sdo_sesion=${Buffer.from('admin').toString('base64url')}.${exp}.${firma}`;
  assert.strictEqual((await fetch(`${ctx.url}/admin`, { headers: { cookie: falsa }, redirect: 'manual' })).status, 303);
});

test('indicadores: embudo, actividad y JSON con clave para el panel de Cristian', async (t) => {
  const ctx = await preparar({ INDICADORES_TOKEN: 'token-kpi-123' });
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}` };
  const mk = (n, extra) => ctx.db.crearLead({ telefono: `5690000000${n}`, nombre: `Persona ${n}`, email: `p${n}@x.cl`, portal: n % 2 ? 'Yapo' : 'Mercado Libre', documentos_at: '2026-10-10T12:00:00Z', ...extra });
  const a = mk(1, { aprobado_at: '2026-10-11T12:00:00Z', estado: 'visitado', rut: '12.345.678-5' });
  const b = mk(2, { aprobado_at: '2026-10-12T12:00:00Z', estado: 'no_asistio' });
  mk(3, { estado: 'documentos_recibidos' });
  mk(4, { aprobado_at: '2026-10-12T12:00:00Z', estado: 'aprobado' });
  const va = ctx.db.crearVisita(a.id, '2026-10-13', 11);
  ctx.db.registrarResultadoVisita(va.id, 'realizada', 'Le gustó');
  ctx.db.marcarBreal(va.id, true);
  const vb = ctx.db.crearVisita(b.id, '2026-10-14', 15);
  ctx.db.registrarResultadoVisita(vb.id, 'no_asistio', '');

  const html = await (await fetch(`${ctx.url}/admin/indicadores`, { headers: h })).text();
  assert.match(html, /Embudo de las postulaciones del período/);
  assert.match(html, /Postularon<\/span>[\s\S]*?<strong>4<\/strong>/);

  assert.strictEqual((await fetch(`${ctx.url}/api/indicadores`)).status, 401);
  const r = await fetch(`${ctx.url}/api/indicadores?detalle=1`, { headers: { authorization: 'Bearer token-kpi-123' } });
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.deepStrictEqual(d.embudo.map((e) => e.cantidad), [4, 3, 2, 1, 1]);
  assert.strictEqual(d.embudo.at(1).desdeAnterior, 75);
  assert.strictEqual(d.actividad.noAsistio, 1);
  assert.strictEqual(d.actividad.asistencia, 50);
  assert.strictEqual(d.actividad.registradasEnBreal, 1);
  assert.deepStrictEqual([d.actividad.realizadasContinua, d.actividad.realizadasContinuaDelEmbudo, d.actividad.realizadasContinuaFueraDelEmbudo, d.actividad.visitasFueraDelEmbudo], [1, 1, 0, 0]);
  assert.strictEqual(d.tiempos.horasHastaAprobacion, 48);
  assert.deepStrictEqual(d.porPortal.map((p) => [p.portal, p.postularon, p.continuan]), [['Yapo', 2, 1], ['Mercado Libre', 2, 0]]);
  assert.strictEqual(d.pendientes.porRevisar, 1);
  const fila = d.interesados.find((x) => x.id === a.id);
  assert.deepStrictEqual([fila.telefono, fila.visita.resultado, fila.visita.registradaEnBreal], ['+56900000001', 'realizada', true]);
  // Seguimiento para cruzar con BReal: sin datos personales, con la clave que el panel calcula desde el RUT
  const seg = await (await fetch(`${ctx.url}/api/indicadores?seguimiento=1`, { headers: { authorization: 'Bearer token-kpi-123' } })).json();
  assert.strictEqual(seg.interesados, undefined);
  assert.strictEqual(seg.seguimiento.length, 1); // solo quien tiene RUT
  const clave = require('node:crypto').createHash('sha256').update('sdo-rent:123456785').digest('hex').slice(0, 32);
  assert.deepStrictEqual(seg.seguimiento[0], { clave, portal: 'Yapo', postulacion: '2026-10-10', aprobado: '2026-10-11', rechazado: null, agendo: '2026-10-13', visito: '2026-10-13', resultado: 'realizada', motivo: null, registradaEnBreal: true });
  assert.doesNotMatch(JSON.stringify(seg.seguimiento), /Persona|@x\.cl|5690000/);
  // Una visita ingresada a mano a alguien que no postuló por el formulario: cuenta en las visitas, no en el embudo
  const m = ctx.db.crearLead({ telefono: '56900000009', nombre: 'Manual', portal: 'Yapo', estado: 'visitado' });
  const vm = ctx.db.crearVisita(m.id, '2026-10-15', 12);
  ctx.db.registrarResultadoVisita(vm.id, 'realizada', '');
  const d2 = await (await fetch(`${ctx.url}/api/indicadores?desde=2026-10-01&hasta=2026-10-31`, { headers: { authorization: 'Bearer token-kpi-123' } })).json();
  assert.strictEqual(d2.embudo.at(-1).cantidad, 1);
  assert.deepStrictEqual([d2.actividad.realizadasContinua, d2.actividad.realizadasContinuaDelEmbudo, d2.actividad.realizadasContinuaFueraDelEmbudo, d2.actividad.visitasFueraDelEmbudo], [2, 1, 1, 1]);
  const html2 = await (await fetch(`${ctx.url}/admin/indicadores?desde=2026-10-01&hasta=2026-10-31`, { headers: h })).text();
  assert.match(html2, /1 del embudo · 1 fuera del embudo/);
  // Sin clave configurada, el endpoint no existe
  const sin = await preparar();
  t.after(() => sin.server.close());
  assert.strictEqual((await fetch(`${sin.url}/api/indicadores?token=x`)).status, 404);
});

test('papelera: canceló, no asistió o no continúa sale de las listas; vuelve si agenda de nuevo', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const post = (ruta, datos) => fetch(ctx.url + ruta, { method: 'POST', headers: h, body: new URLSearchParams(datos), redirect: 'manual' });
  const panel = async (q = '') => (await fetch(`${ctx.url}/admin${q}`, { headers: h })).text();
  const ana = ctx.db.crearLead({ telefono: '56911112222', nombre: 'Ana Cancela', email: 'ana@example.com', estado: 'aprobado', aprobado_at: '2026-10-14T12:00:00Z' });
  const beto = ctx.db.crearLead({ telefono: '56933334444', nombre: 'Beto Falta', email: 'beto@example.com', estado: 'aprobado', aprobado_at: '2026-10-14T12:00:00Z' });

  // Ana agenda y cancela: a la papelera, no a "Esperando agenda"
  await fetch(`${ctx.url}/agendar/${ana.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|10' }) });
  await fetch(`${ctx.url}/visita/${ana.token}/cancelar`, { method: 'POST', body: new URLSearchParams({ motivo: 'Encontré otra' }) });
  assert.match(ctx.db.leadPorId(ana.id).papelera_motivo, /Canceló su visita: Encontré otra/);
  let html = await panel();
  assert.doesNotMatch(html, /Ana Cancela/);
  assert.match(html, /<strong>1<\/strong><span>🗑️ Papelera<\/span>/);
  assert.match(await panel('?estado=papelera'), /Ana Cancela[\s\S]*🗑️ Canceló su visita/);
  // Recordar a todos no le escribe
  const antes = ctx.correos.length;
  await post('/admin/recordar-agenda', {});
  assert.ok(!ctx.correos.slice(antes).some((c) => c.to === 'ana@example.com'));

  // Beto no asiste: a la papelera
  const v = ctx.db.crearVisita(beto.id, '2026-10-15', 11);
  await post(`/admin/lead/${beto.id}/visita`, { resultado: 'no_asistio' });
  assert.strictEqual(ctx.db.visitaPorId(v.id).resultado, 'no_asistio');
  assert.match(ctx.db.leadPorId(beto.id).papelera_motivo, /No asistió/);
  assert.match(await (await fetch(`${ctx.url}/admin/lead/${beto.id}`, { headers: h })).text(), /En la papelera/);

  // Ana vuelve a agendar con su link: sale sola de la papelera
  await fetch(`${ctx.url}/agendar/${ana.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|12' }) });
  assert.strictEqual(ctx.db.leadPorId(ana.id).papelera_at, null);
  assert.match(await panel(), /Ana Cancela/);
  // El equipo saca a Beto a mano
  await post(`/admin/lead/${beto.id}/papelera`, { accion: 'sacar' });
  assert.strictEqual(ctx.db.leadPorId(beto.id).papelera_at, null);
  await post(`/admin/lead/${beto.id}/papelera`, { accion: 'mover' });
  assert.ok(ctx.db.leadPorId(beto.id).papelera_at);
});

test('confirmar desde el calendario: pedir confirmación al interesado o confirmarla el equipo (le llega aviso)', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const post = (ruta, datos) => fetch(ctx.url + ruta, { method: 'POST', headers: h, body: new URLSearchParams(datos), redirect: 'manual' });
  const lead = ctx.db.crearLead({ telefono: '56955556666', nombre: 'Carla Pide', email: 'carla@example.com', propiedad: 'Rosario Sur 91', estado: 'agendado' });
  const v = ctx.db.crearVisita(lead.id, '2026-10-16', 10);
  let cal = await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text();
  assert.match(cal, /📨 Pedir<\/button>/);
  assert.match(cal, /✅ Confirmar<\/button>/);

  // Pedir confirmación: le llega un correo con el botón
  let antes = ctx.correos.length;
  let r = await post(`/admin/visita/${v.id}/pedir-confirmacion`, { volver: 'calendario', semana: '0' });
  assert.strictEqual(r.status, 303);
  assert.match(r.headers.get('location'), /\/admin\/calendario/);
  const pedido = ctx.correos.slice(antes).find((c) => c.to === 'carla@example.com');
  assert.match(pedido.subject, /Confirma tu visita/);
  assert.match(pedido.html, /\/visita\/[^"]+\/confirmar/);
  assert.ok(ctx.db.visitaPorId(v.id).confirmacion_pedida_at);
  cal = await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text();
  assert.match(cal, /⏳ Pedida /);
  assert.match(cal, /📨 Pedir otra vez/);

  // El equipo la confirma: queda en verde, al interesado le llega la confirmación y al equipo el evento con ✅
  antes = ctx.correos.length;
  r = await post(`/admin/visita/${v.id}/confirmar`, {});
  assert.match(r.headers.get('location'), /ok=confirmada_equipo/);
  const nuevos = ctx.correos.slice(antes);
  assert.match(nuevos.find((c) => c.to === 'carla@example.com').subject, /Tu visita está confirmada/);
  const equipo = nuevos.find((c) => /CONFIRMADA por el equipo/.test(c.subject));
  assert.match(equipo.icalEvent.content.replace(/\r\n /g, ''), /SUMMARY:✅ 🏠 Rosario Sur 91/);
  const vc = ctx.db.visitaPorId(v.id);
  assert.ok(vc.confirmada_at);
  assert.strictEqual(vc.confirmada_por, 'equipo');
  cal = await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text();
  assert.match(cal, /✅ Confirmó</);
  assert.doesNotMatch(cal, /✅ Confirmar<\/button>/);
  assert.match(await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text(), /confirmada por el equipo/);
  // Confirmar de nuevo no repite correos
  antes = ctx.correos.length;
  await post(`/admin/visita/${v.id}/confirmar`, {});
  assert.strictEqual(ctx.correos.length, antes);
});

test('SDO Capital · Ventas: propiedad, postulación de compra con calificación, visita en el mismo calendario y negociación', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const post = (ruta, datos) => fetch(ctx.url + ruta, { method: 'POST', headers: h, body: new URLSearchParams(datos), redirect: 'manual' });

  // El equipo carga una propiedad en venta
  assert.strictEqual((await post('/admin/ventas/propiedades', { direccion: 'Rosario Sur 91, depto 504', comuna: 'Las Condes', precio_uf: '3000', dormitorios: '2', banos: '2', url_aviso: 'https://www.yapo.cl/venta/91', estado: 'disponible' })).status, 303);
  const prop = ctx.db.listarPropiedadesVenta()[0];
  assert.strictEqual(prop.precio_uf, 3000);
  const propiedades = await (await fetch(`${ctx.url}/admin/ventas/propiedades`, { headers: h })).text();
  assert.match(propiedades, /Rosario Sur 91, depto 504/);
  assert.match(propiedades, /logo-sdocapital\.png/);

  // Llega por WhatsApp desde el aviso de venta: se crea como interesado de venta y recibe el link de compra
  await postWebhook(ctx, mensajeWA('wamid.v1', '56955554444', 'Hola, me interesa este departamento https://www.yapo.cl/venta/91?utm=wa', 'Marta Rojas'));
  let lead = ctx.db.leadPorTelefono('56955554444');
  assert.strictEqual(lead.negocio, 'venta');
  assert.strictEqual(lead.propiedad_venta_id, prop.id);
  assert.match(ctx.wa.at(-1).texto, new RegExp(`/comprar/${lead.token}`));
  // Un mensaje de arriendo sigue yendo a arriendos
  await postWebhook(ctx, mensajeWA('wamid.a1', '56966667777', 'Hola, me interesa el arriendo https://www.yapo.cl/arriendo/55', 'Pedro Soto'));
  assert.strictEqual(ctx.db.leadPorTelefono('56966667777').negocio, 'arriendo');

  // El formulario de compra muestra la propiedad del listado y el logo de SDO Capital
  const form = await (await fetch(`${ctx.url}/comprar/${lead.token}`)).text();
  assert.match(form, /logo-sdocapital\.png/);
  assert.match(form, /Rosario Sur 91, depto 504, Las Condes · 3\.000 UF/);
  assert.match(form, /Para invertir/);
  // /postular con su link lo lleva al formulario de compra
  assert.strictEqual((await fetch(`${ctx.url}/postular/${lead.token}`, { redirect: 'manual' })).headers.get('location'), `/comprar/${lead.token}`);

  // Faltan datos de compra: se piden
  let r = await fetch(`${ctx.url}/comprar/${lead.token}`, { method: 'POST', body: formulario({ ...DATOS, tipo: 'credito', propiedad_venta_id: String(prop.id) }, [['cedula', 'c.pdf']]) });
  assert.strictEqual(r.status, 422);
  const err = await r.text();
  assert.match(err, /para vivir o para invertir/);
  assert.match(err, /cuánto tienes para el pie/);
  assert.match(err, /banco y el monto de tu preaprobación/);
  assert.match(err, /Falta adjuntar: Carta de preaprobación/);

  // Postulación completa con crédito: pie 20%, preaprobación por el resto y dividendo bajo el 25%
  const DOCS_CREDITO = [['cedula', 'c.pdf'], ['preaprobacion', 'banco.pdf'], ['liquidaciones', 'l1.pdf'], ['afp', 'afp.pdf'], ['pie', 'ahorro.pdf']];
  r = await fetch(`${ctx.url}/comprar/${lead.token}`, {
    method: 'POST',
    body: formulario({ ...DATOS, nombre: 'Marta Rojas Díaz', telefono: '+56 9 5555 4444', tipo: 'credito', para_que: 'invertir', propiedad_venta_id: String(prop.id), pie_uf: '600', renta_liquida: '2.500.000', banco_preaprobacion: 'Banco Estado', monto_preaprobado_uf: '2400', plazo_compra: '1_3_meses', propiedad: '', url_publicacion: '' }, DOCS_CREDITO),
  });
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /Postulación enviada/);
  lead = ctx.db.leadPorId(lead.id);
  assert.deepStrictEqual([lead.estado, lead.tipo, lead.para_que, lead.pie_uf, lead.renta_liquida, lead.monto_preaprobado_uf], ['documentos_recibidos', 'credito', 'invertir', 600, 2500000, 2400]);
  const aviso = ctx.correos.find((c) => /Nueva postulación de COMPRA/.test(c.subject));
  assert.deepStrictEqual([...aviso.to].sort(), ['csolisdeovando@sdocapital.cl', 'julio.mendoza@sdorent.cl', 'sdopropiedades@sdorent.cl']);
  assert.match(aviso.html, /logo-sdocapital\.png/);
  assert.match(aviso.html, /Cumple las 3 condiciones/);
  assert.match(aviso.html, /Para invertir/);
  assert.match(ctx.correos.find((c) => c.to === 'juan@example.com' || /Recibimos tu postulación/.test(c.subject)).subject, /SDO Capital/);

  // Panel de ventas: aparece con su calificación; el panel de arriendos no lo muestra
  const panel = await (await fetch(`${ctx.url}/admin/ventas`, { headers: h })).text();
  assert.match(panel, /Marta Rojas Díaz/);
  assert.match(panel, /✅ Califica/);
  assert.match(panel, /📈 Inversión/);
  assert.doesNotMatch(await (await fetch(`${ctx.url}/admin`, { headers: h })).text(), /Marta Rojas Díaz/);
  const ficha = await (await fetch(`${ctx.url}/admin/lead/${lead.id}`, { headers: h })).text();
  assert.match(ficha, /Carta de preaprobación del banco/);
  assert.match(ficha, /Dividendo estimado/);
  assert.match(ficha, /← SDO Capital · Ventas/);

  // Se aprueba: agenda en el mismo calendario (Julio) y la tarjeta dice "Venta"
  const firma = (await import('../src/utils.js')).firmar(ctx.config.secret, 'revision', lead.id);
  await fetch(`${ctx.url}/revision/${lead.id}/aprobar?firma=${firma}`, { method: 'POST', redirect: 'manual' });
  await fetch(`${ctx.url}/agendar/${lead.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|11' }) });
  const cal = await (await fetch(`${ctx.url}/admin/calendario`, { headers: h })).text();
  assert.match(cal, /🏢 Venta<\/span> Marta Rojas Díaz/);
  // Un arriendo no puede tomar la misma hora
  const otro = ctx.db.crearLead({ telefono: '56911119999', nombre: 'Arrendatario', email: 'a@example.com', estado: 'aprobado' });
  r = await fetch(`${ctx.url}/agendar/${otro.token}`, { method: 'POST', body: new URLSearchParams({ bloque: '2026-10-16|11' }) });
  assert.strictEqual(r.status, 409);

  // Negociación: oferta → reserva (la propiedad queda reservada) → escritura (vendida)
  const antes = ctx.correos.length;
  await post(`/admin/lead/${lead.id}/negociacion`, { etapa: 'oferta', oferta_fecha: '2026-10-20', oferta_uf: '2900', avisar: '1' });
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'oferta');
  assert.match(ctx.correos.slice(antes).find((c) => /Oferta/.test(c.subject)).html, /2\.900 UF/);
  await post(`/admin/lead/${lead.id}/negociacion`, { etapa: 'reserva', reserva_fecha: '2026-10-22', reserva_monto: '25 UF' });
  assert.strictEqual(ctx.db.propiedadVenta(prop.id).estado, 'reservada');
  await post(`/admin/lead/${lead.id}/negociacion`, { etapa: 'escritura', escritura_fecha: '2026-12-15' });
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'escriturado');
  assert.strictEqual(ctx.db.propiedadVenta(prop.id).estado, 'vendida');
  // Corregir la oferta no hace retroceder el estado
  await post(`/admin/lead/${lead.id}/negociacion`, { etapa: 'oferta', oferta_fecha: '2026-10-20', oferta_uf: '2950' });
  assert.strictEqual(ctx.db.leadPorId(lead.id).estado, 'escriturado');
  assert.match(await (await fetch(`${ctx.url}/admin/ventas`, { headers: h })).text(), /<strong>1<\/strong><span>Vendidos/);
  // Ya vendida, no aparece en el formulario de compra
  assert.doesNotMatch(await (await fetch(`${ctx.url}/comprar`)).text(), /Rosario Sur 91, depto 504, Las Condes · 3\.000 UF/);
});

test('SDO Capital · Ventas: completar datos no pide fecha de cambio ni la propiedad', async (t) => {
  const ctx = await preparar();
  t.after(() => ctx.server.close());
  const lead = ctx.db.crearLead({ telefono: '56912340000', negocio: 'venta', estado: 'documentos_recibidos', propiedad: 'Rosario Sur 91' });
  const form = await (await fetch(`${ctx.url}/datos/${lead.token}`)).text();
  assert.doesNotMatch(form, /para cuándo te quieres cambiar/i);
  assert.match(form, /logo-sdocapital\.png/);
  const r = await fetch(`${ctx.url}/datos/${lead.token}`, { method: 'POST', body: new URLSearchParams({ nombre: 'Ana Compra', rut: '11.111.111-1', email: 'ana@example.com', telefono: '+56 9 1234 0000', ...PERSONALES }) });
  assert.strictEqual(r.status, 200);
  const l = ctx.db.leadPorId(lead.id);
  assert.deepStrictEqual([l.nombre, l.propiedad, l.plazo_cambio], ['Ana Compra', 'Rosario Sur 91', null]);
});

test('SDO Capital · Ventas: el pie mínimo depende de la propiedad (desde 10%) o del tramo de precio', async (t) => {
  const ctx = await preparar({ VENTA_PIE_TRAMOS: '2500:0.1' });
  t.after(() => ctx.server.close());
  const h = { authorization: `Basic ${Buffer.from('admin:clave').toString('base64')}`, origin: ctx.url };
  const post = (ruta, datos) => fetch(ctx.url + ruta, { method: 'POST', headers: h, body: new URLSearchParams(datos), redirect: 'manual' });
  await post('/admin/ventas/propiedades', { direccion: 'Depto con pie 10%', precio_uf: '3500', pie_minimo: '10', estado: 'disponible' });
  await post('/admin/ventas/propiedades', { direccion: 'Depto económico', precio_uf: '2400', estado: 'disponible' });
  await post('/admin/ventas/propiedades', { direccion: 'Depto general', precio_uf: '5000', estado: 'disponible' });
  const [conPie, economico, general] = ['Depto con pie 10%', 'Depto económico', 'Depto general'].map((d) => ctx.db.listarPropiedadesVenta().find((p) => p.direccion === d));
  assert.strictEqual(conPie.pie_minimo, 0.1);
  const lista = await (await fetch(`${ctx.url}/admin/ventas/propiedades`, { headers: h })).text();
  assert.match(lista, /Depto económico[\s\S]*?10% <small class="nota">\(general\)/);
  assert.match(await (await fetch(`${ctx.url}/comprar`)).text(), /Depto con pie 10% · 3\.500 UF · pie desde 10%/);
  // Con 10% de pie califica en la propiedad de 10%, pero no en la de 20%
  const { calificacionDe } = require('../src/vistasVentas');
  const comprador = { tipo: 'credito', pie_uf: 350, monto_preaprobado_uf: 4700, renta_liquida: 4000000 };
  assert.strictEqual(calificacionDe(comprador, conPie, ctx.config, 40000).reglas[0].cumple, true);
  assert.match(calificacionDe(comprador, conPie, ctx.config, 40000).reglas[0].nombre, /10%/);
  assert.strictEqual(calificacionDe({ ...comprador, pie_uf: 240 }, economico, ctx.config, 40000).reglas[0].cumple, true);
  assert.strictEqual(calificacionDe(comprador, general, ctx.config, 40000).reglas[0].cumple, false);
});
