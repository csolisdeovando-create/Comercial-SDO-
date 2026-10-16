const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');

const { REQUISITOS, TIPOS, PREFIJO_COMP, esComplemento, todosLosCampos, nombreRequisito } = require('./requisitos');
const { construirCalendario, bloqueValido, ahoraEnZona, describirBloque, sumarDias } = require('./agenda');
const { firmaValida, detectarPortal, extraerUrl } = require('./whatsapp');
const { crearNotificaciones } = require('./notificaciones');
const { interpretarUrl, leerPublicacion, resumenPropiedad } = require('./publicacion');
const { esc, formatearRut, rutValido, limpiarRut, normalizarTelefono, emailValido, firmar, firmaCorrecta } = require('./utils');
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

  // Recordatorio por correo (y WhatsApp si está conectado) el día anterior a la visita, desde las 10:00
  app.locals.enviarRecordatorios = async () => {
    const { fecha: hoy, minutos } = ahoraEnZona(config.zonaHoraria, ahora());
    if (minutos < 10 * 60) return 0;
    let enviados = 0;
    for (const visita of db.visitasParaRecordar(sumarDias(hoy, 1))) {
      const lead = db.leadPorId(visita.lead_id);
      // Si agendó hace menos de 12 horas, ya tiene la confirmación fresca
      const creada = new Date(`${visita.created_at.replace(' ', 'T')}Z`).getTime();
      if (!lead?.email || ahora().getTime() - creada < 12 * 3600 * 1000) {
        db.marcarRecordatorio(visita.id);
        continue;
      }
      try {
        await notif.recordatorioVisita(lead, visita);
        db.marcarRecordatorio(visita.id);
        enviados++;
      } catch (e) {
        console.error('[recordatorio] no se pudo enviar:', e.message);
      }
    }
    return enviados;
  };

  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // Los links personales (/agendar/<token>) no se filtran a otros sitios
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  // Límite simple de solicitudes por IP (evita abusos del formulario)
  function limitar(maximo, ventanaMs) {
    const registro = new Map();
    return (req, res, next) => {
      const ahoraMs = Date.now();
      const ip = req.ip || 'desconocida';
      const recientes = (registro.get(ip) || []).filter((t) => ahoraMs - t < ventanaMs);
      if (recientes.length >= maximo) {
        return res
          .status(429)
          .send(vistas.mensaje('Demasiados intentos', 'Espera unos minutos e inténtalo nuevamente.', { ...opcVista, icono: '⏳' }));
      }
      recientes.push(ahoraMs);
      registro.set(ip, recientes);
      if (registro.size > 5000) registro.clear();
      next();
    };
  }
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
      // Mientras WhatsApp no esté conectado, no se acepta nada en esta dirección
      if (!whatsapp.configurado) return res.sendStatus(404);
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
    if (lead && ['no_continua', 'cerrado'].includes(lead.estado)) lead = null;
    const portal = detectarPortal(texto);
    const pub = interpretarUrl(extraerUrl(texto));
    const url_publicacion = pub?.url || null;
    const propiedad = resumenPropiedad(pub) || (portal ? texto.slice(0, 300) : null);
    if (!lead) {
      lead = db.crearLead({ telefono, nombre: nombrePerfil || null, portal: portal || pub?.portal || null, propiedad, url_publicacion, mensaje_inicial: texto.slice(0, 1000) });
    } else if (lead.estado === 'contactado' && (portal || propiedad)) {
      // Nueva consulta por otra propiedad antes de postular: se actualiza el interés
      lead = db.actualizarLead(lead.id, {
        portal: portal || pub?.portal || lead.portal,
        propiedad: propiedad || lead.propiedad,
        url_publicacion: url_publicacion || lead.url_publicacion,
      });
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
    if (lead && ['aprobado', 'agendado', 'no_asistio'].includes(lead.estado)) return res.redirect(`/agendar/${lead.token}`);
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

  // Lee la propiedad desde el link de la publicación (lo usa el formulario al pegar el link)
  app.get('/api/publicacion', limitar(60, 60 * 1000), async (req, res) => {
    const info = await leerPublicacion(String(req.query.url || '').slice(0, 2000));
    if (!info) return res.status(422).json({ ok: false, error: 'No es un link válido.' });
    res.json({ ok: true, ...info, resumen: resumenPropiedad(info) });
  });
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
      // Complemento de renta: mismos datos básicos y mismos documentos según su tipo
      const complementa = b.complementa === '1';
      const compTipo = complementa ? (TIPOS.includes(b.comp_tipo) ? b.comp_tipo : null) : null;
      if (complementa) {
        if (!compTipo) errores.push('Indica si quien complementa renta es dependiente o independiente.');
        if (!String(b.comp_nombre || '').trim()) errores.push('Ingresa el nombre de quien complementa renta.');
        if (!rutValido(b.comp_rut)) errores.push('El RUT de quien complementa renta no es válido.');
        else if (limpiarRut(b.comp_rut) === limpiarRut(b.rut)) errores.push('Quien complementa renta debe ser otra persona (el RUT es el mismo).');
        if (b.comp_email && !emailValido(b.comp_email)) errores.push('El correo de quien complementa renta no es válido.');
        if (compTipo && !err) {
          for (const d of REQUISITOS[compTipo].documentos) {
            if (!req.files?.[PREFIJO_COMP + d.campo]?.length) errores.push(`Falta adjuntar (complemento): ${d.nombre}.`);
          }
        }
      }

      if (errores.length) {
        borrarTemporales(req);
        return res.status(422).send(vistas.formularioPostulacion({ lead, valores: { ...b, telefono }, errores, config }));
      }

      // Sin link personal: se busca si esta persona ya postuló (mismo teléfono o RUT)
      let actualizacion = false;
      if (!lead) {
        const email = String(b.email).trim().toLowerCase();
        const previo = db.leadPorTelefono(telefono) || db.leadPorRut(limpiarRut(b.rut));
        const mismoCorreo = previo && (!previo.email || previo.email === email);
        if (previo && ['contactado', 'rechazado'].includes(previo.estado) && mismoCorreo) {
          lead = previo;
        } else if (previo && previo.estado === 'documentos_recibidos' && mismoCorreo) {
          // Vuelve a enviar mientras está en revisión: se suman los documentos a la misma postulación
          lead = previo;
          actualizacion = true;
        } else if (previo && ['aprobado', 'agendado', 'no_asistio'].includes(previo.estado) && mismoCorreo) {
          // Ya aprobado: no se duplica; se le reenvía su link del calendario al correo registrado
          borrarTemporales(req);
          await notif.enviarAgenda(previo, { soloCorreo: true }).catch((e) => console.error('[postulacion] reenvío agenda:', e));
          return res.send(
            vistas.mensaje(
              'Ya tienes una postulación aprobada',
              `Te reenviamos a <strong>${esc(previo.email)}</strong> el link para ${previo.estado === 'agendado' ? 'ver o cambiar tu visita' : 'agendar tu visita'}.`,
              { ...opcVista, icono: '📬' }
            )
          );
        } else {
          lead = db.crearLead({ telefono, portal: 'Formulario web' });
        }
      }

      const pub = b.url_publicacion ? await leerPublicacion(String(b.url_publicacion).slice(0, 2000), { timeoutMs: 3000 }) : null;
      const estado = config.agenda.automatica ? 'aprobado' : 'documentos_recibidos';
      lead = db.actualizarLead(lead.id, {
        tipo,
        nombre: String(b.nombre).trim().slice(0, 150),
        rut: limpiarRut(b.rut),
        email: String(b.email).trim().toLowerCase(),
        telefono,
        razon_social: tipo === 'independiente' ? String(b.razon_social || '').trim().slice(0, 150) || null : null,
        rut_empresa: tipo === 'independiente' && b.rut_empresa ? limpiarRut(b.rut_empresa) : null,
        propiedad: String(b.propiedad || '').trim().slice(0, 300) || resumenPropiedad(pub) || lead.propiedad,
        url_publicacion: pub?.url || lead.url_publicacion || null,
        portal: !lead.portal || lead.portal === 'Formulario web' ? pub?.portal || lead.portal : lead.portal,
        comentarios: String(b.comentarios || '').trim().slice(0, 2000) || null,
        complementa: complementa ? 1 : 0,
        comp_tipo: compTipo,
        comp_nombre: complementa ? String(b.comp_nombre).trim().slice(0, 150) : null,
        comp_rut: complementa ? limpiarRut(b.comp_rut) : null,
        comp_email: complementa && b.comp_email ? String(b.comp_email).trim().toLowerCase() : null,
        comp_telefono: complementa && b.comp_telefono ? normalizarTelefono(b.comp_telefono) : null,
        comp_relacion: complementa ? String(b.comp_relacion || '').trim().slice(0, 80) || null : null,
        estado,
        motivo_rechazo: null,
        documentos_at: new Date().toISOString(),
        aprobado_at: config.agenda.automatica ? new Date().toISOString() : null,
      });

      // Mueve los archivos a la carpeta del lead
      const carpeta = path.join(config.uploadsDir, String(lead.id));
      fs.mkdirSync(carpeta, { recursive: true });
      const documentos = [];
      const campos = [
        ...REQUISITOS[tipo].documentos.map((d) => d.campo),
        ...(compTipo ? REQUISITOS[compTipo].documentos.map((d) => PREFIJO_COMP + d.campo) : []),
      ];
      for (const campo of campos) {
        for (const f of req.files[campo] || []) {
          const destino = path.join(carpeta, path.basename(f.path));
          fs.renameSync(f.path, destino);
          const doc = {
            lead_id: lead.id,
            requisito: campo,
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
        await notif.documentosRecibidos(lead, documentos, { actualizacion });
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
  const limitePostular = limitar(10, 60 * 60 * 1000);
  app.post('/postular', limitePostular, recibirPostulacion);
  app.post('/postular/:token', limitePostular, recibirPostulacion);

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
  const puedeAgendar = (lead) => ['aprobado', 'agendado', 'no_asistio'].includes(lead.estado);

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
  // Confirmación de asistencia (desde el recordatorio)
  // ------------------------------------------------------------------
  // GET solo muestra el botón: los antivirus de correo que abren links no confirman nada
  app.get('/visita/:token/confirmar', (req, res) => {
    const lead = leadDesdeToken(req, res);
    if (!lead) return;
    const visita = db.visitaVigente(lead.id);
    if (!visita) return res.redirect(`/agendar/${lead.token}`);
    const cuando = describirBloque(visita.fecha, visita.hora);
    if (visita.confirmada_at) {
      return res.send(vistas.mensaje('Visita confirmada', `Ya confirmaste tu visita del <strong>${esc(cuando)}</strong>. ¡Te esperamos!`, { ...opcVista, icono: '✅' }));
    }
    res.send(
      vistas.mensaje('Confirma tu visita', `<strong>${esc(cuando)}</strong>${lead.propiedad ? `<br>🏠 ${esc(lead.propiedad)}` : ''}`, {
        ...opcVista,
        icono: '📅',
        extra: `<form method="post" class="acciones-centradas"><button class="boton primario grande">✅ Sí, confirmo mi asistencia</button></form>
          <p><a class="boton" href="/agendar/${lead.token}">📅 No puedo, quiero reagendar</a></p>`,
      })
    );
  });

  app.post('/visita/:token/confirmar', async (req, res) => {
    const lead = leadDesdeToken(req, res);
    if (!lead) return;
    const visita = db.visitaVigente(lead.id);
    if (!visita) return res.redirect(303, `/agendar/${lead.token}`);
    if (!visita.confirmada_at) {
      db.confirmarAsistencia(visita.id);
      const actualizada = db.visitaVigente(lead.id);
      await notif.asistenciaConfirmada(lead, actualizada).catch((e) => console.error('[confirmar] aviso al equipo:', e));
    }
    res.redirect(303, `/visita/${lead.token}/confirmar`);
  });

  // ------------------------------------------------------------------
  // Panel interno (usuario/clave)
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Inicio de sesión del panel (página propia + cookie). Funciona también como app
  // en la pantalla de inicio del iPhone, donde la ventana de usuario/clave del navegador no aparece.
  // ------------------------------------------------------------------
  const COOKIE = 'sdo_sesion';
  const DURACION_SESION = 30 * 24 * 3600; // segundos
  const huellaClave = () => crypto.createHash('sha256').update(config.admin.clave).digest('hex').slice(0, 16);
  // Incluye la clave: si se cambia ADMIN_CLAVE, todas las sesiones abiertas se cierran
  const firmaSesion = (exp) => firmar(config.secret, 'sesion', config.admin.usuario, huellaClave(), exp);

  function leerCookies(req) {
    const out = {};
    for (const par of String(req.get('cookie') || '').split(';')) {
      const i = par.indexOf('=');
      if (i > 0) out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
    }
    return out;
  }

  function sesionValida(req) {
    const [exp, firma] = String(leerCookies(req)[COOKIE] || '').split('.');
    if (!exp || !firma || Number(exp) < Date.now() / 1000) return false;
    return firmaCorrecta(config.secret, firma, 'sesion', config.admin.usuario, huellaClave(), exp);
  }

  function igualSeguro(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  // Compatibilidad: también acepta usuario/clave enviados por el navegador (Basic)
  function basicValido(req) {
    const [tipo, valor] = String(req.get('authorization') || '').split(' ');
    if (tipo !== 'Basic') return false;
    const [u, ...c] = Buffer.from(valor || '', 'base64').toString().split(':');
    return u === config.admin.usuario && igualSeguro(c.join(':'), config.admin.clave);
  }

  const destinoSeguro = (v) => (/^\/admin(\/[^\s]*)?$/.test(String(v || '')) && !String(v).startsWith('//') ? String(v) : '/admin');

  app.get('/ingresar', (req, res) => {
    if (config.admin.clave && sesionValida(req)) return res.redirect(303, destinoSeguro(req.query.volver));
    res.set('Cache-Control', 'no-store');
    res.send(vistas.ingresar({ volver: destinoSeguro(req.query.volver), config }));
  });

  app.post('/ingresar', limitar(10, 15 * 60 * 1000), express.urlencoded({ extended: false }), (req, res) => {
    if (!config.admin.clave) return res.status(503).send('Configura ADMIN_CLAVE para habilitar el panel.');
    const volver = destinoSeguro(req.body?.volver);
    const ok = String(req.body?.usuario || '').trim() === config.admin.usuario && igualSeguro(req.body?.clave || '', config.admin.clave);
    if (!ok) {
      return res.status(401).send(vistas.ingresar({ volver, error: 'Usuario o clave incorrectos.', usuario: req.body?.usuario, config }));
    }
    const exp = Math.floor(Date.now() / 1000) + DURACION_SESION;
    res.cookie(COOKIE, `${exp}.${firmaSesion(exp)}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: DURACION_SESION * 1000,
      path: '/',
    });
    res.redirect(303, volver);
  });

  app.get('/salir', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(303, '/ingresar');
  });

  function requiereAdmin(req, res, next) {
    if (!config.admin.clave) return res.status(503).send('Configura ADMIN_CLAVE para habilitar el panel.');
    if (!sesionValida(req) && !basicValido(req)) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        return res.redirect(303, `/ingresar?volver=${encodeURIComponent(req.originalUrl)}`);
      }
      return res.status(401).send('Debes iniciar sesión.');
    }
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Las acciones del panel solo se aceptan desde el propio panel (evita que otra página las dispare)
      const origen = req.get('origin') || req.get('referer') || '';
      let hostOrigen = '';
      try {
        hostOrigen = new URL(origen).host;
      } catch {}
      if (hostOrigen !== req.get('host')) return res.status(403).send('Acción no permitida desde otro sitio.');
    }
    next();
  }
  app.use('/admin', requiereAdmin);

  const hoyChile = () => ahoraEnZona(config.zonaHoraria, ahora()).fecha;

  const sinTildes = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  app.get('/admin', (req, res) => {
    const eliminado = req.query.eliminado ? String(req.query.eliminado).slice(0, 150) : null;
    const filtros = { q: String(req.query.q || '').trim().slice(0, 100), estado: String(req.query.estado || '') };
    const todos = db.listarLeads(5000);
    let leads = todos;
    if (filtros.estado && vistas.ETIQUETAS_ESTADO[filtros.estado]) leads = leads.filter((l) => l.estado === filtros.estado);
    if (filtros.q) {
      const q = sinTildes(filtros.q);
      const qRut = limpiarRut(filtros.q);
      leads = leads.filter(
        (l) =>
          sinTildes([l.nombre, l.email, l.telefono, l.propiedad, l.razon_social, l.portal].join(' ')).includes(q) ||
          (qRut.length >= 4 && (l.rut || '').includes(qRut))
      );
    }
    res.send(vistas.panel({ leads: leads.slice(0, 300), todos, visitas: db.listarVisitas(hoyChile()), hoy: hoyChile(), filtros, eliminado, config }));
  });

  // Planilla para Excel (separador ";" y BOM para que Excel en español abra bien los acentos)
  app.get('/admin/exportar.csv', (_req, res) => {
    const celda = (v) => {
      let t = String(v ?? '');
      if (/^[=+\-@]/.test(t)) t = `'${t}`; // evita fórmulas
      return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const filas = [
      ['N°', 'Fecha postulación', 'Nombre', 'RUT', 'Tipo', 'Razón social', 'Correo', 'Teléfono', 'Propiedad', 'Link aviso', 'Origen', 'Estado', 'Visita', 'Resultado visita', 'Documentos', 'Complementa renta'],
      ...db.listarLeads(100000).map((l) => [
        l.id,
        (l.documentos_at || l.created_at || '').slice(0, 10),
        l.nombre,
        l.rut ? formatearRut(l.rut) : '',
        REQUISITOS[l.tipo]?.etiqueta || '',
        l.razon_social,
        l.email,
        l.telefono ? `+${l.telefono}` : '',
        l.propiedad,
        l.url_publicacion,
        l.portal,
        vistas.ETIQUETAS_ESTADO[l.estado] || l.estado,
        l.visita ? describirBloque(...l.visita.split(' ').map((x, i) => (i ? Number(x) : x))) : '',
        l.resultado_visita ? vistas.RESULTADO_VISITA[l.resultado_visita].replace(/^\S+\s/, '') : '',
        l.n_documentos,
        l.complementa ? `${l.comp_nombre || ''} (${l.comp_rut ? formatearRut(l.comp_rut) : ''})` : '',
      ]),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="interesados-sdo-${hoyChile()}.csv"`);
    res.send('\uFEFF' + filas.map((f) => f.map(celda).join(';')).join('\r\n'));
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
        visita: db.ultimaVisita(lead.id),
        firma: notif.firmaRevision(lead.id),
        aviso: AVISOS[req.query.ok] || null,
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
    const ordenComp = REQUISITOS[lead.comp_tipo]?.documentos.map((d) => PREFIJO_COMP + d.campo) || [];
    const limpiar = (t) => String(t).replace(/[\\/:*?"<>|]/g, '-');
    for (const d of docs) {
      const comp = esComplemento(d.requisito);
      const n = (comp ? ordenComp : orden).indexOf(d.requisito) + 1 || 9;
      const nombreReq = nombreRequisito(comp ? d.requisito.slice(PREFIJO_COMP.length) : d.requisito);
      const carpeta = `${comp ? `Complemento renta - ${limpiar(lead.comp_nombre || 'complemento')}/` : ''}${n} - ${limpiar(nombreReq)}`;
      let nombre = `${carpeta}/${d.nombre_original}`;
      const repetido = usados.get(nombre) || 0;
      usados.set(nombre, repetido + 1);
      if (repetido) nombre = nombre.replace(/(\.[^./]+)?$/, ` (${repetido + 1})$1`);
      zip.file(d.ruta, { name: nombre });
    }
    zip.finalize();
  });


  const AVISOS = {
    resultado: 'Resultado de la visita guardado.',
    cancelada: 'Visita cancelada. El horario quedó libre.',
    cancelada_aviso: 'Visita cancelada. Le enviamos al interesado el link para elegir otro horario.',
  };
  const RESULTADOS = { realizada: 'visitado', no_asistio: 'no_asistio', no_continua: 'no_continua' };
  const formAdmin = express.urlencoded({ extended: false });

  app.post('/admin/lead/:id/visita', formAdmin, (req, res) => {
    const lead = leadAdmin(req, res);
    if (!lead) return;
    const resultado = String(req.body?.resultado || '');
    const visita = db.ultimaVisita(lead.id);
    if (!RESULTADOS[resultado] || !visita || visita.estado !== 'confirmada') return res.redirect(303, `/admin/lead/${lead.id}#visita`);
    db.registrarResultadoVisita(visita.id, resultado, String(req.body?.notas || '').trim().slice(0, 2000));
    db.actualizarLead(lead.id, { estado: RESULTADOS[resultado] });
    res.redirect(303, `/admin/lead/${lead.id}?ok=resultado#visita`);
  });

  app.post('/admin/lead/:id/visita/cancelar', formAdmin, async (req, res) => {
    let lead = leadAdmin(req, res);
    if (!lead) return;
    const visita = db.visitaVigente(lead.id);
    if (!visita) return res.redirect(303, `/admin/lead/${lead.id}#visita`);
    db.cancelarVisita(visita.id);
    lead = db.actualizarLead(lead.id, { estado: 'aprobado' });
    await notif.eventoCancelado(lead, visita, 'Cancelada desde el panel comercial.').catch((e) => console.error('[panel] cancelar evento:', e));
    const avisar = Boolean(req.body?.avisar);
    if (avisar) await notif.visitaCancelada(lead, visita).catch((e) => console.error('[panel] aviso cancelación:', e));
    res.redirect(303, `/admin/lead/${lead.id}?ok=${avisar ? 'cancelada_aviso' : 'cancelada'}#visita`);
  });

  app.get('/admin/lead/:id/eliminar', (req, res) => {
    const lead = leadAdmin(req, res);
    if (!lead) return;
    res.send(vistas.confirmarEliminar({ lead, documentos: db.documentosDeLead(lead.id), visita: db.visitaVigente(lead.id), config }));
  });

  app.post('/admin/lead/:id/eliminar', formAdmin, async (req, res) => {
    const lead = leadAdmin(req, res);
    if (!lead) return;
    if (!req.body?.confirmo) return res.redirect(303, `/admin/lead/${lead.id}/eliminar`);
    const visitaVigente = db.visitaVigente(lead.id);
    if (visitaVigente) {
      await notif.eventoCancelado(lead, visitaVigente, 'El interesado fue eliminado del sistema.').catch((e) => console.error('[panel] cancelar evento:', e));
    }
    const rutas = db.eliminarLead(lead.id);
    for (const r of rutas) fs.rmSync(r, { force: true });
    fs.rmSync(path.join(config.uploadsDir, String(lead.id)), { recursive: true, force: true });
    res.redirect(303, `/admin?eliminado=${encodeURIComponent(lead.nombre || `#${lead.id}`)}`);
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
