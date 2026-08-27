/**
 * La Campana · Fuente de datos
 *
 * - Botón visible: "Actualizar desde SAP" (el nombre se conserva por
 *   requerimiento del negocio, pero YA NO consulta SAP).
 * - Acción real: descarga el archivo público configurado en Google Drive /
 *   Google Sheets a través del backend de Render.
 * - Botón: "Cargar Excel" para seleccionar un archivo local.
 *
 * El procesamiento del Excel se delega al importador real que ya existe en
 * panorama-comercial.html / panorama-produccion.html. Así se conserva el
 * mismo esquema de datos que utilizan las gráficas y KPIs actuales.
 */
(function () {
  'use strict';

  const API_BASE = (window.CAMPANA_API_BASE || 'https://panorama-de-producci-n33.onrender.com/api').replace(/\/$/, '');
  const DRIVE_ENDPOINT = API_BASE + '/drive/data';
  const IS_PRODUCTION = /panorama-produccion(?:-diaria)?\.html$/i.test(location.pathname);
  const PARSER_PAGE = IS_PRODUCTION ? 'panorama-produccion.html' : 'panorama-comercial.html';

  let parserFrame = null;
  let busy = false;

  function setStatus(message, type) {
    const el = document.getElementById('campana-source-status');
    if (!el) return;
    el.textContent = message;
    el.dataset.type = type || '';
  }

  function createUI() {
    if (document.getElementById('campana-source-tools')) return;
    // Prefer the page's own action area. En Costos de Producción this is
    // exactly the row that already contains Editar mes / Nuevo mes / Restablecer.
    let tools = document.querySelector('.cbtns');
    let mode = 'controls';
    if (!tools) {
      tools = document.querySelector('.htools');
      mode = 'header';
    }
    if (!tools) {
      tools = document.querySelector('.controls');
      mode = 'controls';
    }
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'campana-fallback-tools';
      const header = document.querySelector('header');
      if (header) header.insertBefore(tools, header.firstChild);
      else document.body.insertBefore(tools, document.body.firstChild);
      mode = 'fallback';
    }

    const wrap = document.createElement('span');
    wrap.id = 'campana-source-tools';
    wrap.className = 'campana-source-tools ' + mode;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls,.csv';
    input.id = 'campanaExcelInput';
    input.hidden = true;

    const excelBtn = document.createElement('button');
    excelBtn.type = 'button';
    excelBtn.className = mode === 'controls' ? 'cbtn' : 'btn ghost';
    excelBtn.id = 'campanaExcelBtn';
    excelBtn.innerHTML = '📊 Cargar Excel';
    excelBtn.title = 'Cargar un archivo Excel desde este computador';

    const driveBtn = document.createElement('button');
    driveBtn.type = 'button';
    driveBtn.className = mode === 'controls' ? 'cbtn pri' : 'btn';
    driveBtn.id = 'campanaDriveBtn';
    driveBtn.innerHTML = '↻ Actualizar desde SAP';
    driveBtn.title = 'Actualizar los datos desde Google Drive; no consulta SAP';

    const status = document.createElement('span');
    status.id = 'campana-source-status';
    status.setAttribute('aria-live', 'polite');

    excelBtn.addEventListener('click', () => input.click());
    input.addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      await importFile(file, 'Excel local');
      input.value = '';
    });
    driveBtn.addEventListener('click', updateFromDrive);

    wrap.append(input, excelBtn, driveBtn, status);
    // Insert next to the existing action buttons. For .cbtns use display:contents
    // so the two new buttons are real siblings in the same row.
    tools.appendChild(wrap);

    const style = document.createElement('style');
    style.textContent = `
      .campana-fallback-tools{display:flex;justify-content:flex-end;margin:0 0 12px}
      .campana-source-tools{display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap}
      .campana-source-tools.controls{display:contents}
      .campana-source-tools.header{display:inline-flex}
      #campana-source-status{font-size:11px;opacity:.8;white-space:nowrap}
      #campana-source-status[data-type="loading"]{opacity:.65}
      #campana-source-status[data-type="success"]{font-weight:600}
      #campana-source-status[data-type="error"]{font-weight:600}
      #campana-source-tools button[disabled]{opacity:.55;cursor:wait}
      @media(max-width:900px){.campana-fallback-tools{justify-content:stretch}.campana-source-tools{width:100%}#campana-source-status{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function parserReady(frame) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('El importador de datos tardó demasiado en iniciar.')), 30000);
      const check = () => {
        try {
          const doc = frame.contentDocument;
          if (!doc) return setTimeout(check, 100);
          const fileInput = doc.getElementById('xlsInput');
          const excelBtn = doc.getElementById('excelBtn');
          if (fileInput && excelBtn) {
            clearTimeout(timeout);
            resolve({ doc, input: fileInput, excelBtn, own: false });
            return;
          }
        } catch (_) {}
        setTimeout(check, 100);
      };
      frame.addEventListener('load', check, { once: true });
      check();
    });
  }

  async function getParser() {
    const currentInput = document.getElementById('xlsInput');
    const currentBtn = document.getElementById('excelBtn');
    if (currentInput && currentBtn) return { doc: document, input: currentInput, excelBtn: currentBtn, own: true };

    if (parserFrame && parserFrame.isConnected) return parserReady(parserFrame);

    parserFrame = document.createElement('iframe');
    parserFrame.src = PARSER_PAGE;
    parserFrame.title = 'Importador de datos La Campana';
    parserFrame.setAttribute('aria-hidden', 'true');
    parserFrame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
    document.body.appendChild(parserFrame);
    return parserReady(parserFrame);
  }

  function feedFileToInput(input, file) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (error) {
      console.error('[La Campana] No se pudo entregar el archivo al importador:', error);
      return false;
    }
  }

  async function importFile(file, sourceLabel) {
    if (!file || busy) return;
    busy = true;
    const excelBtn = document.getElementById('campanaExcelBtn');
    const driveBtn = document.getElementById('campanaDriveBtn');
    if (excelBtn) excelBtn.disabled = true;
    if (driveBtn) driveBtn.disabled = true;

    try {
      setStatus(`Procesando ${sourceLabel}…`, 'loading');
      const parser = await getParser();
      if (!feedFileToInput(parser.input, file)) throw new Error('El navegador no permitió entregar el archivo al importador.');
      setStatus(`✓ ${sourceLabel} enviado al importador`, 'success');

      // El importador existente guarda en IndexedDB y recarga la página.
      setTimeout(() => {
        if (busy) {
          busy = false;
          if (excelBtn) excelBtn.disabled = false;
          if (driveBtn) driveBtn.disabled = false;
          setStatus('Procesamiento finalizado. Si el tablero no se actualizó, recarga la página.', 'success');
        }
      }, 20000);
    } catch (error) {
      console.error('[La Campana] Error importando:', error);
      setStatus('Error al cargar los datos.', 'error');
      alert('No se pudieron cargar los datos.\n\n' + error.message);
      busy = false;
      if (excelBtn) excelBtn.disabled = false;
      if (driveBtn) driveBtn.disabled = false;
    }
  }

  async function updateFromDrive() {
    if (busy) return;
    busy = true;
    const excelBtn = document.getElementById('campanaExcelBtn');
    const driveBtn = document.getElementById('campanaDriveBtn');
    if (excelBtn) excelBtn.disabled = true;
    if (driveBtn) driveBtn.disabled = true;

    try {
      setStatus('Descargando datos desde Drive…', 'loading');
      const response = await fetch(DRIVE_ENDPOINT, { cache: 'no-store' });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const json = await response.json();
          detail = json.detail || json.error || detail;
        } catch (_) {}
        throw new Error(detail);
      }
      const blob = await response.blob();
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const ext = /csv/i.test(contentType) ? 'csv' : 'xlsx';
      const file = new File([blob], `LaCampana_Drive.${ext}`, { type: contentType });
      setStatus('Archivo recibido. Actualizando el tablero…', 'loading');
      busy = false;
      await importFile(file, 'datos de Drive');
    } catch (error) {
      console.error('[La Campana] Error actualizando desde Drive:', error);
      setStatus('Error al actualizar desde Drive.', 'error');
      alert('No se pudo actualizar desde Google Drive.\n\n' + error.message);
      busy = false;
      if (excelBtn) excelBtn.disabled = false;
      if (driveBtn) driveBtn.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', createUI);
})();
