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

function esDiaHabil(fecha, feriados = []) {
  const d = diaSemana(fecha);
  return d >= 1 && d <= 5 && !feriados.includes(fecha);
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
  const dias = [];
  for (let f = hoy; dias.length < cfg.diasHabiles; f = sumarDias(f, 1)) {
    if (esDiaHabil(f, cfg.feriados)) dias.push(f);
  }

  const semanas = new Map();
  for (const fecha of dias) {
    const lunes = sumarDias(fecha, 1 - diaSemana(fecha));
    if (!semanas.has(lunes)) {
      // Siempre se muestran las 5 columnas de la semana (lun-vie)
      semanas.set(
        lunes,
        [0, 1, 2, 3, 4].map((i) => ({ fecha: sumarDias(lunes, i), habilitado: false, bloques: [] }))
      );
    }
    const dia = semanas.get(lunes)[diaSemana(fecha) - 1];
    dia.habilitado = true;
    dia.bloques = cfg.horas.map((hora) => {
      const ocupados = ocupacion.get(`${fecha} ${hora}`) || 0;
      const pasado = fecha < hoy || (fecha === hoy && hora * 60 < limiteMinutos);
      return { fecha, hora, disponible: !pasado && ocupados < cfg.cuposPorBloque };
    });
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

// Invitación de calendario (.ics) para Google Calendar / Outlook
function generarICS({ uid, fecha, hora, duracionMinutos, zona, titulo, descripcion, ubicacion, organizador, asistentes = [] }) {
  const [y, m, d] = fecha.split('-');
  const ini = `${y}${m}${d}T${String(hora).padStart(2, '0')}0000`;
  const finMin = hora * 60 + duracionMinutos;
  const fin = `${y}${m}${d}T${String(Math.floor(finMin / 60)).padStart(2, '0')}${String(finMin % 60).padStart(2, '0')}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const esc = (s = '') => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
  const lineas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SDO Rent//Agenda Comercial//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${zona}:${ini}`,
    `DTEND;TZID=${zona}:${fin}`,
    `SUMMARY:${esc(titulo)}`,
    `DESCRIPTION:${esc(descripcion)}`,
    ubicacion ? `LOCATION:${esc(ubicacion)}` : null,
    organizador ? `ORGANIZER;CN=SDO Rent:mailto:${organizador}` : null,
    ...asistentes.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${a}`),
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lineas.join('\r\n') + '\r\n';
}

module.exports = {
  ahoraEnZona,
  construirCalendario,
  bloqueValido,
  describirBloque,
  fechaLarga,
  horaTexto,
  generarICS,
  esDiaHabil,
  sumarDias,
};
