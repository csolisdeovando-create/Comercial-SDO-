// SDO Capital · Ventas: formulario de compra, panel de ventas, propiedades en venta y secciones de la ficha.
const { esc, formatearRut } = require('./utils');
const { REQUISITOS_VENTA, FORMAS_COMPRA, requisitosDe } = require('./requisitos');
const { formularioPersona } = require('./personas');
const { calificarCompra, pieMinimoDe } = require('./calificacion');
const { PARA_QUE, PLAZOS_COMPRA } = require('./notificaciones');
const vistas = require('./views');

const ICONO_FORMA = { credito: '🏦', contado: '💵', subsidio: '🏠', empresa: '🏢' };
const ESTADOS_PROPIEDAD = { disponible: 'Disponible', reservada: 'Reservada', vendida: 'Vendida', pausada: 'Pausada' };
const EN_NEGOCIACION = ['oferta', 'reservado', 'promesa'];
const ETAPAS = ['oferta', 'reservado', 'promesa', 'escriturado'];

const uf = (x) => (x === null || x === undefined || x === '' ? '—' : `${Number(x).toLocaleString('es-CL', { maximumFractionDigits: 1 })} UF`);
const pesos = (x) => (x === null || x === undefined || x === '' ? '—' : `$${Math.round(Number(x)).toLocaleString('es-CL')}`);
const opcCapital = (config, nav) => ({ ...vistas.opcPanel(config, nav), empresa: config.venta.empresa, marca: 'capital' });

// Calificación de un interesado con el precio de su propiedad (del listado) o null si no hay datos
function calificacionDe(lead, propiedad, config, valorUf) {
  if (!FORMAS_COMPRA.includes(lead.tipo)) return null;
  return calificarCompra({
    forma: lead.tipo,
    precioUf: propiedad?.precio_uf ?? null,
    pieUf: lead.pie_uf,
    preaprobadoUf: lead.monto_preaprobado_uf,
    rentaLiquida: lead.renta_liquida,
    cfg: config.venta,
    valorUf,
    pieMinimo: pieMinimoDe(propiedad, config.venta),
  });
}

const chipCalificacion = (c) =>
  !c
    ? ''
    : c.cumple === true
      ? '<span class="tag-renta ok" title="Pie, preaprobación y dividendo">✅ Califica</span>'
      : c.cumple === false
        ? `<span class="tag-renta mal" title="${esc(c.reglas.filter((r) => r.cumple === false).map((r) => r.nombre).join(' · '))}">❌ No califica</span>`
        : '<span class="tag-renta" title="Falta información">⏳ Por calificar</span>';

const chipParaQue = (l) => (l.para_que === 'invertir' ? '<span class="tag-proposito invertir">📈 Inversión</span>' : l.para_que === 'vivir' ? '<span class="tag-proposito vivir">🏡 Vivir</span>' : '');

// Recuadro con las 3 reglas (ficha)
function bloqueCalificacion(c) {
  if (!c) return '';
  const icono = (x) => (x === true ? '✅' : x === false ? '❌' : '⏳');
  const titulo = c.cumple === true ? '✅ Cumple las 3 condiciones' : c.cumple === false ? '❌ No cumple todas las condiciones' : '⏳ Falta información para calificar';
  return `<div class="calificacion ${c.cumple === true ? 'ok' : c.cumple === false ? 'mal' : ''}">
    <h3>Calificación: ${titulo}</h3>
    <ul>${c.reglas.map((r) => `<li>${icono(r.cumple)} <strong>${esc(r.nombre)}</strong><br><small>${esc(r.detalle)}</small></li>`).join('')}</ul>
    <p class="nota">Es una guía: el equipo decide si aprueba.</p>
  </div>`;
}

// ---------- Formulario de compra (público) ----------
function formularioCompra({ lead, valores = {}, errores = [], propiedades = [], config }) {
  const v = { ...lead, ...valores };
  if (!FORMAS_COMPRA.includes(v.tipo)) v.tipo = 'credito';
  const val = (k) => esc(v[k] ?? '');
  const seccionDocs = (tipo) => {
    const activo = v.tipo === tipo;
    return `
    <fieldset class="docs" data-tipo="${tipo}" data-grupo="titular" ${activo ? '' : 'hidden'}>
      <legend>${esc(`Documentos · ${REQUISITOS_VENTA[tipo].etiqueta}`)}</legend>
      ${REQUISITOS_VENTA[tipo].documentos
        .map((d, i) => {
          const input = (requerido) =>
            `<input type="file" name="${d.campo}" multiple accept="${vistas.ACEPTA}" ${requerido ? '' : 'data-opcional="1"'} ${activo && requerido ? 'required' : ''}>
          <span class="seleccion" aria-live="polite">Seleccionar archivo</span>`;
          if (!d.casillas) {
            return `<label class="archivo"><span class="num">${i + 1}</span>
          <span class="texto"><strong>${esc(d.nombre)}</strong><small>${esc(d.ayuda)}</small></span>${input(tipo !== 'subsidio' || d.campo !== 'preaprobacion')}</label>`;
          }
          return `<div class="archivo-grupo"><div class="archivo-cab"><span class="num">${i + 1}</span>
            <span class="texto"><strong>${esc(d.nombre)}</strong><small>${esc(d.ayuda)}</small></span></div>
          ${d.casillas
            .map((c, j) => `<label class="archivo sub"><span class="texto"><strong>${esc(c)}</strong>${j ? '<small>Opcional si ya subiste todas en la primera</small>' : ''}</span>${input(j === 0)}</label>`)
            .join('')}</div>`;
        })
        .join('')}
    </fieldset>`;
  };
  const disponibles = propiedades.filter((p) => p.estado === 'disponible');
  const radios = (nombre, opciones) =>
    Object.entries(opciones)
      .map(([k, t]) => `<label class="opcion"><input type="radio" name="${nombre}" value="${k}" required ${v[nombre] === k ? 'checked' : ''}><span>${esc(t)}</span></label>`)
      .join('');

  return vistas.layout(
    'Postulación de compra',
    `<section class="tarjeta">
      <h1>Postula para visitar el departamento</h1>
      <p class="lead">Completa tus datos y antecedentes de compra. Nuestro equipo los revisará y te enviaremos un calendario para que agendes tu visita.</p>
      <p class="nota obligatorio">Todos los datos son obligatorios (solo los comentarios son opcionales): los necesitamos para preparar tu oferta y promesa en caso de reservar.<br>🔒 Tus datos no se divulgan: los usamos solo para evaluar tu postulación.</p>
      ${errores.length ? `<div class="alerta error"><strong>Revisa lo siguiente:</strong><ul>${errores.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
      <form method="post" action="/comprar${lead?.token ? `/${esc(lead.token)}` : ''}" enctype="multipart/form-data" id="form-postulacion" novalidate>
        <fieldset>
          <legend>¿Cómo vas a comprar?</legend>
          <div class="opciones-tipo cuatro">
            ${FORMAS_COMPRA.map((k) => `<label class="opcion"><input type="radio" name="tipo" value="${k}" ${v.tipo === k ? 'checked' : ''}><span>${ICONO_FORMA[k]} ${esc(REQUISITOS_VENTA[k].etiqueta)}</span></label>`).join('')}
          </div>
        </fieldset>

        <fieldset>
          <legend>¿Para qué compras?</legend>
          <div class="opciones-tipo">${radios('para_que', { vivir: '🏡 Para vivir', invertir: '📈 Para invertir (arrendar)' })}</div>
        </fieldset>

        <fieldset>
          <legend>Tus datos</legend>
          ${formularioPersona(v, '')}
          <div class="grilla">
            <label>Razón social <small class="nota">(solo si compras a nombre de una empresa)</small><input name="razon_social" value="${val('razon_social')}"></label>
            <label>RUT empresa <small class="nota">(solo empresa)</small><input name="rut_empresa" placeholder="76.123.456-7" value="${esc(v.rut_empresa ? formatearRut(v.rut_empresa) : '')}" data-rut></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>El departamento que te interesa</legend>
          ${
            disponibles.length
              ? `<label for="propiedad_venta_id">Elige el departamento
            <select id="propiedad_venta_id" name="propiedad_venta_id">
              <option value="">— Otro / no está en la lista —</option>
              ${disponibles
                .map((p) => `<option value="${p.id}" ${String(v.propiedad_venta_id) === String(p.id) ? 'selected' : ''}>${esc(p.direccion)}${p.comuna ? `, ${esc(p.comuna)}` : ''}${p.precio_uf ? ` · ${uf(p.precio_uf)}` : ''}${p.dormitorios ? ` · ${p.dormitorios}D${p.banos ? `/${p.banos}B` : ''}` : ''}${p.precio_uf ? ` · pie desde ${Math.round(pieMinimoDe(p, config.venta) * 100)}%` : ''}</option>`)
                .join('')}
            </select></label>
          <p class="nota">Si no está en la lista, pega el link del aviso y escribe la dirección:</p>`
              : ''
          }
          <label for="url_publicacion">Link del aviso que viste
            <input id="url_publicacion" name="url_publicacion" type="text" inputmode="url" autocomplete="off" placeholder="Pega aquí el link del aviso (Mercado Libre, Yapo, Portal Inmobiliario…)" value="${val('url_publicacion')}" data-publicacion>
          </label>
          <div class="vista-publicacion" id="vista-publicacion" hidden aria-live="polite"></div>
          <label for="propiedad">Dirección del departamento
            <input id="propiedad" name="propiedad" placeholder="Ej: Rosario Sur 91, depto 504, Las Condes" value="${val('propiedad')}">
          </label>
        </fieldset>

        <fieldset>
          <legend>Tu financiamiento</legend>
          <div class="grilla">
            <label>¿Cuánto tienes para el pie? (UF)<input name="pie_uf" type="number" inputmode="decimal" min="0" step="any" required placeholder="Ej: 700" value="${val('pie_uf')}"></label>
            <label>Renta líquida mensual (pesos) <small class="nota">(tuya o del grupo que compra)</small><input name="renta_liquida" type="number" inputmode="numeric" min="0" step="1" placeholder="Ej: 2500000" value="${val('renta_liquida')}"></label>
            <label>Banco de la preaprobación <small class="nota">(si compras con crédito)</small><input name="banco_preaprobacion" placeholder="Ej: Banco de Chile" value="${val('banco_preaprobacion')}"></label>
            <label>Monto preaprobado (UF) <small class="nota">(si compras con crédito)</small><input name="monto_preaprobado_uf" type="number" inputmode="decimal" min="0" step="any" placeholder="Ej: 2800" value="${val('monto_preaprobado_uf')}"></label>
          </div>
          <div class="campo-plazo" role="radiogroup" aria-labelledby="plazo-compra">
            <span id="plazo-compra" class="etiqueta">¿Para cuándo quieres comprar?</span>
            <div class="opciones-plazo">${radios('plazo_compra', PLAZOS_COMPRA)}</div>
          </div>
        </fieldset>

        ${FORMAS_COMPRA.map(seccionDocs).join('')}

        <p class="nota">Formatos: PDF, JPG, PNG o HEIC · Máximo ${config.archivos.maxMB} MB por archivo.</p>
        <label>Comentarios (opcional)<textarea name="comentarios" rows="3" placeholder="Ej: horarios en que puedes visitar, si vendes otra propiedad, etc.">${val('comentarios')}</textarea></label>
        <label class="check"><input type="checkbox" name="consentimiento" value="1" required ${v.consentimiento ? 'checked' : ''}>
          Autorizo a ${esc(config.venta.empresa)} a tratar mis datos y documentos solo para evaluar mi postulación de compra.</label>
        <button type="submit" class="boton primario grande">Enviar postulación</button>
        <p class="nota centrado" id="estado-envio" hidden>Subiendo documentos… no cierres esta página.</p>
      </form>
    </section>`,
    { empresa: config.venta.empresa, scripts: ['/static/postular.js'], marca: 'capital' }
  );
}

// ---------- Panel de ventas ----------
function panelVentas({ leads, todos, papelera, propiedades, visitas, filtros = {}, desde, valorUf, recordados = null, config }) {
  const propDe = (l) => propiedades.find((p) => p.id === l.propiedad_venta_id) || null;
  const conteo = (f) => todos.filter(f).length;
  const resumen = [
    ['documentos_recibidos', 'Por revisar', conteo((l) => l.estado === 'documentos_recibidos')],
    ['aprobado', 'Esperando agenda', conteo((l) => l.estado === 'aprobado')],
    ['agendado', 'Con visita agendada', conteo((l) => l.estado === 'agendado')],
    ['negociacion', 'En negociación', conteo((l) => EN_NEGOCIACION.includes(l.estado))],
    ['escriturado', 'Vendidos', conteo((l) => l.estado === 'escriturado')],
    ['papelera', '🗑️ Papelera', papelera.length],
  ];
  // Embudo de las postulaciones de compra de los últimos 90 días (cada uno hasta donde llegó)
  const cohorte = [...todos, ...papelera].filter((l) => (l.documentos_at || '').slice(0, 10) >= desde);
  const visitasDe = (l) => visitas.filter((v) => v.lead_id === l.id);
  const llego = (l, etapa) => ETAPAS.indexOf(l.estado) >= ETAPAS.indexOf(etapa);
  // Cada interesado cuenta en todas las etapas hasta la más avanzada a la que llegó
  const pasos = [
    ['Postularon', () => true],
    ['Aprobados', (l) => l.aprobado_at],
    ['Agendaron visita', (l) => visitasDe(l).length],
    ['Visitaron', (l) => visitasDe(l).some((v) => v.resultado === 'realizada' || v.resultado === 'no_continua')],
    ['Ofertaron', (l) => l.oferta_fecha || llego(l, 'oferta')],
    ['Reservaron', (l) => l.reserva_fecha || llego(l, 'reservado')],
    ['Promesa', (l) => l.promesa_fecha || llego(l, 'promesa')],
    ['Escritura', (l) => l.escritura_fecha || l.estado === 'escriturado'],
  ];
  const nivel = (l) => pasos.reduce((n, [, f], i) => (f(l) ? i : n), 0);
  const etapas = pasos.map(([t], i) => {
    const llegaron = cohorte.filter((l) => nivel(l) >= i);
    return [t, llegaron.length, llegaron.filter((l) => l.para_que === 'vivir').length, llegaron.filter((l) => l.para_que === 'invertir').length];
  });
  const max = etapas[0][1] || 1;
  const filaLead = (l) => {
    const p = propDe(l);
    return `<tr>
      <td class="col-id">${l.id}</td>
      <td class="col-principal"><a href="/admin/lead/${l.id}"><strong>${esc(l.nombre || 'Sin nombre aún')}</strong></a> ${chipParaQue(l)}<br><small>${esc(l.email || '')}</small></td>
      <td>${vistas.linkWhatsapp(l.telefono)}</td>
      <td class="col-prop">${p ? `${esc(p.direccion)}<br><small>${uf(p.precio_uf)}</small>` : esc(l.propiedad || '—')}</td>
      <td>${esc(requisitosDe(l.tipo)?.etiqueta || '—')}<br>${chipCalificacion(calificacionDe(l, p, config, valorUf))}</td>
      <td>${l.papelera_at ? `<span class="estado papelera">🗑️ ${esc(l.papelera_motivo || 'Papelera')}</span>` : `<span class="estado ${esc(l.estado)}">${esc(vistas.ETIQUETAS_ESTADO[l.estado] || l.estado)}</span>`}${l.visita ? `<br><small>${esc(l.visita)}</small>` : ''}</td>
      <td class="acciones"><a class="boton chico" href="/admin/lead/${l.id}">Ver ficha</a></td>
    </tr>`;
  };
  const opciones = [
    ['', 'Todos'],
    ...resumen.map(([k, t]) => [k, t]),
  ];
  return vistas.layout(
    'SDO Capital · Ventas',
    `${recordados !== null ? `<div class="alerta ok">📨 ${recordados ? `Se envió el recordatorio para agendar a ${recordados} interesado(s).` : 'No había interesados por recordar.'}</div>` : ''}
    <section class="resumen-estados">
      ${resumen.map(([e, t, n]) => `<a class="cifra ${e} ${filtros.estado === e ? 'activa' : ''}" href="/admin/ventas?estado=${e}#interesados-venta"><strong>${n}</strong><span>${t}</span></a>`).join('')}
    </section>
    <section class="tarjeta">
      <div class="titulo-seccion"><div><h1>🏢 SDO Capital · Ventas</h1><span class="nota">Interesados en comprar. Las visitas usan el mismo calendario que arriendos.</span></div>
        <div class="acciones-ficha"><a class="boton chico" href="/admin/ventas/propiedades">🏢 Propiedades en venta (${propiedades.filter((p) => p.estado === 'disponible').length} disponibles)</a><a class="boton chico" href="/admin/calendario">📅 Calendario</a></div></div>
      <p class="nota">Link del formulario de compra para compartir: <a href="${esc(config.baseUrl)}/comprar" target="_blank">${esc(config.baseUrl)}/comprar</a></p>
    </section>
    <section class="tarjeta">
      <h2>Embudo de compra · últimos 90 días</h2>
      <p class="nota">Cada interesado que postuló, hasta dónde llegó. A la derecha: % del paso anterior y cuántos son 🏡 para vivir y 📈 para invertir.</p>
      <div class="embudo">${etapas
        .map(
          ([t, n, vivir, invertir], i) => `<div class="etapa"><span class="nombre">${esc(t)}</span>
          <div class="emb-barra"><div class="emb-relleno" style="width:${Math.max(2, Math.round((n / max) * 100))}%"></div></div>
          <strong>${n}</strong><span class="conv">${i && etapas[i - 1][1] ? `${Math.round((n / etapas[i - 1][1]) * 100)}% · ` : ''}🏡 ${vivir} · 📈 ${invertir}</span></div>`
        )
        .join('')}</div>
    </section>
    <section class="tarjeta" id="interesados-venta">
      <div class="titulo-seccion"><h1>Interesados en comprar</h1>
        <form method="post" action="/admin/recordar-agenda"><input type="hidden" name="negocio" value="venta"><button class="boton chico">📨 Recordar a los aprobados que agenden</button></form></div>
      <form class="filtros" method="get" action="/admin/ventas#interesados-venta" role="search">
        <input name="q" type="search" placeholder="Buscar por nombre, RUT, teléfono, correo o propiedad" value="${esc(filtros.q || '')}">
        <select name="estado">${opciones.map(([k, t]) => `<option value="${k}" ${filtros.estado === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <button class="boton">Buscar</button>
      </form>
      <div class="tabla-scroll"><table class="tabla tabla-movil"><thead><tr><th>#</th><th>Nombre</th><th>Teléfono</th><th>Propiedad</th><th>Compra</th><th>Estado</th><th></th></tr></thead><tbody>
      ${leads.length ? leads.map(filaLead).join('') : '<tr><td colspan="7" class="nota">Aún no hay interesados en comprar.</td></tr>'}
      </tbody></table></div>
    </section>`,
    opcCapital(config, 'ventas')
  );
}

// ---------- Propiedades en venta ----------
function propiedadesVenta({ propiedades, aviso, config }) {
  const campos = (p = {}) => `
      <label>Dirección<input name="direccion" required value="${esc(p.direccion || '')}" placeholder="Ej: Rosario Sur 91, depto 504"></label>
      <label>Comuna<input name="comuna" value="${esc(p.comuna || '')}"></label>
      <label>Precio (UF)<input name="precio_uf" type="number" step="any" min="0" value="${esc(p.precio_uf ?? '')}"></label>
      <label>Dormitorios<input name="dormitorios" type="number" min="0" value="${esc(p.dormitorios ?? '')}"></label>
      <label>Baños<input name="banos" type="number" min="0" value="${esc(p.banos ?? '')}"></label>
      <label>m²<input name="m2" type="number" step="any" min="0" value="${esc(p.m2 ?? '')}"></label>
      <label class="ancho">Link del aviso<input name="url_aviso" type="url" value="${esc(p.url_aviso || '')}" placeholder="https://…"></label>
      <label>Pie mínimo (%)<input name="pie_minimo" type="number" step="any" min="1" max="100" value="${p.pie_minimo ? esc(Math.round(p.pie_minimo * 1000) / 10) : ''}" placeholder="Vacío = ${Math.round(config.venta.pieMinimo * 100)}% o según el precio"></label>
      <label>Estado<select name="estado">${Object.entries(ESTADOS_PROPIEDAD).map(([k, t]) => `<option value="${k}" ${(p.estado || 'disponible') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="ancho">Notas<input name="notas" value="${esc(p.notas || '')}"></label>`;
  return vistas.layout(
    'Propiedades en venta',
    `<p class="migas"><a href="/admin/ventas">← SDO Capital · Ventas</a></p>
    ${aviso ? `<div class="alerta ok">${esc(aviso)}</div>` : ''}
    <section class="tarjeta">
      <div class="titulo-seccion"><div><h1>🏢 Propiedades en venta</h1><span class="nota">Las disponibles aparecen en el formulario de compra para que el interesado elija. El pie mínimo de cada una se usa para calificar (puede ser desde 10%).</span></div></div>
      <div class="tabla-scroll"><table class="tabla tabla-movil"><thead><tr><th>Dirección</th><th>Precio</th><th>Pie mínimo</th><th>D/B</th><th>Estado</th><th></th></tr></thead><tbody>
      ${
        propiedades.length
          ? propiedades
              .map(
                (p) => `<tr>
          <td class="col-principal"><strong>${esc(p.direccion)}</strong>${p.comuna ? `<br><small>${esc(p.comuna)}</small>` : ''}${p.url_aviso ? `<br><a href="${esc(p.url_aviso)}" target="_blank" rel="noopener">Ver aviso ↗</a>` : ''}</td>
          <td>${uf(p.precio_uf)}</td>
          <td>${Math.round(pieMinimoDe(p, config.venta) * 100)}%${p.pie_minimo ? '' : ' <small class="nota">(general)</small>'}${p.precio_uf ? `<br><small>${uf(p.precio_uf * pieMinimoDe(p, config.venta))}</small>` : ''}</td>
          <td>${p.dormitorios ?? '—'}D / ${p.banos ?? '—'}B${p.m2 ? ` · ${p.m2} m²` : ''}</td>
          <td><span class="estado prop-${esc(p.estado)}">${ESTADOS_PROPIEDAD[p.estado] || esc(p.estado)}</span></td>
          <td><details class="editar-propiedad-venta"><summary class="boton chico">Editar</summary>
            <form method="post" action="/admin/ventas/propiedades/${p.id}" class="grilla">${campos(p)}<button class="boton primario">Guardar</button></form>
            <form method="post" action="/admin/ventas/propiedades/${p.id}/eliminar"><button class="boton chico peligro">Eliminar</button></form>
          </details></td>
        </tr>`
              )
              .join('')
          : '<tr><td colspan="6" class="nota">Aún no hay propiedades cargadas.</td></tr>'
      }
      </tbody></table></div>
    </section>
    <section class="tarjeta">
      <h2>Agregar propiedad</h2>
      <form method="post" action="/admin/ventas/propiedades" class="grilla">${campos()}<button class="boton primario">Agregar</button></form>
    </section>`,
    opcCapital(config, 'ventas')
  );
}

// ---------- Ficha: compra, calificación y negociación ----------
function seccionesCompraFicha(lead, config) {
  const p = lead.propiedadVenta || null;
  const c = calificacionDe(lead, p, config, lead.valorUf || config.venta.valorUf);
  const fila = (k, v) => (v ? `<tr><th>${k}</th><td>${esc(v)}</td></tr>` : '');
  const etapa = (clave, titulo, hecho, resumen, campos) => `
    <details class="etapa-negociacion ${hecho ? 'hecha' : ''}" ${hecho ? '' : ''}>
      <summary>${hecho ? '✅' : '⬜'} <strong>${titulo}</strong>${hecho ? ` · ${resumen}` : ''}</summary>
      <form method="post" action="/admin/lead/${lead.id}/negociacion" class="grilla">
        <input type="hidden" name="etapa" value="${clave}">${campos}
        <label class="check"><input type="checkbox" name="avisar" value="1" checked> Avisar al equipo de ventas</label>
        <button class="boton primario">${hecho ? 'Actualizar' : 'Registrar'}</button>
      </form>
    </details>`;
  const v = (k) => esc(lead[k] ?? '');
  return `<h2 class="sep-comp">🏢 Compra · ${esc(config.venta.empresa)}</h2>
  <table class="ficha">
    ${fila('¿Para qué compra?', PARA_QUE[lead.para_que])}
    ${p ? `<tr><th>Departamento</th><td>${esc(p.direccion)}${p.comuna ? `, ${esc(p.comuna)}` : ''} · <strong>${uf(p.precio_uf)}</strong> · ${esc(ESTADOS_PROPIEDAD[p.estado] || p.estado)}</td></tr>` : ''}
    ${fila('Pie disponible', lead.pie_uf != null ? uf(lead.pie_uf) : null)}
    ${fila('Renta líquida', lead.renta_liquida != null ? pesos(lead.renta_liquida) : null)}
    ${fila('Banco preaprobación', lead.banco_preaprobacion)}
    ${fila('Monto preaprobado', lead.monto_preaprobado_uf != null ? uf(lead.monto_preaprobado_uf) : null)}
    ${fila('¿Cuándo quiere comprar?', PLAZOS_COMPRA[lead.plazo_compra])}
  </table>
  ${bloqueCalificacion(c)}
  <div class="negociacion" id="negociacion">
    <h3>Negociación</h3>
    ${etapa('oferta', '💬 Oferta', lead.oferta_fecha, `${esc(lead.oferta_fecha || '')} · ${uf(lead.oferta_uf)}`, `
        <label>Fecha<input type="date" name="oferta_fecha" value="${v('oferta_fecha')}" required></label>
        <label>Monto ofrecido (UF)<input type="number" step="any" min="0" name="oferta_uf" value="${v('oferta_uf')}" required></label>
        <label class="ancho">Condiciones<input name="oferta_condiciones" value="${v('oferta_condiciones')}" placeholder="Ej: sujeta a crédito, entrega en marzo"></label>`)}
    ${etapa('reserva', '📌 Reserva', lead.reserva_fecha, `${esc(lead.reserva_fecha || '')}${lead.reserva_monto ? ` · ${esc(lead.reserva_monto)}` : ''}`, `
        <label>Fecha<input type="date" name="reserva_fecha" value="${v('reserva_fecha')}" required></label>
        <label>Monto<input name="reserva_monto" value="${v('reserva_monto')}" placeholder="Ej: $1.000.000 o 25 UF" required></label>
        <label>Forma de pago<input name="reserva_forma" value="${v('reserva_forma')}" placeholder="Ej: transferencia"></label>`)}
    ${etapa('promesa', '✍️ Promesa', lead.promesa_fecha, `${esc(lead.promesa_fecha || '')}${lead.promesa_notaria ? ` · ${esc(lead.promesa_notaria)}` : ''}`, `
        <label>Fecha de firma<input type="date" name="promesa_fecha" value="${v('promesa_fecha')}" required></label>
        <label>Notaría<input name="promesa_notaria" value="${v('promesa_notaria')}"></label>
        <label>Escritura estimada<input type="date" name="escritura_estimada" value="${v('escritura_estimada')}"></label>`)}
    ${etapa('escritura', '🔑 Escritura', lead.escritura_fecha, esc(lead.escritura_fecha || ''), `
        <label>Fecha de firma<input type="date" name="escritura_fecha" value="${v('escritura_fecha')}" required></label>`)}
  </div>`;
}

module.exports = { formularioCompra, panelVentas, propiedadesVenta, seccionesCompraFicha, calificacionDe, ESTADOS_PROPIEDAD, EN_NEGOCIACION };
