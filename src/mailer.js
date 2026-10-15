const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');

/**
 * Si hay SMTP configurado envía correos reales; si no, los guarda como .eml
 * en data/outbox para poder revisarlos en pruebas.
 */
function crearMailer(config) {
  const { smtp, from } = config.correo;
  const modoPrueba = !smtp.host;
  const outbox = path.join(config.dataDir, 'outbox');

  const transporte = modoPrueba
    ? nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
    : nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      });

  return {
    modoPrueba,
    async enviar(mensaje) {
      const info = await transporte.sendMail({ from, ...mensaje });
      if (modoPrueba) {
        fs.mkdirSync(outbox, { recursive: true });
        const archivo = path.join(outbox, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.eml`);
        fs.writeFileSync(archivo, info.message);
        console.log(`[correo:prueba] "${mensaje.subject}" -> ${[].concat(mensaje.to).join(', ')} (${archivo})`);
      }
      return info;
    },
  };
}

module.exports = { crearMailer };
