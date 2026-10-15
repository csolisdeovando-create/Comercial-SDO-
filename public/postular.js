(function () {
  var form = document.getElementById('form-postulacion');
  if (!form) return;

  // Mostrar documentos según tipo de postulante
  function actualizarTipo() {
    var marcado = form.querySelector('input[name=tipo]:checked');
    var tipo = marcado ? marcado.value : 'dependiente';
    form.querySelectorAll('fieldset.docs').forEach(function (fs) {
      var activo = fs.dataset.tipo === tipo;
      fs.hidden = !activo;
      fs.querySelectorAll('input[type=file]').forEach(function (i) { i.required = activo && !i.dataset.opcional; });
    });
    form.querySelectorAll('.solo-empresa').forEach(function (el) { el.hidden = tipo !== 'independiente'; });
  }
  form.querySelectorAll('input[name=tipo]').forEach(function (r) { r.addEventListener('change', actualizarTipo); });
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
    i.addEventListener('blur', function () { i.value = formatearRut(i.value); });
  });

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
