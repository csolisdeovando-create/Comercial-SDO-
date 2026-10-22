const fs = require('node:fs');
const { esc, formatearRut, firmar, tamanoLegible } = require('./utils');
const { filasPersona, documentoTexto, PLAZOS_CAMBIO, camposFaltantes } = require('./personas');
const { faltaDireccion } = require('./publicacion');
const { REQUISITOS, nombreRequisito, textoRequisitosWhatsapp } = require('./requisitos');
const { describirBloque, generarICS, textoDias } = require('./agenda');

// Número de versión creciente para que los calendarios reemplacen el evento anterior
const secuenciaActual = () => Math.floor(Date.now() / 1000) - 1_700_000_000;

// "Resultado de la Visita" con los valores de la lista de Breal
const MOTIVOS_NO_CONTINUA = ['No cumple requerimiento', 'Precio muy alto', 'Ubicación inadecuada', 'Tamaño inadecuado', 'Desea ver otras propiedades'];
function resultadoBreal(visita) {
  if (visita?.resultado === 'realizada') return 'Cumple requerimiento';
  if (visita?.resultado === 'no_asistio') return 'Interesado no asiste';
  if (visita?.resultado === 'no_continua') return visita.motivo_resultado || 'No cumple requerimiento';
  return null;
}
const TEXTO_RESULTADO = { realizada: '✅ Visitó y continúa', no_asistio: '⚠️ No asistió', no_continua: '❌ No continúa' };

function crearNotificaciones({ config, mailer, whatsapp, db }) {
  const linkPostular = (lead) => `${config.baseUrl}/postular/${lead.token}`;
  const linkAgenda = (lead) => `${config.baseUrl}/agendar/${lead.token}`;
  const firmaRevision = (id) => firmar(config.secret, 'revision', id);
  const firmaResultado = (visitaId) => firmar(config.secret, 'resultado', visitaId);
  const linkCancelar = (lead) => `${config.baseUrl}/visita/${lead.token}/cancelar`;
  // Todas las visitas (también los sábados) le llegan al mismo equipo
  const destinatarios = () => config.correo.visitas;
  const primerNombre = (lead) => (lead.nombre || '').trim().split(/\s+/)[0] || '';

  const correoHTML = (titulo, contenido) => `<!doctype html><html><body style="margin:0;background:#f3f5f9;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:10px;overflow:hidden">
      <tr><td style="background:#ffffff;padding:16px 24px 12px;border-bottom:3px solid #00c3ca">
        <img src="${config.baseUrl}/static/logo.png" alt="${esc(config.empresa.nombre)}" width="96" height="49" style="display:block;border:0">
      </td></tr>
      <tr><td style="padding:20px 24px 0;font-size:19px;font-weight:bold;color:#111417">${esc(titulo)}</td></tr>
      <tr><td style="padding:24px;font-size:15px;line-height:1.5">${contenido}</td></tr>
    </table></td></tr></table></body></html>`;

  const boton = (texto, url, color = '#00949a') =>
    `<a href="${esc(url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;margin:4px 6px 4px 0">${esc(texto)}</a>`;

  const tablaLead = (lead) => {
    const fila = (k, v) =>
      v ? `<tr><td style="padding:6px 10px;color:#5a6478;width:150px">${k}</td><td style="padding:6px 10px"><strong>${esc(v)}</strong></td></tr>` : '';
    const tabla = (filas) => `<table cellpadding="0" cellspacing="0" style="border:1px solid #e3e7ef;border-radius:8px;width:100%;margin:12px 0">${filas}</table>`;
    const titular = tabla(`
      ${filasPersona(lead).map(([k, v]) => fila(k, v)).join('')}
      ${fila('Tipo', REQUISITOS[lead.tipo]?.etiqueta)}${fila('Razón social', lead.razon_social)}
      ${fila('RUT empresa', lead.rut_empresa && formatearRut(lead.rut_empresa))}
      ${fila('Propiedad de interés', lead.propiedad)}${fila('Fecha de cambio', PLAZOS_CAMBIO[lead.plazo_cambio])}
      ${lead.url_publicacion ? `<tr><td style="padding:6px 10px;color:#5a6478;width:150px">Link de publicación</td><td style="padding:6px 10px"><a href="${esc(lead.url_publicacion)}">Ver aviso</a></td></tr>` : ''}
      ${fila('Origen', lead.portal)}${fila('Comentarios', lead.comentarios)}`);
    const comp = lead.complementa
      ? `<p style="margin:16px 0 0"><strong>👥 ${lead.comp_rol === 'aval' ? 'Aval' : 'Complementa renta'}${lead.comp_relacion ? ` (${esc(lead.comp_relacion)})` : ''}</strong></p>` +
        tabla(`${filasPersona(lead, 'comp_').map(([k, v]) => fila(k, v)).join('')}${fila('Tipo', REQUISITOS[lead.comp_tipo]?.etiqueta)}`)
      : '';
    return titular + comp;
  };

  async function enviarWhatsappSeguro(lead, texto, parametrosPlantilla) {
    if (!lead.telefono) return;
    try {
      await whatsapp.enviarTexto(lead.telefono, texto);
      db.registrarMensaje({ lead_id: lead.id, direccion: 'out', contenido: texto });
    } catch (e) {
      // Fuera de la ventana de 24 h Meta exige una plantilla aprobada
      if (config.whatsapp.plantillaAgenda && parametrosPlantilla) {
        try {
          await whatsapp.enviarPlantilla(lead.telefono, config.whatsapp.plantillaAgenda, parametrosPlantilla);
          db.registrarMensaje({ lead_id: lead.id, direccion: 'out', contenido: `[plantilla] ${parametrosPlantilla.join(' | ')}` });
          return;
        } catch (e2) {
          console.error('[whatsapp] plantilla falló:', e2.message);
        }
      }
      console.error('[whatsapp] no se pudo enviar mensaje:', e.message);
    }
  }

  return {
    linkPostular,
    linkAgenda,
    firmaRevision,
    firmaResultado,

    textoBienvenida(lead) {
      const saludo = lead.nombre ? `¡Hola ${primerNombre(lead)}! 👋` : '¡Hola! 👋';
      const origen = lead.portal ? ` que viste en *${lead.portal}*` : '';
      const horas = config.agenda.horas.map((h) => `${h}:00`).join(', ');
      return (
        `${saludo} Gracias por escribir a *${config.empresa.nombre}* por la propiedad${origen}.\n\n` +
        `Para avanzar con tu postulación y coordinar una visita, completa tus datos y sube tus documentos en este link:\n` +
        `👉 ${linkPostular(lead)}\n\n` +
        `${textoRequisitosWhatsapp()}\n\n` +
        `Una vez revisados tus documentos te enviaremos un calendario para agendar tu visita (${textoDias(config.agenda)}, ${horas} hrs). 📅`
      );
    },

    textoYaPostulado(lead) {
      if (lead.estado === 'agendado') {
        const v = db.visitaVigente(lead.id);
        return v
          ? `Hola ${primerNombre(lead)}, tu visita está agendada para el *${describirBloque(v.fecha, v.hora)}*. Si necesitas cambiarla: ${linkAgenda(lead)}`
          : null;
      }
      if (lead.estado === 'aprobado') return `Hola ${primerNombre(lead)}, ya puedes agendar tu visita aquí 📅 ${linkAgenda(lead)}`;
      if (lead.estado === 'documentos_recibidos')
        return `Hola ${primerNombre(lead)}, recibimos tus documentos y están en revisión. Te avisaremos apenas estén aprobados. 🙌`;
      return null;
    },

    // 1) Documentos -> sdopropiedades@sdorent.cl (Bárbara)
    async documentosRecibidos(lead, documentos, { actualizacion = false } = {}) {
      // Adjunta los archivos que quepan en el límite del correo; el resto queda como link de descarga
      const limite = config.correo.maxAdjuntosMB * 1024 * 1024;
      let acumulado = 0;
      const adjuntos = new Set();
      for (const d of [...documentos].sort((a, b) => (a.tamano || 0) - (b.tamano || 0))) {
        if (acumulado + (d.tamano || 0) > limite) continue;
        acumulado += d.tamano || 0;
        adjuntos.add(d);
      }
      const sinAdjuntar = documentos.length - adjuntos.size;
      const firma = firmaRevision(lead.id);
      const lista = documentos
        .map(
          (d) =>
            `<li>${esc(nombreRequisito(d.requisito))}: <a href="${config.baseUrl}/revision/${lead.id}/documento/${d.id}?firma=${firma}">${esc(d.nombre_original)}</a> (${tamanoLegible(d.tamano)})${adjuntos.has(d) ? '' : ' <strong>– descargar desde el link</strong>'}</li>`
        )
        .join('');
      const accion = config.agenda.automatica
        ? '<p>El calendario de visitas ya fue enviado automáticamente al interesado.</p>'
        : `<p>Revisa los documentos y elige una acción. Al aprobar, el interesado recibe <strong>automáticamente</strong> el calendario para agendar su visita.</p>
           ${boton('✅ Aprobar y enviar calendario', `${config.baseUrl}/revision/${lead.id}/aprobar?firma=${firma}`)}
           ${boton('❌ Rechazar / pedir documentos', `${config.baseUrl}/revision/${lead.id}/rechazar?firma=${firma}`, '#c0392b')}
           <p style="color:#5a6478;font-size:13px">Los documentos también quedan guardados en el <a href="${config.baseUrl}/admin/lead/${lead.id}">panel comercial</a> (descarga individual o en ZIP).</p>`;

      await mailer.enviar({
        to: config.correo.documentos,
        replyTo: lead.email || undefined,
        subject: `${actualizacion ? 'Actualización de documentos' : 'Nueva postulación'}: ${lead.nombre} (${REQUISITOS[lead.tipo]?.etiqueta || lead.tipo})${lead.propiedad ? ` – ${lead.propiedad}` : ''}`,
        html: correoHTML(
          actualizacion ? 'Actualización de documentos' : 'Nueva postulación',
          `<p>${
            actualizacion
              ? '<strong>El interesado volvió a enviar documentos</strong> para su postulación en revisión. Estos son los archivos nuevos; los anteriores siguen en el panel.'
              : 'Llegó una nueva postulación con documentos.'
          }</p>${tablaLead(lead)}
           <p><strong>Documentos (${documentos.length}):</strong></p><ul>${lista}</ul>
           <p style="color:#5a6478">${
             sinAdjuntar === 0
               ? 'Los documentos van adjuntos en este correo.'
               : `${sinAdjuntar} archivo(s) no se adjuntaron por superar el tamaño máximo del correo; descárgalos desde los links marcados.`
           }</p>
           ${accion}`
        ),
        attachments: documentos
          .filter((d) => adjuntos.has(d))
          .map((d) => ({
            filename: `${d.requisito}__${d.nombre_original}`,
            content: fs.createReadStream(d.ruta),
            contentType: d.mime,
          })),
      });

      await mailer
        .enviar({
          to: lead.email,
          subject: `Recibimos tu postulación – ${config.empresa.nombre}`,
          html: correoHTML(
            'Postulación recibida',
            `<p>Hola ${esc(primerNombre(lead))},</p><p>Recibimos tus datos y documentos. ${
              config.agenda.automatica
                ? 'Ya puedes agendar tu visita:</p>' + boton('📅 Agendar visita', linkAgenda(lead))
                : 'Nuestro equipo los revisará y te enviaremos un link para agendar tu visita.</p>'
            }`
          ),
        })
        .catch((e) => console.error('[correo] confirmación al interesado falló:', e.message));
    },

    // 2) Aprobación -> calendario al interesado
    async enviarAgenda(lead, { soloCorreo = false, recordatorio = false } = {}) {
      const link = linkAgenda(lead);
      await mailer
        .enviar({
          to: lead.email,
          subject: `${recordatorio ? 'Recordatorio: aún puedes agendar tu visita' : 'Agenda tu visita'} – ${config.empresa.nombre}`,
          html: correoHTML(
            recordatorio ? 'Agenda tu visita' : 'Agenda tu visita',
            `<p>Hola ${esc(primerNombre(lead))},</p>
             <p>${
               recordatorio
                 ? 'Te recordamos que tus documentos ya están aprobados, pero aún no eliges tu horario de visita'
                 : '¡Buenas noticias! Revisamos tus documentos y ya puedes agendar la visita'
             }${lead.propiedad ? ` a <strong>${esc(lead.propiedad)}</strong>` : ''}.</p>
             <p>Elige el día y la hora que te acomoden (${textoDias(config.agenda)}, ${config.agenda.horas.map((h) => `${h}:00`).join(' · ')} hrs):</p>
             ${boton('📅 Elegir horario de visita', link)}`
          ),
        })
        .catch((e) => console.error('[correo] envío de agenda falló:', e.message));

      if (soloCorreo) return;
      await enviarWhatsappSeguro(
        lead,
        recordatorio
          ? `Hola ${primerNombre(lead)} 😊 Te recordamos que tus documentos ya están aprobados. Elige día y hora para tu visita aquí 📅\n${link}`
          : `Hola ${primerNombre(lead)} 😊 Revisamos tus documentos y ya puedes agendar tu visita. Elige día y hora aquí 📅\n${link}`,
        [primerNombre(lead) || 'cliente', link]
      );
    },

    // Se le pide al interesado que complete los datos que faltan (Bárbara los necesita para Breal)
    async pedirDatos(lead) {
      const link = `${config.baseUrl}/datos/${lead.token}`;
      const faltan = camposFaltantes(lead);
      await mailer.enviar({
        to: lead.email,
        subject: `Completa tus datos para tu arriendo – ${config.empresa.nombre}`,
        html: correoHTML(
          'Completa tus datos',
          `<p>Hola ${esc(primerNombre(lead))},</p>
           <p>Para preparar tu contrato necesitamos que completes algunos datos de tu postulación:</p>
           <ul>${faltan.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
           <p>Te toma un par de minutos y no tienes que volver a subir documentos.</p>
           ${boton('📝 Completar mis datos', link)}`
        ),
      });
      await enviarWhatsappSeguro(lead, `Hola ${primerNombre(lead)} 😊 Para preparar tu contrato necesitamos que completes algunos datos. Te toma un par de minutos: ${link}`);
    },

    async datosCompletados(lead) {
      await mailer
        .enviar({
          to: config.correo.documentos,
          subject: `📝 ${lead.nombre} completó sus datos`,
          html: correoHTML(
            'Datos completados',
            `<p><strong>${esc(lead.nombre)}</strong> completó los datos de su postulación. Ya puedes registrarlos en Breal.</p>${tablaLead(lead)}
             <p>${boton('Ver ficha', `${config.baseUrl}/admin/lead/${lead.id}`, '#111417')}</p>`
          ),
        })
        .catch((e) => console.error('[correo] aviso de datos completados falló:', e.message));
    },

    async rechazo(lead, motivo, permitirReenvio) {
      const link = linkPostular(lead);
      await mailer.enviar({
        to: lead.email,
        subject: `Sobre tu postulación – ${config.empresa.nombre}`,
        html: correoHTML(
          'Tu postulación',
          `<p>Hola ${esc(primerNombre(lead))},</p><p>Revisamos tu postulación:</p>
           <blockquote style="border-left:4px solid #c0392b;margin:12px 0;padding:8px 14px;background:#fbf1f0">${esc(motivo).replace(/\n/g, '<br>')}</blockquote>
           ${permitirReenvio ? `<p>Puedes volver a subir tus documentos aquí:</p>${boton('Subir documentos', link)}` : ''}`
        ),
      });
      await enviarWhatsappSeguro(
        lead,
        `Hola ${primerNombre(lead)}, revisamos tu postulación:\n\n${motivo}${permitirReenvio ? `\n\nPuedes volver a subir tus documentos aquí: ${link}` : ''}`
      );
    },

    async recordatorioVisita(lead, visita) {
      const cuando = describirBloque(visita.fecha, visita.hora);
      const link = linkAgenda(lead);
      const confirmar = `${config.baseUrl}/visita/${lead.token}/confirmar`;
      await mailer.enviar({
        to: lead.email,
        subject: `Recordatorio: tu visita es mañana – ${cuando}`,
        html: correoHTML(
          'Recordatorio de visita',
          `<p>Hola ${esc(primerNombre(lead))},</p><p>Te recordamos tu visita de mañana:</p>
           <p style="font-size:18px">🗓️ <strong>${esc(cuando)}</strong></p>
           ${lead.propiedad ? `<p>🏠 ${esc(lead.propiedad)}</p>` : ''}
           <p>Por favor confírmanos tu asistencia, o elige otro horario si no puedes asistir:</p>
           ${boton('✅ Confirmar asistencia', confirmar)} ${boton('📅 Reagendar', link, '#111417')}
           <p style="font-size:13px;color:#5a6478">¿Ya no puedes ir? <a href="${esc(linkCancelar(lead))}">Cancelar la visita</a></p>`
        ),
      });
      await enviarWhatsappSeguro(
        lead,
        `Hola ${primerNombre(lead)} 👋 Te recordamos tu visita de mañana: *${cuando}*.\n✅ Confirma tu asistencia: ${confirmar}\n📅 Si no puedes, reagenda aquí: ${link}\n❌ Para cancelarla: ${linkCancelar(lead)}`
      );
    },

    // Se corrigió la dirección de la propiedad: el evento del equipo se reemplaza (mismo UID, nueva secuencia)
    async propiedadCorregida(lead, visita, { avisarInteresado = false } = {}) {
      const cuando = describirBloque(visita.fecha, visita.hora);
      await mailer.enviar({
        to: destinatarios(visita.fecha),
        subject: `📍 Dirección corregida: visita ${cuando} · ${lead.propiedad} · ${lead.nombre}`,
        html: correoHTML(
          'Dirección de la visita corregida',
          `<p>La visita de <strong>${esc(lead.nombre)}</strong> del <strong>${esc(cuando)}</strong> es en:</p>
           <p style="font-size:18px">🏠 <strong>${esc(lead.propiedad)}</strong></p>
           <p>El evento de tu calendario se actualizó con la dirección correcta.</p>
           <p>${boton('Ver ficha', `${config.baseUrl}/admin/lead/${lead.id}`, '#111417')}</p>`
        ),
        icalEvent: { method: 'REQUEST', filename: 'visita.ics', content: this.eventoEquipo(lead, visita) },
      });
      if (!avisarInteresado) return;
      await mailer
        .enviar({
          to: lead.email,
          subject: `Dirección de tu visita: ${lead.propiedad} – ${config.empresa.nombre}`,
          html: correoHTML(
            'Dirección de tu visita',
            `<p>Hola ${esc(primerNombre(lead))},</p>
             <p>Te confirmamos la dirección de la propiedad que visitarás el <strong>${esc(cuando)}</strong>:</p>
             <p style="font-size:18px">🏠 <strong>${esc(lead.propiedad)}</strong></p>`
          ),
          icalEvent: { method: 'REQUEST', filename: 'visita.ics', content: this.eventoInteresado(lead, visita) },
        })
        .catch((e) => console.error('[correo] dirección corregida al interesado falló:', e.message));
    },

    async visitaCancelada(lead, visita) {
      const cuando = describirBloque(visita.fecha, visita.hora);
      const link = linkAgenda(lead);
      await mailer
        .enviar({
          to: lead.email,
          subject: `Tu visita del ${cuando} fue cancelada – ${config.empresa.nombre}`,
          html: correoHTML(
            'Visita cancelada',
            `<p>Hola ${esc(primerNombre(lead))},</p><p>Tuvimos que cancelar tu visita del <strong>${esc(cuando)}</strong>. Disculpa las molestias.</p>
             <p>Puedes elegir un nuevo horario aquí:</p>${boton('📅 Elegir nuevo horario', link)}`
          ),
          icalEvent: { method: 'CANCEL', filename: 'visita.ics', content: this.eventoInteresado(lead, visita, { metodo: 'CANCEL' }) },
        })
        .catch((e) => console.error('[correo] aviso de cancelación falló:', e.message));
      await enviarWhatsappSeguro(
        lead,
        `Hola ${primerNombre(lead)}, tuvimos que cancelar tu visita del *${cuando}*. Disculpa las molestias 🙏 Puedes elegir un nuevo horario aquí: ${link}`,
        [primerNombre(lead) || 'cliente', link]
      );
    },

    // 3) Visita agendada -> Julio, Bárbara y C. Solís de Ovando + confirmación al interesado
    // Evento de calendario del equipo: toda la información en el título y el detalle (para verlo en terreno)
    eventoEquipo(lead, visita, { metodo = 'REQUEST', asistentes = destinatarios(visita.fecha) } = {}) {
      const direccion = lead.propiedad || 'Dirección por confirmar';
      const tel = lead.telefono ? `+${lead.telefono}` : 'sin teléfono';
      const confirmada = Boolean(visita.confirmada_at);
      // La dirección va primero: es lo que se alcanza a leer en la vista semanal (la hora ya la muestra el calendario)
      const titulo = `${confirmada ? '✅ ' : ''}🏠 ${direccion} · ${lead.nombre || 'Interesado'} · ${tel}`;
      const descripcion = [
        `VISITA ${config.empresa.nombre.toUpperCase()}`,
        `📅 ${describirBloque(visita.fecha, visita.hora)}`,
        confirmada ? '✅ El interesado CONFIRMÓ su asistencia' : '⏳ Pendiente de confirmación del interesado',
        '',
        `🏠 Propiedad de interés: ${direccion}`,
        `🔗 Link de publicación: ${lead.url_publicacion || 'no lo indicó'}`,
        lead.propiedad && !faltaDireccion(lead.propiedad) ? `📍 Mapa: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lead.propiedad)}` : null,
        '',
        `👤 Interesado: ${lead.nombre || '-'}${lead.rut ? ` (${documentoTexto(lead)})` : ''}`,
        `📞 Teléfono: ${tel}`,
        lead.telefono ? `💬 WhatsApp: https://wa.me/${lead.telefono}` : null,
        lead.email ? `✉️ Correo: ${lead.email}` : null,
        lead.direccion_actual ? `🏡 Vive en (dirección actual del interesado): ${[lead.direccion_actual, lead.comuna].filter(Boolean).join(', ')}` : null,
        lead.tipo ? `💼 ${REQUISITOS[lead.tipo]?.etiqueta || lead.tipo}${lead.razon_social ? ` · ${lead.razon_social}` : ''}` : null,
        lead.complementa
          ? `👥 ${lead.comp_rol === 'aval' ? 'Aval' : 'Complementa renta'}: ${lead.comp_nombre || ''}${lead.comp_telefono ? ` +${lead.comp_telefono}` : ''}${lead.comp_relacion ? ` (${lead.comp_relacion})` : ''}`
          : null,
        lead.plazo_cambio ? `🚚 Fecha de cambio: ${PLAZOS_CAMBIO[lead.plazo_cambio]}` : null,
        lead.portal ? `📣 Origen: ${lead.portal}` : null,
        '',
        `📂 Ficha y documentos: ${config.baseUrl}/admin/lead/${lead.id}`,
      ]
        .filter((l) => l !== null)
        .join('\n');
      return generarICS({
        uid: `visita-interesado-${lead.id}@sdorent.cl`,
        secuencia: secuenciaActual(),
        metodo,
        fecha: visita.fecha,
        hora: visita.hora,
        duracionMinutos: config.agenda.duracionMinutos,
        zona: config.zonaHoraria,
        titulo,
        descripcion,
        ubicacion: lead.propiedad || '',
        url: `${config.baseUrl}/admin/lead/${lead.id}`,
        organizador: config.correo.from.match(/<([^>]+)>/)?.[1] || config.correo.documentos[0],
        asistentes,
      });
    },

    // Evento para el interesado (otro identificador, sin datos internos)
    eventoInteresado(lead, visita, { metodo = 'REQUEST' } = {}) {
      return generarICS({
        uid: `visita-cliente-${lead.id}@sdorent.cl`,
        secuencia: secuenciaActual(),
        metodo,
        fecha: visita.fecha,
        hora: visita.hora,
        duracionMinutos: config.agenda.duracionMinutos,
        zona: config.zonaHoraria,
        titulo: `Visita propiedad ${config.empresa.nombre}${lead.propiedad ? ` – ${lead.propiedad}` : ''}`,
        descripcion: `Visita a la propiedad${lead.propiedad ? ` ${lead.propiedad}` : ''}.\nSi necesitas cambiar el horario: ${linkAgenda(lead)}`,
        ubicacion: lead.propiedad || '',
        organizador: config.correo.from.match(/<([^>]+)>/)?.[1] || config.correo.documentos[0],
        asistentes: [lead.email].filter(Boolean),
      });
    },

    // 3) Visita agendada -> equipo del día (con evento de calendario) + confirmación al interesado
    async visitaAgendada(lead, visita, { anterior = null, porEquipo = false, avisarInteresado = true } = {}) {
      const cuando = describirBloque(visita.fecha, visita.hora);
      const reagendada = Boolean(anterior);
      const para = destinatarios(visita.fecha);

      const quien = porEquipo ? ' por el equipo' : '';
      await mailer.enviar({
        to: para,
        subject: `${reagendada ? `🔁 Visita REAGENDADA${quien}` : `📅 Nueva visita${quien}`}: ${cuando} · ${lead.propiedad || 'propiedad por confirmar'} · ${lead.nombre}`,
        html: correoHTML(
          reagendada ? 'Visita reagendada' : 'Nueva visita agendada',
          `<p style="font-size:18px">🗓️ <strong>${esc(cuando)}</strong></p>
           ${
             reagendada
               ? `<p>${porEquipo ? 'El equipo cambió el horario' : 'El interesado cambió el horario'} (antes: ${esc(describirBloque(anterior.fecha, anterior.hora))}). El evento de tu calendario se actualizó con la nueva hora.</p>`
               : '<p>La visita se agregó a tu calendario con toda la información.</p>'
           }
           ${tablaLead(lead)}
           <p>${boton('WhatsApp al interesado', `https://wa.me/${lead.telefono}`)} ${boton('Ver ficha y documentos', `${config.baseUrl}/admin/lead/${lead.id}`, '#111417')} ${boton('Calendario', `${config.baseUrl}/admin/calendario`, '#111417')}</p>`
        ),
        icalEvent: { method: 'REQUEST', filename: 'visita.ics', content: this.eventoEquipo(lead, visita) },
      });

      if (!avisarInteresado) return;
      const titulo = porEquipo ? (reagendada ? 'Reagendamos tu visita' : 'Agendamos tu visita') : 'Visita agendada';
      await mailer
        .enviar({
          to: lead.email,
          subject: `${titulo}: ${cuando} – ${config.empresa.nombre}`,
          html: correoHTML(
            titulo,
            `<p>Hola ${esc(primerNombre(lead))},</p>
             <p>${porEquipo && reagendada ? 'Tuvimos que cambiar el horario de tu visita. La nueva fecha es:' : 'Tu visita quedó agendada para el:'}</p>
             <p style="font-size:18px">🗓️ <strong>${esc(cuando)}</strong></p>
             ${lead.propiedad ? `<p>🏠 ${esc(lead.propiedad)}</p>` : ''}
             <p>El día anterior te enviaremos un recordatorio para confirmar tu asistencia. Si este horario no te acomoda, puedes elegir otro:</p>
             ${boton('📅 Cambiar horario', linkAgenda(lead), '#111417')} ${boton('❌ Cancelar visita', linkCancelar(lead), '#8c2a20')}`
          ),
          icalEvent: { method: 'REQUEST', filename: 'visita.ics', content: this.eventoInteresado(lead, visita) },
        })
        .catch((e) => console.error('[correo] confirmación de visita al interesado falló:', e.message));

      await enviarWhatsappSeguro(
        lead,
        porEquipo && reagendada
          ? `Hola ${primerNombre(lead)}, tuvimos que cambiar el horario de tu visita. Nueva fecha: *${cuando}*. Si no te acomoda, elige otro aquí: ${linkAgenda(lead)}`
          : `✅ ¡Listo ${primerNombre(lead)}! Tu visita quedó agendada para el *${cuando}*. Si necesitas cambiarla: ${linkAgenda(lead)}`
      );
    },

    // El interesado confirmó desde el recordatorio: se actualiza el evento del equipo (título con ✅ CONFIRMADA)
    async asistenciaConfirmada(lead, visita) {
      const cuando = describirBloque(visita.fecha, visita.hora);
      await mailer.enviar({
        to: destinatarios(visita.fecha),
        subject: `✅ Visita CONFIRMADA por el interesado: ${cuando} · ${lead.propiedad || ''} · ${lead.nombre}`,
        html: correoHTML(
          'Visita confirmada',
          `<p style="font-size:18px">✅ <strong>${esc(lead.nombre)}</strong> confirmó que asistirá el <strong>${esc(cuando)}</strong>.</p>
           <p>El evento de tu calendario se actualizó.</p>${tablaLead(lead)}
           <p>${boton('WhatsApp al interesado', `https://wa.me/${lead.telefono}`)} ${boton('Ver ficha', `${config.baseUrl}/admin/lead/${lead.id}`, '#111417')}</p>`
        ),
        icalEvent: { method: 'REQUEST', filename: 'visita.ics', content: this.eventoEquipo(lead, visita) },
      });
    },

    // Quita la visita del calendario del equipo
    // El interesado canceló desde su link: se quita el evento al equipo y se le confirma a él
    async cancelacionInteresado(lead, visita, motivo) {
      const cuando = describirBloque(visita.fecha, visita.hora);
      await this.eventoCancelado(lead, visita, `El interesado canceló la visita${motivo ? `: “${motivo}”` : ' (sin indicar motivo)'}.`);
      await mailer
        .enviar({
          to: lead.email,
          subject: `Cancelaste tu visita del ${cuando} – ${config.empresa.nombre}`,
          html: correoHTML(
            'Visita cancelada',
            `<p>Hola ${esc(primerNombre(lead))},</p><p>Cancelamos tu visita del <strong>${esc(cuando)}</strong>, como pediste.</p>
             <p>Si más adelante quieres visitar la propiedad, puedes elegir un nuevo horario aquí:</p>${boton('📅 Elegir nuevo horario', linkAgenda(lead))}`
          ),
          icalEvent: { method: 'CANCEL', filename: 'visita.ics', content: this.eventoInteresado(lead, visita, { metodo: 'CANCEL' }) },
        })
        .catch((e) => console.error('[correo] confirmación de cancelación falló:', e.message));
    },

    // Terminó la visita: se le pide al equipo el resultado con botones de un toque
    async pedirResultado(lead, visita) {
      const cuando = describirBloque(visita.fecha, visita.hora);
      const link = (r) => `${config.baseUrl}/resultado/${visita.id}?r=${r}&firma=${firmaResultado(visita.id)}`;
      await mailer.enviar({
        to: config.correo.ejecutivoVisitas,
        subject: `📝 ¿Cómo fue la visita? ${lead.nombre} · ${lead.propiedad || ''} · ${cuando}`,
        html: correoHTML(
          '¿Cómo fue la visita?',
          `<p>Terminó la visita de <strong>${esc(lead.nombre)}</strong> del <strong>${esc(cuando)}</strong>${lead.propiedad ? ` en ${esc(lead.propiedad)}` : ''}.</p>
           <p>Registra el resultado con un toque (después puedes agregar notas). Tu respuesta le llega al equipo para dejarla registrada en Breal:</p>
           <p>${boton('✅ Visitó y continúa', link('realizada'))} ${boton('⚠️ No asistió', link('no_asistio'), '#b7791f')} ${boton('❌ No continúa', link('no_continua'), '#8c2a20')}</p>
           ${tablaLead(lead)}`
        ),
      });
    },

    // Quien visitó registró el resultado: el resto del equipo lo recibe listo para pasarlo a Breal
    async resultadoRegistrado(lead, visita) {
      const cuando = describirBloque(visita.fecha, visita.hora);
      const para = config.correo.visitas.filter((c) => !config.correo.ejecutivoVisitas.includes(c));
      if (!para.length) return;
      const fila = (k, v) => (v ? `<tr><td style="padding:6px 10px;color:#5a6478;width:190px">${k}</td><td style="padding:6px 10px"><strong>${esc(v)}</strong></td></tr>` : '');
      await mailer.enviar({
        to: para,
        subject: `${TEXTO_RESULTADO[visita.resultado]}: ${lead.nombre} · ${lead.propiedad || ''} · ${cuando}`,
        html: correoHTML(
          'Resultado de la visita',
          `<p style="font-size:18px">${TEXTO_RESULTADO[visita.resultado]}${visita.motivo_resultado ? ` · ${esc(visita.motivo_resultado)}` : ''}</p>
           <p><strong>${esc(lead.nombre)}</strong> · ${esc(cuando)}${lead.propiedad ? ` · ${esc(lead.propiedad)}` : ''}</p>
           ${visita.notas ? `<blockquote style="border-left:4px solid #00949a;margin:12px 0;padding:8px 14px;background:#f0fafa">${esc(visita.notas).replace(/\n/g, '<br>')}</blockquote>` : ''}
           <p style="margin:16px 0 4px"><strong>Para registrar en Breal (Visita):</strong></p>
           <table cellpadding="0" cellspacing="0" style="border:1px solid #e3e7ef;border-radius:8px;width:100%">
             ${fila('Resultado de la Visita', resultadoBreal(visita))}${fila('Observaciones de la Visita', visita.notas)}
           </table>
           <p>${boton('Ver ficha', `${config.baseUrl}/admin/lead/${lead.id}#visita`, '#111417')}</p>`
        ),
      });
    },

    // Mensaje al interesado según el resultado de la visita
    async seguimientoVisita(lead, visita, resultado) {
      const cuando = describirBloque(visita.fecha, visita.hora);
      const nombre = esc(primerNombre(lead));
      const contenido = {
        realizada: {
          asunto: 'Gracias por visitar la propiedad',
          html: `<p>Hola ${nombre},</p><p>¡Gracias por visitar${lead.propiedad ? ` <strong>${esc(lead.propiedad)}</strong>` : ' la propiedad'}! Nuestro equipo te contactará con los próximos pasos para la reserva y el contrato.</p><p>Si tienes cualquier duda, respóndenos este correo o escríbenos por WhatsApp al ${esc(config.empresa.whatsappComercial)}.</p>`,
          wa: `Hola ${primerNombre(lead)} 😊 ¡Gracias por visitar la propiedad! Te contactaremos con los próximos pasos para la reserva.`,
        },
        no_asistio: {
          asunto: 'No pudimos verte en la visita',
          html: `<p>Hola ${nombre},</p><p>Te esperamos en la visita del <strong>${esc(cuando)}</strong>, pero no pudimos encontrarnos. Si todavía te interesa la propiedad, elige un nuevo horario:</p>${boton('📅 Reagendar visita', linkAgenda(lead))}`,
          wa: `Hola ${primerNombre(lead)}, te esperamos en la visita del *${cuando}* y no pudimos encontrarnos. Si aún te interesa, reagenda aquí: ${linkAgenda(lead)}`,
        },
        no_continua: {
          asunto: 'Gracias por tu visita',
          html: `<p>Hola ${nombre},</p><p>Gracias por visitar la propiedad. Si buscas otras opciones de arriendo, escríbenos por WhatsApp al ${esc(config.empresa.whatsappComercial)} y te ayudamos.</p>`,
          wa: `Hola ${primerNombre(lead)}, gracias por tu visita. Si buscas otras opciones de arriendo, escríbenos y te ayudamos 🙌`,
        },
      }[resultado];
      if (!contenido) return;
      await mailer
        .enviar({ to: lead.email, subject: `${contenido.asunto} – ${config.empresa.nombre}`, html: correoHTML(contenido.asunto, contenido.html) })
        .catch((e) => console.error('[correo] seguimiento de visita falló:', e.message));
      await enviarWhatsappSeguro(lead, contenido.wa);
    },

    async eventoCancelado(lead, visita, motivo) {
      const cuando = describirBloque(visita.fecha, visita.hora);
      await mailer.enviar({
        to: destinatarios(visita.fecha),
        subject: `❌ Visita CANCELADA: ${cuando} · ${lead.propiedad || ''} · ${lead.nombre}`,
        html: correoHTML(
          'Visita cancelada',
          `<p style="font-size:18px">❌ Se canceló la visita del <strong>${esc(cuando)}</strong> con ${esc(lead.nombre)}.</p>
           ${motivo ? `<p>${esc(motivo)}</p>` : ''}<p>El evento se quitó de tu calendario.</p>${tablaLead(lead)}`
        ),
        icalEvent: { method: 'CANCEL', filename: 'visita.ics', content: this.eventoEquipo(lead, visita, { metodo: 'CANCEL' }) },
      });
    },
  };
}

module.exports = { crearNotificaciones, MOTIVOS_NO_CONTINUA, resultadoBreal };
