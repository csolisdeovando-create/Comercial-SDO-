// Lógica de bloques de visita: lunes a viernes, horas fijas, en hora de Chile.

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Fecha y hora "de pared" en la zona horaria indicada
function ahoraEnZona(zona, ahora = new Date()) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zona,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ahora)
      .map((p) => [p.type, p.value])
  );
  return {
    fecha: `${partes.year}-${partes.month}-${partes.day}`,
    minutos: Number(partes.hour) * 60 + Number(partes.minute),
  };
}

const aUTC = (fecha) => new Date(`${fecha}T00:00:00Z`);
const deUTC = (d) => d.toISOString().slice(0, 10);
const sumarDias = (fecha, n) => {
  const d = aUTC(fecha);
  d.setUTCDate(d.getUTCDate() + n);
  return deUTC(d);
};
const diaSemana = (fecha) => aUTC(fecha).getUTCDay();

const DIAS_POR_DEFECTO = [1, 2, 3, 4, 5];

function esDiaHabil(fecha, feriados = [], diasSemana = DIAS_POR_DEFECTO) {
  return diasSemana.includes(diaSemana(fecha)) && !feriados.includes(fecha);
}

// Horas de visita de una fecha. Los sábados: las fijas (si hay) + las que el equipo habilitó ese día (cfg.horasExtra)
function horasDe(cfg, fecha) {
  if (diaSemana(fecha) !== 6) return cfg.horas;
  return [...new Set([...(cfg.horasSabado || []), ...(cfg.horasExtra ? cfg.horasExtra(fecha) : [])])].sort((a, b) => a - b);
}
const esSabado = (fecha) => diaSemana(fecha) === 6;

// Días de la semana que se muestran como columnas (1 = lunes … 6 = sábado)
const columnasSemana = (cfg) => [...(cfg.diasSemana || DIAS_POR_DEFECTO)].filter((d) => d >= 1 && d <= 6).sort((a, b) => a - b);

// "lunes a viernes" / "lunes a sábado"
function textoDias(cfg) {
  const cols = columnasSemana(cfg);
  const nombre = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  return cols.length > 1 ? `${nombre[cols[0]]} a ${nombre[cols[cols.length - 1]]}` : nombre[cols[0]];
}

const horaTexto = (h) => `${String(h).padStart(2, '0')}:00`;

function fechaLarga(fecha) {
  const d = aUTC(fecha);
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
}

function describirBloque(fecha, hora) {
  const t = fechaLarga(fecha);
  return `${t.charAt(0).toUpperCase()}${t.slice(1)} a las ${horaTexto(hora)} hrs`;
}

/**
 * Calcula los bloques disponibles, agrupados por semana (lunes a viernes).
 * @param {object} cfg config.agenda + zonaHoraria
 * @param {Map} ocupacion "YYYY-MM-DD H" -> cantidad de visitas confirmadas
 */
function construirCalendario(cfg, ocupacion = new Map(), ahora = new Date()) {
  const { fecha: hoy, minutos } = ahoraEnZona(cfg.zonaHoraria, ahora);
  const limiteMinutos = minutos + cfg.anticipacionHoras * 60;

  // Días hábiles a ofrecer, partiendo hoy
  const cols = columnasSemana(cfg);
  const dias = [];
  for (let f = hoy; dias.length < cfg.diasHabiles; f = sumarDias(f, 1)) {
    if (esDiaHabil(f, cfg.feriados, cols)) dias.push(f);
  }

  const semanas = new Map();
  for (const fecha of dias) {
    const lunes = sumarDias(fecha, 1 - (diaSemana(fecha) || 7));
    if (!semanas.has(lunes)) {
      // Siempre se muestran todas las columnas de la semana (lun-vie o lun-sáb)
      semanas.set(
        lunes,
        cols.map((d) => ({ fecha: sumarDias(lunes, d - 1), habilitado: false, bloques: [] }))
      );
    }
    const dia = semanas.get(lunes)[cols.indexOf(diaSemana(fecha))];
    dia.bloques = horasDe(cfg, fecha).map((hora) => {
      const ocupados = ocupacion.get(`${fecha} ${hora}`) || 0;
      const pasado = fecha < hoy || (fecha === hoy && hora * 60 < limiteMinutos);
      return { fecha, hora, disponible: !pasado && ocupados < cfg.cuposPorBloque };
    });
    dia.habilitado = dia.bloques.length > 0; // un sábado sin horas habilitadas se muestra cerrado
  }

  return {
    desde: dias[0],
    hasta: dias[dias.length - 1],
    semanas: [...semanas.entries()].map(([lunes, dias]) => ({ lunes, dias })),
  };
}

function bloqueValido(cfg, fecha, hora, ahora = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) return false;
  const cal = construirCalendario(cfg, new Map(), ahora);
  return cal.semanas.some((s) =>
    s.dias.some((d) => d.bloques.some((b) => b.fecha === fecha && b.hora === Number(hora) && b.disponible))
  );
}

// Invitación de calendario (.ics) para Google Calendar / Outlook.
// Mismo `uid` + `secuencia` mayor = actualiza el evento existente (reagendar, confirmar);
// metodo 'CANCEL' lo elimina del calendario.
function generarICS({
  uid,
  fecha,
  hora,
  duracionMinutos,
  zona,
  titulo,
  descripcion,
  ubicacion,
  url,
  organizador,
  asistentes = [],
  metodo = 'REQUEST',
  secuencia = 0,
  alarmaMinutos = 60,
}) {
  const [y, m, d] = fecha.split('-');
  const ini = `${y}${m}${d}T${String(hora).padStart(2, '0')}0000`;
  const finMin = hora * 60 + duracionMinutos;
  const fin = `${y}${m}${d}T${String(Math.floor(finMin / 60)).padStart(2, '0')}${String(finMin % 60).padStart(2, '0')}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const esc = (s = '') => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
  const cancelar = metodo === 'CANCEL';
  const lineas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SDO Rent//Agenda Comercial//ES',
    'CALSCALE:GREGORIAN',
    `METHOD:${metodo}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SEQUENCE:${secuencia}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${zona}:${ini}`,
    `DTEND;TZID=${zona}:${fin}`,
    `SUMMARY:${esc(titulo)}`,
    `DESCRIPTION:${esc(descripcion)}`,
    ubicacion ? `LOCATION:${esc(ubicacion)}` : null,
    url ? `URL:${url}` : null,
    organizador ? `ORGANIZER;CN=SDO Rent:mailto:${organizador}` : null,
    ...asistentes.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${a}`),
    `STATUS:${cancelar ? 'CANCELLED' : 'CONFIRMED'}`,
    ...(!cancelar && alarmaMinutos
      ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(titulo)}`, `TRIGGER:-PT${alarmaMinutos}M`, 'END:VALARM']
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lineas.map(plegarLinea).join('\r\n') + '\r\n';
}

// Las líneas de un .ics no deben superar 75 bytes; las largas se continúan con un espacio
function plegarLinea(linea) {
  const partes = [];
  let actual = '';
  let bytes = 0;
  for (const ch of linea) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (partes.length ? 74 : 75)) {
      partes.push(actual);
      actual = '';
      bytes = 0;
    }
    actual += ch;
    bytes += n;
  }
  partes.push(actual);
  return partes.join('\r\n ');
}

module.exports = {
  horasDe,
  columnasSemana,
  textoDias,
  diaSemana,
  ahoraEnZona,
  construirCalendario,
  bloqueValido,
  describirBloque,
  fechaLarga,
  horaTexto,
  generarICS,
  esDiaHabil,
  sumarDias,
  esSabado,
};
