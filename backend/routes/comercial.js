import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

// Ciudades que la app agrupa como "zona Bogotá" (sedes cercanas, se resurten
// entre sí) — usado solo para el texto informativo de cobertura de inventario.
const REGION_BOGOTA = new Set(['BOGOTÁ', 'BOGOTA', 'SOACHA', 'MOSQUERA', 'CAJICÁ', 'CAJICA']);

function regionDe(ciudad) {
  if (!ciudad) return null;
  return REGION_BOGOTA.has(ciudad.trim().toUpperCase()) ? 'Bogotá' : ciudad.trim();
}

/**
 * GET /api/comercial/dataset
 * Devuelve el dataset completo en el shape que consumen las páginas
 * (window.LC_DATA): months, cats, catalog, clients{...}.
 * Es una carga pesada (todas las combinaciones cliente+articulo+mes), tal
 * como hoy lo hace el flujo de "Cargar Excel" -> IndexedDB, así que el
 * cálculo se hace en un solo viaje a la base de datos.
 */
router.get('/dataset', async (_req, res) => {
  try {
    const [clientesR, ventasR, carteraR] = await Promise.all([
      pool.query(`SELECT codigo_cliente, nombre, nit, ciudad, departamento, asesor,
                         plazo_dias, plazo_texto, cupo_credito, cupo_usado
                  FROM sap_clientes`),
      pool.query(`SELECT codigo_cliente, codigo_articulo, descripcion, grupo,
                         to_char(periodo,'YYYY-MM') AS periodo, kg
                  FROM sap_ventas
                  ORDER BY periodo ASC`),
      pool.query(`SELECT codigo_cliente, factura, dias_vencido, valor
                  FROM sap_cartera
                  WHERE valor > 0
                  ORDER BY dias_vencido DESC`)
    ]);

    if (!clientesR.rows.length) {
      return res.status(404).json({
        error: 'No hay datos comerciales cargados todavía. Corre el importador (npm run import:hoja-ruta) primero.'
      });
    }

    // meses ordenados presentes en las ventas
    const monthsSet = new Set(ventasR.rows.map(v => v.periodo));
    const months = [...monthsSet].sort();
    const monthIdx = new Map(months.map((m, i) => [m, i]));

    // catálogo articulo -> [nombre, indiceGrupo] + lista de grupos (cats)
    const catsSet = new Set();
    const catalog = {};
    for (const v of ventasR.rows) {
      if (v.grupo) catsSet.add(v.grupo);
    }
    const cats = [...catsSet].sort((a, b) => a.localeCompare(b, 'es'));
    const catIdx = new Map(cats.map((c, i) => [c, i]));
    for (const v of ventasR.rows) {
      if (!catalog[v.codigo_articulo]) {
        catalog[v.codigo_articulo] = [v.descripcion || v.codigo_articulo, v.grupo ? catIdx.get(v.grupo) : -1];
      }
    }

    // clientes base
    const clients = {};
    const codigoToNombre = new Map();
    for (const c of clientesR.rows) {
      codigoToNombre.set(c.codigo_cliente, c.nombre);
      clients[c.nombre] = {
        nit: c.nit || c.codigo_cliente,
        ciu: c.ciudad || '',
        dep: c.departamento || '',
        ase: c.asesor || 'Sin asignar',
        plazo: c.plazo_texto || (c.plazo_dias === 0 ? 'Contado' : (c.plazo_dias != null ? `${c.plazo_dias} Días` : 'Contado')),
        cc: Number(c.cupo_credito) || 0,
        cu: Number(c.cupo_usado) || 0,
        kg: 0,
        mora: [],
        a: [],
        reg: regionDe(c.ciudad)
      };
    }

    // ventas -> series por articulo (a: [[codigo, [kg...]]])
    const seriesTmp = new Map(); // nombreCliente -> Map(codigoArticulo -> array kg)
    for (const v of ventasR.rows) {
      const nombre = codigoToNombre.get(v.codigo_cliente);
      if (!nombre) continue;
      const cli = clients[nombre];
      let arts = seriesTmp.get(nombre);
      if (!arts) { arts = new Map(); seriesTmp.set(nombre, arts); }
      let serie = arts.get(v.codigo_articulo);
      if (!serie) { serie = new Array(months.length).fill(0); arts.set(v.codigo_articulo, serie); }
      const idx = monthIdx.get(v.periodo);
      const kg = Number(v.kg) || 0;
      serie[idx] += kg;
      cli.kg += kg;
    }
    for (const [nombre, arts] of seriesTmp) {
      clients[nombre].a = [...arts.entries()];
    }

    // cartera -> mora: [[factura, dias, valor]]
    for (const f of carteraR.rows) {
      const nombre = codigoToNombre.get(f.codigo_cliente);
      if (!nombre) continue;
      clients[nombre].mora.push([f.factura, f.dias_vencido, Number(f.valor) || 0]);
    }

    // metadatos usados por la cabecera de las páginas
    const totalClientes = clientesR.rows.length;
    const totalKg = Object.values(clients).reduce((s, c) => s + c.kg, 0) || 1;
    const ordered = Object.values(clients).sort((a, b) => b.kg - a.kg);
    const top80 = (() => {
      let cum = 0, n = 0;
      for (const c of ordered) { cum += c.kg; n++; if (cum / totalKg >= 0.8) break; }
      return n;
    })();

    const regionSedes = {}; // conteo de sedes por región de Bogotá (informativo)
    for (const c of clientesR.rows) {
      const r = regionDe(c.ciudad);
      if (r === 'Bogotá') regionSedes['Bogotá'] = (regionSedes['Bogotá'] || 0) + 1;
    }

    res.json({
      months,
      cats,
      catalog,
      clients,
      ntop: top80,
      pct: totalClientes ? Math.round((top80 / totalClientes) * 100) : 0,
      volshare: 80,
      regionSedes
    });
  } catch (err) {
    console.error('[comercial/dataset]', err);
    res.status(500).json({ error: 'Error consultando el dataset comercial.' });
  }
});

/**
 * GET /api/comercial/inventario
 * Shape LC_INV: { codigo_articulo: { k: stock_kg } }
 * Vacío hasta que se importe un archivo de inventario a sap_inventario
 * (la Hoja de Ruta comercial no trae stock, solo ventas y cartera).
 */
router.get('/inventario', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT codigo_articulo, stock_kg FROM sap_inventario`);
    const inv = {};
    for (const r of rows) inv[r.codigo_articulo] = { k: Number(r.stock_kg) || 0 };
    res.json(inv);
  } catch (err) {
    console.error('[comercial/inventario]', err);
    res.status(500).json({ error: 'Error consultando inventario.' });
  }
});

/**
 * GET /api/comercial/clientes
 * Lista liviana (para autocompletar, búsquedas) sin la serie mensual completa.
 */
router.get('/clientes', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.codigo_cliente, c.nombre, c.nit, c.ciudad, c.asesor,
             COALESCE(SUM(v.kg),0) AS kg
      FROM sap_clientes c
      LEFT JOIN sap_ventas v ON v.codigo_cliente = c.codigo_cliente
      GROUP BY c.codigo_cliente, c.nombre, c.nit, c.ciudad, c.asesor
      ORDER BY kg DESC
    `);
    res.json(rows.map(r => ({ codigo: r.codigo_cliente, nombre: r.nombre, nit: r.nit, ciudad: r.ciudad, asesor: r.asesor, kg: Number(r.kg) })));
  } catch (err) {
    console.error('[comercial/clientes]', err);
    res.status(500).json({ error: 'Error consultando clientes.' });
  }
});

/**
 * GET /api/comercial/cliente/:codigo
 * Detalle de un solo cliente (por NIT/codigo_cliente), mismo shape que
 * clients[nombre] en /dataset — útil si en el futuro se quiere cargar
 * un cliente a la vez en vez del dataset completo.
 */
router.get('/cliente/:codigo', async (req, res) => {
  const { codigo } = req.params;
  try {
    const [cliR, ventasR, carteraR] = await Promise.all([
      pool.query(`SELECT * FROM sap_clientes WHERE codigo_cliente=$1`, [codigo]),
      pool.query(`SELECT codigo_articulo, descripcion, grupo, to_char(periodo,'YYYY-MM') AS periodo, kg
                  FROM sap_ventas WHERE codigo_cliente=$1 ORDER BY periodo ASC`, [codigo]),
      pool.query(`SELECT factura, dias_vencido, valor FROM sap_cartera WHERE codigo_cliente=$1 AND valor > 0`, [codigo])
    ]);
    if (!cliR.rows.length) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const c = cliR.rows[0];

    const monthsSet = new Set(ventasR.rows.map(v => v.periodo));
    const months = [...monthsSet].sort();
    const monthIdx = new Map(months.map((m, i) => [m, i]));
    const arts = new Map();
    let kgTotal = 0;
    for (const v of ventasR.rows) {
      let serie = arts.get(v.codigo_articulo);
      if (!serie) { serie = new Array(months.length).fill(0); arts.set(v.codigo_articulo, serie); }
      const kg = Number(v.kg) || 0;
      serie[monthIdx.get(v.periodo)] += kg;
      kgTotal += kg;
    }

    res.json({
      nombre: c.nombre,
      nit: c.nit || c.codigo_cliente,
      ciu: c.ciudad || '',
      dep: c.departamento || '',
      ase: c.asesor || 'Sin asignar',
      plazo: c.plazo_texto || (c.plazo_dias === 0 ? 'Contado' : (c.plazo_dias != null ? `${c.plazo_dias} Días` : 'Contado')),
      cc: Number(c.cupo_credito) || 0,
      cu: Number(c.cupo_usado) || 0,
      kg: kgTotal,
      months,
      mora: carteraR.rows.map(f => [f.factura, f.dias_vencido, Number(f.valor) || 0]),
      a: [...arts.entries()]
    });
  } catch (err) {
    console.error('[comercial/cliente/:codigo]', err);
    res.status(500).json({ error: 'Error consultando el cliente.' });
  }
});

/**
 * GET /api/comercial/meta
 * Estado del último import (para mostrar "actualizado hace X" en el futuro).
 */
router.get('/meta', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tabla, ultima_sincronizacion, registros_actualizados, estado, detalle_error
       FROM sap_sync_log WHERE tabla='hoja_ruta_comercial'`
    );
    res.json(rows[0] || { tabla: 'hoja_ruta_comercial', ultima_sincronizacion: null, estado: 'sin_datos' });
  } catch (err) {
    console.error('[comercial/meta]', err);
    res.status(500).json({ error: 'Error consultando metadatos.' });
  }
});

export default router;
