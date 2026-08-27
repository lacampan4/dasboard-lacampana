/**
 * La Campana - Fuente de datos desde Google Sheets publicado como CSV.
 * Cada dashboard carga este helper. No requiere seleccionar ni configurar
 * una fuente externa en cada página.
 */
(function () {
  'use strict';

  const PAGE_KEY = 'campana_data_' + ((location.pathname.split('/').pop() || 'index.html').toLowerCase());
  const DRIVE_URL_KEY = 'campana_drive_url';
  const PUBLISHED_SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTFCaasciuEdspmmdvGFIX5gZWUOdX9UiqbZC07CyyQhxoH8IV1yGZBMXCiVRNG7geTTYP1yWqDndI6/pub?output=csv';
  const XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const old = document.querySelector('script[data-campana-xlsx]');
      if (old) {
        old.addEventListener('load', resolve, { once: true });
        old.addEventListener('error', reject, { once: true });
        return;
      }
      const s = document.createElement('script');
      s.src = XLSX_CDN;
      s.dataset.campanaXlsx = '1';
      s.onload = resolve;
      s.onerror = () => reject(new Error('No se pudo cargar el lector de Excel.'));
      document.head.appendChild(s);
    });
  }

  function saveData(rows, source) {
    const payload = {
      source,
      updatedAt: new Date().toISOString(),
      rows: Array.isArray(rows) ? rows : []
    };
    localStorage.setItem(PAGE_KEY, JSON.stringify(payload));
    window.CAMPANA_DATA = payload;
    document.dispatchEvent(new CustomEvent('campana:data-loaded', { detail: payload }));
    return payload;
  }

  function setStatus(msg, type) {
    const el = document.getElementById('campana-source-status');
    if (!el) return;
    el.textContent = msg;
    el.dataset.type = type || '';
  }

  function rowsFromWorkbook(workbook) {
    const allRows = [];
    workbook.SheetNames.forEach(name => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
        defval: '',
        raw: false
      });
      rows.forEach(row => {
        row.__hoja = name;
        allRows.push(row);
      });
    });
    return allRows;
  }

  async function readExcelFile(file, sourceLabel) {
    if (!file) return;
    setStatus('Leyendo Excel…', 'loading');
    try {
      await loadSheetJS();
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
      const allRows = rowsFromWorkbook(workbook);
      saveData(allRows, sourceLabel || file.name);
      setStatus(`✓ ${allRows.length.toLocaleString('es-CO')} registros cargados`, 'success');
      alert(`Excel cargado correctamente.\n\nRegistros: ${allRows.length}\nHojas: ${workbook.SheetNames.join(', ')}`);
    } catch (error) {
      console.error('[La Campana] Error leyendo Excel:', error);
      setStatus('Error al cargar el Excel.', 'error');
      alert('No se pudo cargar el Excel.\n\n' + error.message);
    }
  }

  async function readDriveFile() {
    const url = PUBLISHED_SHEET_URL;
    localStorage.setItem(DRIVE_URL_KEY, url);
    setStatus('Actualizando desde Google Drive…', 'loading');

    try {
      await loadSheetJS();

      const response = await fetch('/api/drive/download?url=' + encodeURIComponent(url) + '&format=csv', {
        cache: 'no-store'
      });
      if (!response.ok) {
        throw new Error('El servidor respondió HTTP ' + response.status);
      }

      const csv = await response.text();
      if (!csv.trim()) throw new Error('La hoja publicada no contiene datos.');

      const workbook = XLSX.read(csv, { type: 'string', cellDates: true });
      const allRows = rowsFromWorkbook(workbook);

      saveData(allRows, 'Google Sheets / Drive');
      setStatus(`✓ ${allRows.length.toLocaleString('es-CO')} registros actualizados`, 'success');

      alert(`Datos actualizados desde Google Drive.\n\nRegistros: ${allRows.length}\nFuente: Hoja publicada de Google Sheets`);

      if (typeof window.actualizarDashboardDesdeDatos === 'function') {
        window.actualizarDashboardDesdeDatos(allRows);
      }
    } catch (error) {
      console.error('[La Campana] Error actualizando desde Drive:', error);
      setStatus('Error al actualizar desde Drive.', 'error');
      alert('No se pudo actualizar desde Google Drive.\n\n' + error.message);
    }
  }

  function createUI() {
    let tools = document.querySelector('.htools');
    if (document.getElementById('campana-source-tools')) return;

    // Algunos dashboards no traen una barra .htools. En esos casos creamos
    // una barra propia dentro del primer header o al inicio del body.
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'campana-fallback-tools';
      const header = document.querySelector('header');
      if (header) header.insertBefore(tools, header.firstChild);
      else document.body.insertBefore(tools, document.body.firstChild);
    }

    const wrap = document.createElement('span');
    wrap.id = 'campana-source-tools';
    wrap.className = 'campana-source-tools';

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls,.csv';
    input.id = 'campanaExcelInput';
    input.hidden = true;

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'btn ghost';
    loadBtn.id = 'campanaExcelBtn';
    loadBtn.title = 'Cargar un archivo Excel desde el computador';
    loadBtn.innerHTML = '📊 Cargar Excel';

    const driveBtn = document.createElement('button');
    driveBtn.type = 'button';
    driveBtn.className = 'btn';
    driveBtn.id = 'campanaDriveBtn';
    driveBtn.title = 'Actualizar los datos desde la hoja publicada de Google Drive';
    driveBtn.innerHTML = '↻ Actualizar desde Drive';

    const status = document.createElement('span');
    status.id = 'campana-source-status';
    status.setAttribute('aria-live', 'polite');

    loadBtn.addEventListener('click', () => input.click());
    input.addEventListener('change', e => readExcelFile(e.target.files[0], 'Excel local'));
    driveBtn.addEventListener('click', readDriveFile);

    wrap.append(input, loadBtn, driveBtn, status);
    tools.prepend(wrap);

    const style = document.createElement('style');
    style.textContent = `
      .campana-fallback-tools{display:flex;justify-content:flex-end;margin:0 0 12px}
      .campana-source-tools{display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap}
      #campana-source-status{font-size:11px;opacity:.8;white-space:nowrap}
      #campana-source-status[data-type="loading"]{opacity:.65}
      #campana-source-status[data-type="success"]{font-weight:600}
      #campana-source-status[data-type="error"]{font-weight:600}
      @media(max-width:900px){.campana-fallback-tools{justify-content:stretch}.campana-source-tools{width:100%}#campana-source-status{width:100%}}
    `;
    document.head.appendChild(style);
  }

  document.addEventListener('DOMContentLoaded', () => {
    createUI();
    try {
      const saved = JSON.parse(localStorage.getItem(PAGE_KEY) || 'null');
      if (saved && Array.isArray(saved.rows)) {
        window.CAMPANA_DATA = saved;
        setStatus(`✓ Datos guardados: ${saved.rows.length.toLocaleString('es-CO')} registros`, 'success');
        document.dispatchEvent(new CustomEvent('campana:data-loaded', { detail: saved }));
      }
    } catch (_) {}
  });

  window.CampanaData = {
    loadExcel: readExcelFile,
    updateFromDrive: readDriveFile,
    get: () => window.CAMPANA_DATA || null,
    getDriveUrl: () => PUBLISHED_SHEET_URL
  };
})();
