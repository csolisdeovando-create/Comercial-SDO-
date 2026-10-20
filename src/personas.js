// Datos personales que se piden a quien postula y a quien complementa renta o es aval.
// Los de quien complementa usan los mismos nombres con el prefijo "comp_".
const { esc, formatearRut, rutValido, limpiarRut, normalizarTelefono, emailValido } = require('./utils');

const ESTADOS_CIVILES = ['Soltero/a', 'Casado/a', 'Conviviente civil', 'Divorciado/a', 'Separado/a', 'Viudo/a'];

// Columnas en la base de datos (sin prefijo)
const CAMPOS_PERSONA = [
  'nombre',
  'doc_tipo',
  'rut',
  'nacionalidad',
  'fecha_nacimiento',
  'estado_civil',
  'profesion',
  'direccion_actual',
  'comuna',
  'telefono',
  'email',
];

const pasaporteValido = (p) => /^[A-Za-z0-9-]{5,20}$/.test(String(p || '').trim());

// "RUT 12.345.678-9" o "Pasaporte AB123456"
function documentoTexto(datos, prefijo = '') {
  const num = datos[`${prefijo}rut`];
  if (!num) return '';
  return datos[`${prefijo}doc_tipo`] === 'pasaporte' ? `Pasaporte ${num}` : `RUT ${formatearRut(num)}`;
}

function edad(fechaISO, hoy = new Date()) {
  const [y, m, d] = String(fechaISO).split('-').map(Number);
  let e = hoy.getFullYear() - y;
  if (hoy.getMonth() + 1 < m || (hoy.getMonth() + 1 === m && hoy.getDate() < d)) e--;
  return e;
}

const fechaLegible = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};

/**
 * Campos del formulario. `requerido` agrega required (quien postula) o data-req-comp
 * (quien complementa, se activa solo si marca la casilla).
 */
function formularioPersona(v, prefijo = '') {
  const n = (c) => `${prefijo}${c}`;
  const val = (c) => esc(v[n(c)] ?? '');
  const req = prefijo ? 'data-req-comp' : 'required';
  const docTipo = v[n('doc_tipo')] === 'pasaporte' ? 'pasaporte' : 'rut';
  const docValor = v[n('rut')] ? (docTipo === 'rut' ? formatearRut(v[n('rut')]) : v[n('rut')]) : '';
  const tel = v[n('telefono')] ? `+${v[n('telefono')]}`.replace(/^\+\+/, '+') : '';
  const hoy = new Date().toISOString().slice(0, 10);
  return `
          <div class="grilla">
            <label>Nombre completo<input name="${n('nombre')}" ${req} ${prefijo ? '' : 'autocomplete="name"'} value="${val('nombre')}"></label>
            <div class="campo-doc">
              <label for="${n('rut')}">Documento</label>
              <div class="fila-doc">
                <select name="${n('doc_tipo')}" aria-label="Tipo de documento" data-doc-tipo>
                  <option value="rut" ${docTipo === 'rut' ? 'selected' : ''}>RUT</option>
                  <option value="pasaporte" ${docTipo === 'pasaporte' ? 'selected' : ''}>Pasaporte</option>
                </select>
                <input id="${n('rut')}" name="${n('rut')}" ${req} placeholder="${docTipo === 'rut' ? '12.345.678-9' : 'N° de pasaporte'}" value="${esc(docValor)}" data-rut>
              </div>
            </div>
            <label>Nacionalidad<input name="${n('nacionalidad')}" ${req} placeholder="Ej: Chilena" value="${val('nacionalidad')}"></label>
            <label>Fecha de nacimiento<input type="date" name="${n('fecha_nacimiento')}" ${req} max="${hoy}" value="${val('fecha_nacimiento')}"></label>
            <label>Estado civil
              <select name="${n('estado_civil')}" ${req}>
                <option value="">Selecciona…</option>
                ${ESTADOS_CIVILES.map((e) => `<option ${v[n('estado_civil')] === e ? 'selected' : ''}>${e}</option>`).join('')}
              </select>
            </label>
            <label>Profesión u ocupación<input name="${n('profesion')}" ${req} placeholder="Ej: Ingeniera comercial" value="${val('profesion')}"></label>
            <label>Dirección actual<input name="${n('direccion_actual')}" ${req} ${prefijo ? '' : 'autocomplete="street-address"'} placeholder="Calle, número, depto" value="${val('direccion_actual')}"></label>
            <label>Comuna<input name="${n('comuna')}" ${req} placeholder="Ej: Providencia" value="${val('comuna')}"></label>
            <label>Teléfono / WhatsApp<input type="tel" name="${n('telefono')}" ${req} ${prefijo ? '' : 'autocomplete="tel"'} placeholder="+56 9 1234 5678" value="${esc(tel)}"></label>
            <label>Correo electrónico<input type="email" name="${n('email')}" ${req} ${prefijo ? '' : 'autocomplete="email"'} value="${val('email')}"></label>
          </div>`;
}

/** Valida y normaliza los datos de una persona. `quien` se usa en los mensajes de error. */
function validarPersona(b, prefijo = '', quien = '', hoy = new Date()) {
  const n = (c) => `${prefijo}${c}`;
  const de = quien ? ` de ${quien}` : '';
  const errores = [];
  const txt = (c, max = 150) => String(b[n(c)] || '').trim().slice(0, max);

  const docTipo = b[n('doc_tipo')] === 'pasaporte' ? 'pasaporte' : 'rut';
  const doc = txt('rut', 30);
  if (!txt('nombre')) errores.push(`Ingresa el nombre completo${de}.`);
  if (docTipo === 'rut' && !rutValido(doc)) errores.push(`El RUT${de} no es válido.`);
  if (docTipo === 'pasaporte' && !pasaporteValido(doc)) errores.push(`El número de pasaporte${de} no es válido.`);
  if (!txt('nacionalidad')) errores.push(`Indica la nacionalidad${de}.`);
  const fnac = txt('fecha_nacimiento', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fnac) || Number(fnac.slice(0, 4)) < 1900 || fnac > hoy.toISOString().slice(0, 10)) {
    errores.push(`Ingresa una fecha de nacimiento válida${de}.`);
  } else if (edad(fnac, hoy) < 18) {
    errores.push(`${quien ? `Quien ${quien.replace(/^quien /, '')}` : 'Quien postula'} debe ser mayor de edad.`);
  }
  if (!ESTADOS_CIVILES.includes(b[n('estado_civil')])) errores.push(`Selecciona el estado civil${de}.`);
  if (!txt('profesion')) errores.push(`Indica la profesión u ocupación${de}.`);
  if (!txt('direccion_actual', 200)) errores.push(`Ingresa la dirección actual${de}.`);
  if (!txt('comuna', 80)) errores.push(`Ingresa la comuna${de}.`);
  const telefono = normalizarTelefono(b[n('telefono')]);
  if (telefono.length < 8) errores.push(`Ingresa un teléfono válido${de} (ej: +56 9 1234 5678).`);
  if (!emailValido(b[n('email')])) errores.push(`Ingresa un correo electrónico válido${de}.`);

  const datos = {
    [n('nombre')]: txt('nombre'),
    [n('doc_tipo')]: docTipo,
    [n('rut')]: docTipo === 'rut' ? limpiarRut(doc) : doc.toUpperCase(),
    [n('nacionalidad')]: txt('nacionalidad', 60),
    [n('fecha_nacimiento')]: fnac,
    [n('estado_civil')]: b[n('estado_civil')],
    [n('profesion')]: txt('profesion', 120),
    [n('direccion_actual')]: txt('direccion_actual', 200),
    [n('comuna')]: txt('comuna', 80),
    [n('telefono')]: telefono,
    [n('email')]: String(b[n('email')] || '').trim().toLowerCase(),
  };
  return { errores, datos, telefono };
}

/** Filas [etiqueta, valor] para fichas y correos. */
function filasPersona(l, prefijo = '') {
  const n = (c) => l[`${prefijo}${c}`];
  return [
    ['Nombre', n('nombre')],
    ['Documento', documentoTexto(l, prefijo)],
    ['Nacionalidad', n('nacionalidad')],
    ['Fecha de nacimiento', n('fecha_nacimiento') ? `${fechaLegible(n('fecha_nacimiento'))} (${edad(n('fecha_nacimiento'))} años)` : ''],
    ['Estado civil', n('estado_civil')],
    ['Profesión u ocupación', n('profesion')],
    ['Dirección actual', [n('direccion_actual'), n('comuna')].filter(Boolean).join(', ')],
    ['Teléfono', n('telefono') ? `+${n('telefono')}` : ''],
    ['Correo', n('email')],
  ].filter(([, v]) => v);
}

module.exports = { ESTADOS_CIVILES, CAMPOS_PERSONA, formularioPersona, validarPersona, filasPersona, documentoTexto, fechaLegible };
