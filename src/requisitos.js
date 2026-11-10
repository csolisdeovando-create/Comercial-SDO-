// Documentos solicitados según el tipo de postulante.
const REQUISITOS = {
  dependiente: {
    etiqueta: 'Trabajador dependiente',
    documentos: [
      { campo: 'cedula', nombre: 'Cédula de identidad', ayuda: 'Ambos lados (foto o PDF).' },
      { campo: 'liquidaciones', nombre: '3 últimas liquidaciones de sueldo', ayuda: 'Una liquidación por casilla. Si las tienes en un solo PDF, súbelo en la primera.', casillas: ['Liquidación 1 (la más reciente)', 'Liquidación 2', 'Liquidación 3'] },
      { campo: 'afp', nombre: 'Certificado de cotizaciones (AFP)', ayuda: 'Últimos 12 meses idealmente.' },
      { campo: 'dicom', nombre: 'Certificado Dicom u otro reporte de deuda', ayuda: 'Ej: Dicom Equifax o informe de deuda CMF.' },
    ],
  },
  independiente: {
    etiqueta: 'Independiente o empresa',
    documentos: [
      { campo: 'carnet_representante', nombre: 'Carnet del representante legal', ayuda: 'Ambos lados (foto o PDF).' },
      { campo: 'carpeta_tributaria', nombre: 'Carpeta tributaria o reporte de boletas de honorarios', ayuda: 'Se descarga desde sii.cl.' },
      { campo: 'declaraciones_renta', nombre: 'Declaraciones de renta', ayuda: 'Formulario 22 de los últimos años.' },
      { campo: 'dicom_empresa', nombre: 'Reporte Dicom (empresa y representante legal)', ayuda: 'Puedes subir varios archivos.' },
    ],
  },
};

const TIPOS = Object.keys(REQUISITOS);

// SDO Capital · Ventas: documentos según la forma de compra (se guardan en el mismo campo "tipo" del interesado)
const REQUISITOS_VENTA = {
  credito: {
    etiqueta: 'Con crédito hipotecario',
    documentos: [
      { campo: 'cedula', nombre: 'Cédula de identidad', ayuda: 'Ambos lados (foto o PDF).' },
      { campo: 'preaprobacion', nombre: 'Carta de preaprobación del banco', ayuda: 'Con el monto preaprobado (UF o pesos) y su vigencia.' },
      { campo: 'liquidaciones', nombre: '3 últimas liquidaciones de sueldo (o carpeta tributaria si eres independiente)', ayuda: 'Una por casilla. Si las tienes en un solo PDF, súbelo en la primera.', casillas: ['Liquidación 1 (la más reciente)', 'Liquidación 2', 'Liquidación 3'] },
      { campo: 'afp', nombre: 'Certificado de cotizaciones (AFP)', ayuda: 'Últimos 12 meses.' },
      { campo: 'pie', nombre: 'Respaldo del pie', ayuda: 'Cartola de ahorro, cuenta o inversión con el monto del pie.' },
    ],
  },
  contado: {
    etiqueta: 'Al contado',
    documentos: [
      { campo: 'cedula', nombre: 'Cédula de identidad', ayuda: 'Ambos lados (foto o PDF).' },
      { campo: 'fondos', nombre: 'Respaldo de fondos', ayuda: 'Cartola bancaria o de inversión que muestre el monto disponible.' },
    ],
  },
  subsidio: {
    etiqueta: 'Con subsidio habitacional',
    documentos: [
      { campo: 'cedula', nombre: 'Cédula de identidad', ayuda: 'Ambos lados (foto o PDF).' },
      { campo: 'certificado_subsidio', nombre: 'Certificado del subsidio (MINVU/SERVIU)', ayuda: 'Vigente.' },
      { campo: 'ahorro', nombre: 'Libreta o cartola de ahorro para la vivienda', ayuda: 'Con el ahorro acreditado.' },
      { campo: 'preaprobacion', nombre: 'Carta de preaprobación del crédito complementario', ayuda: 'Si compras con crédito además del subsidio.' },
    ],
  },
  empresa: {
    etiqueta: 'A nombre de una empresa',
    documentos: [
      { campo: 'erut', nombre: 'e-RUT de la empresa', ayuda: 'Se descarga desde sii.cl.' },
      { campo: 'escritura', nombre: 'Escritura y certificado de vigencia', ayuda: 'De la sociedad.' },
      { campo: 'carnet_representante', nombre: 'Cédula del representante legal', ayuda: 'Ambos lados (foto o PDF).' },
      { campo: 'fondos', nombre: 'Respaldo de fondos o preaprobación', ayuda: 'Cartola o carta del banco.' },
    ],
  },
};
const FORMAS_COMPRA = Object.keys(REQUISITOS_VENTA);
const requisitosDe = (tipo) => REQUISITOS[tipo] || REQUISITOS_VENTA[tipo] || null;

// Los documentos de quien complementa renta usan el mismo campo con este prefijo
const PREFIJO_COMP = 'comp_';

function todosLosCampos() {
  const base = TIPOS.flatMap((t) => REQUISITOS[t].documentos.map((d) => d.campo));
  const venta = FORMAS_COMPRA.flatMap((t) => REQUISITOS_VENTA[t].documentos.map((d) => d.campo));
  return [...new Set([...base, ...base.map((c) => PREFIJO_COMP + c), ...venta])];
}

const esComplemento = (campo) => String(campo).startsWith(PREFIJO_COMP);

function nombreRequisito(campo) {
  if (esComplemento(campo)) return `Complemento · ${nombreRequisito(campo.slice(PREFIJO_COMP.length))}`;
  for (const grupo of [...Object.values(REQUISITOS), ...Object.values(REQUISITOS_VENTA)]) {
    const doc = grupo.documentos.find((d) => d.campo === campo);
    if (doc) return doc.nombre;
  }
  return campo;
}

function textoRequisitosWhatsapp() {
  const bloque = (tipo, titulo) =>
    `*${titulo}:*\n` +
    REQUISITOS[tipo].documentos.map((d, i) => `${i + 1}️⃣ ${d.nombre}`).join('\n');
  return `${bloque('dependiente', 'Requisitos para dependientes')}\n\n${bloque(
    'independiente',
    'Requisitos para independientes o empresas'
  )}`;
}

module.exports = { REQUISITOS, REQUISITOS_VENTA, FORMAS_COMPRA, requisitosDe, TIPOS, PREFIJO_COMP, esComplemento, todosLosCampos, nombreRequisito, textoRequisitosWhatsapp };
