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

export default router;
