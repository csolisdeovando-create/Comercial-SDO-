const { esc, formatearRut, tamanoLegible } = require('./utils');
const { REQUISITOS, nombreRequisito } = require('./requisitos');
const { fechaLarga, horaTexto, describirBloque, sumarDias } = require('./agenda');

function layout(titulo, cuerpo, { empresa = 'SDO Rent', scripts = [], ancho = '', nav = null, pie = true } = {}) {
  const menu = nav
    ? `<nav class="menu">${[
        ['leads', '/admin', 'Interesados'],
        ['calendario', '/admin/calendario', 'Calendario de visitas'],
      ]
        .map(([k, href, txt]) => `<a href="${href}" class="${nav === k ? 'activo' : ''}">${txt}</a>`)
        .join('')}<a href="/salir" class="salir">Salir</a></nav>`
    : '';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#ffffff">
<title>${esc(titulo)} · ${esc(empresa)}</title>
<link rel="icon" type="image/png" sizes="64x64" href="/static/icono.png?v=${VERSION}">
<link rel="apple-touch-icon" sizes="180x180" href="/static/icono-180.png?v=${VERSION}">
<link rel="manifest" href="/static/manifest.webmanifest?v=${VERSION}">
<meta name="apple-mobile-web-app-title" content="SDO Comercial">
<link rel="stylesheet" href="/static/styles.css?v=${VERSION}">
</head>
<body>
<header class="barra"><div class="contenedor ${ancho}">
  <a class="logo" href="${nav ? '/admin' : '#'}"><img src="/static/logo.png?v=${VERSION}" alt="${esc(empresa)}" width="94" height="48"></a>
  <span class="sub">${nav ? 'Panel comercial' : 'Área Comercial'}</span>
  ${menu}
</div></header>
<main class="contenedor ${ancho}">
${cuerpo}
</main>
${pie ? `<footer class="pie contenedor">${esc(empresa)} · Tus datos se usan solo para evaluar tu postulación de arriendo.</footer>` : ''}
${scripts.map((sc) => `<script src="${sc}?v=${VERSION}" defer></script>`).join('\n')}
${nav || titulo === 'Ingresar al panel' ? `<script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});</script>` : ''}
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

// Cambia en cada publicación para que los navegadores descarguen estilos e íconos nuevos
const VERSION = Date.now().toString(36);

const ACEPTA = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,image/*,application/pdf';

function formularioPostulacion({ lead, valores = {}, errores = [], config }) {
  const v = { ...lead, ...valores };
  if (!v.tipo) v.tipo = 'dependiente';
  const val = (k) => esc(v[k] ?? '');
  const v_comp_tipo = v.comp_tipo || 'dependiente';
  const compActivo = Boolean(Number(v.complementa) || v.complementa === '1');
  // grupo: 'titular' (quien postula) o 'comp' (quien complementa renta)
  const seccionDocs = (tipo, grupo = 'titular') => {
    const prefijo = grupo === 'comp' ? 'comp_' : '';
    const activo = grupo === 'comp' ? compActivo && v_comp_tipo === tipo : v.tipo === tipo;
    const titulo = grupo === 'comp' ? `Documentos de quien complementa · ${REQUISITOS[tipo].etiqueta}` : `Documentos · ${REQUISITOS[tipo].etiqueta}`;
    return `
    <fieldset class="docs" data-tipo="${tipo}" data-grupo="${grupo}" ${activo ? '' : 'hidden'}>
      <legend>${esc(titulo)}</legend>
      ${REQUISITOS[tipo].documentos
        .map((d, i) => {
          const input = (multiple, requerido) =>
            `<input type="file" name="${prefijo}${d.campo}" ${multiple ? 'multiple' : ''} accept="${ACEPTA}" ${requerido ? '' : 'data-opcional="1"'} ${activo && requerido ? 'required' : ''}>
          <span class="seleccion" aria-live="polite">Seleccionar archivo</span>`;
          if (!d.casillas) {
            return `
        <label class="archivo">
          <span class="num">${i + 1}</span>
          <span class="texto"><strong>${esc(d.nombre)}</strong><small>${esc(d.ayuda)}</small></span>
          ${input(true, true)}
        </label>`;
          }
          return `
        <div class="archivo-grupo">
          <div class="archivo-cab"><span class="num">${i + 1}</span>
            <span class="texto"><strong>${esc(d.nombre)}</strong><small>${esc(d.ayuda)}</small></span></div>
          ${d.casillas
            .map(
              (c, j) => `<label class="archivo sub">
            <span class="texto"><strong>${esc(c)}</strong>${j ? '<small>Opcional si ya subiste todas en la primera</small>' : ''}</span>
            ${input(false, j === 0)}
          </label>`
            )
            .join('')}
        </div>`;
        })
        .join('')}
    </fieldset>`;
  };

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
          <label for="url_publicacion">Link de la publicación que te interesa
            <input id="url_publicacion" name="url_publicacion" type="text" inputmode="url" autocomplete="off" placeholder="Pega aquí el link del aviso (Mercado Libre, Yapo, Portal Inmobiliario…)" value="${val('url_publicacion')}" data-publicacion>
          </label>
          <div class="vista-publicacion" id="vista-publicacion" hidden aria-live="polite"></div>
          <label for="propiedad">Dirección de la propiedad <small class="nota">(si no la sabes, basta con el link)</small>
            <input id="propiedad" name="propiedad" placeholder="Ej: Rosario Sur 91, depto 504, Las Condes" value="${val('propiedad')}">
          </label>
        </fieldset>

        ${seccionDocs('dependiente')}
        ${seccionDocs('independiente')}

        <fieldset class="complemento">
          <legend>Complemento de renta</legend>
          <label class="check interruptor"><input type="checkbox" name="complementa" value="1" id="complementa" ${compActivo ? 'checked' : ''}>
            <span><strong>Voy a complementar renta con otra persona</strong><small>Pareja, familiar u otra persona que sume sus ingresos. Debe presentar los mismos documentos.</small></span></label>
          <div class="datos-comp" ${compActivo ? '' : 'hidden'}>
            <p class="subtitulo">¿Cómo trabaja quien complementa?</p>
            <div class="opciones-tipo">
              <label class="opcion"><input type="radio" name="comp_tipo" value="dependiente" ${v_comp_tipo === 'dependiente' ? 'checked' : ''}><span>👔 Dependiente</span></label>
              <label class="opcion"><input type="radio" name="comp_tipo" value="independiente" ${v_comp_tipo === 'independiente' ? 'checked' : ''}><span>🏢 Independiente o empresa</span></label>
            </div>
            <div class="grilla">
              <label>Nombre completo<input name="comp_nombre" data-req-comp value="${val('comp_nombre')}"></label>
              <label>RUT<input name="comp_rut" data-req-comp data-rut placeholder="12.345.678-9" value="${esc(v.comp_rut ? formatearRut(v.comp_rut) : '')}"></label>
              <label>Correo electrónico <small class="nota">(opcional)</small><input type="email" name="comp_email" value="${val('comp_email')}"></label>
              <label>Teléfono <small class="nota">(opcional)</small><input type="tel" name="comp_telefono" placeholder="+56 9 1234 5678" value="${esc(v.comp_telefono ? `+${v.comp_telefono}`.replace(/^\+\+/, '+') : '')}"></label>
            </div>
            <label>Relación con quien postula <small class="nota">(opcional)</small><input name="comp_relacion" placeholder="Ej: pareja, padre, hermana" value="${val('comp_relacion')}"></label>
          </div>
        </fieldset>
        ${seccionDocs('dependiente', 'comp')}
        ${seccionDocs('independiente', 'comp')}

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
    ${lead.url_publicacion ? `<tr><th>Publicación</th><td><a href="${esc(lead.url_publicacion)}" target="_blank" rel="noopener noreferrer">Ver aviso ↗</a></td></tr>` : ''}
    ${fila('Origen', lead.portal)}
    ${fila('Comentarios', lead.comentarios)}
    ${
      lead.complementa
        ? `<tr><th>Complementa renta</th><td>${esc(lead.comp_nombre)} · ${esc(formatearRut(lead.comp_rut || ''))} · ${esc(REQUISITOS[lead.comp_tipo]?.etiqueta || '')}${lead.comp_relacion ? ` · ${esc(lead.comp_relacion)}` : ''}${
            lead.comp_email || lead.comp_telefono ? `<br><small>${esc([lead.comp_email, lead.comp_telefono && `+${lead.comp_telefono}`].filter(Boolean).join(' · '))}</small>` : ''
          }</td></tr>`
        : ''
    }
  </table>`;
}

// ---------- Panel interno ----------

const ETIQUETAS_ESTADO = {
  contactado: 'Contactado (link enviado)',
  documentos_recibidos: 'Documentos por revisar',
  aprobado: 'Aprobado (esperando agenda)',
  rechazado: 'Rechazado / faltan docs',
  agendado: 'Visita agendada',
  visitado: 'Visita realizada',
  no_asistio: 'No asistió a la visita',
  no_continua: 'No continúa',
  cerrado: 'Cerrado',
};

const RESULTADO_VISITA = {
  realizada: '✅ Visita realizada – continúa',
  no_asistio: '⚠️ No asistió',
  no_continua: '❌ No continúa',
};

const opcPanel = (config, nav) => ({ empresa: config.empresa.nombre, ancho: 'ancho', nav, pie: false });
const linkWhatsapp = (tel) => (tel ? `<a href="https://wa.me/${esc(tel)}" target="_blank">+${esc(tel)}</a>` : '—');
const bloqueDeVisita = (v) => describirBloque(...v.split(' ').map((x, i) => (i ? Number(x) : x)));

function panel({ leads, todos, visitas, hoy, filtros = {}, eliminado, config }) {
  const conteo = (e) => todos.filter((l) => l.estado === e).length;
  const deHoy = visitas.filter((v) => v.fecha === hoy);
  const resumen = [
    ['documentos_recibidos', 'Por revisar', conteo('documentos_recibidos')],
    ['aprobado', 'Esperando agenda', conteo('aprobado')],
    ['agendado', 'Con visita agendada', conteo('agendado')],
    ['hoy', 'Visitas hoy', deHoy.length],
  ];
  const filtrando = Boolean(filtros.q || filtros.estado);
  const opcionesEstado = Object.entries(ETIQUETAS_ESTADO)
    .map(([k, t]) => `<option value="${k}" ${filtros.estado === k ? 'selected' : ''}>${esc(t)}</option>`)
    .join('');
  const filaVisita = (v) =>
    `<tr><td>${esc(fechaLarga(v.fecha))}</td><td>${horaTexto(v.hora)}</td><td><a href="/admin/lead/${v.lead_id}">${esc(v.nombre)}</a></td><td>${linkWhatsapp(v.telefono)}</td><td>${esc(v.propiedad || '—')}</td></tr>`;

  return layout(
    'Panel comercial',
    `${eliminado ? `<div class="alerta ok">🗑️ Se eliminó a <strong>${esc(eliminado)}</strong> con todos sus documentos.</div>` : ''}
    <section class="resumen-estados">
      ${resumen
        .map(
          ([e, t, n]) =>
            `<a class="cifra ${e} ${filtros.estado === e ? 'activa' : ''}" href="${e === 'hoy' ? '#hoy' : `/admin?estado=${e}#interesados`}"><strong>${n}</strong><span>${t}</span></a>`
        )
        .join('')}
    </section>
    ${
      deHoy.length
        ? `<section class="tarjeta destacada" id="hoy">
      <h1>📅 Visitas de hoy</h1>
      <ul class="agenda-lista">${deHoy
        .map(
          (v) =>
            `<li><span class="cuando">${horaTexto(v.hora)} hrs</span> <a href="/admin/lead/${v.lead_id}">${esc(v.nombre)}</a> · ${linkWhatsapp(v.telefono)}${v.propiedad ? ` · ${esc(v.propiedad)}` : ''}${v.resultado ? ` · <strong>${RESULTADO_VISITA[v.resultado]}</strong>` : ''}</li>`
        )
        .join('')}</ul>
    </section>`
        : ''
    }
    <section class="tarjeta">
      <div class="titulo-seccion"><h1>Próximas visitas</h1><a class="boton chico" href="/admin/calendario">Ver calendario</a></div>
      ${
        visitas.length
          ? `<div class="tabla-scroll"><table class="tabla"><thead><tr><th>Fecha</th><th>Hora</th><th>Interesado</th><th>Teléfono</th><th>Propiedad</th></tr></thead><tbody>
          ${visitas.slice(0, 8).map(filaVisita).join('')}</tbody></table></div>`
          : '<p class="nota">No hay visitas agendadas.</p>'
      }
    </section>
    <section class="tarjeta" id="interesados">
      <div class="titulo-seccion">
        <h1>Interesados</h1>
        <a class="boton chico" href="/admin/exportar.csv">⬇ Exportar a Excel</a>
      </div>
      <form class="filtros" method="get" action="/admin#interesados" role="search">
        <label for="q" class="oculto">Buscar</label>
        <input id="q" name="q" type="search" placeholder="Buscar por nombre, RUT, teléfono, correo o propiedad" value="${esc(filtros.q || '')}">
        <label for="estado" class="oculto">Estado</label>
        <select id="estado" name="estado"><option value="">Todos los estados</option>${opcionesEstado}</select>
        <button class="boton">Buscar</button>
        ${filtrando ? '<a class="boton chico" href="/admin#interesados">Limpiar</a>' : ''}
      </form>
      ${filtrando ? `<p class="nota">${leads.length} resultado(s)</p>` : ''}
      <div class="tabla-scroll"><table class="tabla"><thead><tr><th>#</th><th>Nombre</th><th>Teléfono</th><th>Origen</th><th>Estado</th><th>Documentos</th><th></th></tr></thead><tbody>
      ${
        leads.length
          ? leads
              .map(
                (l) => `<tr>
          <td>${l.id}</td>
          <td><a href="/admin/lead/${l.id}"><strong>${esc(l.nombre || 'Sin nombre aún')}</strong></a>${l.complementa ? ' <span class="tag-comp" title="Complementa renta con ' + esc(l.comp_nombre || '') + '">+ complemento</span>' : ''}<br><small>${esc(l.email || '')}</small>
            ${l.duplicados ? `<br><span class="aviso-dup" title="Mismo teléfono o RUT que #${esc(l.duplicados)}">⚠️ Posible duplicado de ${l.duplicados.split(',').map((d) => `<a href="/admin/lead/${esc(d)}">#${esc(d)}</a>`).join(', ')}</span>` : ''}</td>
          <td>${linkWhatsapp(l.telefono)}</td>
          <td>${esc(l.portal || '—')}</td>
          <td><span class="estado ${esc(l.estado)}">${esc(ETIQUETAS_ESTADO[l.estado] || l.estado)}</span>${l.visita ? `<br><small>${esc(bloqueDeVisita(l.visita))}</small>` : ''}</td>
          <td>${l.n_documentos ? `<a href="/admin/lead/${l.id}#documentos">📎 ${l.n_documentos} archivo(s)</a>` : '<span class="nota">—</span>'}</td>
          <td class="acciones"><a class="boton chico" href="/admin/lead/${l.id}">Ver ficha</a></td>
        </tr>`
              )
              .join('')
          : `<tr><td colspan="7" class="nota">${filtrando ? 'No hay interesados que coincidan con la búsqueda.' : 'Aún no hay interesados.'}</td></tr>`
      }
      </tbody></table></div>
    </section>`,
    opcPanel(config, 'leads')
  );
}

function fichaAdmin({ lead, documentos, visita, firma, aviso, config }) {
  const requisitos = REQUISITOS[lead.tipo]?.documentos || [];
  const grupos = requisitos.map((r, i) => ({ ...r, n: i + 1, docs: documentos.filter((d) => d.requisito === r.campo) }));
  const reqComp = lead.complementa ? (REQUISITOS[lead.comp_tipo]?.documentos || []).map((r) => ({ ...r, campo: `comp_${r.campo}` })) : [];
  const gruposComp = reqComp.map((r, i) => ({ ...r, n: i + 1, docs: documentos.filter((d) => d.requisito === r.campo) }));
  const otros = documentos.filter((d) => ![...requisitos, ...reqComp].some((r) => r.campo === d.requisito));
  if (otros.length) grupos.push({ campo: 'otros', n: '·', nombre: 'Otros documentos (postulación anterior)', docs: otros });
  const tipoArchivo = (d) => (/pdf/.test(d.mime || '') ? 'PDF' : 'IMG');
  const fecha = (iso) => (iso ? new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).toLocaleString('es-CL', { timeZone: config.zonaHoraria, dateStyle: 'medium', timeStyle: 'short' }) : '');
  const puedeRevisar = ['documentos_recibidos', 'rechazado'].includes(lead.estado) && documentos.length;

  return layout(
    lead.nombre || 'Interesado',
    `<p class="migas"><a href="/admin">← Interesados</a></p>
    ${aviso ? `<div class="alerta ok">${esc(aviso)}</div>` : ''}
    <section class="tarjeta">
      <div class="titulo-seccion">
        <div><h1>${esc(lead.nombre || 'Sin nombre aún')}</h1>
        <span class="estado ${esc(lead.estado)}">${esc(ETIQUETAS_ESTADO[lead.estado] || lead.estado)}</span></div>
        <div class="acciones-ficha">
          ${lead.telefono ? `<a class="boton chico" href="https://wa.me/${esc(lead.telefono)}" target="_blank">WhatsApp</a>` : ''}
          ${puedeRevisar ? `<a class="boton chico primario" href="/revision/${lead.id}/aprobar?firma=${esc(firma)}">Aprobar y enviar calendario</a>
          <a class="boton chico" href="/revision/${lead.id}/rechazar?firma=${esc(firma)}">Rechazar / pedir documentos</a>` : ''}
        </div>
      </div>
      ${lead.motivo_rechazo ? `<div class="alerta error">Motivo informado: ${esc(lead.motivo_rechazo)}</div>` : ''}
      ${fichaLead(lead)}
      ${lead.mensaje_inicial ? `<p class="nota">Primer mensaje por WhatsApp: “${esc(lead.mensaje_inicial)}”</p>` : ''}
    </section>

    <section class="tarjeta" id="documentos">
      <div class="titulo-seccion">
        <div><h1>Documentos</h1>${lead.documentos_at ? `<span class="nota">Recibidos el ${esc(fecha(lead.documentos_at))}</span>` : ''}</div>
        ${documentos.length ? `<a class="boton primario" href="/admin/lead/${lead.id}/documentos.zip">⬇ Descargar todo (ZIP)</a>` : ''}
      </div>
      ${
        documentos.length
          ? [
              ...grupos,
              ...(gruposComp.length
                ? [{ separador: `Complemento de renta · ${lead.comp_nombre || ''} (${REQUISITOS[lead.comp_tipo]?.etiqueta || ''})` }, ...gruposComp]
                : []),
            ]
              .map((g) =>
                g.separador
                  ? `<h2 class="sep-comp">👥 ${esc(g.separador)}</h2>`
                  : `<div class="grupo-docs">
            <h3><span class="num">${g.n}</span>${esc(g.nombre)}</h3>
            ${
              g.docs.length
                ? `<ul class="archivos">${g.docs
                    .map(
                      (d) => `<li>
                  <span class="tipo-archivo">${tipoArchivo(d)}</span>
                  <span class="nombre-archivo">${esc(d.nombre_original)} <small>${tamanoLegible(d.tamano)}</small></span>
                  <a class="boton chico" href="/admin/documento/${d.id}" target="_blank">Ver</a>
                  <a class="boton chico" href="/admin/documento/${d.id}?descargar=1">Descargar</a>
                </li>`
                    )
                    .join('')}</ul>`
                : '<p class="falta">No adjuntado</p>'
            }
          </div>`
              )
              .join('')
          : '<p class="nota">Este interesado aún no ha subido documentos.</p>'
      }
    </section>

    ${seccionVisita(lead, visita)}

    <section class="tarjeta zona-peligro">
      <div class="titulo-seccion">
        <div><h2>Eliminar interesado</h2>
        <p class="nota">Si el interesado no continúa, puedes borrar sus datos, documentos y visitas del sistema. No se puede deshacer.</p></div>
        <a class="boton peligro" href="/admin/lead/${lead.id}/eliminar">🗑️ Eliminar interesado</a>
      </div>
    </section>`,
    opcPanel(config, 'leads')
  );
}

function seccionVisita(lead, visita) {
  if (!visita) {
    return `<section class="tarjeta" id="visita"><h1>Visita</h1>
      <p class="nota">${
        ['aprobado'].includes(lead.estado)
          ? 'Aprobado: esperando que el interesado elija un horario en el calendario.'
          : 'Aún no tiene visita agendada. El calendario se envía al aprobar sus documentos.'
      }</p></section>`;
  }
  const cuando = describirBloque(visita.fecha, visita.hora);
  if (visita.estado === 'cancelada') {
    return `<section class="tarjeta" id="visita"><h1>Visita</h1>
      <p>La visita del <strong>${esc(cuando)}</strong> fue <strong>cancelada</strong>.${lead.estado === 'aprobado' ? ' El interesado puede elegir otro horario con su link.' : ''}</p></section>`;
  }
  const opcion = (valor) =>
    `<label class="opcion-resultado"><input type="radio" name="resultado" value="${valor}" ${visita.resultado === valor ? 'checked' : ''} required><span>${RESULTADO_VISITA[valor]}</span></label>`;
  return `<section class="tarjeta" id="visita">
    <div class="titulo-seccion">
      <div><h1>Visita</h1><p class="cuando-visita">📅 ${esc(cuando)}</p>
      <p class="${visita.confirmada_at ? 'confirmo' : 'nota'}">${visita.confirmada_at ? '✅ El interesado confirmó su asistencia' : '⏳ El interesado aún no confirma (se le pide el día anterior)'}</p>
      ${lead.propiedad ? `<p class="nota">🏠 ${esc(lead.propiedad)}</p>` : ''}</div>
      ${visita.resultado ? `<span class="estado ${visita.resultado === 'realizada' ? 'agendado' : visita.resultado === 'no_continua' ? 'rechazado' : 'documentos_recibidos'}">${RESULTADO_VISITA[visita.resultado]}</span>` : '<span class="estado aprobado">Pendiente</span>'}
    </div>
    <form method="post" action="/admin/lead/${lead.id}/visita" class="form-visita">
      <fieldset>
        <legend>¿Cómo fue la visita?</legend>
        <div class="opciones-resultado">${opcion('realizada')}${opcion('no_asistio')}${opcion('no_continua')}</div>
      </fieldset>
      <label for="notas-visita">Notas de la visita (opcional)</label>
      <textarea id="notas-visita" name="notas" rows="3" placeholder="Ej: le gustó, pide ver contrato; o: busca algo más grande.">${esc(visita.notas || '')}</textarea>
      <div class="acciones-ficha"><button class="boton primario">Guardar resultado</button></div>
    </form>
    ${
      visita.resultado
        ? ''
        : `<form method="post" action="/admin/lead/${lead.id}/visita/cancelar" class="form-cancelar">
      <label class="check"><input type="checkbox" name="avisar" value="1" checked> Avisar al interesado (correo y WhatsApp) para que elija otro horario</label>
      <button class="boton">Cancelar esta visita</button>
    </form>`
    }
    ${visita.resultado === 'no_continua' ? `<div class="alerta error">Este interesado no continúa. Si ya no necesitas sus datos, puedes <a href="/admin/lead/${lead.id}/eliminar">eliminarlo</a>.</div>` : ''}
  </section>`;
}

function ingresar({ volver, error, usuario, config }) {
  return layout(
    'Ingresar al panel',
    `<section class="tarjeta login">
      <h1>Panel comercial</h1>
      <p class="lead">Ingresa con el usuario y la clave del equipo comercial.</p>
      ${error ? `<div class="alerta error">${esc(error)}</div>` : ''}
      <form method="post" action="/ingresar">
        <input type="hidden" name="volver" value="${esc(volver)}">
        <label for="usuario">Usuario<input id="usuario" name="usuario" autocomplete="username" autocapitalize="none" required value="${esc(usuario || config.admin.usuario)}"></label>
        <label for="clave">Clave<input id="clave" name="clave" type="password" autocomplete="current-password" required autofocus></label>
        <button class="boton primario grande">Ingresar</button>
      </form>
      <p class="nota centrado">La sesión queda abierta 30 días en este dispositivo.</p>
    </section>`,
    { empresa: config.empresa.nombre, pie: false }
  );
}

function confirmarEliminar({ lead, documentos, visita, config }) {
  return layout(
    'Eliminar interesado',
    `<p class="migas"><a href="/admin/lead/${lead.id}">← Volver a la ficha</a></p>
    <section class="tarjeta zona-peligro">
      <h1>¿Eliminar a ${esc(lead.nombre || 'este interesado')}?</h1>
      <p>Se borrarán del sistema de forma permanente:</p>
      <ul>
        <li>Sus datos (${esc(lead.email || 'sin correo')}${lead.telefono ? `, +${esc(lead.telefono)}` : ''})</li>
        <li>${documentos.length} documento(s) subido(s)</li>
        <li>Su historial de visitas${visita ? ` (incluida la visita del ${esc(describirBloque(visita.fecha, visita.hora))}, cuyo horario quedará libre)` : ''}</li>
      </ul>
      <p class="nota">Los correos que ya llegaron a las casillas del equipo no se borran. Si necesitas los documentos, <a href="/admin/lead/${lead.id}/documentos.zip">descárgalos antes</a>.</p>
      <form method="post" action="/admin/lead/${lead.id}/eliminar">
        <label class="check"><input type="checkbox" name="confirmo" value="1" required> Confirmo que quiero eliminar a este interesado y sus documentos</label>
        <div class="acciones-ficha">
          <button class="boton peligro">Eliminar definitivamente</button>
          <a class="boton" href="/admin/lead/${lead.id}">Cancelar</a>
        </div>
      </form>
    </section>`,
    opcPanel(config, 'leads')
  );
}

function calendarioPanel({ lunes, hoy, desplazamiento, visitas, proximas, config }) {
  const dias = [0, 1, 2, 3, 4].map((i) => sumarDias(lunes, i));
  const enBloque = (f, h) => visitas.filter((v) => v.fecha === f && v.hora === h);
  const titulo = `${fechaLarga(dias[0]).replace(/^\S+ /, '')} – ${fechaLarga(dias[4]).replace(/^\S+ /, '')}`;
  const total = visitas.length;
  return layout(
    'Calendario de visitas',
    `<section class="tarjeta">
      <div class="titulo-seccion">
        <div><h1>Calendario de visitas</h1><span class="nota">${total ? `${total} visita(s) esta semana` : 'Sin visitas esta semana'}</span></div>
        <div class="nav-semanas compacto">
          <a class="boton" href="/admin/calendario?semana=${desplazamiento - 1}" aria-label="Semana anterior">‹</a>
          <span class="titulo-semana">${esc(titulo)}</span>
          <a class="boton" href="/admin/calendario?semana=${desplazamiento + 1}" aria-label="Semana siguiente">›</a>
          ${desplazamiento ? '<a class="boton chico" href="/admin/calendario">Hoy</a>' : ''}
        </div>
      </div>
      <div class="tabla-scroll">
      <table class="cal-panel">
        <thead><tr><th></th>${dias
          .map((f) => {
            const [nombre, ...resto] = fechaLarga(f).split(' ');
            const esFeriado = config.agenda.feriados.includes(f);
            return `<th class="${f === hoy ? 'hoy' : ''} ${f < hoy ? 'pasado' : ''}"><span>${esc(nombre)}</span><small>${esc(resto.join(' ').replace(' de ', ' '))}${esFeriado ? ' · feriado' : ''}</small></th>`;
          })
          .join('')}</tr></thead>
        <tbody>${config.agenda.horas
          .map(
            (h) => `<tr><th class="hora">${horaTexto(h)}</th>${dias
              .map((f) => {
                const vs = enBloque(f, h);
                return `<td class="${f === hoy ? 'hoy' : ''} ${f < hoy ? 'pasado' : ''}">${vs
                  .map(
                    (v) => `<a class="visita" href="/admin/lead/${v.lead_id}">
                      <strong>${esc(v.nombre)}</strong>
                      <span>+${esc(v.telefono || '')}</span>
                      ${v.propiedad ? `<span class="prop">🏠 ${esc(v.propiedad)}</span>` : ''}
                      ${v.resultado ? `<span class="res">${RESULTADO_VISITA[v.resultado]}</span>` : v.confirmada_at ? '<span class="res">✅ Confirmó asistencia</span>' : ''}
                    </a>`
                  )
                  .join('')}</td>`;
              })
              .join('')}</tr>`
          )
          .join('')}</tbody>
      </table>
      </div>
    </section>
    <section class="tarjeta">
      <h1>Próximas visitas</h1>
      ${
        proximas.length
          ? `<ul class="agenda-lista">${proximas
              .map(
                (v) => `<li><span class="cuando">${esc(describirBloque(v.fecha, v.hora))}</span>
                <a href="/admin/lead/${v.lead_id}">${esc(v.nombre)}</a> · ${linkWhatsapp(v.telefono)}${v.propiedad ? ` · ${esc(v.propiedad)}` : ''}</li>`
              )
              .join('')}</ul>`
          : '<p class="nota">No hay visitas agendadas.</p>'
      }
    </section>`,
    opcPanel(config, 'calendario')
  );
}

module.exports = { ETIQUETAS_ESTADO, RESULTADO_VISITA, layout, mensaje, formularioPostulacion, calendario, revision, fichaLead, panel, fichaAdmin, calendarioPanel, confirmarEliminar, ingresar };
