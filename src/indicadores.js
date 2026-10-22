// Indicadores comerciales (KPI): embudo de las postulaciones de un período, actividad de visitas y pendientes.
// Se muestran en el panel y se entregan en JSON para el panel de Cristian (Breal), que cruza por RUT o teléfono.

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
    esperandoAgenda: leads.filter((l) => l.estado === 'aprobado').length,
    sinResultado: pasadas.filter((v) => !v.resultado).length,
    sinRegistrarEnBreal: visitas.filter((v) => v.estado === 'confirmada' && !v.breal_at && v.fecha >= desde).length,
  };

  return {
    periodo: { desde, hasta },
    embudo: etapas,
    porPortal: [...porPortal.values()].sort((a, b) => b.postularon - a.postularon),
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

module.exports = { calcularIndicadores, detalleInteresados };
