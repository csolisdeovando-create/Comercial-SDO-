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

function todosLosCampos() {
  return TIPOS.flatMap((t) => REQUISITOS[t].documentos.map((d) => d.campo));
}

function nombreRequisito(campo) {
  for (const t of TIPOS) {
    const doc = REQUISITOS[t].documentos.find((d) => d.campo === campo);
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

module.exports = { REQUISITOS, TIPOS, todosLosCampos, nombreRequisito, textoRequisitosWhatsapp };
