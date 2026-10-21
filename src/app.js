const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');

const { REQUISITOS, TIPOS, PREFIJO_COMP, esComplemento, todosLosCampos, nombreRequisito } = require('./requisitos');
const { construirCalendario, bloqueValido, ahoraEnZona, describirBloque, sumarDias, horasDe } = require('./agenda');
const { firmaValida, detectarPortal, extraerUrl } = require('./whatsapp');
const { crearNotificaciones } = require('./notificaciones');
const { interpretarUrl, leerPublicacion, resumenPropiedad, pareceLink, faltaDireccion } = require('./publicacion');
const { validarPersona, CAMPOS_PERSONA, filasPersona, PLAZOS_CAMBIO } = require('./personas');
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
  // El service worker debe servirse desde la raíz para cubrir todo el sitio
  app.get('/sw.js', (_req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
  });
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
    limits: { fileSize: config.archivos.maxMB * 1024 * 1024, files: 60, fields: 150 },
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
      const titular = validarPersona(b, '', '', ahora());
      errores.push(...titular.errores);
      const plazoCambio = PLAZOS_CAMBIO[b.plazo_cambio] ? b.plazo_cambio : null;
      if (!plazoCambio) errores.push('Indica para cuándo te quieres cambiar.');
      // Pegó el link en la dirección: se mueve al campo del link y se le pide la dirección
      if (pareceLink(b.propiedad)) {
        if (!String(b.url_publicacion || '').trim()) b.url_publicacion = String(b.propiedad).trim();
        b.propiedad = '';
        errores.push('En "Dirección de la propiedad" escribe la dirección (calle, número y comuna). El link del aviso va en el campo de arriba.');
      } else if (!String(b.propiedad || '').trim()) {
        errores.push('Ingresa la dirección de la propiedad que quieres arrendar.');
      }
      if (!interpretarUrl(String(b.url_publicacion || '').slice(0, 2000))) {
        errores.push('Pega el link del aviso de la propiedad que te interesa (Mercado Libre, Yapo, Portal Inmobiliario…).');
      }
      const soloLetras = (t) => sinTildes(t).replace(/[^a-z0-9]/g, '');
      const dirPropiedad = soloLetras(b.propiedad);
      const dirActual = soloLetras(b.direccion_actual);
      if (dirPropiedad.length >= 6 && dirActual.length >= 6 && (dirPropiedad.includes(dirActual) || dirActual.includes(dirPropiedad))) {
        errores.push('En "Dirección de la propiedad" va la dirección de la propiedad que quieres arrendar (la del aviso), no tu dirección actual.');
      }
      if (b.rut_empresa && !rutValido(b.rut_empresa)) errores.push('El RUT de la empresa no es válido.');
      const telefono = titular.telefono;
      if (!b.consentimiento) errores.push('Debes autorizar el uso de tus datos para evaluar la postulación.');
      if (tipo && !err) {
        for (const d of REQUISITOS[tipo].documentos) {
          if (!req.files?.[d.campo]?.length) errores.push(`Falta adjuntar: ${d.nombre}.`);
        }
      }
      // Complemento de renta: mismos datos básicos y mismos documentos según su tipo
      const complementa = b.complementa === '1';
      const compTipo = complementa ? (TIPOS.includes(b.comp_tipo) ? b.comp_tipo : null) : null;
      const compRol = b.comp_rol === 'aval' ? 'aval' : 'complemento';
      const quienComp = compRol === 'aval' ? 'quien es aval' : 'quien complementa renta';
      let comp = null;
      if (complementa) {
        if (!compTipo) errores.push(`Indica si ${quienComp} es dependiente o independiente.`);
        comp = validarPersona(b, PREFIJO_COMP, quienComp, ahora());
        errores.push(...comp.errores);
        if (comp.datos.comp_rut && comp.datos.comp_rut === titular.datos.rut) {
          errores.push(`${quienComp.charAt(0).toUpperCase()}${quienComp.slice(1)} debe ser otra persona (el documento es el mismo).`);
        }
        if (compTipo && !err) {
          for (const d of REQUISITOS[compTipo].documentos) {
            if (!req.files?.[PREFIJO_COMP + d.campo]?.length) errores.push(`Falta adjuntar (${compRol === 'aval' ? 'aval' : 'complemento'}): ${d.nombre}.`);
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
        const email = titular.datos.email;
        const previo = db.leadPorTelefono(telefono) || db.leadPorRut(titular.datos.rut);
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
        ...titular.datos,
        razon_social: tipo === 'independiente' ? String(b.razon_social || '').trim().slice(0, 150) || null : null,
        rut_empresa: tipo === 'independiente' && b.rut_empresa ? limpiarRut(b.rut_empresa) : null,
        propiedad: String(b.propiedad || '').trim().slice(0, 300) || resumenPropiedad(pub) || lead.propiedad,
        url_publicacion: pub?.url || lead.url_publicacion || null,
        plazo_cambio: plazoCambio,
        portal: !lead.portal || lead.portal === 'Formulario web' ? pub?.portal || lead.portal : lead.portal,
        comentarios: String(b.comentarios || '').trim().slice(0, 2000) || null,
        complementa: complementa ? 1 : 0,
        comp_tipo: compTipo,
        // Quien complementa renta o es aval (si no marcó la casilla, se limpian sus datos)
        ...Object.fromEntries(CAMPOS_PERSONA.map((c) => [PREFIJO_COMP + c, comp ? comp.datos[PREFIJO_COMP + c] : null])),
        comp_rol: complementa ? compRol : null,
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

  // Botones para volver después de revisar
  const botonesRevision = (lead) =>
    `<p class="acciones-centradas"><a class="boton primario" href="/admin">Volver al panel</a> <a class="boton" href="/admin/lead/${lead.id}">Ver ficha de ${esc((lead.nombre || 'interesado').split(' ')[0])}</a></p>`;

  // Resultado de la revisión (se llega con una redirección: volver atrás o recargar no repite la acción)
  const RESULTADOS_REVISION = {
    aprobada: ['Postulación aprobada', '✅', (l) => `Se envió a ${esc(l.nombre)} el calendario para agendar su visita (${esc(l.email)}${l.telefono ? ` y WhatsApp +${esc(l.telefono)}` : ''}).`],
    rechazada: ['Respuesta enviada', '📨', (l) => `Se informó a ${esc(l.nombre)} por correo${l.telefono ? ' y WhatsApp' : ''}.`],
    ya_aprobada: ['Ya estaba aprobada', '👍', (l) => `La postulación de ${esc(l.nombre)} ya fue aprobada anteriormente. No se envió nada nuevo.`],
    ya_rechazada: ['Respuesta ya enviada', '📨', (l) => `Ya se le había enviado esta respuesta a ${esc(l.nombre)}. No se envió nada nuevo.`],
    no_rechazable: ['No se puede rechazar', 'ℹ️', (l) => `La postulación de ${esc(l.nombre)} ya está aprobada. Si no continúa, márcalo en su ficha.`],
  };

  app.get('/revision/:id/resultado', (req, res) => {
    const lead = leadRevision(req, res);
    if (!lead) return;
    const [titulo, icono, texto] = RESULTADOS_REVISION[req.query.r] || RESULTADOS_REVISION.ya_aprobada;
    res.send(vistas.mensaje(titulo, texto(lead), { ...opcVista, icono, extra: botonesRevision(lead) }));
  });

  const irResultado = (res, lead, firma, r) =>
    res.redirect(303, `/revision/${lead.id}/resultado?firma=${encodeURIComponent(firma)}&r=${r}`);
  const yaAprobado = (lead) => ['aprobado', 'agendado', 'no_asistio', 'visitado'].includes(lead.estado);

  // GET solo muestra la confirmación: así los antivirus de correo que "visitan" links no aprueban nada
  app.get('/revision/:id/:accion', (req, res) => {
    if (!['aprobar', 'rechazar'].includes(req.params.accion)) return res.sendStatus(404);
    const lead = leadRevision(req, res);
    if (!lead) return;
    // Si ya se resolvió, se informa en vez de volver a mostrar el botón
    if (yaAprobado(lead)) return irResultado(res, lead, req.query.firma, req.params.accion === 'aprobar' ? 'ya_aprobada' : 'no_rechazable');
    res.send(vistas.revision({ lead, documentos: db.documentosDeLead(lead.id), accion: req.params.accion, firma: req.query.firma, config }));
  });

  app.post('/revision/:id/:accion', express.urlencoded({ extended: false }), async (req, res) => {
    const { accion } = req.params;
    if (!['aprobar', 'rechazar'].includes(accion)) return res.sendStatus(404);
    let lead = leadRevision(req, res);
    if (!lead) return;
    const firma = req.query.firma;

    if (accion === 'aprobar') {
      if (yaAprobado(lead)) return irResultado(res, lead, firma, 'ya_aprobada');
      lead = db.actualizarLead(lead.id, { estado: 'aprobado', aprobado_at: new Date().toISOString(), motivo_rechazo: null });
      await notif.enviarAgenda(lead).catch((e) => console.error('[revision] envío agenda:', e));
      return irResultado(res, lead, firma, 'aprobada');
    }

    if (yaAprobado(lead)) return irResultado(res, lead, firma, 'no_rechazable');
    const motivo = String(req.body?.motivo || '').trim().slice(0, 2000);
    if (!motivo) return res.redirect(303, `/revision/${lead.id}/rechazar?firma=${encodeURIComponent(firma)}`);
    // Mismo rechazo enviado de nuevo (doble clic, volver atrás): no se repite el aviso
    if (['rechazado', 'cerrado'].includes(lead.estado) && lead.motivo_rechazo === motivo) return irResultado(res, lead, firma, 'ya_rechazada');
    const reenviar = Boolean(req.body?.reenviar);
    lead = db.actualizarLead(lead.id, { estado: reenviar ? 'rechazado' : 'cerrado', motivo_rechazo: motivo });
    await notif.rechazo(lead, motivo, reenviar).catch((e) => console.error('[revision] envío rechazo:', e));
    irResultado(res, lead, firma, 'rechazada');
  });

  // ------------------------------------------------------------------
  // Agenda de visitas
  // ------------------------------------------------------------------
  const puedeAgendar = (lead) => ['aprobado', 'agendado', 'no_asistio'].includes(lead.estado);

  // Calendario con horarios ocupados (visitas + bloqueos del equipo)
  function calendarioDisponible() {
    const base = construirCalendario(cfgAgenda, new Map(), ahora());
    const ocupacion = db.ocupacionBloques(base.desde, base.hasta, (f) => horasDe(cfgAgenda, f), DURACION_HORAS);
    return construirCalendario(cfgAgenda, ocupacion, ahora());
  }

  function mostrarCalendario(res, lead, error, status = 200) {
    res.status(status).send(vistas.calendario({ lead, cal: calendarioDisponible(), visita: db.visitaVigente(lead.id), error, config }));
  }

  // Reserva un bloque para el interesado (usada por el interesado y por el equipo). Devuelve { visita, anterior } o un error.
  // Horas que dura una visita: nunca se agenda otra que se cruce con ella
  const DURACION_HORAS = Math.max(1, Math.ceil(config.agenda.duracionMinutos / 60));

  function reservar(lead, fecha, hora) {
    if (!horasDe(cfgAgenda, fecha).includes(hora) || !bloqueValido(cfgAgenda, fecha, hora, ahora())) return { error: 'invalido' };
    const anterior = db.visitaVigente(lead.id);
    if (anterior && anterior.fecha === fecha && anterior.hora === hora) return { visita: anterior, anterior, sinCambio: true };
    let visita = null;
    try {
      visita = db.transaccion(() => {
        if (db.contarBloque(fecha, hora, DURACION_HORAS, lead.id) >= config.agenda.cuposPorBloque) return null;
        db.cancelarVisitasDeLead(lead.id);
        return db.crearVisita(lead.id, fecha, hora);
      });
    } catch (e) {
      console.error('[agenda] error al reservar:', e);
    }
    return visita ? { visita, anterior } : { error: 'ocupado' };
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
    const r = reservar(lead, fecha, Number(horaTxt));
    if (r.error === 'invalido') return mostrarCalendario(res, lead, 'Selecciona un horario válido.', 422);
    if (r.error) return mostrarCalendario(res, lead, 'Ese horario se acaba de ocupar. Por favor elige otro.', 409);
    if (r.sinCambio) return res.redirect(303, `/agendar/${lead.token}/listo`);

    lead = db.actualizarLead(lead.id, { estado: 'agendado' });
    await notif.visitaAgendada(lead, r.visita, { anterior: r.anterior }).catch((e) => console.error('[agenda] notificación:', e));
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
      ['N°', 'Fecha postulación', 'Nombre', 'RUT', 'Tipo', 'Razón social', 'Correo', 'Teléfono', 'Propiedad de interés', 'Link de publicación', 'Origen', 'Estado', 'Visita', 'Resultado visita', 'Documentos', 'Complementa renta / aval', 'Documento', 'Nacionalidad', 'Fecha nacimiento', 'Estado civil', 'Profesión', 'Dirección actual', 'Comuna', 'Fecha de cambio'],
      ...db.listarLeads(100000).map((l) => [
        l.id,
        (l.documentos_at || l.created_at || '').slice(0, 10),
        l.nombre,
        l.rut ? (l.doc_tipo === 'pasaporte' ? l.rut : formatearRut(l.rut)) : '',
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
        l.complementa ? `${l.comp_rol === 'aval' ? 'Aval' : 'Complementa'}: ${l.comp_nombre || ''} (${l.comp_rut ? (l.comp_doc_tipo === 'pasaporte' ? l.comp_rut : formatearRut(l.comp_rut)) : ''})` : '',
        l.rut ? (l.doc_tipo === 'pasaporte' ? `Pasaporte ${l.rut}` : formatearRut(l.rut)) : '',
        l.nacionalidad,
        l.fecha_nacimiento,
        l.estado_civil,
        l.profesion,
        l.direccion_actual,
        l.comuna,
        PLAZOS_CAMBIO[l.plazo_cambio] || '',
      ]),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="interesados-sdo-${hoyChile()}.csv"`);
    res.send('\uFEFF' + filas.map((f) => f.map(celda).join(';')).join('\r\n'));
  });

  const formAdmin = express.urlencoded({ extended: false });

  const lunesDe = (fecha) => sumarDias(fecha, 1 - (new Date(`${fecha}T00:00:00Z`).getUTCDay() || 7));
  // Semanas entre la actual y la de `fecha` (para volver al calendario en la semana de la visita)
  const semanaDe = (fecha) => Math.round((Date.parse(lunesDe(fecha)) - Date.parse(lunesDe(hoyChile()))) / (7 * 864e5));

  app.get('/admin/calendario', (req, res) => {
    const desplazamiento = Math.max(-52, Math.min(52, parseInt(req.query.semana, 10) || 0));
    const hoy = hoyChile();
    const lunes = sumarDias(lunesDe(hoy), desplazamiento * 7);
    const sabado = sumarDias(lunes, 5);
    const nueva = req.query.ok === 'manual' ? db.leadPorId(Number(req.query.lead)) : null;
    res.send(
      vistas.calendarioPanel({
        lunes,
        hoy,
        desplazamiento,
        visitas: db.visitasEntre(lunes, sabado),
        bloqueos: db.bloqueosEntre(lunes, sabado),
        proximas: db.listarVisitas(hoy),
        nueva,
        config,
      })
    );
  });

  // Visita agendada por otro medio (teléfono, WhatsApp, portal): se ingresa a mano y queda igual que las demás
  const ORIGENES_MANUALES = ['WhatsApp', 'Llamada telefónica', 'Mercado Libre', 'Yapo', 'Portal Inmobiliario', 'Referido', 'Otro'];
  const HORAS_MANUALES = Array.from({ length: 13 }, (_, i) => i + 8); // 08:00 a 20:00

  const formNuevaVisita = (res, valores, { errores = [], conflicto = null, cruces = [], existente = null, status = 200 } = {}) =>
    res.status(status).send(
      vistas.nuevaVisita({ valores, errores, conflicto, cruces, existente, origenes: ORIGENES_MANUALES, horas: HORAS_MANUALES, hoy: hoyChile(), config })
    );

  app.get('/admin/visita/nueva', (req, res) => {
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '') ? req.query.fecha : hoyChile();
    const hora = HORAS_MANUALES.includes(Number(req.query.hora)) ? Number(req.query.hora) : '';
    formNuevaVisita(res, { fecha, hora, avisar: '1' });
  });

  app.post('/admin/visita/nueva', formAdmin, async (req, res) => {
    const b = req.body || {};
    const txt = (c, max = 150) => String(b[c] || '').trim().slice(0, max);
    const valores = { ...b };
    const errores = [];
    const hoy = hoyChile();
    const nombre = txt('nombre');
    const telefono = normalizarTelefono(b.telefono);
    const email = txt('email', 150).toLowerCase();
    const fecha = txt('fecha', 10);
    const hora = Number(b.hora);
    const origen = ORIGENES_MANUALES.includes(b.origen) ? b.origen : 'Otro';
    if (!nombre) errores.push('Ingresa el nombre del interesado.');
    if (telefono.length < 8) errores.push('Ingresa un teléfono válido (ej: +56 9 1234 5678).');
    if (email && !emailValido(email)) errores.push('El correo no es válido (puedes dejarlo vacío).');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(Date.parse(fecha)) || fecha < sumarDias(hoy, -60) || fecha > sumarDias(hoy, 180)) {
      errores.push('Elige una fecha válida.');
    }
    if (!HORAS_MANUALES.includes(hora)) errores.push('Elige la hora de la visita.');
    if (pareceLink(b.propiedad)) errores.push('En la dirección de la propiedad va la calle y número, no el link del aviso.');
    if (errores.length) return formNuevaVisita(res, valores, { errores, status: 422 });

    // Si ya existe (mismo teléfono) se usa su ficha; si no, se crea una nueva
    let lead = db.leadPorTelefono(telefono);
    const anterior = lead ? db.visitaVigente(lead.id) : null;
    if (anterior && !b.confirmo_existente && !(anterior.fecha === fecha && anterior.hora === hora)) {
      return formNuevaVisita(res, valores, { existente: { lead, visita: anterior }, status: 409 });
    }
    // Nunca se cruza con otra visita ya agendada; un horario bloqueado sí se puede usar si se confirma
    const seCruzaCon = db.cruces(fecha, hora, DURACION_HORAS, lead?.id);
    if (seCruzaCon.length >= config.agenda.cuposPorBloque) {
      return formNuevaVisita(res, valores, { conflicto: 'ocupado', cruces: seCruzaCon, existente: anterior ? { lead, visita: anterior } : null, status: 409 });
    }
    if (db.bloqueado(fecha, hora) && !b.forzar) {
      return formNuevaVisita(res, valores, { conflicto: 'bloqueado', existente: anterior ? { lead, visita: anterior } : null, status: 409 });
    }

    const nota = txt('notas', 1000);
    const propiedad = txt('propiedad', 300);
    const r = db.transaccion(() => {
      if (!lead) {
        lead = db.crearLead({ telefono, nombre, email: email || null, propiedad: propiedad || null, portal: origen, comentarios: nota || null });
      } else {
        lead = db.actualizarLead(lead.id, {
          nombre: lead.nombre || nombre,
          email: lead.email || email || null,
          propiedad: propiedad || lead.propiedad,
          portal: lead.portal || origen,
          comentarios: nota ? [lead.comentarios, `Visita ingresada por el equipo: ${nota}`].filter(Boolean).join('\n') : lead.comentarios,
        });
      }
      if (anterior && anterior.fecha === fecha && anterior.hora === hora) return { visita: anterior, sinCambio: true };
      if (db.cruces(fecha, hora, DURACION_HORAS, lead.id).length >= config.agenda.cuposPorBloque) return { ocupado: true };
      db.cancelarVisitasDeLead(lead.id);
      const visita = db.crearVisita(lead.id, fecha, hora, 'equipo');
      lead = db.actualizarLead(lead.id, { estado: 'agendado' });
      return { visita };
    });

    if (r.ocupado) return formNuevaVisita(res, valores, { conflicto: 'ocupado', cruces: db.cruces(fecha, hora, DURACION_HORAS, lead.id), status: 409 });

    // Avisos: solo visitas de hoy en adelante (una pasada es solo registro)
    if (!r.sinCambio && fecha >= hoy) {
      const avisar = Boolean(b.avisar) && Boolean(lead.email);
      await notif
        .visitaAgendada(lead, r.visita, { anterior, porEquipo: true, avisarInteresado: avisar })
        .catch((e) => console.error('[panel] visita manual:', e));
    }
    res.redirect(303, `/admin/calendario?semana=${semanaDe(fecha)}&ok=manual&lead=${lead.id}`);
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
        disponibles: calendarioDisponible(),
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
    agendada: 'Visita agendada. Se avisó al equipo y se agregó a su calendario.',
    agendada_aviso: 'Visita agendada. Se avisó al equipo y al interesado.',
    reagendada: 'Visita reagendada. El evento del calendario del equipo se movió a la nueva hora.',
    reagendada_aviso: 'Visita reagendada. Se avisó al equipo y al interesado con la nueva hora.',
    bloque_ocupado: 'Ese horario ya está ocupado o bloqueado. Elige otro.',
    bloque_invalido: 'Selecciona un horario válido.',
    propiedad: 'Dirección de la propiedad guardada.',
    propiedad_link: 'No se guardó: en la dirección va la calle y número, no el link del aviso.',
    propiedad_evento: 'Dirección de la propiedad guardada. Se actualizó el evento de la visita en el calendario del equipo.',
  };
  const RESULTADOS = { realizada: 'visitado', no_asistio: 'no_asistio', no_continua: 'no_continua' };

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


  // El equipo agenda o reagenda la visita (por ejemplo, si Julio no puede a esa hora)
  app.post('/admin/lead/:id/visita/agendar', formAdmin, async (req, res) => {
    let lead = leadAdmin(req, res);
    if (!lead) return;
    const [fecha, horaTxt] = String(req.body?.bloque || '').split('|');
    const r = reservar(lead, fecha, Number(horaTxt));
    if (r.error) return res.redirect(303, `/admin/lead/${lead.id}?ok=${r.error === 'ocupado' ? 'bloque_ocupado' : 'bloque_invalido'}#visita`);
    if (r.sinCambio) return res.redirect(303, `/admin/lead/${lead.id}#visita`);
    lead = db.actualizarLead(lead.id, { estado: 'agendado' });
    const avisar = Boolean(req.body?.avisar);
    await notif
      .visitaAgendada(lead, r.visita, { anterior: r.anterior, porEquipo: true, avisarInteresado: avisar })
      .catch((e) => console.error('[panel] agendar visita:', e));
    res.redirect(303, `/admin/lead/${lead.id}?ok=${r.anterior ? 'reagendada' : 'agendada'}${avisar ? '_aviso' : ''}#visita`);
  });

  // Corregir la dirección de la propiedad a visitar (se actualiza el evento del calendario del equipo)
  app.post('/admin/lead/:id/propiedad', formAdmin, async (req, res) => {
    let lead = leadAdmin(req, res);
    if (!lead) return;
    const propiedad = String(req.body?.propiedad || '').trim().slice(0, 300);
    if (pareceLink(propiedad)) return res.redirect(303, `/admin/lead/${lead.id}?ok=propiedad_link`);
    if (!propiedad || propiedad === lead.propiedad) return res.redirect(303, `/admin/lead/${lead.id}`);
    lead = db.actualizarLead(lead.id, { propiedad });
    const visita = db.visitaVigente(lead.id);
    const avisarEvento = visita && !visita.resultado && visita.fecha >= hoyChile();
    if (avisarEvento) {
      await notif
        .propiedadCorregida(lead, visita, { avisarInteresado: Boolean(req.body?.avisar) && Boolean(lead.email) })
        .catch((e) => console.error('[panel] corregir propiedad:', e));
    }
    res.redirect(303, `/admin/lead/${lead.id}?ok=${avisarEvento ? 'propiedad_evento' : 'propiedad'}`);
  });

  // Bloquear horarios en que el equipo no puede (compromisos fuera del sistema)
  const volverCalendario = (req) => `/admin/calendario?semana=${parseInt(req.body?.semana, 10) || 0}`;
  app.post('/admin/bloqueos', formAdmin, (req, res) => {
    const fecha = String(req.body?.fecha || '');
    const hora = req.body?.hora === '' || req.body?.hora === undefined ? null : Number(req.body.hora);
    const valido = /^\d{4}-\d{2}-\d{2}$/.test(fecha) && (hora === null || horasDe(cfgAgenda, fecha).includes(hora));
    if (valido && !(hora !== null && db.bloqueado(fecha, hora))) {
      db.bloquear(fecha, hora, String(req.body?.motivo || '').trim().slice(0, 120));
    }
    res.redirect(303, volverCalendario(req));
  });
  app.post('/admin/bloqueos/:bid/eliminar', formAdmin, (req, res) => {
    db.desbloquear(Number(req.params.bid));
    res.redirect(303, volverCalendario(req));
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
