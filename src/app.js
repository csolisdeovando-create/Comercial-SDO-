const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');

const { REQUISITOS, TIPOS, todosLosCampos, nombreRequisito } = require('./requisitos');
const { construirCalendario, bloqueValido, ahoraEnZona, describirBloque, sumarDias } = require('./agenda');
const { firmaValida, detectarPortal, extraerUrl } = require('./whatsapp');
const { crearNotificaciones } = require('./notificaciones');
const { esc, formatearRut, rutValido, limpiarRut, normalizarTelefono, emailValido, firmaCorrecta } = require('./utils');
const vistas = require('./views');

const MIMES_PERMITIDOS = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/;
const EXT_PERMITIDAS = /\.(pdf|jpe?g|png|webp|heic|heif)$/i;

function crearApp({ config, db, mailer, whatsapp, ahora = () => new Date() }) {
  const app = express();
  const notif = crearNotificaciones({ config, mailer, whatsapp, db });
  const cfgAgenda = { ...config.agenda, zonaHoraria: config.zonaHoraria };
  const opcVista = { empresa: config.empresa.nombre };
  const tareas = new Set(); // procesos en segundo plano (útil para pruebas)
  app.locals.esperarTareas = () => Promise.allSettled([...tareas]);

  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

  const tmpDir = path.join(config.uploadsDir, '_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  // ------------------------------------------------------------------
  // WhatsApp Cloud API: webhook
  // ------------------------------------------------------------------
  app.get('/webhook/whatsapp', (req, res) => {
    const ok =
      req.query['hub.mode'] === 'subscribe' &&
      config.whatsapp.verifyToken &&
      req.query['hub.verify_token'] === config.whatsapp.verifyToken;
    return ok ? res.status(200).send(String(req.query['hub.challenge'])) : res.sendStatus(403);
  });

  app.post(
    '/webhook/whatsapp',
    express.json({ limit: '2mb', verify: (req, _res, buf) => (req.rawBody = buf) }),
    (req, res) => {
      if (!firmaValida(config.whatsapp.appSecret, req.rawBody, req.get('x-hub-signature-256'))) {
        return res.sendStatus(401);
      }
      res.sendStatus(200); // Meta exige respuesta rápida; se procesa después
      const t = procesarWebhook(req.body).catch((e) => console.error('[webhook] error:', e));
      tareas.add(t);
      t.finally(() => tareas.delete(t));
    }
  );

  async function procesarWebhook(cuerpo) {
    for (const entrada of cuerpo?.entry || []) {
      for (const cambio of entrada.changes || []) {
        const valor = cambio.value || {};
        const contactos = valor.contacts || [];
        for (const msg of valor.messages || []) {
          const nombrePerfil = contactos.find((c) => c.wa_id === msg.from)?.profile?.name;
          await procesarMensaje(msg, nombrePerfil);
        }
      }
    }
  }

  async function procesarMensaje(msg, nombrePerfil) {
    const telefono = normalizarTelefono(msg.from);
    if (!telefono) return;
    const texto =
      msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || msg.image?.caption || '';

    let lead = db.leadPorTelefono(telefono);
    const portal = detectarPortal(texto);
    const propiedad = extraerUrl(texto) || (portal ? texto.slice(0, 300) : null);
    if (!lead) {
      lead = db.crearLead({ telefono, nombre: nombrePerfil || null, portal, propiedad, mensaje_inicial: texto.slice(0, 1000) });
    } else if (lead.estado === 'contactado' && (portal || propiedad)) {
      // Nueva consulta por otra propiedad antes de postular: se actualiza el interés
      lead = db.actualizarLead(lead.id, { portal: portal || lead.portal, propiedad: propiedad || lead.propiedad });
    }

    // Meta puede reenviar el mismo webhook: no responder dos veces
    if (!db.registrarMensaje({ lead_id: lead.id, wa_id: msg.id, direccion: 'in', contenido: texto })) return;

    const ultimo = lead.ultimo_autoreply_at ? new Date(lead.ultimo_autoreply_at).getTime() : 0;
    if (ahora().getTime() - ultimo < config.whatsapp.enfriamientoHoras * 3600 * 1000) return;

    const respuesta =
      lead.estado === 'contactado' || lead.estado === 'rechazado' ? notif.textoBienvenida(lead) : notif.textoYaPostulado(lead);
    if (!respuesta) return;

    whatsapp.marcarLeido(msg.id);
    await whatsapp.enviarTexto(telefono, respuesta);
    db.registrarMensaje({ lead_id: lead.id, direccion: 'out', contenido: respuesta });
    db.actualizarLead(lead.id, { ultimo_autoreply_at: ahora().toISOString() });
  }

  // ------------------------------------------------------------------
  // Postulación: datos + documentos
  // ------------------------------------------------------------------
  const subir = multer({
    storage: multer.diskStorage({
      destination: tmpDir,
      filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
    }),
    defParamCharset: 'utf8',
    limits: { fileSize: config.archivos.maxMB * 1024 * 1024, files: 40, fields: 30 },
    fileFilter: (_req, file, cb) => {
      if (!todosLosCampos().includes(file.fieldname)) return cb(null, false);
      if (!MIMES_PERMITIDOS.test(file.mimetype) && !EXT_PERMITIDAS.test(file.originalname)) {
        const e = new Error(`"${file.originalname}" no es un formato permitido (usa PDF, JPG, PNG o HEIC).`);
        e.code = 'FORMATO';
        return cb(e);
      }
      cb(null, true);
    },
  }).fields(todosLosCampos().map((name) => ({ name, maxCount: config.archivos.maxPorRequisito })));

  const borrarTemporales = (req) => {
    for (const lista of Object.values(req.files || {})) for (const f of lista) fs.rm(f.path, { force: true }, () => {});
  };

  function leadDesdeToken(req, res) {
    const lead = db.leadPorToken(req.params.token);
    if (!lead) {
      res.status(404).send(vistas.mensaje('Link no válido', 'Este link no existe o expiró. Escríbenos por WhatsApp y te enviaremos uno nuevo.', { ...opcVista, icono: '🔗' }));
      return null;
    }
    return lead;
  }

  function mostrarFormulario(req, res, lead) {
    if (lead && ['aprobado', 'agendado'].includes(lead.estado)) return res.redirect(`/agendar/${lead.token}`);
    if (lead && lead.estado === 'documentos_recibidos') {
      return res.send(
        vistas.mensaje('Documentos en revisión', 'Ya recibimos tus documentos y nuestro equipo los está revisando. Te avisaremos por correo y WhatsApp.', { ...opcVista, icono: '⏳' })
      );
    }
    res.send(vistas.formularioPostulacion({ lead, config }));
  }

  app.get('/', (_req, res) => res.redirect('/postular'));
  app.get('/salud', (_req, res) => res.json({ ok: true }));
  app.get('/postular', (req, res) => mostrarFormulario(req, res, null));
  app.get('/postular/:token', (req, res) => {
    const lead = leadDesdeToken(req, res);
    if (lead) mostrarFormulario(req, res, lead);
  });

  const recibirPostulacion = (req, res) => {
    let lead = null;
    if (req.params.token) {
      lead = leadDesdeToken(req, res);
      if (!lead) return;
      if (!['contactado', 'rechazado'].includes(lead.estado)) return mostrarFormulario(req, res, lead);
    }

    subir(req, res, async (err) => {
      const b = req.body || {};
      const errores = [];
      if (err) {
        errores.push(
          err.code === 'LIMIT_FILE_SIZE'
            ? `Uno de los archivos supera ${config.archivos.maxMB} MB. Intenta con una foto más liviana o un PDF comprimido.`
            : err.code === 'LIMIT_UNEXPECTED_FILE'
              ? `Puedes subir hasta ${config.archivos.maxPorRequisito} archivos por documento.`
              : err.message
        );
      }
      const tipo = TIPOS.includes(b.tipo) ? b.tipo : null;
      if (!tipo) errores.push('Indica si eres trabajador dependiente o independiente/empresa.');
      if (!String(b.nombre || '').trim()) errores.push('Ingresa tu nombre completo.');
      if (!rutValido(b.rut)) errores.push('El RUT no es válido.');
      if (b.rut_empresa && !rutValido(b.rut_empresa)) errores.push('El RUT de la empresa no es válido.');
      if (!emailValido(b.email)) errores.push('Ingresa un correo electrónico válido.');
      const telefono = normalizarTelefono(b.telefono);
      if (telefono.length < 11) errores.push('Ingresa un teléfono válido (ej: +56 9 1234 5678).');
      if (!b.consentimiento) errores.push('Debes autorizar el uso de tus datos para evaluar la postulación.');
      if (tipo && !err) {
        for (const d of REQUISITOS[tipo].documentos) {
          if (!req.files?.[d.campo]?.length) errores.push(`Falta adjuntar: ${d.nombre}.`);
        }
      }

      if (errores.length) {
        borrarTemporales(req);
        return res.status(422).send(vistas.formularioPostulacion({ lead, valores: { ...b, telefono }, errores, config }));
      }

      // Si llega sin token pero el teléfono ya escribió por WhatsApp, se reutiliza ese lead
      if (!lead) {
        const previo = db.leadPorTelefono(telefono);
        lead = previo && ['contactado', 'rechazado'].includes(previo.estado) ? previo : db.crearLead({ telefono, portal: 'Formulario web' });
      }

      const estado = config.agenda.automatica ? 'aprobado' : 'documentos_recibidos';
      lead = db.actualizarLead(lead.id, {
        tipo,
        nombre: String(b.nombre).trim().slice(0, 150),
        rut: limpiarRut(b.rut),
        email: String(b.email).trim().toLowerCase(),
        telefono,
        razon_social: tipo === 'independiente' ? String(b.razon_social || '').trim().slice(0, 150) || null : null,
        rut_empresa: tipo === 'independiente' && b.rut_empresa ? limpiarRut(b.rut_empresa) : null,
        propiedad: String(b.propiedad || '').trim().slice(0, 300) || lead.propiedad,
        comentarios: String(b.comentarios || '').trim().slice(0, 2000) || null,
        estado,
        motivo_rechazo: null,
        documentos_at: new Date().toISOString(),
        aprobado_at: config.agenda.automatica ? new Date().toISOString() : null,
      });

      // Mueve los archivos a la carpeta del lead
      const carpeta = path.join(config.uploadsDir, String(lead.id));
      fs.mkdirSync(carpeta, { recursive: true });
      const documentos = [];
      for (const d of REQUISITOS[tipo].documentos) {
        for (const f of req.files[d.campo] || []) {
          const destino = path.join(carpeta, path.basename(f.path));
          fs.renameSync(f.path, destino);
          const doc = {
            lead_id: lead.id,
            requisito: d.campo,
            nombre_original: path.basename(f.originalname).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'archivo',
            ruta: destino,
            mime: f.mimetype,
            tamano: f.size,
          };
          doc.id = db.agregarDocumento(doc);
          documentos.push(doc);
        }
      }
      borrarTemporales(req); // archivos de campos que no correspondían al tipo elegido

      try {
        await notif.documentosRecibidos(lead, documentos);
        if (config.agenda.automatica) await notif.enviarAgenda(lead);
      } catch (e) {
        console.error('[postulacion] error enviando notificaciones:', e);
      }

      if (config.agenda.automatica) return res.redirect(303, `/agendar/${lead.token}`);
      res
        .status(200)
        .send(
          vistas.mensaje(
            '¡Postulación enviada!',
            `Gracias ${esc(lead.nombre.split(' ')[0])}. Recibimos tus datos y ${documentos.length} archivo(s). Nuestro equipo revisará tus documentos y te enviaremos por correo y WhatsApp el calendario para agendar tu visita.`,
            { ...opcVista, icono: '✅' }
          )
        );
    });
  };
  app.post('/postular', recibirPostulacion);
  app.post('/postular/:token', recibirPostulacion);

  // ------------------------------------------------------------------
  // Revisión de documentos (links firmados enviados a sdopropiedades@)
  // ------------------------------------------------------------------
  function leadRevision(req, res) {
    const id = Number(req.params.id);
    const lead = Number.isInteger(id) ? db.leadPorId(id) : null;
    if (!lead || !firmaCorrecta(config.secret, req.query.firma, 'revision', id)) {
      res.status(403).send(vistas.mensaje('Acceso denegado', 'El link de revisión no es válido.', { ...opcVista, icono: '🔒' }));
      return null;
    }
    return lead;
  }

  app.get('/revision/:id/documento/:docId', (req, res) => {
    const lead = leadRevision(req, res);
    if (!lead) return;
    const doc = db.documentoPorId(Number(req.params.docId));
    if (!doc || doc.lead_id !== lead.id || !fs.existsSync(doc.ruta)) return res.sendStatus(404);
    res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.nombre_original)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(doc.ruta).pipe(res);
  });

  // GET solo muestra la confirmación: así los antivirus de correo que "visitan" links no aprueban nada
  app.get('/revision/:id/:accion', (req, res) => {
    if (!['aprobar', 'rechazar'].includes(req.params.accion)) return res.sendStatus(404);
    const lead = leadRevision(req, res);
    if (!lead) return;
    res.send(vistas.revision({ lead, documentos: db.documentosDeLead(lead.id), accion: req.params.accion, firma: req.query.firma, config }));
  });

  app.post('/revision/:id/:accion', express.urlencoded({ extended: false }), async (req, res) => {
    const { accion } = req.params;
    if (!['aprobar', 'rechazar'].includes(accion)) return res.sendStatus(404);
    let lead = leadRevision(req, res);
    if (!lead) return;

    if (accion === 'aprobar') {
      if (['aprobado', 'agendado'].includes(lead.estado)) {
        return res.send(vistas.mensaje('Ya estaba aprobada', `La postulación de ${esc(lead.nombre)} ya fue aprobada anteriormente.`, { ...opcVista, icono: '👍' }));
      }
      lead = db.actualizarLead(lead.id, { estado: 'aprobado', aprobado_at: new Date().toISOString(), motivo_rechazo: null });
      await notif.enviarAgenda(lead).catch((e) => console.error('[revision] envío agenda:', e));
      return res.send(
        vistas.mensaje('Postulación aprobada', `Se envió a ${esc(lead.nombre)} el calendario para agendar su visita (${esc(lead.email)}${lead.telefono ? ` y WhatsApp +${esc(lead.telefono)}` : ''}).`, { ...opcVista, icono: '✅' })
      );
    }

    const motivo = String(req.body?.motivo || '').trim().slice(0, 2000);
    if (!motivo) return res.redirect(303, `/revision/${lead.id}/rechazar?firma=${encodeURIComponent(req.query.firma)}`);
    const reenviar = Boolean(req.body?.reenviar);
    lead = db.actualizarLead(lead.id, { estado: reenviar ? 'rechazado' : 'cerrado', motivo_rechazo: motivo });
    await notif.rechazo(lead, motivo, reenviar).catch((e) => console.error('[revision] envío rechazo:', e));
    res.send(vistas.mensaje('Respuesta enviada', `Se informó a ${esc(lead.nombre)} por correo y WhatsApp.`, { ...opcVista, icono: '📨' }));
  });

  // ------------------------------------------------------------------
  // Agenda de visitas
  // ------------------------------------------------------------------
  const puedeAgendar = (lead) => ['aprobado', 'agendado'].includes(lead.estado);

  function mostrarCalendario(res, lead, error, status = 200) {
    const cal = construirCalendario(cfgAgenda, new Map(), ahora());
    const ocupacion = db.ocupacionBloques(cal.desde, cal.hasta);
    res.status(status).send(
      vistas.calendario({ lead, cal: construirCalendario(cfgAgenda, ocupacion, ahora()), visita: db.visitaVigente(lead.id), error, config })
    );
  }

  app.get('/agendar/:token', (req, res) => {
    const lead = leadDesdeToken(req, res);
    if (!lead) return;
    if (!puedeAgendar(lead)) {
      return res.send(
        vistas.mensaje('Aún no puedes agendar', 'Primero debemos revisar tus documentos. Te enviaremos el calendario apenas estén aprobados.', {
          ...opcVista,
          icono: '⏳',
          extra: ['contactado', 'rechazado'].includes(lead.estado) ? `<a class="boton primario" href="/postular/${lead.token}">Completar postulación</a>` : '',
        })
      );
    }
    mostrarCalendario(res, lead);
  });

  app.post('/agendar/:token', express.urlencoded({ extended: false }), async (req, res) => {
    let lead = leadDesdeToken(req, res);
    if (!lead) return;
    if (!puedeAgendar(lead)) return res.redirect(303, `/agendar/${lead.token}`);

    const [fecha, horaTxt] = String(req.body?.bloque || '').split('|');
    const hora = Number(horaTxt);
    if (!config.agenda.horas.includes(hora) || !bloqueValido(cfgAgenda, fecha, hora, ahora())) {
      return mostrarCalendario(res, lead, 'Selecciona un horario válido.', 422);
    }

    const anterior = db.visitaVigente(lead.id);
    if (anterior && anterior.fecha === fecha && anterior.hora === hora) return res.redirect(303, `/agendar/${lead.token}/listo`);

    let visita;
    try {
      visita = db.transaccion(() => {
        if (db.contarBloque(fecha, hora) >= config.agenda.cuposPorBloque) return null;
        db.cancelarVisitasDeLead(lead.id);
        return db.crearVisita(lead.id, fecha, hora);
      });
    } catch (e) {
      console.error('[agenda] error al reservar:', e);
    }
    if (!visita) return mostrarCalendario(res, lead, 'Ese horario se acaba de ocupar. Por favor elige otro.', 409);

    lead = db.actualizarLead(lead.id, { estado: 'agendado' });
    await notif.visitaAgendada(lead, visita, Boolean(anterior)).catch((e) => console.error('[agenda] notificación:', e));
    res.redirect(303, `/agendar/${lead.token}/listo`);
  });

  app.get('/agendar/:token/listo', (req, res) => {
    const lead = leadDesdeToken(req, res);
    if (!lead) return;
    const visita = db.visitaVigente(lead.id);
    if (!visita) return res.redirect(`/agendar/${lead.token}`);
    res.send(
      vistas.mensaje('¡Visita agendada!', `Te esperamos el <strong>${esc(describirBloque(visita.fecha, visita.hora))}</strong>. Te enviamos la confirmación por correo y WhatsApp.`, {
        ...opcVista,
        icono: '📅',
        extra: `<a class="boton" href="/agendar/${lead.token}">Cambiar horario</a>`,
      })
    );
  });

  // ------------------------------------------------------------------
  // Panel interno (usuario/clave)
  // ------------------------------------------------------------------
  function requiereAdmin(req, res, next) {
    if (!config.admin.clave) return res.status(503).send('Configura ADMIN_CLAVE para habilitar el panel.');
    const [tipo, valor] = String(req.get('authorization') || '').split(' ');
    const [u, ...c] = Buffer.from(valor || '', 'base64').toString().split(':');
    const okUsuario = tipo === 'Basic' && u === config.admin.usuario;
    const a = Buffer.from(c.join(':'));
    const b = Buffer.from(config.admin.clave);
    if (!okUsuario || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.set('WWW-Authenticate', 'Basic realm="SDO Comercial", charset="UTF-8"');
      return res.status(401).send('Autenticación requerida');
    }
    res.set('Cache-Control', 'no-store');
    next();
  }
  app.use('/admin', requiereAdmin);

  const hoyChile = () => ahoraEnZona(config.zonaHoraria, ahora()).fecha;

  app.get('/admin', (_req, res) => {
    res.send(vistas.panel({ leads: db.listarLeads(), visitas: db.listarVisitas(hoyChile()), firmaDe: notif.firmaRevision, config }));
  });

  app.get('/admin/calendario', (req, res) => {
    const desplazamiento = Math.max(-52, Math.min(52, parseInt(req.query.semana, 10) || 0));
    const hoy = hoyChile();
    const lunesActual = sumarDias(hoy, 1 - (new Date(`${hoy}T00:00:00Z`).getUTCDay() || 7));
    const lunes = sumarDias(lunesActual, desplazamiento * 7);
    const viernes = sumarDias(lunes, 4);
    res.send(
      vistas.calendarioPanel({ lunes, hoy, desplazamiento, visitas: db.visitasEntre(lunes, viernes), proximas: db.listarVisitas(hoy), config })
    );
  });

  function leadAdmin(req, res) {
    const lead = db.leadPorId(Number(req.params.id));
    if (!lead) res.status(404).send(vistas.mensaje('No encontrado', 'Ese interesado no existe.', { ...opcVista, icono: '🤷' }));
    return lead;
  }

  app.get('/admin/lead/:id', (req, res) => {
    const lead = leadAdmin(req, res);
    if (!lead) return;
    res.send(
      vistas.fichaAdmin({
        lead,
        documentos: db.documentosDeLead(lead.id),
        visita: db.visitaVigente(lead.id),
        firma: notif.firmaRevision(lead.id),
        config,
      })
    );
  });

  app.get('/admin/documento/:docId', (req, res) => {
    const doc = db.documentoPorId(Number(req.params.docId));
    if (!doc || !fs.existsSync(doc.ruta)) return res.status(404).send('Archivo no encontrado');
    const modo = req.query.descargar ? 'attachment' : 'inline';
    res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${modo}; filename*=UTF-8''${encodeURIComponent(doc.nombre_original)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(doc.ruta).pipe(res);
  });

  // Todos los documentos del interesado en un ZIP, ordenados por requisito (para subirlos a Breal)
  app.get('/admin/lead/:id/documentos.zip', (req, res) => {
    const lead = leadAdmin(req, res);
    if (!lead) return;
    const docs = db.documentosDeLead(lead.id).filter((d) => fs.existsSync(d.ruta));
    if (!docs.length) return res.status(404).send('Este interesado no tiene documentos.');
    const base = `${lead.nombre || 'interesado'} ${lead.rut ? formatearRut(lead.rut) : lead.id}`
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9.-]+/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', (e) => {
      console.error('[zip]', e);
      res.destroy(e);
    });
    zip.pipe(res);
    const usados = new Map();
    const orden = REQUISITOS[lead.tipo]?.documentos.map((d) => d.campo) || [];
    for (const d of docs) {
      const n = orden.indexOf(d.requisito) + 1 || 9;
      const carpeta = `${n} - ${nombreRequisito(d.requisito).replace(/[\\/:*?"<>|]/g, '-')}`;
      let nombre = `${carpeta}/${d.nombre_original}`;
      const repetido = usados.get(nombre) || 0;
      usados.set(nombre, repetido + 1);
      if (repetido) nombre = nombre.replace(/(\.[^./]+)?$/, ` (${repetido + 1})$1`);
      zip.file(d.ruta, { name: nombre });
    }
    zip.finalize();
  });

  app.use((_req, res) => res.status(404).send(vistas.mensaje('Página no encontrada', 'La página que buscas no existe.', { ...opcVista, icono: '🤷' })));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).send(vistas.mensaje('Ocurrió un error', 'Intenta nuevamente en unos minutos.', { ...opcVista, icono: '⚠️' }));
  });

  return app;
}

module.exports = { crearApp };
