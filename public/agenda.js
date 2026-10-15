(function () {
  var form = document.querySelector('form.calendario');
  if (!form) return;
  var semanas = Array.prototype.slice.call(form.querySelectorAll('.semana'));
  var titulo = form.querySelector('.titulo-semana');
  var actual = 0;

  function mostrar(i) {
    actual = Math.max(0, Math.min(semanas.length - 1, i));
    semanas.forEach(function (s, j) { s.hidden = j !== actual; });
    var cabs = semanas[actual].querySelectorAll('.dia-fecha');
    titulo.textContent = 'Semana ' + cabs[0].textContent + ' – ' + cabs[cabs.length - 1].textContent;
    form.querySelector('[data-nav="-1"]').disabled = actual === 0;
    form.querySelector('[data-nav="1"]').disabled = actual === semanas.length - 1;
  }
  form.querySelectorAll('[data-nav]').forEach(function (b) {
    b.addEventListener('click', function () { mostrar(actual + Number(b.dataset.nav)); });
  });

  // Si la primera semana no tiene horarios libres, partir en la siguiente
  var inicio = semanas.findIndex(function (s) { return s.querySelector('input[type=radio]'); });
  mostrar(inicio < 0 ? 0 : inicio);

  var resumen = form.querySelector('.resumen');
  form.addEventListener('change', function (e) {
    if (e.target.name !== 'bloque') return;
    var dia = e.target.closest('.dia');
    var nombre = dia.querySelector('.dia-nombre').textContent;
    var fecha = dia.querySelector('.dia-fecha').textContent;
    resumen.hidden = false;
    resumen.querySelector('strong').textContent = nombre + ' ' + fecha + ' a las ' + e.target.nextElementSibling.textContent + ' hrs';
  });

  form.addEventListener('submit', function (e) {
    if (!form.querySelector('input[name=bloque]:checked')) {
      e.preventDefault();
      alert('Selecciona un día y una hora para tu visita.');
      return;
    }
    var boton = form.querySelector('button[type=submit]');
    boton.disabled = true;
    boton.textContent = 'Confirmando…';
  });
})();
