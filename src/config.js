const fs = require('node:fs');
const path = require('node:path');

// Carga .env si existe (Node >= 20.12 trae process.loadEnvFile)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath) && !process.env.SDO_SKIP_ENV_FILE) {
  process.loadEnvFile(envPath);
}

const lista = (valor, porDefecto = '') =>
  String(valor ?? porDefecto)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const bool = (valor, porDefecto = false) =>
  valor === undefined || valor === '' ? porDefecto : ['1', 'true', 'si', 'sí', 'yes'].includes(String(valor).toLowerCase());

function cargarConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  return {
    port: Number(env.PORT || 3000),
    baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
    secret: env.APP_SECRET || 'cambia-esta-clave-secreta',
    dataDir,
    uploadsDir: path.join(dataDir, 'uploads'),
    zonaHoraria: env.ZONA_HORARIA || 'America/Santiago',

    empresa: {
      nombre: env.EMPRESA_NOMBRE || 'SDO Rent',
      whatsappComercial: env.WHATSAPP_COMERCIAL || '+56961216962',
    },

    // Agenda de visitas
    agenda: {
      horas: lista(env.AGENDA_HORAS, '9,11,13,15,17').map(Number),
      diasHabiles: Number(env.AGENDA_DIAS_HABILES || 15),
      anticipacionHoras: Number(env.AGENDA_ANTICIPACION_HORAS || 2),
      cuposPorBloque: Number(env.AGENDA_CUPOS_POR_BLOQUE || 1),
      duracionMinutos: Number(env.AGENDA_DURACION_MINUTOS || 60),
      feriados: lista(env.AGENDA_FERIADOS, '2026-12-08,2026-12-25,2027-01-01'),
      // false: Bárbara aprueba los documentos y recién ahí se envía el calendario.
      // true: el calendario se envía apenas el interesado sube sus documentos.
      automatica: bool(env.AGENDA_AUTOMATICA, false),
    },

    correo: {
      documentos: lista(env.EMAIL_DOCUMENTOS, 'sdopropiedades@sdorent.cl'),
      visitas: lista(
        env.EMAIL_VISITAS,
        'julio.mendoza@sdorent.cl,barbara.diaz@sdorent.cl,csolisdeovando@sdocapital.cl'
      ),
      from: env.EMAIL_FROM || 'SDO Rent <sdopropiedades@sdorent.cl>',
      maxAdjuntosMB: Number(env.EMAIL_MAX_ADJUNTOS_MB || 20),
      smtp: {
        host: env.SMTP_HOST || '',
        port: Number(env.SMTP_PORT || 465),
        secure: bool(env.SMTP_SECURE, Number(env.SMTP_PORT || 465) === 465),
        user: env.SMTP_USER || '',
        pass: env.SMTP_PASS || '',
      },
    },

    whatsapp: {
      token: env.WHATSAPP_TOKEN || '',
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
      appSecret: env.WHATSAPP_APP_SECRET || '',
      graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v23.0',
      // Horas que deben pasar antes de volver a enviar el link al mismo número
      enfriamientoHoras: Number(env.WHATSAPP_ENFRIAMIENTO_HORAS || 12),
      // Plantilla aprobada por Meta para mensajes fuera de la ventana de 24 h (opcional)
      plantillaAgenda: env.WHATSAPP_PLANTILLA_AGENDA || '',
      plantillaIdioma: env.WHATSAPP_PLANTILLA_IDIOMA || 'es',
    },

    admin: {
      usuario: env.ADMIN_USUARIO || 'admin',
      clave: env.ADMIN_CLAVE || '',
    },

    archivos: {
      maxMB: Number(env.ARCHIVO_MAX_MB || 30),
      maxPorRequisito: Number(env.ARCHIVO_MAX_POR_REQUISITO || 6),
    },
  };
}

module.exports = { cargarConfig };
