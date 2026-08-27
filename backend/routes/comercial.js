import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

/**
 * GET /api/comercial/clientes
 * Lista liviana para el buscador/autocompletar (nombre + nit + kg totales).
 */
router.get('/clientes', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.codigo_cliente, c.nombre, c.nit, c.ciudad, c.departamento,
             c.asesor, c.plazo_dias, c.cupo_credito, c.cupo_usado,
             COALESCE(SUM(v.kg), 0) AS kg_total
      FROM sap_clientes c
      LEFT JOIN sap_ventas v ON v.codigo_cliente = c.codigo_cliente
      GROUP BY c.codigo_cliente
      ORDER BY kg_total DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('[comercial/clientes]', e);
    res.status(500).json({ error: 'No se pudo consultar clientes' });
  }
});

/**
 * GET /api/comercial/cliente/:codigo
 * Detalle completo de un cliente: crédito, cartera y ventas mensuales por
 * artículo. Es el equivalente a lo que hoy arma window.LC_DATA.clients[x]
 * en el frontend, pero calculado desde Neon.
 * :codigo puede ser el NIT o el nombre en mayúsculas (según cómo se haya
 * importado, ver import-hoja-ruta.js).
 */
router.get('/cliente/:codigo', async (req, res) => {
  const { codigo } = req.params;
  try {
    const cliente = await pool.query(
      `SELECT * FROM sap_clientes WHERE codigo_cliente = $1`, [codigo]
    );
    if (!cliente.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });

    const ventas = await pool.query(
      `SELECT codigo_articulo, descripcion, grupo, periodo, kg, valor_kilo, costo_kilo, peso_unitario
       FROM sap_ventas WHERE codigo_cliente = $1 ORDER BY periodo`, [codigo]
    );
    const cartera = await pool.query(
      `SELECT factura, fecha_factura, dias_vencido, valor
       FROM sap_cartera WHERE codigo_cliente = $1 ORDER BY dias_vencido DESC`, [codigo]
    );

    res.json({ cliente: cliente.rows[0], ventas: ventas.rows, cartera: cartera.rows });
  } catch (e) {
    console.error('[comercial/cliente]', e);
    res.status(500).json({ error: 'No se pudo consultar el cliente' });
  }
});

/**
 * GET /api/comercial/inventario
 * Stock por artículo (y por sede si se cargó sap_inventario_sede).
 */
router.get('/inventario', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM sap_inventario`);
    res.json(rows);
  } catch (e) {
    console.error('[comercial/inventario]', e);
    res.status(500).json({ error: 'No se pudo consultar inventario' });
  }
});

/**
 * GET /api/comercial/meta
 * Última fecha de sincronización, para mostrar "datos actualizados hace X".
 */
router.get('/meta', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT MAX(sincronizado_en) AS ultima_actualizacion, COUNT(*)::int AS clientes
       FROM sap_clientes`
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[comercial/meta]', e);
    res.status(500).json({ error: 'No se pudo consultar el estado' });
  }
});

export default router;
