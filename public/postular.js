(function () {
  var form = document.getElementById('form-postulacion');
  if (!form) return;

  // Mostrar documentos según tipo de postulante y, si corresponde, de quien complementa renta
  var chkComp = form.querySelector('#complementa');
  function marcado(nombre) {
    var r = form.querySelector('input[name=' + nombre + ']:checked');
    return r ? r.value : 'dependiente';
  }
  function actualizarTipo() {
    var tipo = marcado('tipo');
    var comp = chkComp && chkComp.checked;
    var tipoComp = marcado('comp_tipo');
    form.querySelectorAll('fieldset.docs').forEach(function (fs) {
      var activo = fs.dataset.grupo === 'comp' ? comp && fs.dataset.tipo === tipoComp : fs.dataset.tipo === tipo;
      fs.hidden = !activo;
      fs.querySelectorAll('input[type=file]').forEach(function (i) { i.required = activo && !i.dataset.opcional; });
    });
    form.querySelectorAll('.solo-empresa').forEach(function (el) { el.hidden = tipo !== 'independiente'; });
    form.querySelectorAll('.datos-comp').forEach(function (el) { el.hidden = !comp; });
    form.querySelectorAll('[data-req-comp]').forEach(function (i) { i.required = comp; });
  }
  form.querySelectorAll('input[name=tipo], input[name=comp_tipo]').forEach(function (r) { r.addEventListener('change', actualizarTipo); });
  if (chkComp) chkComp.addEventListener('change', actualizarTipo);
  actualizarTipo();

  // Mostrar nombres de archivos seleccionados
  form.querySelectorAll('.archivo input[type=file]').forEach(function (input) {
    input.addEventListener('change', function () {
      var label = input.closest('.archivo');
      var n = input.files.length;
      label.classList.toggle('listo', n > 0);
      label.querySelector('.seleccion').textContent =
        n === 0 ? 'Seleccionar archivo' : n === 1 ? '✓ ' + input.files[0].name : '✓ ' + n + ' archivos seleccionados';
    });
  });

  // Formato de RUT
  function formatearRut(v) {
    var r = v.replace(/[^0-9kK]/g, '').toUpperCase();
    if (r.length < 2) return r;
    return r.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + r.slice(-1);
  }
  form.querySelectorAll('[data-rut]').forEach(function (i) {
    var selector = i.parentElement.querySelector('[data-doc-tipo]');
    i.addEventListener('blur', function () {
      if (!selector || selector.value === 'rut') i.value = formatearRut(i.value);
    });
    if (selector) selector.addEventListener('change', function () {
      i.placeholder = selector.value === 'rut' ? '12.345.678-9' : 'N° de pasaporte';
      if (selector.value === 'rut' && i.value) i.value = formatearRut(i.value);
    });
  });

  // Al pegar el link del aviso, se identifica la propiedad automáticamente
  var campoUrl = form.querySelector('[data-publicacion]');
  var campoProp = form.querySelector('[name=propiedad]');
  var vista = document.getElementById('vista-publicacion');
  var autoCompletado = '';
  var temporizador;
  function mostrar(html, clase) {
    vista.hidden = !html;
    vista.className = 'vista-publicacion ' + (clase || '');
    vista.innerHTML = html;
  }
  function esc(t) { var d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }
  function consultar() {
    var url = campoUrl.value.trim();
    if (!url) { mostrar(''); return; }
    mostrar('Buscando la propiedad…', 'cargando');
    fetch('/api/publicacion?url=' + encodeURIComponent(url))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { mostrar('No reconocemos ese link. Revisa que esté completo o escribe la dirección abajo.', 'error'); return; }
        var titulo = d.direccion || d.titulo || d.descripcion || 'Publicación';
        mostrar('<strong>🏠 ' + esc(titulo) + '</strong><span>' + esc([d.portal, d.codigo].filter(Boolean).join(' · ')) + '</span>', 'ok');
        // Completa la dirección solo si el interesado no la escribió
        if (!campoProp.value.trim() || campoProp.value === autoCompletado) {
          campoProp.value = d.resumen || titulo;
          autoCompletado = campoProp.value;
        }
      })
      .catch(function () { mostrar(''); });
  }
  if (campoUrl) {
    campoUrl.addEventListener('input', function () { clearTimeout(temporizador); temporizador = setTimeout(consultar, 500); });
    if (campoUrl.value) consultar();
  }

  form.addEventListener('submit', function (e) {
    if (!form.checkValidity()) {
      e.preventDefault();
      form.reportValidity();
      return;
    }
    var boton = form.querySelector('button[type=submit]');
    boton.disabled = true;
    boton.textContent = 'Enviando…';
    document.getElementById('estado-envio').hidden = false;
  });
})();
