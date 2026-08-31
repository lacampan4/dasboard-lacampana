/* La Campana - integración del botón "Actualizar desde SAP".
   No usa Google Drive. La sincronización se ejecuta en Render y el botón
   muestra el progreso consultando /sync-status. */
(function () {
  'use strict';

  const API_BASE = (window.LC_API_BASE || 'https://prueba-k6t5.onrender.com').replace(/\/$/, '');
  const DEFAULT_START = '2026-08-01';

  function getButton() {
    return document.getElementById('updateSapBtn');
  }

  function setButton(button, text, disabled) {
    if (!button) return;
    button.dataset.sapOriginalText ||= button.textContent.trim();
    button.textContent = text;
    button.disabled = !!disabled;
  }

  async function getStatus() {
    const response = await fetch(API_BASE + '/sync-status', { cache: 'no-store' });
    if (!response.ok) throw new Error('No se pudo consultar el estado de SAP (' + response.status + ').');
    return response.json();
  }

  async function startSync() {
    const now = new Date();
    const fin = now.toISOString().slice(0, 10);
    const url = API_BASE + '/sync-sap?inicio=' + encodeURIComponent(DEFAULT_START) + '&fin=' + encodeURIComponent(fin);
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

  async function refreshDataCache() {
    try {
      const response = await fetch(API_BASE + '/facturacion?inicio=' + encodeURIComponent(DEFAULT_START) + '&fin=' + encodeURIComponent(new Date().toISOString().slice(0, 10)), { cache: 'no-store' });
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

  async function waitForCompletion(button) {
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

      await refreshDataCache();
      return status;
    }
    throw new Error('La sincronización está tardando más de lo esperado. Revisa /sync-status en Render.');
  }

  async function updateFromSap() {
    const button = getButton();
    if (!button || button.dataset.sapBusy === '1') return;

    button.dataset.sapBusy = '1';
    const original = button.dataset.sapOriginalText || button.textContent.trim();
    setButton(button, 'SAP: iniciando…', true);

    try {
      const started = await startSync();
      if (started.alreadyRunning) {
        setButton(button, 'SAP: ya está sincronizando…', true);
      }
      await waitForCompletion(button);
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
    button.title = 'Sincronizar los datos de SAP con PostgreSQL';
    button.addEventListener('click', updateFromSap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
