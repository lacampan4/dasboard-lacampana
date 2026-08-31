/* La Campana - integración del botón "Actualizar desde SAP".
   No usa Google Drive. La sincronización se ejecuta en Render y el botón
   muestra el progreso consultando /sync-status.

   Además, este script inyecta junto al botón dos campos de fecha
   ("Desde" / "Hasta") para que el usuario elija el rango a sincronizar,
   en vez de usar siempre un rango fijo. La última selección se recuerda
   en este navegador (localStorage). */
(function () {
  'use strict';

  const API_BASE = (window.LC_API_BASE || 'https://prueba-k6t5.onrender.com').replace(/\/$/, '');
  const DEFAULT_START = '2026-08-01';
  const LS_INICIO = 'LC_SAP_FECHA_INICIO';
  const LS_FIN = 'LC_SAP_FECHA_FIN';

  function getButton() {
    return document.getElementById('updateSapBtn');
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function setButton(button, text, disabled) {
    if (!button) return;
    button.dataset.sapOriginalText ||= button.textContent.trim();
    button.textContent = text;
    button.disabled = !!disabled;
  }

  // Lee inicio/fin guardados en este navegador, o usa los valores por defecto.
  function loadSavedRange() {
    let inicio = DEFAULT_START;
    let fin = todayISO();
    try {
      inicio = localStorage.getItem(LS_INICIO) || inicio;
      fin = localStorage.getItem(LS_FIN) || fin;
    } catch (_) {}
    return { inicio, fin };
  }

  function saveRange(inicio, fin) {
    try {
      localStorage.setItem(LS_INICIO, inicio);
      localStorage.setItem(LS_FIN, fin);
    } catch (_) {}
  }

  // Crea (si no existen ya) los inputs de fecha justo antes del botón.
  function ensureDatePickers(button) {
    if (document.getElementById('sapFechaInicio') && document.getElementById('sapFechaFin')) {
      return {
        inicioInput: document.getElementById('sapFechaInicio'),
        finInput: document.getElementById('sapFechaFin')
      };
    }

    const { inicio, fin } = loadSavedRange();

    const wrap = document.createElement('span');
    wrap.id = 'sapFechaWrap';
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';
    wrap.style.marginRight = '6px';
    wrap.className = 'noprint';

    const inicioInput = document.createElement('input');
    inicioInput.type = 'date';
    inicioInput.id = 'sapFechaInicio';
    inicioInput.value = inicio;
    inicioInput.title = 'Fecha inicial a sincronizar desde SAP';
    styleDateInput(inicioInput);

    const separador = document.createElement('span');
    separador.textContent = '→';
    separador.style.color = 'var(--txt3, #888)';
    separador.style.fontSize = '12px';

    const finInput = document.createElement('input');
    finInput.type = 'date';
    finInput.id = 'sapFechaFin';
    finInput.value = fin;
    finInput.title = 'Fecha final a sincronizar desde SAP';
    styleDateInput(finInput);

    wrap.appendChild(inicioInput);
    wrap.appendChild(separador);
    wrap.appendChild(finInput);

    button.parentNode.insertBefore(wrap, button);

    return { inicioInput, finInput };
  }

  function styleDateInput(input) {
    input.style.background = 'var(--bg2, #e6e8eb)';
    input.style.border = '1px solid var(--line2, #d2d6db)';
    input.style.color = 'var(--txt, #14161a)';
    input.style.fontFamily = "'Archivo', sans-serif";
    input.style.fontSize = '12.5px';
    input.style.padding = '8px 9px';
    input.style.borderRadius = '8px';
  }

  async function getStatus() {
    const response = await fetch(API_BASE + '/sync-status', { cache: 'no-store' });
    if (!response.ok) throw new Error('No se pudo consultar el estado de SAP (' + response.status + ').');
    return response.json();
  }

  async function startSync(inicio, fin) {
    const url = API_BASE + '/sync-sap?inicio=' + encodeURIComponent(inicio) + '&fin=' + encodeURIComponent(fin);
    const response = await fetch(url, { method: 'GET', cache: 'no-store' });
    const body = await response.json().catch(() => ({}));

    if (response.status === 409) {
      return { alreadyRunning: true, body };
    }
    if (!response.ok) {
      throw new Error(body.error || body.mensaje || ('SAP respondió con HTTP ' + response.status + '.'));
    }
    return { alreadyRunning: false, body };
  }

  async function refreshDataCache(inicio, fin) {
    try {
      const response = await fetch(API_BASE + '/facturacion?inicio=' + encodeURIComponent(inicio) + '&fin=' + encodeURIComponent(fin), { cache: 'no-store' });
      if (!response.ok) return;
      const body = await response.json();
      window.LC_SAP_DATA = body.data || body;
      window.LC_SAP_DATA_IMPORTED = true;
      try {
        localStorage.setItem('LC_SAP_DATA', JSON.stringify(window.LC_SAP_DATA));
        localStorage.setItem('LC_SAP_UPDATED_AT', new Date().toISOString());
      } catch (_) {}
      window.dispatchEvent(new CustomEvent('lc:sap-updated', { detail: window.LC_SAP_DATA }));
    } catch (_) {
      // La sincronización ya terminó. El cache es complementario.
    }
  }

  async function waitForCompletion(button, inicio, fin) {
    let attempts = 0;
    while (attempts++ < 180) {
      const status = await getStatus();
      const processed = Number(status.registrosProcesados || 0);
      const total = Number(status.registrosSAP || 0);
      const page = Number(status.paginaActual || 0);

      if (status.ejecutando) {
        const detail = total > 0 ? ' ' + processed + '/' + total : (page > 0 ? ' pág. ' + page : '');
        setButton(button, 'SAP: sincronizando' + detail + '…', true);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }

      if (status.estado === 'error') {
        throw new Error(status.error || 'La sincronización SAP terminó con error.');
      }

      await refreshDataCache(inicio, fin);
      return status;
    }
    throw new Error('La sincronización está tardando más de lo esperado. Revisa /sync-status en Render.');
  }

  async function updateFromSap() {
    const button = getButton();
    if (!button || button.dataset.sapBusy === '1') return;

    const { inicioInput, finInput } = ensureDatePickers(button);
    const inicio = inicioInput.value || DEFAULT_START;
    const fin = finInput.value || todayISO();

    if (!inicio || !fin) {
      alert('Elige una fecha inicial y una fecha final antes de sincronizar.');
      return;
    }
    if (inicio > fin) {
      alert('La fecha inicial no puede ser posterior a la fecha final.');
      return;
    }

    saveRange(inicio, fin);

    button.dataset.sapBusy = '1';
    const original = button.dataset.sapOriginalText || button.textContent.trim();
    setButton(button, 'SAP: iniciando…', true);

    try {
      const started = await startSync(inicio, fin);
      if (started.alreadyRunning) {
        setButton(button, 'SAP: ya está sincronizando…', true);
      }
      await waitForCompletion(button, inicio, fin);
      setButton(button, '✓ SAP actualizado', true);
      setTimeout(() => {
        // Recargar permite que los módulos vuelvan a inicializarse con el último estado.
        window.location.reload();
      }, 900);
    } catch (error) {
      console.error('[SAP]', error);
      alert('No se pudo actualizar desde SAP.\n\n' + error.message);
      setButton(button, original, false);
      button.dataset.sapBusy = '0';
    }
  }

  function init() {
    const button = getButton();
    if (!button) return;
    button.title = 'Sincronizar los datos de SAP con PostgreSQL para el rango de fechas elegido';
    ensureDatePickers(button);
    button.addEventListener('click', updateFromSap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
