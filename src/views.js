const { esc, formatearRut, tamanoLegible } = require('./utils');
const { REQUISITOS, nombreRequisito } = require('./requisitos');
const { formularioPersona, filasPersona, PLAZOS_CAMBIO } = require('./personas');
const { faltaDireccion } = require('./publicacion');
const { evaluarRenta, alertasAfp } = require('./evaluacionRenta');
const { fechaLegible } = require('./personas');

const PLAZO_CORTO = { '5_dias': '5 días', '15_dias': '15 días', '1_mes': '1 mes', mas_1_mes: '+1 mes' };
const { fechaLarga, horaTexto, describirBloque, sumarDias, horasDe, columnasSemana, textoDias } = require('./agenda');

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
    const titulo = grupo === 'comp' ? `Documentos de quien complementa o es aval · ${REQUISITOS[tipo].etiqueta}` : `Documentos · ${REQUISITOS[tipo].etiqueta}`;
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
          ${formularioPersona(v, '')}
          <div class="grilla solo-empresa" ${v.tipo === 'independiente' ? '' : 'hidden'}>
            <label>Razón social (si postulas como empresa)<input name="razon_social" value="${val('razon_social')}"></label>
            <label>RUT empresa<input name="rut_empresa" placeholder="76.123.456-7" value="${esc(v.rut_empresa ? formatearRut(v.rut_empresa) : '')}" data-rut></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>La propiedad que quieres arrendar</legend>
          <label for="url_publicacion">Link de la publicación que te interesa
            <input id="url_publicacion" name="url_publicacion" type="text" inputmode="url" autocomplete="off" required placeholder="Pega aquí el link del aviso (Mercado Libre, Yapo, Portal Inmobiliario…)" value="${val('url_publicacion')}" data-publicacion>
          </label>
          <div class="vista-publicacion" id="vista-publicacion" hidden aria-live="polite"></div>
          <label for="propiedad">Dirección de la propiedad que quieres arrendar <small class="nota">(la del aviso, no tu dirección actual)</small>
            <input id="propiedad" name="propiedad" required placeholder="Ej: Rosario Sur 91, depto 504, Las Condes" value="${val('propiedad')}">
          </label>
          <div class="campo-plazo" role="radiogroup" aria-labelledby="plazo-titulo">
            <span id="plazo-titulo" class="etiqueta">¿Para cuándo te quieres cambiar?</span>
            <div class="opciones-plazo">
              ${Object.entries(PLAZOS_CAMBIO)
                .map(([k, t]) => `<label class="opcion"><input type="radio" name="plazo_cambio" value="${k}" required ${v.plazo_cambio === k ? 'checked' : ''}><span>${t}</span></label>`)
                .join('')}
            </div>
          </div>
        </fieldset>

        ${seccionDocs('dependiente')}
        ${seccionDocs('independiente')}

        <fieldset class="complemento">
          <legend>Complemento de renta o aval</legend>
          <label class="check interruptor"><input type="checkbox" name="complementa" value="1" id="complementa" ${compActivo ? 'checked' : ''}>
            <span><strong>Voy a complementar renta o tengo un aval</strong><small>Pareja, familiar u otra persona. Debe entregar los mismos datos y documentos.</small></span></label>
          <div class="datos-comp" ${compActivo ? '' : 'hidden'}>
            <p class="subtitulo">Esta persona…</p>
            <div class="opciones-tipo">
              <label class="opcion"><input type="radio" name="comp_rol" value="complemento" ${v.comp_rol !== 'aval' ? 'checked' : ''}><span>➕ Complementa renta</span></label>
              <label class="opcion"><input type="radio" name="comp_rol" value="aval" ${v.comp_rol === 'aval' ? 'checked' : ''}><span>🤝 Es aval</span></label>
            </div>
            <p class="subtitulo">¿Cómo trabaja?</p>
            <div class="opciones-tipo">
              <label class="opcion"><input type="radio" name="comp_tipo" value="dependiente" ${v_comp_tipo === 'dependiente' ? 'checked' : ''}><span>👔 Dependiente</span></label>
              <label class="opcion"><input type="radio" name="comp_tipo" value="independiente" ${v_comp_tipo === 'independiente' ? 'checked' : ''}><span>🏢 Independiente o empresa</span></label>
            </div>
            <p class="subtitulo">Sus datos</p>
            ${formularioPersona(v, 'comp_')}
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
    const corto = { miércoles: 'mié', sábado: 'sáb' }[nombre] || nombre.slice(0, 3);
    return `<span class="dia-nombre"><span class="largo">${esc(nombre)}</span><span class="corto">${esc(corto)}</span></span><span class="dia-fecha">${esc(resto.join(' ').replace(' de ', ' '))}</span>`;
  };
  const semanas = cal.semanas
    .map(
      (s, i) => `
    <div class="semana" data-semana="${i}" ${i === 0 ? '' : 'hidden'}>
      <div class="dias" style="--ndias:${s.dias.length}">
        ${s.dias
          .map(
            (d) => `
          <div class="dia ${d.habilitado ? '' : 'inhabil'}">
            <div class="dia-cab">${cabecera(d.fecha)}</div>
            ${
              d.habilitado
                ? d.bloques
                    .map((b) => {
                      const h = b.hora;
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
      <p class="lead">Hola ${esc((lead.nombre || '').split(' ')[0])}, elige el día y la hora que te acomoden. Las visitas son de ${esc(textoDias(config.agenda))}.</p>
      ${lead.propiedad ? `<p class="propiedad">🏠 ${esc(lead.propiedad)}</p>` : ''}
      ${visita ? `<div class="alerta ok">Ya tienes una visita agendada para el <strong>${esc(describirBloque(visita.fecha, visita.hora))}</strong>. Si eliges otro horario, la reagendaremos. <a href="/visita/${lead.token}/cancelar">Cancelar mi visita</a></div>` : ''}
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
    `<p class="migas"><a href="/admin">← Volver al panel</a> · <a href="/admin/lead/${lead.id}">Ver ficha</a></p>
    <section class="tarjeta">
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

// El interesado escribió su propia dirección como la de la propiedad
const soloLetras = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const mismaDireccion = (lead) => {
  const p = soloLetras(lead.propiedad);
  const d = soloLetras(lead.direccion_actual);
  return p.length >= 6 && d.length >= 6 && (p.includes(d) || d.includes(p));
};

// Etiqueta del panel: si las liquidaciones cumplen 2,5 veces el arriendo
function etiquetaRenta(l) {
  if (!l.revision_datos || !l.valor_arriendo) return '';
  let r = null;
  try {
    r = resumenRenta(l, JSON.parse(l.revision_datos));
  } catch {
    return '';
  }
  if (!r || r.cumple === null) return '';
  return r.cumple ? ' <span class="tag-renta ok" title="Cumple 2,5 veces el arriendo">💰 Cumple</span>' : ' <span class="tag-renta mal" title="No cumple 2,5 veces el arriendo">💰 No cumple</span>';
}

const etiquetaComp = (lead) => (lead.comp_rol === 'aval' ? 'Aval' : 'Complementa renta');

function fichaLead(lead) {
  const fila = (k, v) => (v ? `<tr><th>${k}</th><td>${esc(v)}</td></tr>` : '');
  return `<table class="ficha">
    ${filasPersona(lead).map(([k, v]) => fila(k, v)).join('')}
    ${fila('Tipo', REQUISITOS[lead.tipo]?.etiqueta)}
    ${fila('Razón social', lead.razon_social)}
    ${fila('RUT empresa', lead.rut_empresa && formatearRut(lead.rut_empresa))}
    ${fila('Propiedad de interés', lead.propiedad)}
    ${faltaDireccion(lead.propiedad) ? '<tr><th></th><td><span class="aviso-dup">⚠️ Falta la dirección exacta (el interesado pegó el link). Revisa el aviso y escríbela abajo para que Julio la vea en el calendario.</span></td></tr>' : ''}
    ${mismaDireccion(lead) ? '<tr><th></th><td><span class="aviso-dup">⚠️ Es igual a su dirección actual: confirma con el interesado cuál propiedad quiere visitar y corrígela abajo.</span></td></tr>' : ''}
    ${fila('Fecha de cambio', PLAZOS_CAMBIO[lead.plazo_cambio])}
    ${lead.url_publicacion ? `<tr><th>Link de publicación</th><td><a href="${esc(lead.url_publicacion)}" target="_blank" rel="noopener noreferrer">Ver aviso ↗</a></td></tr>` : '<tr><th>Link de publicación</th><td class="nota">No lo indicó</td></tr>'}
    ${fila('Origen', lead.portal)}
    ${fila('Comentarios', lead.comentarios)}
  </table>
  ${
    lead.complementa
      ? `<h2 class="sep-comp">👥 ${etiquetaComp(lead)}${lead.comp_relacion ? ` · ${esc(lead.comp_relacion)}` : ''}</h2>
  <table class="ficha">
    ${filasPersona(lead, 'comp_').map(([k, v]) => fila(k, v)).join('')}
    ${fila('Tipo', REQUISITOS[lead.comp_tipo]?.etiqueta)}
  </table>`
      : ''
  }`;
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

// "21-10 18:05" en hora de Chile, desde fechas guardadas en UTC
const fechaHora = (iso) =>
  iso ? new Date(`${String(iso).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'}`).toLocaleString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const opcPanel = (config, nav) => ({ empresa: config.empresa.nombre, ancho: 'ancho', nav, pie: false });
const linkWhatsapp = (tel) => (tel ? `<a href="https://wa.me/${esc(tel)}" target="_blank">+${esc(tel)}</a>` : '—');
const bloqueDeVisita = (v) => describirBloque(...v.split(' ').map((x, i) => (i ? Number(x) : x)));

function panel({ leads, todos, visitas, sinResultado = [], recordados = null, hoy, filtros = {}, eliminado, config }) {
  const conteo = (e) => todos.filter((l) => l.estado === e).length;
  const deHoy = visitas.filter((v) => v.fecha === hoy);
  const resumen = [
    ['documentos_recibidos', 'Por revisar', conteo('documentos_recibidos')],
    ['aprobado', 'Esperando agenda', conteo('aprobado')],
    ['agendado', 'Con visita agendada', conteo('agendado')],
    ['hoy', 'Visitas hoy', deHoy.length],
    ['resultado', 'Por registrar resultado', sinResultado.length],
  ];
  const esperando = todos.filter((l) => l.estado === 'aprobado' && l.email);
  const filtrando = Boolean(filtros.q || filtros.estado);
  const opcionesEstado = Object.entries(ETIQUETAS_ESTADO)
    .map(([k, t]) => `<option value="${k}" ${filtros.estado === k ? 'selected' : ''}>${esc(t)}</option>`)
    .join('');
  const filaVisita = (v) =>
    `<tr><td class="col-principal">${esc(fechaLarga(v.fecha))}<span class="solo-movil"> · ${horaTexto(v.hora)}</span></td><td class="col-hora">${horaTexto(v.hora)}</td><td><a href="/admin/lead/${v.lead_id}">${esc(v.nombre)}</a></td><td>${linkWhatsapp(v.telefono)}</td><td class="col-prop">${esc(v.propiedad || '—')}</td></tr>`;

  return layout(
    'Panel comercial',
    `${eliminado ? `<div class="alerta ok">🗑️ Se eliminó a <strong>${esc(eliminado)}</strong> con todos sus documentos.</div>` : ''}
    <section class="resumen-estados">
      ${resumen
        .map(
          ([e, t, n]) =>
            `<a class="cifra ${e} ${filtros.estado === e ? 'activa' : ''}" href="${e === 'hoy' ? '#hoy' : e === 'resultado' ? '#post-visita' : `/admin?estado=${e}#interesados`}"><strong>${n}</strong><span>${t}</span></a>`
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
    ${recordados !== null ? `<div class="alerta ok">📨 ${recordados ? `Se envió el recordatorio para agendar a ${recordados} interesado(s).` : 'No había interesados por recordar (a los que ya se les avisó en las últimas 24 horas no se les vuelve a enviar).'}</div>` : ''}
    ${
      sinResultado.length
        ? `<section class="tarjeta destacada" id="post-visita">
      <h1>📝 Visitas por registrar resultado</h1>
      <p class="nota">Ya pasaron y no tienen resultado. Al terminar cada visita también llega un correo al equipo para registrarlo con un toque.</p>
      <ul class="agenda-lista">${sinResultado
        .map(
          (v) =>
            `<li><span class="cuando">${esc(describirBloque(v.fecha, v.hora))}</span> <a href="/admin/lead/${v.lead_id}#visita">${esc(v.nombre)}</a>${v.propiedad ? ` · ${esc(v.propiedad)}` : ''} · <a class="boton chico" href="/admin/lead/${v.lead_id}#visita">Registrar resultado</a></li>`
        )
        .join('')}</ul>
    </section>`
        : ''
    }
    ${
      esperando.length && !filtrando
        ? `<section class="tarjeta" id="esperando-agenda">
      <div class="titulo-seccion"><div><h1>⏳ Esperando agenda</h1><span class="nota">${esperando.length} aprobado(s) que aún no eligen horario</span></div>
        <form method="post" action="/admin/recordar-agenda"><button class="boton primario">📨 Recordar a todos que agenden</button></form></div>
      <ul class="agenda-lista">${esperando
        .slice(0, 20)
        .map(
          (l) =>
            `<li><a href="/admin/lead/${l.id}#visita">${esc(l.nombre || 'Sin nombre')}</a> · ${linkWhatsapp(l.telefono)} · <span class="nota">${l.aviso_agenda_at ? `recordado ${l.avisos_agenda} vez(ces), último ${esc(fechaHora(l.aviso_agenda_at))}` : `aprobado ${esc(fechaHora(l.aprobado_at))}`}</span></li>`
        )
        .join('')}</ul>
    </section>`
        : ''
    }
    <section class="tarjeta">
      <div class="titulo-seccion"><h1>Próximas visitas</h1><a class="boton chico" href="/admin/calendario">Ver calendario</a></div>
      ${
        visitas.length
          ? `<div class="tabla-scroll"><table class="tabla tabla-movil"><thead><tr><th>Fecha</th><th>Hora</th><th>Interesado</th><th>Teléfono</th><th>Propiedad</th></tr></thead><tbody>
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
      <div class="tabla-scroll"><table class="tabla tabla-movil"><thead><tr><th>#</th><th>Nombre</th><th>Teléfono</th><th>Origen</th><th>Estado</th><th>Documentos</th><th></th></tr></thead><tbody>
      ${
        leads.length
          ? leads
              .map(
                (l) => `<tr>
          <td class="col-id">${l.id}</td>
          <td class="col-principal"><a href="/admin/lead/${l.id}"><strong>${esc(l.nombre || 'Sin nombre aún')}</strong></a>${l.complementa ? ' <span class="tag-comp" title="' + (l.comp_rol === 'aval' ? 'Aval: ' : 'Complementa renta: ') + esc(l.comp_nombre || '') + '">' + (l.comp_rol === 'aval' ? '+ aval' : '+ complemento') + '</span>' : ''}${etiquetaRenta(l)}${PLAZO_CORTO[l.plazo_cambio] ? ` <span class="tag-plazo plazo-${l.plazo_cambio}" title="${PLAZOS_CAMBIO[l.plazo_cambio]}">🚚 ${PLAZO_CORTO[l.plazo_cambio]}</span>` : ''}<br><small>${esc(l.email || '')}</small>
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

function fichaAdmin({ lead, documentos, visita, revisionDocs = null, disponibles, firma, aviso, config }) {
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
      ${formPropiedad(lead, visita)}
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
                ? [{ separador: `${etiquetaComp(lead)} · ${lead.comp_nombre || ''} (${REQUISITOS[lead.comp_tipo]?.etiqueta || ''})` }, ...gruposComp]
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

    ${seccionRevisionDocs(lead, revisionDocs)}

    ${seccionVisita(lead, visita, disponibles)}

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

// Selector de horarios libres para que el equipo agende o reagende
function formAgendar(lead, disponibles, reagendar) {
  const grupos = (disponibles?.semanas || [])
    .flatMap((s) => s.dias)
    .filter((d) => d.habilitado && d.bloques.some((b) => b.disponible))
    .map(
      (d) =>
        `<optgroup label="${esc(describirBloque(d.fecha, 0).replace(/ a las .*/, ''))}">${d.bloques
          .filter((b) => b.disponible)
          .map((b) => `<option value="${b.fecha}|${b.hora}">${esc(describirBloque(b.fecha, b.hora))}</option>`)
          .join('')}</optgroup>`
    )
    .join('');
  if (!grupos) return '<p class="nota">No hay horarios libres en los próximos días.</p>';
  return `<form method="post" action="/admin/lead/${lead.id}/visita/agendar" class="form-agendar">
      <label for="bloque-equipo"><strong>${reagendar ? '🔁 Reagendar: elegir nueva fecha y hora' : '📅 Agendar visita (coordinada por el equipo)'}</strong></label>
      <div class="fila-agendar">
        <select id="bloque-equipo" name="bloque" required><option value="">Elige un horario libre…</option>${grupos}</select>
        <button class="boton primario">${reagendar ? 'Reagendar' : 'Agendar'}</button>
      </div>
      <label class="check"><input type="checkbox" name="avisar" value="1" checked> Avisar al interesado (correo y WhatsApp) con la ${reagendar ? 'nueva ' : ''}hora</label>
    </form>`;
}

const pesos = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString('es-CL')}` : '—');
const mesLegible = (p) => {
  const [y, m] = String(p).split('-').map(Number);
  return m ? `${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][m - 1]} ${y}` : p;
};

// Resultado de la lectura automática de liquidaciones y AFP, con el cálculo de 2,5 veces el arriendo
function resumenRenta(lead, datos) {
  if (!datos?.titular) return null;
  return evaluarRenta({
    valorArriendo: lead.valor_arriendo,
    titular: { liquidaciones: datos.titular.liquidaciones?.datos?.liquidaciones || [], rut: lead.rut },
    comp: datos.comp ? { liquidaciones: datos.comp.liquidaciones?.datos?.liquidaciones || [], rut: lead.comp_rut } : null,
  });
}

function bloqueAfp(titulo, persona, rut) {
  if (!persona?.afp) return '';
  if (!persona.afp.ok) return `<div class="afp-caja"><h3>${titulo}</h3><p class="falta">No se pudo leer: ${esc(persona.afp.error)}</p></div>`;
  const a = persona.afp.datos;
  const v = persona.validacionAfp || {};
  const estado = {
    valido: `<span class="sello ok">✅ Válido en AFP ${esc(a.afp)}</span>`,
    no_reconocido: `<span class="sello mal">⚠️ AFP ${esc(a.afp)} no lo reconoció</span>`,
    no_verificado: '<span class="sello medio">⏳ No se pudo consultar ahora</span>',
    manual: '<span class="sello medio">👀 Validar a mano</span>',
  }[v.estado] || '';
  const alertas = alertasAfp(a, rut);
  return `<div class="afp-caja"><h3>${titulo}</h3>
      <p>${estado}</p>
      <table class="ficha">
        <tr><th>AFP</th><td>${esc(a.afp)}</td></tr>
        <tr><th>Folio</th><td>${a.folio ? `<code>${esc(a.folio)}</code>` : '<span class="falta">No se leyó</span>'}</td></tr>
        ${a.fecha_emision ? `<tr><th>Emitido</th><td>${esc(fechaLegible(a.fecha_emision))}</td></tr>` : ''}
        ${a.ultimo_periodo_cotizado ? `<tr><th>Última cotización</th><td>${esc(mesLegible(a.ultimo_periodo_cotizado))}${a.empleador_actual ? ` · ${esc(a.empleador_actual)}` : ''}</td></tr>` : ''}
      </table>
      ${v.detalle ? `<p class="nota">${esc(v.detalle)}${v.mismoArchivo === true ? ' El PDF subido es idéntico al original de la AFP.' : v.mismoArchivo === false ? ' Ojo: el PDF subido no es idéntico al que entrega la AFP (puede ser otra descarga o estar editado): compara los datos.' : ''}</p>` : ''}
      ${alertas.length ? `<ul class="alertas">${alertas.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${v.validador && v.estado !== 'valido' ? `<a class="boton chico" href="${esc(v.validador)}" target="_blank" rel="noopener noreferrer">Abrir validador de AFP ${esc(a.afp)} ↗</a> <span class="nota">Copia el folio${a.rut_afiliado ? ` y el RUT ${esc(a.rut_afiliado)}` : ''}.</span>` : ''}
    </div>`;
}

function seccionRevisionDocs(lead, revision) {
  const reintentar = `<form method="post" action="/admin/lead/${lead.id}/revisar" class="en-linea"><button class="boton chico">🔁 Volver a leer documentos</button></form>`;
  const cabecera = (extra = '') => `<div class="titulo-seccion"><div><h1>🤖 Revisión automática</h1><span class="nota">Liquidaciones (2,5 veces el arriendo) y certificado de AFP</span></div>${extra}</div>`;
  if (lead.tipo !== 'dependiente' && !(lead.complementa && lead.comp_tipo === 'dependiente')) return '';
  if (!revision) return `<section class="tarjeta" id="revision-docs">${cabecera(reintentar)}<p class="nota">Aún no se leen los documentos.</p></section>`;
  if (revision.estado === 'sin_config') {
    return `<section class="tarjeta" id="revision-docs">${cabecera()}<p class="nota">La lectura automática no está activada: falta la clave ANTHROPIC_API_KEY en Render.</p></section>`;
  }
  if (revision.estado === 'leyendo') return `<section class="tarjeta" id="revision-docs">${cabecera()}<p>⏳ Leyendo los documentos… recarga la página en un minuto.</p></section>`;
  if (revision.estado === 'error' && !revision.datos) {
    return `<section class="tarjeta" id="revision-docs">${cabecera(reintentar)}<p class="falta">No se pudieron leer: ${esc(revision.error || '')}</p></section>`;
  }
  const d = revision.datos;
  const r = resumenRenta(lead, d);
  const hayComp = Boolean(d.comp?.liquidaciones);
  const sello = !r ? '' : r.cumple === true ? '<span class="sello ok">✅ Cumple 2,5 veces el arriendo en las 3 liquidaciones</span>' : r.cumple === false ? '<span class="sello mal">❌ No cumple 2,5 veces el arriendo</span>' : '<span class="sello medio">Falta el valor del arriendo</span>';
  const errorLiq = [d.titular?.liquidaciones, d.comp?.liquidaciones].filter((x) => x && !x.ok).map((x) => x.error);
  return `<section class="tarjeta" id="revision-docs">
      ${cabecera(reintentar)}
      <form method="post" action="/admin/lead/${lead.id}/arriendo" class="form-arriendo">
        <label>Valor del arriendo (mensual)<input name="valor_arriendo" inputmode="numeric" required placeholder="Ej: 450000" value="${lead.valor_arriendo || ''}"></label>
        <button class="boton primario">Calcular</button>
        ${r?.requerido ? `<span class="nota">Renta líquida requerida: <strong>${pesos(r.requerido)}</strong> por mes${hayComp ? ' (sumando a quien complementa)' : ''}</span>` : ''}
      </form>
      ${lead.url_publicacion ? `<p class="nota">El precio está en el <a href="${esc(lead.url_publicacion)}" target="_blank" rel="noopener noreferrer">aviso de la propiedad ↗</a>.</p>` : ''}
      <p>${sello}</p>
      ${
        r?.meses.length
          ? `<div class="tabla-scroll"><table class="tabla tabla-renta"><thead><tr><th>Mes</th><th>Empleador</th><th>Líquido</th>${hayComp ? '<th>Complemento</th><th>Total</th>' : ''}<th></th></tr></thead><tbody>
          ${r.meses
            .map(
              (m) => `<tr><td>${esc(mesLegible(m.periodo))}</td><td>${esc(m.empleador || '—')}</td><td>${pesos(m.titular)}</td>${hayComp ? `<td>${pesos(m.comp)}</td><td><strong>${pesos(m.total)}</strong></td>` : ''}<td>${m.cumple === true ? '✅' : m.cumple === false ? `❌ faltan ${pesos(r.requerido - m.total)}` : ''}</td></tr>`
            )
            .join('')}</tbody></table></div>`
          : ''
      }
      ${errorLiq.length ? `<p class="falta">No se pudieron leer las liquidaciones: ${esc(errorLiq.join(' · '))}</p>` : ''}
      ${r?.alertas.length ? `<ul class="alertas">${r.alertas.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${d.titular?.liquidaciones?.datos?.observaciones ? `<p class="nota">Observación: ${esc(d.titular.liquidaciones.datos.observaciones)}</p>` : ''}
      <div class="grilla-afp">
        ${bloqueAfp('Certificado AFP', d.titular, lead.rut)}
        ${bloqueAfp(`Certificado AFP · ${etiquetaComp(lead)}`, d.comp, lead.comp_rut)}
      </div>
      <p class="nota">Leído automáticamente el ${esc(new Date(d.leido_at).toLocaleString('es-CL', { timeZone: 'America/Santiago', dateStyle: 'short', timeStyle: 'short' }))} · Es una ayuda: confirma con los documentos antes de aprobar.</p>
    </section>`;
}

function formPropiedad(lead, visita) {
  const conVisita = visita && visita.estado === 'confirmada' && !visita.resultado;
  const falta = !lead.propiedad || faltaDireccion(lead.propiedad);
  return `<details class="editar-propiedad" ${falta ? 'open' : ''}>
      <summary>✏️ ${lead.propiedad ? 'Corregir la dirección de la propiedad a visitar' : 'Agregar la dirección de la propiedad a visitar'}</summary>
      <form method="post" action="/admin/lead/${lead.id}/propiedad">
        <label>Dirección de la propiedad en arriendo<input name="propiedad" required maxlength="300" value="${esc(falta ? '' : lead.propiedad || '')}" placeholder="Ej: Rosario Sur 91, depto 504, Las Condes"></label>
        ${conVisita ? `<p class="nota">Se actualiza el evento de la visita en el calendario del equipo (título y ubicación).</p>
        <label class="check"><input type="checkbox" name="avisar" value="1"> Enviar también al interesado su evento con la dirección correcta</label>` : ''}
        <button class="boton primario">Guardar dirección</button>
      </form>
    </details>`;
}

function formRecordarAgenda(lead) {
  if (lead.estado !== 'aprobado' || !lead.email) return '';
  return `<form method="post" action="/admin/lead/${lead.id}/recordar-agenda" class="form-recordar">
      <button class="boton">📨 Recordarle que agende</button>
      <span class="nota">${lead.aviso_agenda_at ? `Recordado ${lead.avisos_agenda} vez(ces) · último ${esc(fechaHora(lead.aviso_agenda_at))}` : 'Le llega un correo con el link para elegir horario.'}</span>
    </form>`;
}

// Página del link del correo post-visita: el equipo registra el resultado sin iniciar sesión
function resultadoVisita({ lead, visita, elegido, firma, error, config }) {
  const opcion = (valor) =>
    `<label class="opcion-resultado"><input type="radio" name="resultado" value="${valor}" ${elegido === valor ? 'checked' : ''} required><span>${RESULTADO_VISITA[valor]}</span></label>`;
  return layout(
    'Resultado de la visita',
    `<section class="tarjeta angosta">
      <h1>📝 ¿Cómo fue la visita?</h1>
      <p><strong>${esc(lead.nombre || '')}</strong> · ${esc(describirBloque(visita.fecha, visita.hora))}${lead.propiedad ? `<br>🏠 ${esc(lead.propiedad)}` : ''}</p>
      ${error ? `<div class="alerta error">${esc(error)}</div>` : ''}
      ${visita.estado !== 'confirmada' ? '<div class="alerta error">Esta visita fue cancelada o reagendada.</div>' : ''}
      ${visita.resultado ? `<div class="alerta ok">Ya registrado: ${RESULTADO_VISITA[visita.resultado]}. Puedes cambiarlo.</div>` : ''}
      <form method="post" class="form-visita">
        <input type="hidden" name="firma" value="${esc(firma)}">
        <div class="opciones-resultado">${opcion('realizada')}${opcion('no_asistio')}${opcion('no_continua')}</div>
        <label for="notas-visita">Notas (opcional)</label>
        <textarea id="notas-visita" name="notas" rows="3" placeholder="Ej: le gustó, pide ver contrato; o: busca algo más grande.">${esc(visita.notas || '')}</textarea>
        <label class="check"><input type="checkbox" name="avisar" value="1" ${visita.resultado ? '' : 'checked'}> Enviar mensaje al interesado según el resultado</label>
        <button class="boton primario grande">Guardar resultado</button>
      </form>
      <p class="nota"><a href="/admin/lead/${lead.id}#visita">Ver ficha completa</a></p>
    </section>`,
    { empresa: config.empresa.nombre }
  );
}

function seccionVisita(lead, visita, disponibles) {
  const puedeAgendarEquipo = ['aprobado', 'agendado', 'no_asistio'].includes(lead.estado);
  if (!visita) {
    return `<section class="tarjeta" id="visita"><h1>Visita</h1>
      <p class="nota">${
        ['aprobado'].includes(lead.estado)
          ? 'Aprobado: esperando que el interesado elija un horario en el calendario. También puedes agendarla tú si la coordinaron por teléfono.'
          : 'Aún no tiene visita agendada. El calendario se envía al aprobar sus documentos.'
      }</p>${formRecordarAgenda(lead)}${puedeAgendarEquipo ? formAgendar(lead, disponibles, false) : ''}</section>`;
  }
  const cuando = describirBloque(visita.fecha, visita.hora);
  if (visita.estado === 'cancelada') {
    return `<section class="tarjeta" id="visita"><h1>Visita</h1>
      <p>La visita del <strong>${esc(cuando)}</strong> fue <strong>cancelada${visita.cancelada_por === 'interesado' ? ' por el interesado' : ''}</strong>.${lead.estado === 'aprobado' ? ' El interesado puede elegir otro horario con su link.' : ''}</p>
      ${visita.motivo_cancelacion ? `<p class="nota">Motivo: “${esc(visita.motivo_cancelacion)}”</p>` : ''}
      ${formRecordarAgenda(lead)}${puedeAgendarEquipo ? formAgendar(lead, disponibles, false) : ''}</section>`;
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
      ${visita.resultado ? '' : `<label class="check"><input type="checkbox" name="avisar" value="1" checked> Enviar mensaje al interesado según el resultado <small class="nota">(continúa: próximos pasos · no asistió: link para reagendar · no continúa: agradecimiento)</small></label>`}
      <div class="acciones-ficha"><button class="boton primario">Guardar resultado</button></div>
    </form>
    ${
      visita.resultado && visita.resultado !== 'no_asistio'
        ? ''
        : `<div class="cambiar-visita">
      ${formAgendar(lead, disponibles, true)}
      <form method="post" action="/admin/lead/${lead.id}/visita/cancelar" class="form-cancelar">
        <label class="check"><input type="checkbox" name="avisar" value="1" checked> Avisar al interesado para que él elija otro horario</label>
        <button class="boton">Cancelar esta visita</button>
      </form>
    </div>`
    }
    ${visita.resultado === 'realizada' ? '<div class="alerta ok">✅ Continúa: siguiente paso, la reserva y el contrato (Bárbara).</div>' : ''}
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

function nuevaVisita({ valores: v, errores, conflicto, cruces = [], existente, origenes, horas, hoy, config }) {
  const val = (c) => esc(v[c] ?? '');
  const reintento = conflicto || existente;
  return layout(
    'Ingresar visita',
    `<section class="tarjeta angosta">
      <a class="volver" href="/admin/calendario">← Calendario de visitas</a>
      <h1>📝 Ingresar visita manual</h1>
      <p class="nota">Para visitas coordinadas por teléfono, WhatsApp u otro medio. Queda en el calendario, se avisa al equipo del día y llega el evento a su calendario, igual que las demás.</p>
      ${errores.length ? `<div class="alerta error"><strong>Revisa lo siguiente:</strong><ul>${errores.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
      ${
        existente
          ? `<div class="alerta aviso">👤 <strong>${esc(existente.lead.nombre || 'Este interesado')}</strong> (mismo teléfono) ya tiene una visita el <strong>${esc(describirBloque(existente.visita.fecha, existente.visita.hora))}</strong>. Si continúas, se <strong>reagenda</strong> a la nueva hora y se quita la anterior. <a href="/admin/lead/${existente.lead.id}">Ver ficha</a></div>`
          : ''
      }
      ${
        conflicto === 'ocupado'
          ? `<div class="alerta error">⛔ El ${esc(describirBloque(v.fecha, Number(v.hora)))} se cruza con ${cruces
              .map((c) => `la visita de <a href="/admin/lead/${c.lead_id}"><strong>${esc(c.nombre || 'otro interesado')}</strong></a> a las ${horaTexto(c.hora)}`)
              .join(', ') || '<strong>otra visita</strong>'}. Elige otra hora.</div>`
          : conflicto === 'bloqueado'
            ? `<div class="alerta aviso">⚠️ El ${esc(describirBloque(v.fecha, Number(v.hora)))} está <strong>bloqueado</strong> por el equipo. Elige otra hora o confirma abajo que quieres agendarla igual.</div>`
            : ''
      }
      <form method="post" action="/admin/visita/nueva" class="form-manual">
        <fieldset>
          <legend>Fecha y hora</legend>
          <div class="grilla">
            <label>Fecha<input type="date" name="fecha" required min="${sumarDias(hoy, -60)}" value="${val('fecha')}"></label>
            <label>Hora
              <select name="hora" required>
                <option value="">Elige…</option>
                ${horas.map((h) => `<option value="${h}" ${String(v.hora) === String(h) ? 'selected' : ''}>${horaTexto(h)}${config.agenda.horas.includes(h) ? '' : ' (fuera de horario)'}</option>`).join('')}
              </select>
            </label>
          </div>
          <p class="nota">No se puede cruzar con otra visita ya agendada. Una fecha pasada queda solo como registro (no se envían avisos).</p>
        </fieldset>
        <fieldset>
          <legend>Interesado</legend>
          <div class="grilla">
            <label>Nombre<input name="nombre" required value="${val('nombre')}"></label>
            <label>Teléfono / WhatsApp<input type="tel" name="telefono" required placeholder="+56 9 1234 5678" value="${val('telefono')}"></label>
            <label>Correo <small class="nota">(opcional)</small><input type="email" name="email" value="${val('email')}"></label>
            <label>¿Cómo se agendó?
              <select name="origen">${origenes.map((o) => `<option ${v.origen === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
            </label>
          </div>
          <label>Dirección de la propiedad<input name="propiedad" placeholder="Ej: Rosario Sur 91, depto 504, Las Condes" value="${val('propiedad')}"></label>
          <label>Notas para el equipo <small class="nota">(opcional)</small><textarea name="notas" rows="2" placeholder="Ej: viene con su pareja, pidió estacionamiento">${val('notas')}</textarea></label>
          <label class="check"><input type="checkbox" name="avisar" value="1" ${v.avisar ? 'checked' : ''}> Enviar confirmación al interesado (si tiene correo)</label>
        </fieldset>
        ${existente ? '<input type="hidden" name="confirmo_existente" value="1">' : ''}
        ${conflicto === 'bloqueado' ? '<label class="check fuerte"><input type="checkbox" name="forzar" value="1" required> Sí, agendar igual en ese horario</label>' : ''}
        <button class="boton primario grande">${reintento ? 'Confirmar y agendar' : 'Agendar visita'}</button>
      </form>
    </section>`,
    opcPanel(config, 'calendario')
  );
}

function calendarioPanel({ lunes, hoy, desplazamiento, visitas, bloqueos = [], proximas, nueva = null, config }) {
  const cols = columnasSemana(config.agenda);
  const dias = cols.map((d) => sumarDias(lunes, d - 1));
  // Horas del horario normal + las de visitas ingresadas a mano fuera de horario
  const horas = [...new Set([...dias.flatMap((f) => horasDe(config.agenda, f)), ...visitas.map((v) => v.hora)])].sort((x, y) => x - y);
  const enBloque = (f, h) => visitas.filter((v) => v.fecha === f && v.hora === h);
  const bloqueoDe = (f, h) => bloqueos.find((b) => b.fecha === f && (b.hora === null || b.hora === h));
  const diaBloqueado = (f) => bloqueos.find((b) => b.fecha === f && b.hora === null);
  const titulo = `${fechaLarga(dias[0]).replace(/^\S+ /, '')} – ${fechaLarga(dias[dias.length - 1]).replace(/^\S+ /, '')}`;
  const total = visitas.length;
  const campoSemana = `<input type="hidden" name="semana" value="${desplazamiento}">`;
  const botonBloquear = (f, h, texto) =>
    `<form method="post" action="/admin/bloqueos" class="form-bloqueo">${campoSemana}<input type="hidden" name="fecha" value="${f}"><input type="hidden" name="hora" value="${h ?? ''}"><button class="boton-bloquear" title="Bloquear: el equipo no puede a esta hora">${texto}</button></form>`;
  const botonDesbloquear = (b) =>
    `<form method="post" action="/admin/bloqueos/${b.id}/eliminar" class="form-bloqueo">${campoSemana}<button class="boton-bloquear" title="Volver a dejar disponible">Desbloquear</button></form>`;
  const botonAgregar = (f, h) => `<a class="boton-agregar" href="/admin/visita/nueva?fecha=${f}&amp;hora=${h}" title="Ingresar una visita a esta hora">＋<span class="txt"> Agendar</span></a>`;
  const estadoVisita = (v) => (v.resultado ? 'realizada' : v.confirmada_at ? 'confirmada' : 'pendiente');
  const tarjetaVisita = (v) => `<a class="visita ${estadoVisita(v)}" href="/admin/lead/${v.lead_id}">
      <strong>${esc(v.nombre || 'Interesado')}</strong>
      ${v.propiedad ? `<span class="prop ${faltaDireccion(v.propiedad) ? 'falta' : ''}">🏠 ${esc(v.propiedad)}</span>` : '<span class="prop falta">🏠 Dirección por confirmar</span>'}
      <span class="tel">📞 +${esc(v.telefono || '')}</span>
      ${v.email ? `<span class="correo">✉️ ${esc(v.email)}</span>` : ''}
      ${v.resultado ? `<span class="res">${RESULTADO_VISITA[v.resultado]}</span>` : v.confirmada_at ? '<span class="res">✅ Confirmó asistencia</span>' : ''}
      ${v.origen === 'equipo' ? `<span class="tag-manual" title="Ingresada a mano por el equipo">✍️ ${esc(v.portal || 'Manual')}</span>` : ''}
    </a>`;
  const cuantas = (f) => visitas.filter((v) => v.fecha === f).length;

  // Celda (escritorio) o fila (celular) de un horario
  const contenidoBloque = (f, h) => {
    const vs = enBloque(f, h);
    const bl = bloqueoDe(f, h);
    const enHorario = horasDe(config.agenda, f).includes(h);
    const futuro = f >= hoy && !config.agenda.feriados.includes(f);
    const acciones = !vs.length && futuro && !bl && enHorario ? `<div class="acciones-bloque">${botonAgregar(f, h)}${botonBloquear(f, h, '🔒')}</div>` : '';
    return {
      vs,
      bl,
      enHorario,
      html: `${vs.map(tarjetaVisita).join('')}${
        bl ? `<div class="bloqueo">🔒 ${esc(bl.motivo || 'Bloqueado')}${bl.hora !== null && futuro ? botonDesbloquear(bl) : ''}</div>` : acciones
      }`,
    };
  };

  const encabezadoDia = (f) => {
    const [nombre, ...resto] = fechaLarga(f).split(' ');
    return { nombre, fecha: resto.join(' ').replace(' de ', ' '), feriado: config.agenda.feriados.includes(f), bloqueo: diaBloqueado(f) };
  };

  const tabla = `<div class="tabla-scroll vista-semana">
      <table class="cal-panel" style="--ndias:${dias.length}">
        <thead><tr><th></th>${dias
          .map((f) => {
            const d = encabezadoDia(f);
            const n = cuantas(f);
            return `<th class="${f === hoy ? 'hoy' : ''} ${f < hoy ? 'pasado' : ''} ${d.bloqueo ? 'bloqueado' : ''}"><span>${esc(d.nombre)}</span><small>${esc(d.fecha)}${d.feriado ? ' · feriado' : ''}</small>
              <small class="responsable">${n ? `${n} visita${n > 1 ? 's' : ''}` : 'Sin visitas'}</small>
              ${f >= hoy && !d.feriado ? (d.bloqueo ? botonDesbloquear(d.bloqueo) : botonBloquear(f, null, '🔒 Día')) : ''}</th>`;
          })
          .join('')}</tr></thead>
        <tbody>${horas
          .map(
            (h) => `<tr><th class="hora">${horaTexto(h)}</th>${dias
              .map((f) => {
                const c = contenidoBloque(f, h);
                if (!c.enHorario && !c.vs.length) return '<td class="na"></td>';
                return `<td class="${f === hoy ? 'hoy' : ''} ${f < hoy ? 'pasado' : ''} ${c.bl ? 'bloqueado' : ''}">${c.html}</td>`;
              })
              .join('')}</tr>`
          )
          .join('')}</tbody>
      </table>
      </div>`;

  // En el celular: un día debajo del otro, con todos sus horarios
  const lista = `<div class="vista-dias">${dias
    .map((f) => {
      const d = encabezadoDia(f);
      const filas = horas
        .map((h) => ({ h, c: contenidoBloque(f, h) }))
        // Días pasados: solo las horas con visitas
        .filter(({ c }) => (f < hoy ? c.vs.length : c.enHorario || c.vs.length))
        .map(
          ({ h, c }) =>
            `<li class="${c.bl ? 'bloqueado' : ''} ${c.vs.length ? 'con-visita' : ''}"><span class="hora">${horaTexto(h)}</span><div>${c.html || (f < hoy ? '' : '<span class="libre">Libre</span>')}</div></li>`
        )
        .join('');
      return `<section class="dia-lista ${f === hoy ? 'hoy' : ''} ${f < hoy ? 'pasado' : ''}" ${f === hoy ? 'id="hoy"' : ''}>
        <header><div><strong>${esc(d.nombre)}</strong> ${esc(d.fecha)}${d.feriado ? ' · feriado' : ''}<small>${cuantas(f) ? `${cuantas(f)} visita${cuantas(f) > 1 ? 's' : ''}` : 'Sin visitas'}</small></div>
          ${f >= hoy && !d.feriado ? (d.bloqueo ? botonDesbloquear(d.bloqueo) : botonBloquear(f, null, '🔒 Día')) : ''}</header>
        ${d.bloqueo ? `<p class="bloqueo">🔒 Día bloqueado${d.bloqueo.motivo ? `: ${esc(d.bloqueo.motivo)}` : ''}</p>` : ''}
        ${filas ? `<ul>${filas}</ul>` : '<p class="sin-visitas">Sin visitas</p>'}
      </section>`;
    })
    .join('')}</div>`;

  return layout(
    'Calendario de visitas',
    `${nueva ? `<div class="alerta ok">✅ Visita de <strong>${esc(nueva.nombre || '')}</strong> ingresada. Se avisó al equipo y se agregó a su calendario. <a href="/admin/lead/${nueva.id}">Ver ficha</a></div>` : ''}
    <section class="tarjeta">
      <div class="titulo-seccion">
        <div><h1>Calendario de visitas</h1><span class="nota">${total ? `${total} visita(s) esta semana` : 'Sin visitas esta semana'}</span></div>
        <a class="boton primario" href="/admin/visita/nueva">＋ Ingresar visita</a>
      </div>
      <div class="nav-semanas compacto">
        <a class="boton" href="/admin/calendario?semana=${desplazamiento - 1}" aria-label="Semana anterior">‹</a>
        <span class="titulo-semana">${esc(titulo)}</span>
        <a class="boton" href="/admin/calendario?semana=${desplazamiento + 1}" aria-label="Semana siguiente">›</a>
        ${desplazamiento ? '<a class="boton chico" href="/admin/calendario">Hoy</a>' : ''}
      </div>
      <p class="leyenda"><span class="ley pendiente">Por confirmar</span><span class="ley confirmada">Confirmó asistencia</span><span class="ley realizada">Con resultado</span><span>✍️ Ingresada a mano</span></p>
      <p class="nota">Toca <strong>＋</strong> en un horario libre para ingresar una visita agendada por otro medio, o <strong>🔒</strong> (o <strong>🔒 Día</strong>) cuando el equipo no pueda atender: deja de aparecer para los interesados.</p>
      ${tabla}
      ${lista}
    </section>
    <section class="tarjeta">
      <h1>Próximas visitas</h1>
      ${
        proximas.length
          ? `<ul class="agenda-lista">${proximas
              .map(
                (v) => `<li><span class="cuando">${esc(describirBloque(v.fecha, v.hora))}</span>
                <a href="/admin/lead/${v.lead_id}">${esc(v.nombre)}</a> · ${linkWhatsapp(v.telefono)}${v.propiedad ? ` · ${esc(v.propiedad)}` : ''}${v.origen === 'equipo' ? ' <span class="tag-manual">✍️ Manual</span>' : ''}</li>`
              )
              .join('')}</ul>`
          : '<p class="nota">No hay visitas agendadas.</p>'
      }
    </section>`,
    opcPanel(config, 'calendario')
  );
}

module.exports = { ETIQUETAS_ESTADO, RESULTADO_VISITA, layout, mensaje, formularioPostulacion, calendario, revision, fichaLead, panel, fichaAdmin, calendarioPanel, nuevaVisita, resultadoVisita, confirmarEliminar, ingresar };
