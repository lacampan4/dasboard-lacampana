import express from 'express';
import axios from 'axios';
import { pool } from '../db.js';

const router = express.Router();

// Credenciales desde las Variables de Entorno en Render.
// Mientras no las tengas configuradas, /api/sap/sync devolverá 500 con un
// mensaje claro, pero /api/produccion (lectura desde Neon) seguirá
// funcionando con lo que ya se haya sincronizado o cargado manualmente.
const SAP_SERVICE_URL = process.env.SAP_SERVICE_URL;
const SAP_USER = process.env.SAP_USER;
const SAP_PASS = process.env.SAP_PASS;

// -------------------------------------------------------------------------
// GET /api/produccion?inicio=YYYY-MM-DD&fin=YYYY-MM-DD
// Lee de la tabla caché en Neon (sap_produccion). Esto es lo que deben
// consumir los paneles del frontend: nunca golpean SAP directamente.
// -------------------------------------------------------------------------
router.get('/produccion', async (req, res) => {
    const { inicio, fin } = req.query;

    if (!inicio || !fin) {
        return res.status(400).json({ error: 'Faltan las fechas de inicio o fin' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT fecha, codigo_almacen, nombre_usuario, grupo, maquina,
                    codigo_articulo, articulo, cantidad_kg, comentarios
             FROM sap_produccion
             WHERE fecha BETWEEN $1 AND $2
             ORDER BY fecha`,
            [inicio, fin]
        );
        res.json(rows);
    } catch (error) {
        console.error('Error al leer produccion desde Neon:', error.message);
        res.status(500).json({ error: 'Error al consultar la producción almacenada' });
    }
});

// -------------------------------------------------------------------------
// POST /api/sap/sync/produccion?inicio=YYYY-MM-DD&fin=YYYY-MM-DD
// Trae el rango desde SAP (OData) y lo guarda en sap_produccion (Neon).
// Requiere SAP_SERVICE_URL / SAP_USER / SAP_PASS configuradas en Render.
// Este es el endpoint que vas a poder usar en cuanto tengas el acceso a SAP;
// hasta entonces simplemente responde 500 explicando qué falta.
// -------------------------------------------------------------------------
router.post('/sap/sync/produccion', async (req, res) => {
    const { inicio, fin } = req.query;

    if (!inicio || !fin) {
        return res.status(400).json({ error: 'Faltan las fechas de inicio o fin' });
    }

    if (!SAP_SERVICE_URL || !SAP_USER || !SAP_PASS) {
        return res.status(500).json({
            error: 'Variables de entorno de SAP no configuradas (SAP_SERVICE_URL, SAP_USER, SAP_PASS)'
        });
    }

    const client = await pool.connect();
    try {
        const urlOData = `${SAP_SERVICE_URL}?$filter=Fecha ge datetime'${inicio}T00:00:00' and Fecha le datetime'${fin}T23:59:59'&$format=json`;

        const respuestaSAP = await axios.get(urlOData, {
            auth: { username: SAP_USER, password: SAP_PASS },
            timeout: 10000
        });

        const registros = respuestaSAP.data?.d?.results || [];

        await client.query('BEGIN');
        // Evita duplicados si el mismo rango se sincroniza más de una vez.
        await client.query(
            `DELETE FROM sap_produccion WHERE fecha BETWEEN $1 AND $2`,
            [inicio, fin]
        );
        for (const r of registros) {
            await client.query(
                `INSERT INTO sap_produccion
                    (fecha, codigo_almacen, nombre_usuario, grupo, maquina,
                     codigo_articulo, articulo, cantidad_kg, comentarios)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [
                    r.Fecha, r.CodigoAlmacen, r.NombreUsuario, r.Grupo, r.Maquina,
                    r.CodigoArticulo, r.Articulo, r.CantidadKg || 0, r.Comentarios
                ]
            );
        }
        await client.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, registros_actualizados, estado)
             VALUES ('sap_produccion', NOW(), $1, 'ok')
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                registros_actualizados = EXCLUDED.registros_actualizados,
                estado = 'ok', detalle_error = NULL`,
            [registros.length]
        );
        await client.query('COMMIT');

        res.json({ ok: true, registros: registros.length });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al sincronizar con SAP:', error.message);
        await pool.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, estado, detalle_error)
             VALUES ('sap_produccion', NOW(), 'error', $1)
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                estado = 'error', detalle_error = EXCLUDED.detalle_error`,
            [error.message]
        ).catch(() => {});
        res.status(500).json({ error: 'Error al consultar la información de SAP' });
    } finally {
        client.release();
    }
});

// =========================================================================
// A partir de aquí: mismo patrón (GET desde Neon + POST sync desde SAP)
// para los demás módulos del menú. Los nombres de propiedad que se leen
// de `r.Campo` (ej. r.CodigoCliente) son SUPOSICIONES basadas en los
// exports de Excel que ya usan. Cuando tengas el acceso real a SAP, pide
// al equipo técnico el nombre EXACTO de cada campo en el servicio OData
// y ajusta solo esas líneas (el resto del flujo no cambia).
// =========================================================================

// -------------------------------------------------------------------------
// CLIENTES (usado por: Comercial, Portafolio, Asesor, Ruta Cliente)
// -------------------------------------------------------------------------
router.get('/clientes', async (_req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT codigo_cliente, nombre, nit, ciudad, departamento,
                    asesor, plazo_dias, cupo_credito, cupo_usado
             FROM sap_clientes
             ORDER BY nombre`
        );
        res.json(rows);
    } catch (error) {
        console.error('Error al leer clientes desde Neon:', error.message);
        res.status(500).json({ error: 'Error al consultar los clientes almacenados' });
    }
});

router.post('/sap/sync/clientes', async (_req, res) => {
    if (!SAP_SERVICE_URL || !SAP_USER || !SAP_PASS) {
        return res.status(500).json({
            error: 'Variables de entorno de SAP no configuradas (SAP_SERVICE_URL, SAP_USER, SAP_PASS)'
        });
    }

    const client = await pool.connect();
    try {
        // TODO: confirmar la URL exacta del servicio OData de clientes con SAP.
        const urlOData = `${SAP_SERVICE_URL}/Clientes?$format=json`;

        const respuestaSAP = await axios.get(urlOData, {
            auth: { username: SAP_USER, password: SAP_PASS },
            timeout: 15000
        });

        const registros = respuestaSAP.data?.d?.results || [];

        await client.query('BEGIN');
        for (const r of registros) {
            await client.query(
                `INSERT INTO sap_clientes
                    (codigo_cliente, nombre, nit, ciudad, departamento,
                     asesor, plazo_dias, cupo_credito, cupo_usado, sincronizado_en)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
                 ON CONFLICT (codigo_cliente) DO UPDATE SET
                    nombre = EXCLUDED.nombre,
                    nit = EXCLUDED.nit,
                    ciudad = EXCLUDED.ciudad,
                    departamento = EXCLUDED.departamento,
                    asesor = EXCLUDED.asesor,
                    plazo_dias = EXCLUDED.plazo_dias,
                    cupo_credito = EXCLUDED.cupo_credito,
                    cupo_usado = EXCLUDED.cupo_usado,
                    sincronizado_en = NOW()`,
                [
                    r.CodigoCliente, r.Nombre, r.Nit, r.Ciudad, r.Departamento,
                    r.Asesor, r.PlazoDias || null, r.CupoCredito || 0, r.CupoUsado || 0
                ]
            );
        }
        await client.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, registros_actualizados, estado)
             VALUES ('sap_clientes', NOW(), $1, 'ok')
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                registros_actualizados = EXCLUDED.registros_actualizados,
                estado = 'ok', detalle_error = NULL`,
            [registros.length]
        );
        await client.query('COMMIT');

        res.json({ ok: true, registros: registros.length });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al sincronizar clientes con SAP:', error.message);
        await pool.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, estado, detalle_error)
             VALUES ('sap_clientes', NOW(), 'error', $1)
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                estado = 'error', detalle_error = EXCLUDED.detalle_error`,
            [error.message]
        ).catch(() => {});
        res.status(500).json({ error: 'Error al consultar los clientes en SAP' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------------------
// VENTAS (usado por: Comercial, Portafolio, Asesor)
// -------------------------------------------------------------------------
router.get('/ventas', async (req, res) => {
    const { inicio, fin } = req.query;
    if (!inicio || !fin) {
        return res.status(400).json({ error: 'Faltan las fechas de inicio o fin' });
    }
    try {
        const { rows } = await pool.query(
            `SELECT codigo_cliente, codigo_articulo, descripcion, grupo,
                    periodo, kg, valor_kilo, costo_kilo, peso_unitario
             FROM sap_ventas
             WHERE periodo BETWEEN $1 AND $2
             ORDER BY periodo`,
            [inicio, fin]
        );
        res.json(rows);
    } catch (error) {
        console.error('Error al leer ventas desde Neon:', error.message);
        res.status(500).json({ error: 'Error al consultar las ventas almacenadas' });
    }
});

router.post('/sap/sync/ventas', async (req, res) => {
    const { inicio, fin } = req.query;
    if (!inicio || !fin) {
        return res.status(400).json({ error: 'Faltan las fechas de inicio o fin' });
    }
    if (!SAP_SERVICE_URL || !SAP_USER || !SAP_PASS) {
        return res.status(500).json({
            error: 'Variables de entorno de SAP no configuradas (SAP_SERVICE_URL, SAP_USER, SAP_PASS)'
        });
    }

    const client = await pool.connect();
    try {
        // TODO: confirmar URL y nombre de campos del servicio OData de ventas.
        const urlOData = `${SAP_SERVICE_URL}/Ventas?$filter=Periodo ge datetime'${inicio}T00:00:00' and Periodo le datetime'${fin}T23:59:59'&$format=json`;

        const respuestaSAP = await axios.get(urlOData, {
            auth: { username: SAP_USER, password: SAP_PASS },
            timeout: 15000
        });

        const registros = respuestaSAP.data?.d?.results || [];

        await client.query('BEGIN');
        await client.query(
            `DELETE FROM sap_ventas WHERE periodo BETWEEN $1 AND $2`,
            [inicio, fin]
        );
        for (const r of registros) {
            await client.query(
                `INSERT INTO sap_ventas
                    (codigo_cliente, codigo_articulo, descripcion, grupo,
                     periodo, kg, valor_kilo, costo_kilo, peso_unitario)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT (codigo_cliente, codigo_articulo, periodo) DO UPDATE SET
                    descripcion = EXCLUDED.descripcion,
                    grupo = EXCLUDED.grupo,
                    kg = EXCLUDED.kg,
                    valor_kilo = EXCLUDED.valor_kilo,
                    costo_kilo = EXCLUDED.costo_kilo,
                    peso_unitario = EXCLUDED.peso_unitario,
                    sincronizado_en = NOW()`,
                [
                    r.CodigoCliente, r.CodigoArticulo, r.Descripcion, r.Grupo,
                    r.Periodo, r.Kg || 0, r.ValorKilo, r.CostoKilo, r.PesoUnitario
                ]
            );
        }
        await client.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, registros_actualizados, estado)
             VALUES ('sap_ventas', NOW(), $1, 'ok')
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                registros_actualizados = EXCLUDED.registros_actualizados,
                estado = 'ok', detalle_error = NULL`,
            [registros.length]
        );
        await client.query('COMMIT');

        res.json({ ok: true, registros: registros.length });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al sincronizar ventas con SAP:', error.message);
        await pool.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, estado, detalle_error)
             VALUES ('sap_ventas', NOW(), 'error', $1)
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                estado = 'error', detalle_error = EXCLUDED.detalle_error`,
            [error.message]
        ).catch(() => {});
        res.status(500).json({ error: 'Error al consultar las ventas en SAP' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------------------
// CARTERA (usado por: Portafolio y Cartera)
// -------------------------------------------------------------------------
router.get('/cartera', async (_req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT codigo_cliente, factura, fecha_factura, dias_vencido, valor
             FROM sap_cartera
             ORDER BY dias_vencido DESC`
        );
        res.json(rows);
    } catch (error) {
        console.error('Error al leer cartera desde Neon:', error.message);
        res.status(500).json({ error: 'Error al consultar la cartera almacenada' });
    }
});

router.post('/sap/sync/cartera', async (_req, res) => {
    if (!SAP_SERVICE_URL || !SAP_USER || !SAP_PASS) {
        return res.status(500).json({
            error: 'Variables de entorno de SAP no configuradas (SAP_SERVICE_URL, SAP_USER, SAP_PASS)'
        });
    }

    const client = await pool.connect();
    try {
        // TODO: confirmar URL y campos del servicio OData de cartera (cuentas por cobrar).
        const urlOData = `${SAP_SERVICE_URL}/Cartera?$format=json`;

        const respuestaSAP = await axios.get(urlOData, {
            auth: { username: SAP_USER, password: SAP_PASS },
            timeout: 15000
        });

        const registros = respuestaSAP.data?.d?.results || [];

        await client.query('BEGIN');
        for (const r of registros) {
            await client.query(
                `INSERT INTO sap_cartera
                    (codigo_cliente, factura, fecha_factura, dias_vencido, valor, sincronizado_en)
                 VALUES ($1,$2,$3,$4,$5,NOW())
                 ON CONFLICT (codigo_cliente, factura) DO UPDATE SET
                    fecha_factura = EXCLUDED.fecha_factura,
                    dias_vencido = EXCLUDED.dias_vencido,
                    valor = EXCLUDED.valor,
                    sincronizado_en = NOW()`,
                [r.CodigoCliente, r.Factura, r.FechaFactura, r.DiasVencido || 0, r.Valor || 0]
            );
        }
        await client.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, registros_actualizados, estado)
             VALUES ('sap_cartera', NOW(), $1, 'ok')
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                registros_actualizados = EXCLUDED.registros_actualizados,
                estado = 'ok', detalle_error = NULL`,
            [registros.length]
        );
        await client.query('COMMIT');

        res.json({ ok: true, registros: registros.length });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al sincronizar cartera con SAP:', error.message);
        await pool.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, estado, detalle_error)
             VALUES ('sap_cartera', NOW(), 'error', $1)
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                estado = 'error', detalle_error = EXCLUDED.detalle_error`,
            [error.message]
        ).catch(() => {});
        res.status(500).json({ error: 'Error al consultar la cartera en SAP' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------------------
// INVENTARIO GENERAL (usado por: Portafolio y Cartera, Planeación Nogales)
// -------------------------------------------------------------------------
router.get('/inventario', async (_req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT codigo_articulo, descripcion, grupo, stock_kg
             FROM sap_inventario
             ORDER BY descripcion`
        );
        res.json(rows);
    } catch (error) {
        console.error('Error al leer inventario desde Neon:', error.message);
        res.status(500).json({ error: 'Error al consultar el inventario almacenado' });
    }
});

router.post('/sap/sync/inventario', async (_req, res) => {
    if (!SAP_SERVICE_URL || !SAP_USER || !SAP_PASS) {
        return res.status(500).json({
            error: 'Variables de entorno de SAP no configuradas (SAP_SERVICE_URL, SAP_USER, SAP_PASS)'
        });
    }

    const client = await pool.connect();
    try {
        // TODO: confirmar URL y campos del servicio OData de inventario/stock.
        const urlOData = `${SAP_SERVICE_URL}/Inventario?$format=json`;

        const respuestaSAP = await axios.get(urlOData, {
            auth: { username: SAP_USER, password: SAP_PASS },
            timeout: 15000
        });

        const registros = respuestaSAP.data?.d?.results || [];

        await client.query('BEGIN');
        for (const r of registros) {
            await client.query(
                `INSERT INTO sap_inventario
                    (codigo_articulo, descripcion, grupo, stock_kg, sincronizado_en)
                 VALUES ($1,$2,$3,$4,NOW())
                 ON CONFLICT (codigo_articulo) DO UPDATE SET
                    descripcion = EXCLUDED.descripcion,
                    grupo = EXCLUDED.grupo,
                    stock_kg = EXCLUDED.stock_kg,
                    sincronizado_en = NOW()`,
                [r.CodigoArticulo, r.Descripcion, r.Grupo, r.StockKg || 0]
            );
        }
        await client.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, registros_actualizados, estado)
             VALUES ('sap_inventario', NOW(), $1, 'ok')
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                registros_actualizados = EXCLUDED.registros_actualizados,
                estado = 'ok', detalle_error = NULL`,
            [registros.length]
        );
        await client.query('COMMIT');

        res.json({ ok: true, registros: registros.length });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al sincronizar inventario con SAP:', error.message);
        await pool.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, estado, detalle_error)
             VALUES ('sap_inventario', NOW(), 'error', $1)
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                estado = 'error', detalle_error = EXCLUDED.detalle_error`,
            [error.message]
        ).catch(() => {});
        res.status(500).json({ error: 'Error al consultar el inventario en SAP' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------------------
// INVENTARIO POR SEDE (usado por: Hoja de Sede)
// -------------------------------------------------------------------------
router.get('/inventario-sede', async (req, res) => {
    const { sede } = req.query;
    try {
        const { rows } = await pool.query(
            sede
                ? `SELECT sede, codigo_articulo, descripcion, stock_kg, stock_unidades
                   FROM sap_inventario_sede WHERE sede = $1 ORDER BY descripcion`
                : `SELECT sede, codigo_articulo, descripcion, stock_kg, stock_unidades
                   FROM sap_inventario_sede ORDER BY sede, descripcion`,
            sede ? [sede] : []
        );
        res.json(rows);
    } catch (error) {
        console.error('Error al leer inventario por sede desde Neon:', error.message);
        res.status(500).json({ error: 'Error al consultar el inventario por sede almacenado' });
    }
});

router.post('/sap/sync/inventario-sede', async (_req, res) => {
    if (!SAP_SERVICE_URL || !SAP_USER || !SAP_PASS) {
        return res.status(500).json({
            error: 'Variables de entorno de SAP no configuradas (SAP_SERVICE_URL, SAP_USER, SAP_PASS)'
        });
    }

    const client = await pool.connect();
    try {
        // TODO: confirmar URL y campos del servicio OData de stock por sede/almacén.
        const urlOData = `${SAP_SERVICE_URL}/InventarioSede?$format=json`;

        const respuestaSAP = await axios.get(urlOData, {
            auth: { username: SAP_USER, password: SAP_PASS },
            timeout: 15000
        });

        const registros = respuestaSAP.data?.d?.results || [];

        await client.query('BEGIN');
        for (const r of registros) {
            await client.query(
                `INSERT INTO sap_inventario_sede
                    (sede, codigo_articulo, descripcion, stock_kg, stock_unidades, sincronizado_en)
                 VALUES ($1,$2,$3,$4,$5,NOW())
                 ON CONFLICT (sede, codigo_articulo) DO UPDATE SET
                    descripcion = EXCLUDED.descripcion,
                    stock_kg = EXCLUDED.stock_kg,
                    stock_unidades = EXCLUDED.stock_unidades,
                    sincronizado_en = NOW()`,
                [r.Sede, r.CodigoArticulo, r.Descripcion, r.StockKg || 0, r.StockUnidades || 0]
            );
        }
        await client.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, registros_actualizados, estado)
             VALUES ('sap_inventario_sede', NOW(), $1, 'ok')
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                registros_actualizados = EXCLUDED.registros_actualizados,
                estado = 'ok', detalle_error = NULL`,
            [registros.length]
        );
        await client.query('COMMIT');

        res.json({ ok: true, registros: registros.length });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al sincronizar inventario por sede con SAP:', error.message);
        await pool.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, estado, detalle_error)
             VALUES ('sap_inventario_sede', NOW(), 'error', $1)
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                estado = 'error', detalle_error = EXCLUDED.detalle_error`,
            [error.message]
        ).catch(() => {});
        res.status(500).json({ error: 'Error al consultar el inventario por sede en SAP' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------------------
// DESPACHO — facturas del día (usado por: Hoja de Despacho)
// -------------------------------------------------------------------------
router.get('/despacho', async (req, res) => {
    const { fecha } = req.query;
    if (!fecha) {
        return res.status(400).json({ error: 'Falta la fecha' });
    }
    try {
        const { rows } = await pool.query(
            `SELECT factura, fecha, codigo_cliente, cliente, direccion, asesor,
                    correo, codigo_articulo, texto_breve, grupo, cantidad, kilos
             FROM sap_despacho_facturas
             WHERE fecha = $1
             ORDER BY factura`,
            [fecha]
        );
        res.json(rows);
    } catch (error) {
        console.error('Error al leer despacho desde Neon:', error.message);
        res.status(500).json({ error: 'Error al consultar el despacho almacenado' });
    }
});

router.post('/sap/sync/despacho', async (req, res) => {
    const { fecha } = req.query;
    if (!fecha) {
        return res.status(400).json({ error: 'Falta la fecha' });
    }
    if (!SAP_SERVICE_URL || !SAP_USER || !SAP_PASS) {
        return res.status(500).json({
            error: 'Variables de entorno de SAP no configuradas (SAP_SERVICE_URL, SAP_USER, SAP_PASS)'
        });
    }

    const client = await pool.connect();
    try {
        // TODO: confirmar URL y campos del servicio OData equivalente a VF05N.
        const urlOData = `${SAP_SERVICE_URL}/Despacho?$filter=Fecha eq datetime'${fecha}T00:00:00'&$format=json`;

        const respuestaSAP = await axios.get(urlOData, {
            auth: { username: SAP_USER, password: SAP_PASS },
            timeout: 15000
        });

        const registros = respuestaSAP.data?.d?.results || [];

        await client.query('BEGIN');
        await client.query(`DELETE FROM sap_despacho_facturas WHERE fecha = $1`, [fecha]);
        for (const r of registros) {
            await client.query(
                `INSERT INTO sap_despacho_facturas
                    (factura, fecha, codigo_cliente, cliente, direccion, asesor,
                     correo, codigo_articulo, texto_breve, grupo, cantidad, kilos)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [
                    r.Factura, r.Fecha, r.CodigoCliente, r.Cliente, r.Direccion, r.Asesor,
                    r.Correo, r.CodigoArticulo, r.TextoBreve, r.Grupo, r.Cantidad || 0, r.Kilos || 0
                ]
            );
        }
        await client.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, registros_actualizados, estado)
             VALUES ('sap_despacho_facturas', NOW(), $1, 'ok')
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                registros_actualizados = EXCLUDED.registros_actualizados,
                estado = 'ok', detalle_error = NULL`,
            [registros.length]
        );
        await client.query('COMMIT');

        res.json({ ok: true, registros: registros.length });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al sincronizar despacho con SAP:', error.message);
        await pool.query(
            `INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, estado, detalle_error)
             VALUES ('sap_despacho_facturas', NOW(), 'error', $1)
             ON CONFLICT (tabla) DO UPDATE SET
                ultima_sincronizacion = EXCLUDED.ultima_sincronizacion,
                estado = 'error', detalle_error = EXCLUDED.detalle_error`,
            [error.message]
        ).catch(() => {});
        res.status(500).json({ error: 'Error al consultar el despacho en SAP' });
    } finally {
        client.release();
    }
});

export default router;
