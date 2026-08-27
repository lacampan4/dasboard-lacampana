(function () {
  'use strict';

  if (window.__LA_CAMPANA_BUTTONS_ONLY__) return;
  window.__LA_CAMPANA_BUTTONS_ONLY__ = true;

  function addButtons() {
    if (document.getElementById('campanaBtnActualizarSAP')) return true;

    var target = document.querySelector('.cbtns') ||
                 document.querySelector('.htools') ||
                 document.querySelector('.toolbar');

    if (!target) {
      var header = document.querySelector('header');
      if (header) {
        target = document.createElement('div');
        target.className = 'campana-buttons-fallback';
        header.appendChild(target);
      } else {
        target = document.body;
        if (!target) return false;
      }
    }

    if (!document.getElementById('campanaBtnCargarExcel')) {
      var excel = document.createElement('button');
      excel.type = 'button';
      excel.id = 'campanaBtnCargarExcel';
      excel.className = target.classList.contains('cbtns') ? 'cbtn' : 'btn ghost';
      excel.textContent = '📊 Cargar Excel';
      excel.title = 'Cargar Excel';
      target.appendChild(excel);
    }

    if (!document.getElementById('campanaBtnActualizarSAP')) {
      var sap = document.createElement('button');
      sap.type = 'button';
      sap.id = 'campanaBtnActualizarSAP';
      sap.className = target.classList.contains('cbtns') ? 'cbtn pri' : 'btn ghost';
      sap.textContent = '↻ Actualizar desde SAP';
      sap.title = 'Actualizar desde SAP';
      target.appendChild(sap);
    }

    return true;
  }

  function installStyle() {
    if (document.getElementById('campanaButtonsStyle')) return;
    var style = document.createElement('style');
    style.id = 'campanaButtonsStyle';
    style.textContent = `
      .campana-buttons-fallback {
        display:flex;
        gap:10px;
        align-items:center;
        flex-wrap:wrap;
        margin-left:auto;
        margin-top:12px;
      }
      #campanaBtnCargarExcel,
      #campanaBtnActualizarSAP {
        white-space:nowrap;
      }
      @media (max-width: 900px) {
        .campana-buttons-fallback {
          width:100%;
          margin-left:0;
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function start() {
    installStyle();
    if (addButtons()) return;

    var observer = new MutationObserver(function () {
      installStyle();
      if (addButtons()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    setTimeout(function () {
      if (document.getElementById('campanaBtnActualizarSAP')) observer.disconnect();
    }, 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
