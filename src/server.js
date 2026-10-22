// SDO Comercial · Desarrollado por José Cano · Todos los derechos reservados (ver LICENSE)
const path = require('node:path');
const { cargarConfig } = require('./config');
const { abrirDB } = require('./db');
const { crearMailer } = require('./mailer');
const { crearWhatsapp } = require('./whatsapp');
const { crearApp } = require('./app');

const config = cargarConfig();
const db = abrirDB(path.join(config.dataDir, 'comercial.db'));
const mailer = crearMailer(config);
const whatsapp = crearWhatsapp(config);
const app = crearApp({ config, db, mailer, whatsapp });

if (config.secret === 'cambia-esta-clave-secreta') console.warn('⚠️  Define APP_SECRET en .env antes de usar en producción.');
if (mailer.modoPrueba) console.warn('⚠️  SMTP no configurado: los correos se guardan en data/outbox (modo prueba).');
if (!whatsapp.configurado) console.warn('⚠️  WhatsApp no configurado: los mensajes solo se muestran en consola y el webhook está desactivado.');
else if (!config.whatsapp.appSecret) console.warn('⚠️  Define WHATSAPP_APP_SECRET: sin él no se verifica que los mensajes vengan de Meta.');

// Cada 15 minutos: recordatorios del día anterior y pedido de resultado de las visitas que ya terminaron
const revisarRecordatorios = () =>
  app.locals.enviarRecordatorios().then((n) => n && console.log(`[recordatorio] ${n} enviado(s)`)).catch((e) => console.error('[recordatorio]', e));
const pedirResultados = () =>
  app.locals.pedirResultados().then((n) => n && console.log(`[resultado] ${n} pedido(s)`)).catch((e) => console.error('[resultado]', e));
setTimeout(revisarRecordatorios, 60 * 1000);
setInterval(revisarRecordatorios, 15 * 60 * 1000);
setTimeout(pedirResultados, 90 * 1000);
setInterval(pedirResultados, 15 * 60 * 1000);

app.listen(config.port, () => {
  console.log(`SDO Comercial escuchando en ${config.baseUrl} (puerto ${config.port})`);
  console.log(`  Webhook WhatsApp: ${config.baseUrl}/webhook/whatsapp`);
  console.log(`  Formulario:       ${config.baseUrl}/postular`);
  console.log(`  Panel interno:    ${config.baseUrl}/admin`);
});
