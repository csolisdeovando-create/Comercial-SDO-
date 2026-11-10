// SDO Capital · Ventas: calificación del comprador con 3 reglas (pie, preaprobación y dividendo).
// Solo apoya la decisión: el equipo aprueba o rechaza igual que en arriendos.

// Dividendo mensual (en UF) de un crédito: cuota fija con tasa mensual simple anual/12
function dividendoUf(montoUf, tasaAnual, plazoAnios) {
  if (!(montoUf > 0)) return 0;
  const r = tasaAnual / 12;
  const n = plazoAnios * 12;
  return r ? (montoUf * r) / (1 - (1 + r) ** -n) : montoUf / n;
}

const uf = (x) => `${Number(x).toLocaleString('es-CL', { maximumFractionDigits: 0 })} UF`;
const pesos = (x) => `$${Math.round(x).toLocaleString('es-CL')}`;
const num = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

/**
 * @param {object} p
 * @param {'credito'|'contado'|'subsidio'|'empresa'} p.forma
 * @param {number|null} p.precioUf precio de la propiedad
 * @param {number|null} p.pieUf pie disponible
 * @param {number|null} p.preaprobadoUf monto preaprobado por el banco
 * @param {number|null} p.rentaLiquida renta líquida mensual en pesos
 * @param {object} p.cfg config.venta (pieMinimo, cargaMaxima, tasaAnual, plazoAnios)
 * @param {number} p.valorUf valor de la UF en pesos
 * @returns {{reglas: {clave, nombre, cumple: boolean|null, detalle}[], cumple: boolean|null, dividendoUf: number|null}}
 */
function calificarCompra({ forma, precioUf, pieUf, preaprobadoUf, rentaLiquida, cfg, valorUf }) {
  const precio = num(precioUf);
  const pie = num(pieUf);
  const prestamo = num(preaprobadoUf);
  const renta = num(rentaLiquida);
  const conCredito = forma === 'credito' || forma === 'subsidio';
  const reglas = [];

  // 1) Pie: al menos el % mínimo del precio (al contado debe cubrir el precio completo)
  const piePedido = precio ? precio * (forma === 'contado' ? 1 : cfg.pieMinimo) : null;
  reglas.push({
    clave: 'pie',
    nombre: forma === 'contado' ? 'Fondos para el precio completo' : `Pie de al menos ${Math.round(cfg.pieMinimo * 100)}%`,
    cumple: precio === null || pie === null ? null : pie >= piePedido,
    detalle:
      precio === null
        ? 'Falta el precio de la propiedad (elígela del listado o ingrésalo en la ficha).'
        : pie === null
          ? 'No indicó cuánto tiene para el pie.'
          : `Tiene ${uf(pie)} · se piden ${uf(piePedido)}${forma === 'contado' ? '' : ` (${Math.round((pie / precio) * 100)}% del precio)`}.`,
  });

  // 2) Preaprobación del banco por el resto del precio
  if (conCredito || forma === 'empresa') {
    const resto = precio !== null && pie !== null ? Math.max(0, precio - pie) : null;
    reglas.push({
      clave: 'preaprobacion',
      nombre: 'Preaprobación del banco por el resto',
      cumple: resto === null ? null : resto === 0 ? true : prestamo === null ? (forma === 'empresa' ? null : false) : prestamo >= resto,
      detalle:
        resto === null
          ? 'Se calcula con el precio y el pie.'
          : resto === 0
            ? 'El pie cubre el precio completo.'
            : prestamo === null
              ? `Falta la preaprobación: necesita ${uf(resto)} de crédito.`
              : `Preaprobado ${uf(prestamo)} · necesita ${uf(resto)}.`,
    });
  }

  // 3) Dividendo estimado: no más del % máximo de la renta líquida
  let div = null;
  if (conCredito) {
    const resto = precio !== null && pie !== null ? Math.max(0, precio - pie) : null;
    div = resto === null ? null : dividendoUf(resto, cfg.tasaAnual, cfg.plazoAnios);
    const tope = renta === null ? null : renta * cfg.cargaMaxima;
    const divPesos = div === null ? null : div * valorUf;
    reglas.push({
      clave: 'dividendo',
      nombre: `Dividendo hasta ${Math.round(cfg.cargaMaxima * 100)}% de la renta`,
      cumple: divPesos === null || tope === null ? null : divPesos <= tope,
      detalle:
        divPesos === null
          ? 'Se calcula con el precio y el pie.'
          : tope === null
            ? `Dividendo estimado ${pesos(divPesos)}; falta su renta líquida.`
            : `Dividendo estimado ${pesos(divPesos)} (${Math.round((divPesos / renta) * 100)}% de su renta de ${pesos(renta)}) · tope ${pesos(tope)}.`,
    });
  }

  const cumple = reglas.some((r) => r.cumple === false) ? false : reglas.every((r) => r.cumple === true) ? true : null;
  return { reglas, cumple, dividendoUf: div };
}

// Valor de la UF del día (mindicador.cl), guardado 6 horas; si falla se usa el de la configuración
function crearValorUf({ respaldo, fetchFn = fetch }) {
  let cache = { valor: respaldo, hasta: 0 };
  async function actualizar() {
    if (!fetchFn) return;
    try {
      const r = await fetchFn('https://mindicador.cl/api/uf', { signal: AbortSignal.timeout(5000) });
      const v = Number((await r.json())?.serie?.[0]?.valor);
      if (v > 10000) cache = { valor: v, hasta: Date.now() + 6 * 3600 * 1000 };
    } catch {
      cache.hasta = Date.now() + 30 * 60 * 1000; // reintenta en media hora
    }
  }
  return {
    actual: () => {
      if (Date.now() > cache.hasta) actualizar();
      return cache.valor;
    },
    actualizar,
  };
}

module.exports = { calificarCompra, dividendoUf, crearValorUf };
