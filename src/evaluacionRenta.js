// Requisito de renta: el líquido a recibir de cada una de las 3 últimas liquidaciones debe ser al menos
// 2,5 veces el valor del arriendo. Si alguien complementa renta, se suma su líquido del mismo mes.
const { limpiarRut } = require('./utils');

const FACTOR_RENTA = 2.5;

// Una entrada por mes (la de mayor monto si se repite), de la más reciente a la más antigua
function porMes(liquidaciones = []) {
  const mapa = new Map();
  for (const l of liquidaciones) {
    if (!/^\d{4}-\d{2}$/.test(l.periodo || '') || !Number.isInteger(l.liquido_a_pagar)) continue;
    const previa = mapa.get(l.periodo);
    if (!previa || l.liquido_a_pagar > previa.liquido_a_pagar) mapa.set(l.periodo, l);
  }
  return [...mapa.values()].sort((a, b) => b.periodo.localeCompare(a.periodo));
}

const mesesEntre = (a, b) => {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
};

/**
 * @param {object} p
 * @param {number|null} p.valorArriendo
 * @param {{liquidaciones: object[], rut: string}} p.titular
 * @param {{liquidaciones: object[], rut: string}|null} p.comp
 * @returns {{requerido, meses: {periodo, titular, comp, total, cumple, empleador}[], cumple: boolean|null, alertas: string[]}}
 */
function evaluarRenta({ valorArriendo, titular, comp = null, hoy = new Date() }) {
  const alertas = [];
  const requerido = valorArriendo ? Math.ceil(valorArriendo * FACTOR_RENTA) : null;
  const mesesTit = porMes(titular?.liquidaciones);
  const mesesComp = new Map(porMes(comp?.liquidaciones).map((l) => [l.periodo, l]));
  const ultimas = mesesTit.slice(0, 3);

  if (mesesTit.length < 3) alertas.push(`Se leyeron ${mesesTit.length} de 3 liquidaciones con mes y monto.`);
  const ilegibles = (titular?.liquidaciones || []).filter((l) => !l.legible).length;
  if (ilegibles) alertas.push(`${ilegibles} liquidación(es) no se pudieron leer bien: revísalas a mano.`);
  const rutDistinto = (lista, rut) => rut && lista.some((l) => l.rut_trabajador && limpiarRut(l.rut_trabajador) !== limpiarRut(rut));
  if (rutDistinto(ultimas, titular?.rut)) alertas.push('Una liquidación tiene un RUT distinto al del interesado.');
  if (comp && rutDistinto([...mesesComp.values()], comp.rut)) alertas.push('Una liquidación de quien complementa tiene un RUT distinto al declarado.');
  const mesActual = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
  if (ultimas[0] && mesesEntre(ultimas[0].periodo, mesActual) > 3) alertas.push(`La liquidación más reciente es de ${ultimas[0].periodo}: pide liquidaciones más nuevas.`);
  if (ultimas.length === 3 && mesesEntre(ultimas[2].periodo, ultimas[0].periodo) > 2) alertas.push('Las 3 liquidaciones no son de meses seguidos.');

  const meses = ultimas.map((l) => {
    const c = mesesComp.get(l.periodo);
    if (comp && !c) alertas.push(`Falta la liquidación de ${l.periodo} de quien complementa renta.`);
    const total = l.liquido_a_pagar + (c?.liquido_a_pagar || 0);
    return { periodo: l.periodo, empleador: l.empleador, titular: l.liquido_a_pagar, comp: c ? c.liquido_a_pagar : null, total, cumple: requerido ? total >= requerido : null };
  });

  let cumple = null;
  if (!requerido) alertas.unshift('Ingresa el valor del arriendo para calcular si cumple la renta.');
  else cumple = meses.length === 3 && meses.every((m) => m.cumple);
  return { requerido, meses, cumple, alertas };
}

// Revisión del certificado de AFP contra los datos del interesado
function alertasAfp(afp, rut, hoy = new Date()) {
  const alertas = [];
  if (!afp) return alertas;
  if (!afp.es_certificado_afp) alertas.push('El archivo no parece un certificado de cotizaciones de AFP.');
  if (rut && afp.rut_afiliado && limpiarRut(afp.rut_afiliado) !== limpiarRut(rut)) alertas.push('El RUT del certificado no coincide con el del interesado.');
  if (afp.fecha_emision) {
    const dias = Math.floor((hoy - new Date(`${afp.fecha_emision}T12:00:00`)) / 864e5);
    if (dias > 30) alertas.push(`El certificado se emitió hace ${dias} días: algunas AFP solo lo validan por 30 días.`);
  }
  return alertas;
}

module.exports = { evaluarRenta, alertasAfp, FACTOR_RENTA };
