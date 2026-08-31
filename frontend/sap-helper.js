/* La Campana - integración del botón "Actualizar desde SAP".
   No usa Google Drive. La sincronización se ejecuta en Render y el botón
   muestra el progreso consultando /sync-status.

   Ahora incluye un selector de rango de fechas (Desde / Hasta) que se
   inserta junto al botón en todos los dashboards. Elegir un rango más
   corto hace que tanto la sincronización con SAP como la carga de datos
   en el navegador sean más rápidas, porque se consulta/trae menos
   información. El rango elegido se recuerda por navegador (localStorage). */
(function () {
  'use strict';

  const API_BASE = (window.LC_API_BASE || 'https://prueba-k6t5.onrender.com').replace(/\/$/, '');

  // Rango por defecto la primera vez que alguien usa el navegador:
  // últimos 30 días. Después de eso, se respeta lo último que el usuario
  // haya elegido (persistido en localStorage).
  const DEFAULT_RANGE_DAYS = 30;
  const LS_INICIO = 'LC_SAP_RANGE_INICIO';
  const LS_FIN = 'LC_SAP_RANGE_FIN';

  // Tamaño de página al traer /facturacion hacia el navegador. El backend
  // acepta hasta 1000 por llamada.
  const FETCH_PAGE_SIZE = 1000;
  // Tope de seguridad de páginas a traer, para no quedarnos pegados si el
  // rango elegido es enorme.
  const FETCH_MAX_PAGES = 50;

  // Qué endpoint agregado (más liviano) corresponde a cada pantalla.
  // Si la pantalla actual no aparece aquí, se usa /facturacion completo
  // (datos crudos) como respaldo.
  const DASHBOARD_ENDPOINT_BY_PAGE = {
    'hoja-asesor.html': '/dashboards/hoja-asesor',
    'hoja-ruta-cliente.html': '/dashboards/hoja-cliente',
    'panorama-comercial.html': '/dashboards/labor-comercial',
    'panorama-portafolio.html': '/dashboards/portafolio-cartera',
    'planeacion-nogales.html': '/dashboards/planeacion-nogales'
  };

  function currentPageFile() {
    const path = window.location.pathname || '';
    const parts = path.split('/');
    return (parts[parts.length - 1] || '').toLowerCase() || 'index.html';
  }

  function toISODate(date) {
    return date.toISOString().slice(0, 10);
  }

  function defaultRange() {
    const hoy = new Date();
    const desde = new Date(hoy);
    desde.setDate(desde.getDate() - DEFAULT_RANGE_DAYS);
    return { inicio: toISODate(desde), fin: toISODate(hoy) };
  }

  function getStoredRange() {
    let inicio = null;
    let fin = null;
    try {
      inicio = localStorage.getItem(LS_INICIO);
      fin = localStorage.getItem(LS_FIN);
    } catch (_) {}
    if (!inicio || !fin) {
      return defaultRange();
    }
    return { inicio, fin };
  }

  function storeRange(inicio, fin) {
    try {
      localStorage.setItem(LS_INICIO, inicio);
      localStorage.setItem(LS_FIN, fin);
    } catch (_) {}
  }

  function getButton() {
    return document.getElementById('updateSapBtn');
  }

  function setButton(button, text, disabled) {
    if (!button) return;
    button.dataset.sapOriginalText ||= button.textContent.trim();
    button.textContent = text;
    button.disabled = !!disabled;
  }

  // ------------------------------------------------------------
  // Selector de rango de fechas (Desde / Hasta), insertado a la
  // izquierda del botón "Actualizar desde SAP".
  // ------------------------------------------------------------

  function buildRangePicker(button) {
    if (document.getElementById('sapRangeWrap')) {
      return document.getElementById('sapRangeWrap');
    }

    const range = getStoredRange();

    const wrap = document.createElement('span');
    wrap.id = 'sapRangeWrap';
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';
    wrap.style.marginRight = '8px';

    const mkInput = (id, value, title) => {
      const inp = document.createElement('input');
      inp.type = 'date';
      inp.id = id;
      inp.value = value;
      inp.title = title;
      inp.style.font = 'inherit';
      inp.style.padding = '8px 9px';
      inp.style.borderRadius = '8px';
      inp.style.border = '1px solid var(--line2, #d2d6db)';
      inp.style.background = 'var(--panel, #fff)';
      inp.style.color = 'var(--txt, #14161a)';
      return inp;
    };

    const desdeInput = mkInput('sapRangeInicio', range.inicio, 'Desde qué fecha consultar/sincronizar');
    const hastaInput = mkInput('sapRangeFin', range.fin, 'Hasta qué fecha consultar/sincronizar');

    const sep = document.createElement('span');
    sep.textContent = '→';
    sep.style.opacity = '0.6';
    sep.style.fontSize = '12px';

    wrap.appendChild(desdeInput);
    wrap.appendChild(sep);
    wrap.appendChild(hastaInput);

    button.parentNode.insertBefore(wrap, button);

    const persist = () => {
      let inicio = desdeInput.value || defaultRange().inicio;
      let fin = hastaInput.value || defaultRange().fin;
      if (inicio > fin) {
        // Si el usuario invierte las fechas, las corregimos solas.
        const tmp = inicio;
        inicio = fin;
        fin = tmp;
        desdeInput.value = inicio;
        hastaInput.value = fin;
      }
      storeRange(inicio, fin);
    };

    desdeInput.addEventListener('change', persist);
    hastaInput.addEventListener('change', persist);

    return wrap;
  }

  function getSelectedRange() {
    const desdeInput = document.getElementById('sapRangeInicio');
    const hastaInput = document.getElementById('sapRangeFin');
    if (desdeInput && hastaInput && desdeInput.value && hastaInput.value) {
      let inicio = desdeInput.value;
      let fin = hastaInput.value;
      if (inicio > fin) {
        const tmp = inicio;
        inicio = fin;
        fin = tmp;
      }
      return { inicio, fin };
    }
    return getStoredRange();
  }

  // ------------------------------------------------------------
  // Llamadas al backend
  // ------------------------------------------------------------

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

  // Trae TODO el rango elegido paginando /facturacion (el backend limita
  // cada llamada a 1000 filas), en vez de quedarse solo con las primeras
  // 50 filas como pasaba antes. Se usa solo cuando la pantalla actual no
  // tiene un endpoint agregado propio (ver DASHBOARD_ENDPOINT_BY_PAGE).
  async function fetchFacturacionRango(inicio, fin) {
    const filas = [];
    let offset = 0;
    let total = Infinity;

    for (let pagina = 0; pagina < FETCH_MAX_PAGES && offset < total; pagina++) {
      const url = API_BASE +
        '/facturacion?inicio=' + encodeURIComponent(inicio) +
        '&fin=' + encodeURIComponent(fin) +
        '&limit=' + FETCH_PAGE_SIZE +
        '&offset=' + offset;

      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) break;

      const body = await response.json();
      const data = body.data || [];
      total = Number(body.total || data.length);

      filas.push(...data);
      offset += data.length;

      if (data.length < FETCH_PAGE_SIZE) break; // última página
    }

    return filas;
  }

  // Trae solo los datos YA AGREGADOS que necesita la pantalla actual
  // (mucho más liviano que traer todas las líneas de factura crudas).
  async function fetchDashboardPropio(endpoint, inicio, fin) {
    const url = API_BASE + endpoint +
      '?inicio=' + encodeURIComponent(inicio) +
      '&fin=' + encodeURIComponent(fin);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json();
    return body.data || [];
  }

  async function refreshDataCache(inicio, fin) {
    try {
      const page = currentPageFile();
      const endpointPropio = DASHBOARD_ENDPOINT_BY_PAGE[page];

      let filas;
      let esAgregado = false;

      if (endpointPropio) {
        filas = await fetchDashboardPropio(endpointPropio, inicio, fin);
        esAgregado = filas !== null;
      }
      if (!filas) {
        // Sin endpoint propio (o falló): se cae al detalle completo.
        filas = await fetchFacturacionRango(inicio, fin);
      }

      window.LC_SAP_DATA = filas;
      window.LC_SAP_DATA_IMPORTED = true;
      window.LC_SAP_DATA_ES_AGREGADO = esAgregado;
      window.LC_SAP_RANGE = { inicio, fin };
      try {
        localStorage.setItem('LC_SAP_DATA', JSON.stringify(filas));
        localStorage.setItem('LC_SAP_UPDATED_AT', new Date().toISOString());
      } catch (_) {}
      window.dispatchEvent(new CustomEvent('lc:sap-updated', { detail: filas }));
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

      setButton(button, 'SAP: cargando datos…', true);
      await refreshDataCache(inicio, fin);
      return status;
    }
    throw new Error('La sincronización está tardando más de lo esperado. Revisa /sync-status en Render.');
  }

  async function updateFromSap() {
    const button = getButton();
    if (!button || button.dataset.sapBusy === '1') return;

    const { inicio, fin } = getSelectedRange();
    storeRange(inicio, fin);

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
    buildRangePicker(button);
    button.addEventListener('click', updateFromSap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
