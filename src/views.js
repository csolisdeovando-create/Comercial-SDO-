const { esc, formatearRut, tamanoLegible } = require('./utils');
const { REQUISITOS, nombreRequisito } = require('./requisitos');
const { fechaLarga, horaTexto, describirBloque } = require('./agenda');

function layout(titulo, cuerpo, { empresa = 'SDO Rent', scripts = [], ancho = '' } = {}) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(titulo)} · ${esc(empresa)}</title>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<header class="barra"><div class="contenedor ${ancho}"><span class="marca">${esc(empresa)}</span><span class="sub">Área Comercial</span></div></header>
<main class="contenedor ${ancho}">
${cuerpo}
</main>
<footer class="pie contenedor">${esc(empresa)} · Tus datos se usan solo para evaluar tu postulación de arriendo.</footer>
${scripts.map((s) => `<script src="${s}" defer></script>`).join('\n')}
</body>
</html>`;
}

function mensaje(titulo, texto, opciones = {}) {
  return layout(
    titulo,
    `<section class="tarjeta centrada">
      <div class="icono">${opciones.icono || 'ℹ️'}</div>
      <h1>${esc(titulo)}</h1>
      <p>${texto}</p>
      ${opciones.extra || ''}
    </section>`,
    opciones
  );
}

// ---------- Formulario de postulación ----------

function formularioPostulacion({ lead, valores = {}, errores = [], config }) {
  const v = { ...lead, ...valores };
  if (!v.tipo) v.tipo = 'dependiente';
  const val = (k) => esc(v[k] ?? '');
  const seccionDocs = (tipo) => `
    <fieldset class="docs" data-tipo="${tipo}" ${v.tipo === tipo ? '' : 'hidden'}>
      <legend>Documentos · ${esc(REQUISITOS[tipo].etiqueta)}</legend>
      ${REQUISITOS[tipo].documentos
        .map(
          (d, i) => `
        <label class="archivo">
          <span class="num">${i + 1}</span>
          <span class="texto"><strong>${esc(d.nombre)}</strong><small>${esc(d.ayuda)}</small></span>
          <input type="file" name="${d.campo}" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,image/*,application/pdf" ${v.tipo === tipo ? 'required' : ''}>
          <span class="seleccion" aria-live="polite">Seleccionar archivo</span>
        </label>`
        )
        .join('')}
    </fieldset>`;

  return layout(
    'Postulación de arriendo',
    `<section class="tarjeta">
      <h1>Postula a la propiedad</h1>
      <p class="lead">Completa tus datos y sube tus documentos. Nuestro equipo los revisará y te enviaremos un calendario para que agendes tu visita.</p>
      ${errores.length ? `<div class="alerta error"><strong>Revisa lo siguiente:</strong><ul>${errores.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
      <form method="post" action="/postular${lead?.token ? `/${esc(lead.token)}` : ''}" enctype="multipart/form-data" id="form-postulacion" novalidate>
        <fieldset>
          <legend>¿Cómo postulas?</legend>
          <div class="opciones-tipo">
            <label class="opcion"><input type="radio" name="tipo" value="dependiente" ${v.tipo === 'dependiente' ? 'checked' : ''}><span>👔 Trabajador dependiente</span></label>
            <label class="opcion"><input type="radio" name="tipo" value="independiente" ${v.tipo === 'independiente' ? 'checked' : ''}><span>🏢 Independiente o empresa</span></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Tus datos</legend>
          <div class="grilla">
            <label>Nombre completo<input name="nombre" required autocomplete="name" value="${val('nombre')}"></label>
            <label>RUT<input name="rut" required placeholder="12.345.678-9" value="${esc(v.rut ? formatearRut(v.rut) : '')}" data-rut></label>
            <label>Correo electrónico<input type="email" name="email" required autocomplete="email" value="${val('email')}"></label>
            <label>Teléfono / WhatsApp<input type="tel" name="telefono" required autocomplete="tel" placeholder="+56 9 1234 5678" value="${esc(v.telefono ? `+${v.telefono}`.replace(/^\+\+/, '+') : '')}"></label>
          </div>
          <div class="grilla solo-empresa" ${v.tipo === 'independiente' ? '' : 'hidden'}>
            <label>Razón social (si postulas como empresa)<input name="razon_social" value="${val('razon_social')}"></label>
            <label>RUT empresa<input name="rut_empresa" placeholder="76.123.456-7" value="${esc(v.rut_empresa ? formatearRut(v.rut_empresa) : '')}" data-rut></label>
          </div>
          <label>Propiedad de interés<input name="propiedad" placeholder="Dirección, código o link del aviso" value="${val('propiedad')}"></label>
        </fieldset>

        ${seccionDocs('dependiente')}
        ${seccionDocs('independiente')}

        <p class="nota">Formatos: PDF, JPG, PNG o HEIC · Máximo ${config.archivos.maxMB} MB por archivo.</p>

        <label>Comentarios (opcional)<textarea name="comentarios" rows="3" placeholder="Ej: fecha en que necesitas arrendar, mascotas, etc.">${val('comentarios')}</textarea></label>

        <label class="check"><input type="checkbox" name="consentimiento" value="1" required ${v.consentimiento ? 'checked' : ''}>
          Autorizo a ${esc(config.empresa.nombre)} a tratar mis datos y documentos solo para evaluar mi postulación de arriendo.</label>

        <button type="submit" class="boton primario grande">Enviar postulación</button>
        <p class="nota centrado" id="estado-envio" hidden>Subiendo documentos… no cierres esta página.</p>
      </form>
    </section>`,
    { empresa: config.empresa.nombre, scripts: ['/static/postular.js'] }
  );
}

// ---------- Calendario ----------

function calendario({ lead, cal, visita, error, config }) {
  const cabecera = (fecha) => {
    const [nombre, ...resto] = fechaLarga(fecha).split(' ');
    return `<span class="dia-nombre">${esc(nombre)}</span><span class="dia-fecha">${esc(resto.join(' ').replace(' de ', ' '))}</span>`;
  };
  const semanas = cal.semanas
    .map(
      (s, i) => `
    <div class="semana" data-semana="${i}" ${i === 0 ? '' : 'hidden'}>
      <div class="dias">
        ${s.dias
          .map(
            (d) => `
          <div class="dia ${d.habilitado ? '' : 'inhabil'}">
            <div class="dia-cab">${cabecera(d.fecha)}</div>
            ${
              d.habilitado
                ? config.agenda.horas
                    .map((h) => {
                      const b = d.bloques.find((x) => x.hora === h);
                      const id = `b-${d.fecha}-${h}`;
                      return b && b.disponible
                        ? `<input type="radio" name="bloque" id="${id}" value="${d.fecha}|${h}"><label for="${id}" class="bloque">${horaTexto(h)}</label>`
                        : `<span class="bloque ocupado" title="No disponible">${horaTexto(h)}</span>`;
                    })
                    .join('')
                : '<span class="sin-bloques">—</span>'
            }
          </div>`
          )
          .join('')}
      </div>
    </div>`
    )
    .join('');

  return layout(
    'Agenda tu visita',
    `<section class="tarjeta">
      <h1>Agenda tu visita</h1>
      <p class="lead">Hola ${esc((lead.nombre || '').split(' ')[0])}, elige el día y la hora que te acomoden. Las visitas son de lunes a viernes.</p>
      ${lead.propiedad ? `<p class="propiedad">🏠 ${esc(lead.propiedad)}</p>` : ''}
      ${visita ? `<div class="alerta ok">Ya tienes una visita agendada para el <strong>${esc(describirBloque(visita.fecha, visita.hora))}</strong>. Si eliges otro horario, la reagendaremos.</div>` : ''}
      ${error ? `<div class="alerta error">${esc(error)}</div>` : ''}
      <form method="post" action="/agendar/${esc(lead.token)}" class="calendario">
        <div class="nav-semanas">
          <button type="button" class="boton" data-nav="-1" aria-label="Semana anterior">‹</button>
          <span class="titulo-semana" aria-live="polite"></span>
          <button type="button" class="boton" data-nav="1" aria-label="Semana siguiente">›</button>
        </div>
        ${semanas}
        <div class="leyenda"><span class="bloque muestra">09:00</span> disponible <span class="bloque ocupado muestra">09:00</span> no disponible</div>
        <div class="resumen" hidden>Seleccionaste: <strong></strong></div>
        <button type="submit" class="boton primario grande">Confirmar visita</button>
      </form>
    </section>`,
    { empresa: config.empresa.nombre, scripts: ['/static/agenda.js'], ancho: 'ancho' }
  );
}

// ---------- Revisión (Bárbara) ----------

function revision({ lead, documentos, accion, firma, config }) {
  const aprobar = accion === 'aprobar';
  return layout(
    aprobar ? 'Aprobar postulación' : 'Rechazar postulación',
    `<section class="tarjeta">
      <h1>${aprobar ? '✅ Aprobar postulación' : '❌ Rechazar / pedir documentos'}</h1>
      ${fichaLead(lead)}
      <h2>Documentos (${documentos.length})</h2>
      <ul class="lista-docs">${documentos
        .map(
          (d) =>
            `<li><span>${esc(nombreRequisito(d.requisito))}</span> <a href="/revision/${lead.id}/documento/${d.id}?firma=${esc(firma)}" target="_blank">${esc(d.nombre_original)}</a> <small>${tamanoLegible(d.tamano)}</small></li>`
        )
        .join('')}</ul>
      <form method="post" action="/revision/${lead.id}/${accion}?firma=${esc(firma)}">
        ${
          aprobar
            ? `<p>Al aprobar, se enviará automáticamente al interesado (correo y WhatsApp) el calendario para agendar su visita.</p>
               <button class="boton primario grande">Aprobar y enviar calendario</button>`
            : `<label>Motivo / documentos faltantes (se enviará al interesado)
                 <textarea name="motivo" rows="4" required placeholder="Ej: Falta la liquidación de agosto, por favor súbela nuevamente."></textarea></label>
               <label class="check"><input type="checkbox" name="reenviar" value="1" checked> Permitir que vuelva a subir sus documentos</label>
               <button class="boton peligro grande">Enviar respuesta</button>`
        }
      </form>
    </section>`,
    { empresa: config.empresa.nombre }
  );
}

function fichaLead(lead) {
  const fila = (k, v) => (v ? `<tr><th>${k}</th><td>${esc(v)}</td></tr>` : '');
  return `<table class="ficha">
    ${fila('Nombre', lead.nombre)}
    ${fila('RUT', lead.rut && formatearRut(lead.rut))}
    ${fila('Tipo', REQUISITOS[lead.tipo]?.etiqueta)}
    ${fila('Razón social', lead.razon_social)}
    ${fila('RUT empresa', lead.rut_empresa && formatearRut(lead.rut_empresa))}
    ${fila('Correo', lead.email)}
    ${fila('Teléfono', lead.telefono && `+${lead.telefono}`)}
    ${fila('Propiedad', lead.propiedad)}
    ${fila('Origen', lead.portal)}
    ${fila('Comentarios', lead.comentarios)}
    ${fila('Estado', lead.estado)}
  </table>`;
}

// ---------- Panel interno ----------

const ETIQUETAS_ESTADO = {
  contactado: 'Contactado (link enviado)',
  documentos_recibidos: 'Documentos por revisar',
  aprobado: 'Aprobado (esperando agenda)',
  rechazado: 'Rechazado / faltan docs',
  agendado: 'Visita agendada',
  cerrado: 'Cerrado',
};

function panel({ leads, visitas, firmaDe, config }) {
  return layout(
    'Panel comercial',
    `<section class="tarjeta">
      <h1>Próximas visitas</h1>
      ${
        visitas.length
          ? `<table class="tabla"><thead><tr><th>Fecha</th><th>Hora</th><th>Interesado</th><th>Teléfono</th><th>Propiedad</th></tr></thead><tbody>
          ${visitas
            .map(
              (v) =>
                `<tr><td>${esc(fechaLarga(v.fecha))}</td><td>${horaTexto(v.hora)}</td><td>${esc(v.nombre)}</td><td><a href="https://wa.me/${esc(v.telefono)}">+${esc(v.telefono)}</a></td><td>${esc(v.propiedad)}</td></tr>`
            )
            .join('')}</tbody></table>`
          : '<p>No hay visitas agendadas.</p>'
      }
    </section>
    <section class="tarjeta">
      <h1>Leads</h1>
      <table class="tabla"><thead><tr><th>#</th><th>Nombre</th><th>Teléfono</th><th>Origen</th><th>Estado</th><th>Docs</th><th>Acciones</th></tr></thead><tbody>
      ${leads
        .map(
          (l) => `<tr>
          <td>${l.id}</td>
          <td>${esc(l.nombre || '—')}<br><small>${esc(l.email || '')}</small></td>
          <td>${l.telefono ? `<a href="https://wa.me/${esc(l.telefono)}">+${esc(l.telefono)}</a>` : '—'}</td>
          <td>${esc(l.portal || '—')}</td>
          <td><span class="estado ${esc(l.estado)}">${esc(ETIQUETAS_ESTADO[l.estado] || l.estado)}</span>${l.visita ? `<br><small>${esc(describirBloque(...l.visita.split(' ').map((x, i) => (i ? Number(x) : x))))}</small>` : ''}</td>
          <td>${l.n_documentos}</td>
          <td class="acciones">${
            l.n_documentos
              ? `<a class="boton chico" href="/revision/${l.id}/aprobar?firma=${firmaDe(l.id)}">Aprobar</a> <a class="boton chico" href="/revision/${l.id}/rechazar?firma=${firmaDe(l.id)}">Rechazar</a>`
              : ''
          } <a class="boton chico" href="/postular/${esc(l.token)}" target="_blank">Formulario</a></td>
        </tr>`
        )
        .join('')}
      </tbody></table>
    </section>`,
    { empresa: config.empresa.nombre, ancho: 'ancho' }
  );
}

module.exports = { layout, mensaje, formularioPostulacion, calendario, revision, fichaLead, panel };
