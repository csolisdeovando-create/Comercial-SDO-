// Verifica la conexión SMTP y envía un correo de prueba.
// Uso: npm run probar-correo [destinatario]
const { cargarConfig } = require('../src/config');
const { crearMailer } = require('../src/mailer');

(async () => {
  const config = cargarConfig();
  const { smtp } = config.correo;
  if (!smtp.host) {
    console.error('❌ Falta SMTP_HOST en .env (para Google Workspace: smtp.gmail.com).');
    process.exit(1);
  }
  if (!smtp.user || !smtp.pass) {
    console.error('❌ Faltan SMTP_USER o SMTP_PASS en .env.');
    process.exit(1);
  }
  const destino = process.argv[2] || config.correo.documentos[0];
  console.log(`Conectando a ${smtp.host}:${smtp.port} como ${smtp.user}…`);
  const mailer = crearMailer(config);
  const limite = (ms) =>
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Sin respuesta de ${smtp.host}:${smtp.port} en ${ms / 1000} s (¿firewall o red bloquea el puerto?).`)), ms).unref()
    );
  try {
    await Promise.race([mailer.verificar(), limite(30000)]);
    console.log('✅ Conexión y usuario/clave correctos.');
    await mailer.enviar({
      to: destino,
      subject: `Prueba de correo – ${config.empresa.nombre} Comercial`,
      html: `<p>Este es un correo de prueba del sistema comercial de ${config.empresa.nombre}.</p><p>Si lo recibiste, el envío de correos está funcionando ✅</p>`,
    });
    console.log(`✅ Correo de prueba enviado a ${destino}. Revisa la bandeja de entrada (y spam).`);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    if (e.responseCode === 535 || /Username and Password not accepted|BadCredentials/i.test(e.message)) {
      console.error(
        '\nGoogle rechazó el usuario/clave. La clave normal de la cuenta NO sirve:\n' +
          'hay que usar una "contraseña de aplicación" de 16 letras (requiere verificación en 2 pasos).\n' +
          'Ver https://myaccount.google.com/apppasswords'
      );
    }
    process.exit(1);
  }
  process.exit(0);
})();
