const fs = require('node:fs');
const { esc, formatearRut, firmar, tamanoLegible } = require('./utils');
const { REQUISITOS, nombreRequisito, textoRequisitosWhatsapp } = require('./requisitos');
const { describirBloque, generarICS } = require('./agenda');

function crearNotificaciones({ config, mailer, whatsapp, db }) {
  const linkPostular = (lead) => `${config.baseUrl}/postular/${lead.token}`;
  const linkAgenda = (lead) => `${config.baseUrl}/agendar/${lead.token}`;
  const firmaRevision = (id) => firmar(config.secret, 'revision', id);
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
      v ? `<tr><td style="padding:6px 10px;color:#5a6478;width:140px">${k}</td><td style="padding:6px 10px"><strong>${esc(v)}</strong></td></tr>` : '';
    return `<table cellpadding="0" cellspacing="0" style="border:1px solid #e3e7ef;border-radius:8px;width:100%;margin:12px 0">
      ${fila('Nombre', lead.nombre)}${fila('RUT', lead.rut && formatearRut(lead.rut))}
      ${fila('Tipo', REQUISITOS[lead.tipo]?.etiqueta)}${fila('Razón social', lead.razon_social)}
      ${fila('RUT empresa', lead.rut_empresa && formatearRut(lead.rut_empresa))}
      ${fila('Correo', lead.email)}${fila('Teléfono', lead.telefono && `+${lead.telefono}`)}
      ${fila('Propiedad', lead.propiedad)}${fila('Origen', lead.portal)}${fila('Comentarios', lead.comentarios)}
    </table>`;
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

    textoBienvenida(lead) {
      const saludo = lead.nombre ? `¡Hola ${primerNombre(lead)}! 👋` : '¡Hola! 👋';
      const origen = lead.portal ? ` que viste en *${lead.portal}*` : '';
      const horas = config.agenda.horas.map((h) => `${h}:00`).join(', ');
      return (
        `${saludo} Gracias por escribir a *${config.empresa.nombre}* por la propiedad${origen}.\n\n` +
        `Para avanzar con tu postulación y coordinar una visita, completa tus datos y sube tus documentos en este link:\n` +
        `👉 ${linkPostular(lead)}\n\n` +
        `${textoRequisitosWhatsapp()}\n\n` +
        `Una vez revisados tus documentos te enviaremos un calendario para agendar tu visita (lunes a viernes a las ${horas} hrs). 📅`
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
    async documentosRecibidos(lead, documentos) {
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
        subject: `Nueva postulación: ${lead.nombre} (${REQUISITOS[lead.tipo]?.etiqueta || lead.tipo})${lead.propiedad ? ` – ${lead.propiedad}` : ''}`,
        html: correoHTML(
          'Nueva postulación',
          `<p>Llegó una nueva postulación con documentos.</p>${tablaLead(lead)}
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
    async enviarAgenda(lead) {
      const link = linkAgenda(lead);
      await mailer
        .enviar({
          to: lead.email,
          subject: `Agenda tu visita – ${config.empresa.nombre}`,
          html: correoHTML(
            'Agenda tu visita',
            `<p>Hola ${esc(primerNombre(lead))},</p>
             <p>¡Buenas noticias! Revisamos tus documentos y ya puedes agendar la visita${lead.propiedad ? ` a <strong>${esc(lead.propiedad)}</strong>` : ''}.</p>
             <p>Elige el día y la hora que te acomoden (lunes a viernes, ${config.agenda.horas.map((h) => `${h}:00`).join(' · ')} hrs):</p>
             ${boton('📅 Elegir horario de visita', link)}`
          ),
        })
        .catch((e) => console.error('[correo] envío de agenda falló:', e.message));

      await enviarWhatsappSeguro(
        lead,
        `Hola ${primerNombre(lead)} 😊 Revisamos tus documentos y ya puedes agendar tu visita. Elige día y hora aquí 📅\n${link}`,
        [primerNombre(lead) || 'cliente', link]
      );
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

    // 3) Visita agendada -> Julio, Bárbara y C. Solís de Ovando + confirmación al interesado
    async visitaAgendada(lead, visita, reagendada = false) {
      const cuando = describirBloque(visita.fecha, visita.hora);
      const ics = generarICS({
        uid: `visita-${visita.id}@sdorent.cl`,
        fecha: visita.fecha,
        hora: visita.hora,
        duracionMinutos: config.agenda.duracionMinutos,
        zona: config.zonaHoraria,
        titulo: `Visita propiedad – ${lead.nombre}`,
        descripcion: `Interesado: ${lead.nombre}\nTeléfono: +${lead.telefono || ''}\nCorreo: ${lead.email || ''}\nPropiedad: ${lead.propiedad || '-'}\nOrigen: ${lead.portal || '-'}`,
        ubicacion: lead.propiedad || '',
        organizador: config.correo.documentos[0],
        asistentes: [...config.correo.visitas, lead.email].filter(Boolean),
      });
      const adjuntoIcs = { filename: 'visita.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=REQUEST' };

      await mailer.enviar({
        to: config.correo.visitas,
        subject: `${reagendada ? '🔁 Visita REAGENDADA' : '📅 Nueva visita agendada'}: ${cuando} – ${lead.nombre}`,
        html: correoHTML(
          reagendada ? 'Visita reagendada' : 'Nueva visita agendada',
          `<p style="font-size:18px">🗓️ <strong>${esc(cuando)}</strong></p>${tablaLead(lead)}
           <p>${boton('WhatsApp al interesado', `https://wa.me/${lead.telefono}`)} ${boton('Ver ficha y documentos', `${config.baseUrl}/admin/lead/${lead.id}`, '#111417')} ${boton('Calendario', `${config.baseUrl}/admin/calendario`, '#111417')}</p>`
        ),
        icalEvent: { method: 'REQUEST', filename: 'visita.ics', content: ics },
      });

      await mailer
        .enviar({
          to: lead.email,
          subject: `Visita confirmada: ${cuando} – ${config.empresa.nombre}`,
          html: correoHTML(
            'Visita confirmada',
            `<p>Hola ${esc(primerNombre(lead))},</p><p>Tu visita quedó agendada para el:</p>
             <p style="font-size:18px">🗓️ <strong>${esc(cuando)}</strong></p>
             ${lead.propiedad ? `<p>🏠 ${esc(lead.propiedad)}</p>` : ''}
             <p>Te contactaremos por WhatsApp para coordinar los detalles. Si necesitas cambiar el horario:</p>
             ${boton('Cambiar horario', linkAgenda(lead), '#111417')}`
          ),
          attachments: [adjuntoIcs],
        })
        .catch((e) => console.error('[correo] confirmación de visita al interesado falló:', e.message));

      await enviarWhatsappSeguro(
        lead,
        `✅ ¡Listo ${primerNombre(lead)}! Tu visita quedó agendada para el *${cuando}*. Te escribiremos para coordinar los detalles. Si necesitas cambiarla: ${linkAgenda(lead)}`
      );
    },
  };
}

module.exports = { crearNotificaciones };
