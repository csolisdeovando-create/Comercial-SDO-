// Indicadores comerciales (KPI): embudo de las postulaciones de un período, actividad de visitas y pendientes.
// Se muestran en el panel y se entregan en JSON para el panel de Cristian (Breal), que cruza por RUT o teléfono.

const crypto = require('node:crypto');
const { limpiarRut } = require('./utils');

const dia = (iso) => (iso ? String(iso).slice(0, 10) : null);
const enPeriodo = (iso, desde, hasta) => {
  const d = dia(iso);
  return Boolean(d) && d >= desde && d <= hasta;
};
const ms = (iso) => Date.parse(String(iso).includes('T') ? iso : `${String(iso).replace(' ', 'T')}Z`);
const mediana = (xs) => {
  if (!xs.length) return null;
  const o = [...xs].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const redondear = (x, d = 1) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

function calcularIndicadores({ leads, visitas, desde, hasta, hoy }) {
  const visitasDe = new Map();
  for (const v of visitas) {
    if (v.estado === 'reagendada') continue; // la reemplazó otra visita del mismo interesado
    if (!visitasDe.has(v.lead_id)) visitasDe.set(v.lead_id, []);
    visitasDe.get(v.lead_id).push(v);
  }
  const de = (l) => visitasDe.get(l.id) || [];
  const agendo = (l) => de(l).length > 0;
  const visito = (l) => de(l).some((v) => v.resultado === 'realizada' || v.resultado === 'no_continua');
  const continua = (l) => de(l).some((v) => v.resultado === 'realizada');

  // Embudo de las postulaciones del período (cada interesado avanza hasta donde llegó)
  const cohorte = leads.filter((l) => enPeriodo(l.documentos_at, desde, hasta));
  const etapas = [
    { etapa: 'Postularon', cantidad: cohorte.length },
    { etapa: 'Aprobados', cantidad: cohorte.filter((l) => l.aprobado_at).length },
    { etapa: 'Agendaron visita', cantidad: cohorte.filter(agendo).length },
    { etapa: 'Visitaron', cantidad: cohorte.filter(visito).length },
    { etapa: 'Continúan', cantidad: cohorte.filter(continua).length },
  ];
  etapas.forEach((e, i) => {
    e.desdeAnterior = i ? pct(e.cantidad, etapas[i - 1].cantidad) : null;
    e.desdeInicio = pct(e.cantidad, etapas[0].cantidad);
  });

  // Por campaña (links con ?origen=canal-campaña o anuncios de Instagram/Facebook)
  const porCampana = new Map();
  for (const l of cohorte.filter((x) => x.campana)) {
    const k = `${l.portal || 'Sin origen'} · ${l.campana}`;
    if (!porCampana.has(k)) porCampana.set(k, { campana: k, postularon: 0, aprobados: 0, visitaron: 0, continuan: 0 });
    const f = porCampana.get(k);
    f.postularon++;
    if (l.aprobado_at) f.aprobados++;
    if (visito(l)) f.visitaron++;
    if (continua(l)) f.continuan++;
  }

  const porPortal = new Map();
  for (const l of cohorte) {
    const p = l.portal || 'Sin origen';
    if (!porPortal.has(p)) porPortal.set(p, { portal: p, postularon: 0, aprobados: 0, visitaron: 0, continuan: 0 });
    const f = porPortal.get(p);
    f.postularon++;
    if (l.aprobado_at) f.aprobados++;
    if (visito(l)) f.visitaron++;
    if (continua(l)) f.continuan++;
  }

  // Actividad del período (visitas con fecha dentro del período)
  const delPeriodo = visitas.filter((v) => v.estado !== 'reagendada' && v.fecha >= desde && v.fecha <= hasta);
  const contar = (f) => delPeriodo.filter(f).length;
  const noContinua = new Map();
  for (const v of delPeriodo.filter((x) => x.resultado === 'no_continua')) {
    const m = v.motivo_resultado || 'Sin motivo';
    noContinua.set(m, (noContinua.get(m) || 0) + 1);
  }
  const activas = delPeriodo.filter((v) => v.estado === 'confirmada');
  const actividad = {
    postulaciones: cohorte.length,
    aprobados: leads.filter((l) => enPeriodo(l.aprobado_at, desde, hasta)).length,
    rechazados: leads.filter((l) => enPeriodo(l.rechazado_at, desde, hasta)).length,
    visitasAgendadas: activas.length,
    visitasManuales: activas.filter((v) => v.origen === 'equipo').length,
    canceladasPorInteresado: contar((v) => v.estado === 'cancelada' && v.cancelada_por === 'interesado'),
    canceladasPorEquipo: contar((v) => v.estado === 'cancelada' && v.cancelada_por !== 'interesado'),
    confirmaronAsistencia: activas.filter((v) => v.confirmada_at).length,
    realizadasContinua: activas.filter((v) => v.resultado === 'realizada').length,
    noAsistio: activas.filter((v) => v.resultado === 'no_asistio').length,
    noContinua: activas.filter((v) => v.resultado === 'no_continua').length,
    registradasEnBreal: activas.filter((v) => v.breal_at).length,
  };
  // Las visitas del período incluyen a quienes no están en el embudo: visitas ingresadas a mano a personas que no
  // postularon por el formulario, o que postularon antes del período. Se separan para que cuadre con el embudo.
  const enEmbudo = new Set(cohorte.map((l) => l.id));
  actividad.visitasFueraDelEmbudo = activas.filter((v) => !enEmbudo.has(v.lead_id)).length;
  actividad.realizadasContinuaDelEmbudo = activas.filter((v) => v.resultado === 'realizada' && enEmbudo.has(v.lead_id)).length;
  actividad.realizadasContinuaFueraDelEmbudo = actividad.realizadasContinua - actividad.realizadasContinuaDelEmbudo;
  actividad.asistencia = pct(actividad.realizadasContinua + actividad.noContinua, actividad.realizadasContinua + actividad.noContinua + actividad.noAsistio);

  // Tiempos (medianas) de las postulaciones del período
  const horasAprobacion = cohorte.filter((l) => l.aprobado_at).map((l) => (ms(l.aprobado_at) - ms(l.documentos_at)) / 36e5).filter((h) => h >= 0);
  const diasAVisita = cohorte
    .filter((l) => l.aprobado_at && agendo(l))
    .map((l) => (Date.parse(`${de(l).map((v) => v.fecha).sort().at(0)}T12:00:00Z`) - ms(l.aprobado_at)) / 864e5)
    .filter((d) => d >= -1);
  const tiempos = { horasHastaAprobacion: redondear(mediana(horasAprobacion)), diasDeAprobacionAVisita: redondear(mediana(diasAVisita)) };

  // Pendientes hoy
  const pasadas = visitas.filter((v) => v.estado === 'confirmada' && v.fecha < hoy);
  const pendientes = {
    porRevisar: leads.filter((l) => l.estado === 'documentos_recibidos').length,
    esperandoAgenda: leads.filter((l) => l.estado === 'aprobado' && !l.papelera_at).length,
    sinResultado: pasadas.filter((v) => !v.resultado).length,
    sinRegistrarEnBreal: visitas.filter((v) => v.estado === 'confirmada' && !v.breal_at && v.fecha >= desde).length,
  };

  return {
    periodo: { desde, hasta },
    embudo: etapas,
    porPortal: [...porPortal.values()].sort((a, b) => b.postularon - a.postularon),
    porCampana: [...porCampana.values()].sort((a, b) => b.postularon - a.postularon),
    actividad,
    motivosNoContinua: [...noContinua.entries()].map(([motivo, cantidad]) => ({ motivo, cantidad })).sort((a, b) => b.cantidad - a.cantidad),
    tiempos,
    pendientes,
  };
}

// Una fila por interesado con la fecha de cada paso (para cruzar con Breal por RUT, teléfono o correo)
function detalleInteresados({ leads, visitas, desde, hasta }) {
  const ultima = new Map();
  for (const v of visitas) if (v.estado !== 'reagendada') ultima.set(v.lead_id, v);
  return leads
    .filter((l) => enPeriodo(l.documentos_at || l.created_at, desde, hasta))
    .map((l) => {
      const v = ultima.get(l.id);
      return {
        id: l.id,
        nombre: l.nombre,
        rut: l.rut,
        telefono: l.telefono ? `+${l.telefono}` : null,
        email: l.email,
        portal: l.portal,
        propiedad: l.propiedad,
        urlPublicacion: l.url_publicacion,
        estado: l.estado,
        postulacion: l.documentos_at,
        aprobado: l.aprobado_at,
        rechazado: l.rechazado_at,
        visita: v ? { fecha: v.fecha, hora: v.hora, estado: v.estado, confirmada: Boolean(v.confirmada_at), resultado: v.resultado, motivo: v.motivo_resultado, registradaEnBreal: Boolean(v.breal_at) } : null,
      };
    });
}

// Clave para cruzar con BReal sin entregar el RUT: el panel de Cristian calcula la misma con el RUT del Contacto
const claveRut = (rut) => {
  const r = limpiarRut(rut);
  return r ? crypto.createHash('sha256').update(`sdo-rent:${r}`).digest('hex').slice(0, 32) : null;
};

// Una fila por interesado del período, sin nombre, RUT, teléfono ni correo: solo la clave, el portal y la fecha de cada paso
function seguimientoAnonimo({ leads, visitas, desde, hasta }) {
  const deLead = new Map();
  for (const v of visitas) {
    if (v.estado === 'reagendada') continue;
    if (!deLead.has(v.lead_id)) deLead.set(v.lead_id, []);
    deLead.get(v.lead_id).push(v);
  }
  return leads
    .filter((l) => enPeriodo(l.documentos_at, desde, hasta) && claveRut(l.rut))
    .map((l) => {
      const vs = (deLead.get(l.id) || []).sort((a, b) => `${a.fecha}${a.hora}`.localeCompare(`${b.fecha}${b.hora}`));
      const hecha = vs.find((v) => v.resultado === 'realizada' || v.resultado === 'no_continua');
      const ultima = vs.at(-1);
      return {
        clave: claveRut(l.rut),
        portal: l.portal || 'Sin origen',
        postulacion: dia(l.documentos_at),
        aprobado: dia(l.aprobado_at),
        rechazado: dia(l.rechazado_at),
        agendo: vs.length ? vs[0].fecha : null,
        visito: hecha ? hecha.fecha : null,
        resultado: ultima ? ultima.resultado || (ultima.estado === 'cancelada' ? 'cancelada' : null) : null,
        motivo: ultima ? ultima.motivo_resultado || null : null,
        registradaEnBreal: vs.some((v) => v.breal_at),
      };
    });
}

module.exports = { calcularIndicadores, detalleInteresados, seguimientoAnonimo, claveRut };

// ---------- SDO Capital · Ventas ----------
const ETAPAS_VENTA = ['oferta', 'reservado', 'promesa', 'escriturado'];

// Embudo, actividad y tiempos de las compras. Cada interesado cuenta en todas las etapas hasta la más avanzada que alcanzó.
function calcularIndicadoresVenta({ leads, visitas, propiedades = [], desde, hasta, hoy }) {
  const visitasDe = new Map();
  for (const v of visitas) {
    if (v.estado === 'reagendada') continue;
    if (!visitasDe.has(v.lead_id)) visitasDe.set(v.lead_id, []);
    visitasDe.get(v.lead_id).push(v);
  }
  const de = (l) => visitasDe.get(l.id) || [];
  const llego = (l, etapa) => ETAPAS_VENTA.indexOf(l.estado) >= ETAPAS_VENTA.indexOf(etapa);
  const pasos = [
    ['Postularon', () => true],
    ['Aprobados', (l) => l.aprobado_at],
    ['Agendaron visita', (l) => de(l).length],
    ['Visitaron', (l) => de(l).some((v) => v.resultado === 'realizada' || v.resultado === 'no_continua')],
    ['Ofertaron', (l) => l.oferta_fecha || llego(l, 'oferta')],
    ['Reservaron', (l) => l.reserva_fecha || llego(l, 'reservado')],
    ['Promesa', (l) => l.promesa_fecha || llego(l, 'promesa')],
    ['Escritura', (l) => l.escritura_fecha || l.estado === 'escriturado'],
  ];
  const nivel = (l) => pasos.reduce((n, [, f], i) => (f(l) ? i : n), 0);
  const cohorte = leads.filter((l) => enPeriodo(l.documentos_at, desde, hasta));
  const embudo = pasos.map(([etapa], i) => {
    const llegaron = cohorte.filter((l) => nivel(l) >= i);
    return { etapa, cantidad: llegaron.length, vivir: llegaron.filter((l) => l.para_que === 'vivir').length, invertir: llegaron.filter((l) => l.para_que === 'invertir').length };
  });
  embudo.forEach((e, i) => {
    e.desdeAnterior = i ? pct(e.cantidad, embudo[i - 1].cantidad) : null;
    e.desdeInicio = pct(e.cantidad, embudo[0].cantidad);
  });
  const agrupar = (clave) => {
    const m = new Map();
    for (const l of cohorte) {
      const k = clave(l) || 'Sin dato';
      if (!m.has(k)) m.set(k, { grupo: k, postularon: 0, aprobados: 0, visitaron: 0, reservaron: 0, escrituraron: 0 });
      const f = m.get(k);
      f.postularon++;
      if (nivel(l) >= 1) f.aprobados++;
      if (nivel(l) >= 3) f.visitaron++;
      if (nivel(l) >= 5) f.reservaron++;
      if (nivel(l) >= 7) f.escrituraron++;
    }
    return [...m.values()].sort((a, b) => b.postularon - a.postularon);
  };
  const propiedad = (l) => {
    const p = propiedades.find((x) => x.id === l.propiedad_venta_id);
    return p ? [p.direccion, p.comuna].filter(Boolean).join(', ') : l.propiedad;
  };

  // Lo que pasó en el período (por fecha de cada hecho)
  const delPeriodo = visitas.filter((v) => v.estado !== 'reagendada' && v.fecha >= desde && v.fecha <= hasta && leads.some((l) => l.id === v.lead_id));
  const activas = delPeriodo.filter((v) => v.estado === 'confirmada');
  const fechaEn = (campo) => leads.filter((l) => enPeriodo(l[campo], desde, hasta)).length;
  const actividad = {
    postulaciones: cohorte.length,
    visitasAgendadas: activas.length,
    confirmaronAsistencia: activas.filter((v) => v.confirmada_at).length,
    realizadas: activas.filter((v) => v.resultado === 'realizada').length,
    noAsistio: activas.filter((v) => v.resultado === 'no_asistio').length,
    noContinua: activas.filter((v) => v.resultado === 'no_continua').length,
    canceladas: delPeriodo.filter((v) => v.estado === 'cancelada').length,
    ofertas: fechaEn('oferta_fecha'),
    reservas: fechaEn('reserva_fecha'),
    promesas: fechaEn('promesa_fecha'),
    escrituras: fechaEn('escritura_fecha'),
    ufOfertadas: leads.filter((l) => enPeriodo(l.oferta_fecha, desde, hasta)).reduce((s, l) => s + (Number(l.oferta_uf) || 0), 0),
  };
  const noContinua = new Map();
  for (const v of activas.filter((x) => x.resultado === 'no_continua')) noContinua.set(v.motivo_resultado || 'Sin motivo', (noContinua.get(v.motivo_resultado || 'Sin motivo') || 0) + 1);

  // Tiempos (medianas, en días) de las postulaciones del período
  const dias = (a, b) => (ms(b) - ms(a)) / 864e5;
  const primeraVisita = (l) => de(l).map((v) => v.fecha).sort().at(0);
  const med = (xs) => redondear(mediana(xs.filter((x) => x >= 0)));
  const tiempos = {
    postulacionAAprobacion: med(cohorte.filter((l) => l.aprobado_at).map((l) => dias(l.documentos_at, l.aprobado_at))),
    aprobacionAVisita: med(cohorte.filter((l) => l.aprobado_at && primeraVisita(l)).map((l) => dias(l.aprobado_at, `${primeraVisita(l)}T12:00:00Z`))),
    visitaAReserva: med(cohorte.filter((l) => l.reserva_fecha && primeraVisita(l)).map((l) => dias(`${primeraVisita(l)}T12:00:00Z`, `${l.reserva_fecha}T12:00:00Z`))),
    reservaAEscritura: med(cohorte.filter((l) => l.reserva_fecha && l.escritura_fecha).map((l) => dias(`${l.reserva_fecha}T12:00:00Z`, `${l.escritura_fecha}T12:00:00Z`))),
  };

  return {
    periodo: { desde, hasta },
    embudo,
    porProposito: agrupar((l) => ({ vivir: 'Para vivir', invertir: 'Para invertir' })[l.para_que]),
    porFormaCompra: agrupar((l) => ({ credito: 'Crédito hipotecario', contado: 'Contado', subsidio: 'Subsidio', empresa: 'Empresa' })[l.tipo]),
    porPortal: agrupar((l) => l.portal),
    porCampana: cohorte.some((l) => l.campana) ? agrupar((l) => (l.campana ? `${l.portal || 'Sin origen'} · ${l.campana}` : null)).filter((f) => f.grupo !== 'Sin dato') : [],
    porPropiedad: agrupar(propiedad),
    actividad,
    motivosNoContinua: [...noContinua.entries()].map(([motivo, cantidad]) => ({ motivo, cantidad })).sort((a, b) => b.cantidad - a.cantidad),
    tiempos,
    pendientes: {
      porRevisar: leads.filter((l) => l.estado === 'documentos_recibidos' && !l.papelera_at).length,
      esperandoAgenda: leads.filter((l) => l.estado === 'aprobado' && !l.papelera_at).length,
      enNegociacion: leads.filter((l) => ['oferta', 'reservado', 'promesa'].includes(l.estado)).length,
      sinResultado: visitas.filter((v) => v.estado === 'confirmada' && v.fecha < hoy && !v.resultado && leads.some((l) => l.id === v.lead_id)).length,
    },
    propiedades: {
      disponibles: propiedades.filter((p) => p.estado === 'disponible').length,
      reservadas: propiedades.filter((p) => p.estado === 'reservada').length,
      vendidas: propiedades.filter((p) => p.estado === 'vendida').length,
    },
  };
}

module.exports.calcularIndicadoresVenta = calcularIndicadoresVenta;
