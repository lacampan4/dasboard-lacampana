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

  // hoja-asesor.html, panorama-comercial.html y panorama-portafolio.html no
  // leen datos directamente de la API: leen un único objeto ya agregado
  // (window.LC_DATA) que guardan/leen de IndexedDB bajo la clave 'dataset'
  // (ver window.lcGet/lcSet, definidos en el script compartido de storage).
  // Antes ese 'dataset' solo lo llenaba la carga manual de Excel; el botón
  // "Actualizar desde SAP" traía los datos pero los dejaba en otra variable
  // (window.LC_SAP_DATA) que ninguna pantalla leía, así que nunca se veía
  // nada tras sincronizar. Ahora construimos aquí el mismo objeto que arma
  // el importador de Excel (mismos campos: clients, months, catalog, cats,
  // metaAse, metaSede, metaGrupo, aseKg, aseKgMons, hasRent, rentGrupoMon,
  // aseRev, aseCost) a partir de las filas crudas de /facturacion, y lo
  // guardamos en la misma clave 'dataset' para que esas 3 pantallas lo vean
  // sin más cambios.
  const PAGES_QUE_USAN_DATASET = new Set([
    'hoja-asesor.html',
    'panorama-comercial.html',
    'panorama-portafolio.html'
  ]);

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
    // El backend ya tenía este mismo rango sincronizado hace poco (ver
    // SYNC_CACHE_HORAS en backend/app.js): no relanzó la consulta a SAP.
    if (body.yaSincronizado) {
      return { alreadyRunning: false, yaSincronizado: true, body };
    }
    return { alreadyRunning: false, body };
  }

  // Trae TODO el rango elegido paginando /facturacion (el backend limita
  // cada llamada a 1000 filas). OJO: el endpoint espera fecha_inicio /
  // fecha_fin (no inicio/fin) — antes se mandaba mal y el rango elegido
  // por el usuario se ignoraba silenciosamente.
  async function fetchFacturacionRango(inicio, fin) {
    const filas = [];
    let offset = 0;
    let total = Infinity;

    for (let pagina = 0; pagina < FETCH_MAX_PAGES && offset < total; pagina++) {
      const url = API_BASE +
        '/facturacion?fecha_inicio=' + encodeURIComponent(inicio) +
        '&fecha_fin=' + encodeURIComponent(fin) +
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

  // ------------------------------------------------------------
  // Construcción del "dataset" agregado (mismo formato que arma el
  // importador de Excel en panorama-portafolio.html: función
  // rebuildRaw/handleFile → lcSet('dataset', {data, inv})). Lo replicamos
  // aquí a partir de las filas crudas de /facturacion, que ya vienen
  // tipadas (no hace falta adivinar encabezados de Excel).
  // ------------------------------------------------------------

  function ymDeFecha(v) {
    if (!v) return null;
    // fecha_factura llega como 'YYYY-MM-DD' o ISO ('YYYY-MM-DDTHH:mm:ss.sssZ').
    const s = String(v);
    return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null;
  }

  function sucOf(ase) {
    if (!ase) return '(Sin asignar)';
    const m = ase.match(/^\s*([^-]+?)\s*-\s*\S/);
    let s = null;
    if (m) s = m[1].trim();
    else if (ase.trim().startsWith('-')) return '(Sin asignar)';
    else s = '(Otros)';
    if (/^MOSTRADOR\s*P\b/i.test(s)) return 'PALOQUEMAO';
    return s;
  }

  function modoValores(cnt) {
    // Para cada clave, el valor más frecuente visto (robusto ante datos
    // erróneos en filas sueltas) — igual que hace el importador de Excel.
    const out = {};
    for (const k in cnt) {
      let best = 0, bestCount = -1;
      const mc = cnt[k];
      for (const v in mc) {
        if (mc[v] > bestCount) { bestCount = mc[v]; best = +v; }
      }
      out[k] = best;
    }
    return out;
  }

  function buildDatasetFromFacturacion(rows) {
    const cats = [];
    const catIdx = {};
    const gi = (name) => {
      name = (name || '').toString().trim() || '(s/g)';
      if (!(name in catIdx)) { catIdx[name] = cats.length; cats.push(name); }
      return catIdx[name];
    };

    const catalog = {};
    const CLI = {};
    const getCli = (name) => {
      name = (name || '').toString().trim();
      if (!name) return null;
      if (!CLI[name]) {
        CLI[name] = {
          nit: '', ciu: '', dep: '', ase: '', plazo: '',
          cc: 0, cu: 0, am: {}, regKg: {}, rev: 0, cost: 0, rgByG: {}
        };
      }
      return CLI[name];
    };

    const metaCnt = {}, metaSedeCnt = {}, metaGrupoCnt = {};
    const aseKgM = {}; // asesor -> ym -> kg (por factura, no por cartera asignada)
    const rentGM = {}; // grupo -> {rev:{ym}, cost:{ym}, kg:{ym}}
    const aseRevM = {}, aseCostM = {};
    const fact = {}; // numero_factura -> {cli, dias, total, pag, paga}

    const allYM = new Set();

    rows.forEach((r) => {
      const name = (r.cliente || '').toString().trim();
      if (!name) return;
      const c = getCli(name);

      if (!c.nit && r.nit) c.nit = String(r.nit).trim();
      if (!c.ciu && r.ciudad) c.ciu = String(r.ciudad).trim();
      if (!c.dep && r.departamento) c.dep = String(r.departamento).trim();
      if (!c.ase && r.asesor) c.ase = String(r.asesor).trim();
      if (!c.plazo && r.plazo) c.plazo = String(r.plazo).trim();

      const ase = (r.asesor || '').toString().trim() || c.ase;
      if (ase) {
        const mv = Number(r.meta_anual_asesor) || 0;
        if (mv > 0) { const mc = metaCnt[ase] || (metaCnt[ase] = {}); mc[mv] = (mc[mv] || 0) + 1; }
        const su = sucOf(ase);
        const mvs = Number(r.meta_anual_sede) || 0;
        if (mvs > 0) { const mc = metaSedeCnt[su] || (metaSedeCnt[su] = {}); mc[mvs] = (mc[mvs] || 0) + 1; }
      }
      const grpNombre = (r.grupo || '(s/g)').toString().trim() || '(s/g)';
      const mvg = Number(r.meta_anual_grupo) || 0;
      if (mvg > 0) { const mc = metaGrupoCnt[grpNombre] || (metaGrupoCnt[grpNombre] = {}); mc[mvg] = (mc[mvg] || 0) + 1; }

      const cc = Number(r.cupo_credito) || 0;
      if (cc > c.cc) c.cc = cc;
      const cu = Number(r.cupo_usado) || 0;
      if (cu > c.cu) c.cu = cu;

      const cod = (r.codigo_articulo || '').toString().trim();
      const ym = ymDeFecha(r.fecha_factura);
      if (cod && ym) {
        allYM.add(ym);
        const gidx = gi(grpNombre);
        if (!catalog[cod]) catalog[cod] = [(r.articulo || cod).toString().trim(), gidx];
        const pu = Number(r.peso_unitario) || 0;
        if (pu && catalog[cod][2] == null) catalog[cod][2] = pu;

        const kk = Number(r.kilos) || 0;
        const am = c.am[cod] || (c.am[cod] = {});
        am[ym] = (am[ym] || 0) + kk;

        const vk = Number(r.valor_kilo) || 0;
        const ck = Number(r.costo_kilo) || 0;
        if (vk || ck) {
          const rev = vk * kk, cost = ck * kk;
          c.rev += rev; c.cost += cost;
          const rgg = c.rgByG[gidx] || (c.rgByG[gidx] = { rev: 0, cost: 0 });
          rgg.rev += rev; rgg.cost += cost;
          const gm = rentGM[grpNombre] || (rentGM[grpNombre] = { rev: {}, cost: {}, kg: {} });
          gm.rev[ym] = (gm.rev[ym] || 0) + rev;
          gm.cost[ym] = (gm.cost[ym] || 0) + cost;
          gm.kg[ym] = (gm.kg[ym] || 0) + kk;
          if (ase) {
            (aseRevM[ase] || (aseRevM[ase] = {}))[ym] = (aseRevM[ase][ym] || 0) + rev;
            (aseCostM[ase] || (aseCostM[ase] = {}))[ym] = (aseCostM[ase][ym] || 0) + cost;
          }
        }

        if (ase) {
          const k = Number(r.kilos) || 0;
          if (k) (aseKgM[ase] || (aseKgM[ase] = {}))[ym] = (aseKgM[ase][ym] || 0) + k;
        }
      }

      const numF = (r.numero_factura || '').toString().trim();
      if (numF) {
        const f = fact[numF] || (fact[numF] = { cli: name, dias: 0, total: 0, pag: 0, paga: '' });
        f.dias = Math.max(f.dias, Number(r.dias_mora) || 0);
        f.total += Number(r.valor_total_articulo) || 0;
        f.pag = Math.max(f.pag, Number(r.valor_pagado) || 0);
        const p = (r.factura_paga_total || '').toString().trim().toUpperCase();
        if (p) f.paga = p;
      }
    });

    const MONTHS = [...allYM].sort();

    const clients = {};
    for (const name in CLI) {
      const c = CLI[name];
      const a = [];
      let kg = 0;
      for (const cod in c.am) {
        const s = MONTHS.map((ym) => Math.round(c.am[cod][ym] || 0));
        const t = s.reduce((x, y) => x + y, 0);
        if (t > 0) { a.push([cod, s]); kg += t; }
      }
      if (!a.length && c.cc <= 0) continue;
      clients[name] = {
        nit: c.nit, ciu: c.ciu, dep: c.dep, ase: c.ase, plazo: c.plazo,
        cc: c.cc, cu: c.cu, kg, a, mora: [],
        rev: Math.round(c.rev || 0), cost: Math.round(c.cost || 0),
        rg: Object.entries(c.rgByG || {}).map(([g, o]) => [+g, Math.round(o.rev), Math.round(o.cost)])
      };
    }

    for (const nf in fact) {
      const f = fact[nf];
      if (f.dias > 0 && f.paga !== 'SI') {
        const pend = Math.max(0, Math.round(f.total - f.pag));
        if (pend > 0 && clients[f.cli]) clients[f.cli].mora.push([nf, Math.round(f.dias), pend]);
      }
    }

    const metaAse = modoValores(metaCnt);
    const metaSede = modoValores(metaSedeCnt);
    const metaGrupo = modoValores(metaGrupoCnt);

    const aseKg = {}, aseKgMons = {};
    for (const a in aseKgM) {
      const ser = MONTHS.map((ym) => Math.round(aseKgM[a][ym] || 0));
      const t = ser.reduce((s, v) => s + v, 0);
      if (t > 0) { aseKg[a] = t; aseKgMons[a] = ser; }
    }

    const hasRent = Object.keys(rentGM).length > 0;
    const rentGrupoMon = {};
    for (const g in rentGM) {
      const gm = rentGM[g];
      rentGrupoMon[g] = {
        rev: MONTHS.map((ym) => Math.round(gm.rev[ym] || 0)),
        cost: MONTHS.map((ym) => Math.round(gm.cost[ym] || 0)),
        kg: MONTHS.map((ym) => Math.round(gm.kg[ym] || 0))
      };
    }
    const aseRev = {}, aseCost = {};
    for (const a in aseRevM) {
      let t = 0; MONTHS.forEach((ym) => t += aseRevM[a][ym] || 0);
      if (t) aseRev[a] = Math.round(t);
    }
    for (const a in aseCostM) {
      let t = 0; MONTHS.forEach((ym) => t += aseCostM[a][ym] || 0);
      if (t) aseCost[a] = Math.round(t);
    }

    const DATA = {
      months: MONTHS, cats, catalog, clients,
      ntop: Object.keys(clients).length, pct: 100, volshare: 100,
      metaAse, metaSede, metaGrupo, aseKg, aseKgMons,
      hasRent, rentGrupoMon, aseRev, aseCost
    };

    // No traemos stock/inventario desde SAP (la tabla facturacion no lo
    // tiene), así que INV queda vacío: las secciones que dependen de stock
    // simplemente no muestran datos, en vez de romper la página.
    return { DATA, INV: {} };
  }

  async function refreshDataCache(inicio, fin) {
    try {
      const page = currentPageFile();
      const filas = await fetchFacturacionRango(inicio, fin);

      window.LC_SAP_DATA = filas;
      window.LC_SAP_DATA_IMPORTED = true;
      window.LC_SAP_RANGE = { inicio, fin };

      if (PAGES_QUE_USAN_DATASET.has(page) && window.lcSet) {
        const { DATA, INV } = buildDatasetFromFacturacion(filas);
        await window.lcSet('dataset', { data: DATA, inv: INV });
      }

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

      if (started.yaSincronizado) {
        // Ya está en Postgres: no hay nada que esperar, solo traer los
        // datos guardados y refrescar la pantalla con ellos.
        setButton(button, 'SAP: cargando datos guardados…', true);
        await refreshDataCache(inicio, fin);
        setButton(button, '✓ Datos ya estaban al día', true);
        setTimeout(() => {
          window.location.reload();
        }, 900);
        return;
      }

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
