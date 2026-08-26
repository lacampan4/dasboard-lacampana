import express from 'express';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';
import { pool } from '../db.js';

dotenv.config();

const router = express.Router();

// ============================================================
// CONFIGURACIÓN SAP
// ============================================================

const SAP_SERVICE_URL = (
  process.env.SAP_SERVICE_URL ||
  'https://170.239.154.46:4300/api_campana26'
).replace(/\/$/, '');

const SAP_USER = process.env.SAP_USER;
const SAP_PASS = process.env.SAP_PASS;

const sapHttpsAgent = new https.Agent({
  rejectUnauthorized: false
});

// ============================================================
// CONFIGURACIÓN AXIOS
// ============================================================

function sapConfig() {
  return {
    auth: {
      username: SAP_USER,
      password: SAP_PASS
    },
    httpsAgent: sapHttpsAgent,
    timeout: 60000,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'PostmanRuntime/7.43.0'
    },
    validateStatus: () => true
  };
}

// ============================================================
// REINTENTOS ANTE FALLOS TRANSITORIOS DE SAP (503, timeouts, etc.)
// ============================================================

const SAP_RETRY_INTENTOS = Number(process.env.SAP_RETRY_INTENTOS || 3);
const SAP_RETRY_ESPERA_MS = Number(process.env.SAP_RETRY_ESPERA_MS || 3000);

// Códigos HTTP que consideramos "temporales" y por lo tanto reintentables.
// 503 = servicio no disponible (xsengine caído/reiniciando)
// 502/504 = problemas de gateway/timeout intermedios
const SAP_STATUS_REINTENTABLES = new Set([502, 503, 504]);

// Códigos de error de red/axios que también vale la pena reintentar.
const SAP_CODIGOS_REINTENTABLES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED'
]);

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Llama a SAP con reintentos automáticos ante fallos transitorios.
 * - Si la respuesta HTTP viene en SAP_STATUS_REINTENTABLES, reintenta.
 * - Si axios lanza un error de red en SAP_CODIGOS_REINTENTABLES, reintenta.
 * - Usa backoff simple: espera SAP_RETRY_ESPERA_MS × intento antes de cada reintento.
 * - Al agotar los intentos, devuelve la última respuesta (o relanza el último error)
 *   para que el código que llama maneje el caso exactamente igual que antes.
 */
async function sapGetConReintentos(url, config, {
  intentos = SAP_RETRY_INTENTOS,
  esperaMs = SAP_RETRY_ESPERA_MS,
  etiqueta = 'SAP'
} = {}) {
  let ultimoError = null;
  let ultimaRespuesta = null;

  for (let intento = 1; intento <= intentos; intento++) {
    try {
      const response = await axios.get(url, config);

      const esReintentable =
        response.status >= 200 && response.status < 300
          ? false
          : SAP_STATUS_REINTENTABLES.has(response.status);

      if (!esReintentable || intento === intentos) {
        if (esReintentable && intento === intentos) {
          console.warn(
            `[${etiqueta}] HTTP ${response.status} tras ${intento} intento(s). Se agotaron los reintentos.`
          );
        }
        return response;
      }

      ultimaRespuesta = response;

      console.warn(
        `[${etiqueta}] HTTP ${response.status} (intento ${intento}/${intentos}). ` +
        `Reintentando en ${esperaMs * intento}ms…`
      );

      await esperar(esperaMs * intento);

    } catch (error) {
      ultimoError = error;

      const esReintentable = SAP_CODIGOS_REINTENTABLES.has(error.code);

      if (!esReintentable || intento === intentos) {
        throw error;
      }

      console.warn(
        `[${etiqueta}] Error de red ${error.code} (intento ${intento}/${intentos}). ` +
        `Reintentando en ${esperaMs * intento}ms…`
      );

      await esperar(esperaMs * intento);
    }
  }

  // No debería llegar aquí, pero por seguridad:
  if (ultimaRespuesta) return ultimaRespuesta;
  throw ultimoError;
}

// ============================================================
// UTILIDADES
// ============================================================

function validateDates(inicio, fin) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(inicio || '') &&
    /^\d{4}-\d{2}-\d{2}$/.test(fin || '')
  );
}

function facturacionUrl(inicio, fin, skip = null, top = null) {
  const filtro =
    `Fecha_Factura ge datetime'${inicio}' and ` +
    `Fecha_Factura le datetime'${fin}'`;

  let url =
    `${SAP_SERVICE_URL}/facturacion.xsodata/Facturacion` +
    `?$filter=${encodeURIComponent(filtro)}` +
    `&$format=json`;

  if (skip !== null) {
    url += `&$skip=${skip}`;
  }

  if (top !== null) {
    url += `&$top=${top}`;
  }

  return url;
}

function extractRows(data) {
  return data?.d?.results || data?.value || [];
}

function errorInfo(error, response) {
  const code = error?.code || null;
  const status =
    response?.status ||
    error?.response?.status ||
    null;

  if (code === 'ECONNREFUSED') {
    return 'SAP rechazó la conexión al servidor 170.239.154.46:4300.';
  }

  if (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT'
  ) {
    return 'La conexión con SAP agotó el tiempo de espera.';
  }

  if (code === 'ECONNRESET') {
    return 'SAP cerró la conexión antes de completar la respuesta.';
  }

  if (code === 'ENOTFOUND') {
    return 'No se pudo resolver el servidor SAP.';
  }

  if (status === 401) {
    return 'SAP rechazó las credenciales.';
  }

  if (status === 403) {
    return 'SAP rechazó el acceso (HTTP 403).';
  }

  if (status === 404) {
    return 'SAP no encontró el endpoint Facturacion.';
  }

  if (status >= 500) {
    return `SAP respondió con HTTP ${status}.`;
  }

  return (
    error?.message ||
    `Error desconocido${status ? ` (HTTP ${status})` : ''}.`
  );
}

// ============================================================
// CONVERSIÓN DE DATOS SAP → NEON
// ============================================================

function parseSapDate(value) {
  if (!value) return null;

  // Formato SAP OData:
  // /Date(1786406400000)/
  const match = String(value).match(/\/Date\((\d+)\)\//);

  if (match) {
    const timestamp = Number(match[1]);

    if (!Number.isNaN(timestamp)) {
      return new Date(timestamp);
    }
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function cleanNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function mapSapRow(row) {
  return {
    sap_id: row.ID != null ? String(row.ID) : null,

    cliente: row.Cliente ?? null,
    nit: row.Nit != null ? String(row.Nit) : null,
    ciudad: row.Ciudad ?? null,
    departamento: row.Departamento ?? null,
    ciiu: row.CIIU != null ? String(row.CIIU) : null,

    numero_factura: cleanNumber(row.Numero_Factura),
    fecha_factura: parseSapDate(row.Fecha_Factura),

    plazo: row.Plazo ?? null,

    cupo_credito: cleanNumber(row.Cupo_Credito),
    cupo_usado: cleanNumber(row.Cupo_Usado),

    asesor: row.Asesor ?? null,
    meta_anual_asesor: cleanNumber(row.Meta_Anual_Asesor),

    sede: row.Sede ?? null,
    meta_anual_sede: cleanNumber(row.Meta_Anual_Sede),

    nombre_almacen: row.Nombre_Almacen ?? null,

    codigo_articulo:
      row.Codigo_Articulo != null
        ? String(row.Codigo_Articulo)
        : null,

    articulo: row.Articulo ?? null,
    grupo: row.Grupo ?? null,

    meta_anual_grupo:
      cleanNumber(row.Meta_Anual_Grupo),

    factura_paga_total:
      row.Factura_Paga_Total != null
        ? String(row.Factura_Paga_Total)
        : null,

    valor_pagado: cleanNumber(row.Valor_Pagado),

    valor_total_articulo:
      cleanNumber(row.Valor_Total_Articulo),

    dias_mora: cleanNumber(row.Dias_Mora),

    kilos: cleanNumber(row.Kilos),
    valor_kilo: cleanNumber(row.Valor_Kilo),
    costo_kilo: cleanNumber(row.Costo_Kilo),
    peso_unitario: cleanNumber(row.Peso_Unitario),

    fecha_sincronizacion: new Date()
  };
}

// ============================================================
// INSERTAR POR LOTES
// ============================================================

const INSERT_BATCH_SIZE = 250;

async function saveBatch(rows) {
  if (!rows.length) return;

  const columns = [
    'sap_id',
    'cliente',
    'nit',
    'ciudad',
    'departamento',
    'ciiu',
    'numero_factura',
    'fecha_factura',
    'plazo',
    'cupo_credito',
    'cupo_usado',
    'asesor',
    'meta_anual_asesor',
    'sede',
    'meta_anual_sede',
    'nombre_almacen',
    'codigo_articulo',
    'articulo',
    'grupo',
    'meta_anual_grupo',
    'factura_paga_total',
    'valor_pagado',
    'valor_total_articulo',
    'dias_mora',
    'kilos',
    'valor_kilo',
    'costo_kilo',
    'peso_unitario',
    'fecha_sincronizacion'
  ];

  const values = [];
  const placeholders = [];

  let parameterIndex = 1;

  for (const row of rows) {
    const rowPlaceholders = [];

    for (const column of columns) {
      rowPlaceholders.push(`$${parameterIndex++}`);
      values.push(row[column]);
    }

    placeholders.push(`(${rowPlaceholders.join(',')})`);
  }

  const query = `
    INSERT INTO facturacion_sap (
      ${columns.join(', ')}
    )
    VALUES
      ${placeholders.join(',')}
    ON CONFLICT (sap_id)
    DO UPDATE SET
      cliente = EXCLUDED.cliente,
      nit = EXCLUDED.nit,
      ciudad = EXCLUDED.ciudad,
      departamento = EXCLUDED.departamento,
      ciiu = EXCLUDED.ciiu,
      numero_factura = EXCLUDED.numero_factura,
      fecha_factura = EXCLUDED.fecha_factura,
      plazo = EXCLUDED.plazo,
      cupo_credito = EXCLUDED.cupo_credito,
      cupo_usado = EXCLUDED.cupo_usado,
      asesor = EXCLUDED.asesor,
      meta_anual_asesor = EXCLUDED.meta_anual_asesor,
      sede = EXCLUDED.sede,
      meta_anual_sede = EXCLUDED.meta_anual_sede,
      nombre_almacen = EXCLUDED.nombre_almacen,
      codigo_articulo = EXCLUDED.codigo_articulo,
      articulo = EXCLUDED.articulo,
      grupo = EXCLUDED.grupo,
      meta_anual_grupo = EXCLUDED.meta_anual_grupo,
      factura_paga_total = EXCLUDED.factura_paga_total,
      valor_pagado = EXCLUDED.valor_pagado,
      valor_total_articulo = EXCLUDED.valor_total_articulo,
      dias_mora = EXCLUDED.dias_mora,
      kilos = EXCLUDED.kilos,
      valor_kilo = EXCLUDED.valor_kilo,
      costo_kilo = EXCLUDED.costo_kilo,
      peso_unitario = EXCLUDED.peso_unitario,
      fecha_sincronizacion = EXCLUDED.fecha_sincronizacion
  `;

  await pool.query(query, values);
}

// ============================================================
// GET /api/sap/config
// ============================================================

router.get('/sap/config', (_req, res) => {
  res.json({
    ok: true,
    modulo: 'Hoja de Ruta',
    servicioApi: 'facturacion.xsodata',
    entidadApi: 'Facturacion',

    sapServiceUrl: SAP_SERVICE_URL,

    endpointFacturacion:
      `${SAP_SERVICE_URL}/facturacion.xsodata/Facturacion`,

    usuarioConfigurado: Boolean(SAP_USER),
    passwordConfigurada: Boolean(SAP_PASS),

    neonConfigurado: Boolean(
      process.env.DATABASE_URL
    )
  });
});

// ============================================================
// GET /api/sap/ping
//
// DIAGNÓSTICO MÍNIMO: no pide facturas ni filtra por fechas.
// Solo pregunta si el xsengine/servicio de SAP responde en absoluto.
//
// Sirve para separar dos escenarios:
//  - Si esto también da 503 → todo el motor xsengine está caído.
//    No es un problema de cuántos datos pedimos, no hay nada
//    que ajustar desde el dashboard. Hay que escalarlo con quien
//    administra el servidor SAP.
//  - Si esto responde bien pero /sap/test con fechas falla →
//    el problema es más específico (el servicio Facturacion,
//    el filtro, o el volumen de datos de esas fechas).
// ============================================================

router.get('/sap/ping', async (_req, res) => {
  if (!SAP_USER || !SAP_PASS) {
    return res.status(500).json({
      ok: false,
      error: 'Faltan SAP_USER o SAP_PASS en Render.'
    });
  }

  // Pedimos el documento de servicio raíz (sin entidad, sin filtro,
  // sin $format=json): es la petición más liviana posible al xsengine.
  const url = `${SAP_SERVICE_URL}/facturacion.xsodata/`;

  try {
    console.log(`[SAP PING] GET ${url}`);

    const response = await sapGetConReintentos(
      url,
      { ...sapConfig(), timeout: 15000 },
      { intentos: 1, etiqueta: 'SAP PING' }
    );

    return res.json({
      ok: response.status >= 200 && response.status < 300,
      httpStatusSAP: response.status,
      url,
      detalle:
        typeof response.data === 'string'
          ? response.data.slice(0, 500)
          : response.data,
      interpretacion:
        response.status >= 200 && response.status < 300
          ? 'El motor SAP responde. Si /sap/test con fechas falla, el problema es más específico del servicio Facturacion o del rango de fechas, no del motor en general.'
          : `El motor SAP respondió HTTP ${response.status} incluso a la petición más mínima posible (sin filtros, sin datos). Esto confirma que el problema es del lado del servidor SAP/xsengine en su totalidad — no hay ajuste posible desde este dashboard.`
    });

  } catch (error) {
    return res.status(502).json({
      ok: false,
      url,
      error: 'Render no pudo consultar SAP.',
      codigo: error.code || 'SAP_PING_ERROR',
      detalleTecnico: error.message,
      interpretacion:
        'No se pudo ni siquiera establecer la conexión con el motor SAP. Esto confirma que el problema es de infraestructura del lado de SAP (servidor, red o motor caído), no de este dashboard.'
    });
  }
});

// ============================================================
// GET /api/sap/test
// PRUEBA SAP SIN GUARDAR EN NEON
// ============================================================

router.get('/sap/test', async (req, res) => {
  const { inicio, fin } = req.query;

  if (!validateDates(inicio, fin)) {
    return res.status(400).json({
      ok: false,
      error:
        'Fechas inválidas. Usa ?inicio=YYYY-MM-DD&fin=YYYY-MM-DD'
    });
  }

  if (!SAP_USER || !SAP_PASS) {
    return res.status(500).json({
      ok: false,
      error:
        'Faltan SAP_USER o SAP_PASS en Render.'
    });
  }

  try {
    const url = facturacionUrl(
      inicio,
      fin,
      0,
      1
    );

    console.log(`[SAP TEST] GET ${url}`);

    const response =
      await sapGetConReintentos(
        url,
        sapConfig(),
        { etiqueta: 'SAP TEST' }
      );

    const rows =
      extractRows(response.data);

    console.log(
      `[SAP TEST] HTTP ${response.status}`
    );

    if (
      response.status < 200 ||
      response.status >= 300
    ) {
      return res.status(502).json({
        ok: false,
        conexionSAP: true,
        httpStatusSAP: response.status,
        error:
          `SAP respondió HTTP ${response.status}`,
        detalle: response.data
      });
    }

    return res.json({
      ok: true,
      conexionSAP: true,
      modulo: 'Hoja de Ruta',
      servicioApi: 'facturacion.xsodata',
      entidadApi: 'Facturacion',
      httpStatusSAP: response.status,
      registros_muestra: rows.length,
      primerRegistro:
        rows[0] || null,
      inicio,
      fin
    });

  } catch (error) {
    return res.status(502).json({
      ok: false,
      conexionSAP: false,
      error:
        'Render no pudo consultar SAP.',
      codigo:
        error.code ||
        'SAP_REQUEST_ERROR',
      causa:
        errorInfo(error),
      detalleTecnico:
        error.message
    });
  }
});

// ============================================================
// POST /api/sap/sync/hoja-ruta
//
// SAP → NEON
//
// IMPORTANTE:
// Se consulta SAP por páginas pequeñas.
// No se mantiene todo SAP en memoria.
// ============================================================

router.post(
  '/sap/sync/hoja-ruta',
  async (req, res) => {

    const { inicio, fin } =
      req.query;

    if (!validateDates(inicio, fin)) {
      return res.status(400).json({
        ok: false,
        error:
          'Fechas inválidas.'
      });
    }

    if (!SAP_USER || !SAP_PASS) {
      return res.status(500).json({
        ok: false,
        error:
          'Faltan SAP_USER o SAP_PASS en Render.'
      });
    }

    const SAP_PAGE_SIZE = 500;

    let skip = 0;
    let totalGuardados = 0;
    let paginas = 0;

    console.log(
      '=================================================='
    );

    console.log(
      `[SAP → NEON] Iniciando sincronización ${inicio} → ${fin}`
    );

    try {

      while (true) {

        const url =
          facturacionUrl(
            inicio,
            fin,
            skip,
            SAP_PAGE_SIZE
          );

        console.log(
          `[SAP → NEON] Consultando SAP. skip=${skip} top=${SAP_PAGE_SIZE}`
        );

        const response =
          await sapGetConReintentos(
            url,
            sapConfig(),
            { etiqueta: `SAP → NEON skip=${skip}` }
          );

        if (
          response.status < 200 ||
          response.status >= 300
        ) {
          return res.status(502).json({
            ok: false,
            error:
              `SAP respondió HTTP ${response.status}`,
            httpStatusSAP:
              response.status,
            detalle:
              response.data,
            guardados:
              totalGuardados
          });
        }

        const rows =
          extractRows(response.data);

        console.log(
          `[SAP → NEON] Recibidos: ${rows.length}`
        );

        if (!rows.length) {
          break;
        }

        // Convertimos solamente este lote.
        const mappedRows =
          rows
            .map(mapSapRow)
            .filter(row => row.sap_id);

        // Guardamos solamente este lote.
        for (
          let i = 0;
          i < mappedRows.length;
          i += INSERT_BATCH_SIZE
        ) {

          const batch =
            mappedRows.slice(
              i,
              i + INSERT_BATCH_SIZE
            );

          await saveBatch(batch);

          totalGuardados +=
            batch.length;

          console.log(
            `[SAP → NEON] Guardados: ${totalGuardados}`
          );
        }

        paginas++;

        // Liberamos referencias antes de continuar.
        skip += rows.length;

        // Si SAP devolvió menos que el máximo,
        // llegamos al final.
        if (
          rows.length < SAP_PAGE_SIZE
        ) {
          break;
        }
      }

      console.log(
        `[SAP → NEON] Sincronización terminada. Total procesado: ${totalGuardados}`
      );

      return res.json({
        ok: true,
        fuente: 'SAP → Neon',
        modulo: 'Hoja de Ruta',
        inicio,
        fin,
        registrosProcesados:
          totalGuardados,
        paginas,
        mensaje:
          'Sincronización completada correctamente.'
      });

    } catch (error) {

      console.error(
        '[SAP → NEON] ERROR:',
        {
          code: error.code,
          message: error.message
        }
      );

      return res.status(502).json({
        ok: false,
        error:
          'No fue posible sincronizar SAP con Neon.',
        codigo:
          error.code ||
          'SAP_SYNC_ERROR',
        causa:
          errorInfo(error),
        detalleTecnico:
          error.message,
        registrosProcesados:
          totalGuardados
      });
    }
  }
);

// ============================================================
// GET /api/sap/neon/count
// ============================================================

router.get(
  '/sap/neon/count',
  async (_req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT COUNT(*)::bigint AS total
          FROM facturacion_sap
        `);

      return res.json({
        ok: true,
        baseDatos: 'Neon',
        tabla: 'facturacion_sap',
        total:
          Number(result.rows[0].total)
      });

    } catch (error) {

      console.error(
        '[NEON COUNT] ERROR:',
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          'No fue posible consultar Neon.',
        detalle:
          error.message
      });
    }
  }
);

// ============================================================
// GET /api/sap/neon/facturacion
//
// CONSULTA PAGINADA
//
// Ejemplo:
//
// ?inicio=2026-08-01
// &fin=2026-08-25
// &page=1
// &limit=500
//
// ============================================================

router.get(
  '/sap/neon/facturacion',
  async (req, res) => {

    const {
      inicio,
      fin
    } = req.query;

    const page =
      Math.max(
        Number.parseInt(
          req.query.page || '1',
          10
        ),
        1
      );

    let limit =
      Number.parseInt(
        req.query.limit || '500',
        10
      );

    // Nunca permitir más de 500 registros
    // en una sola respuesta.
    limit =
      Math.min(
        Math.max(limit, 1),
        500
      );

    if (!validateDates(inicio, fin)) {
      return res.status(400).json({
        ok: false,
        error:
          'Usa ?inicio=YYYY-MM-DD&fin=YYYY-MM-DD'
      });
    }

    const offset =
      (page - 1) * limit;

    try {

      // ------------------------------------------------------
      // TOTAL
      // ------------------------------------------------------

      const countResult =
        await pool.query(
          `
          SELECT COUNT(*)::bigint AS total
          FROM facturacion_sap
          WHERE fecha_factura >= $1::date
            AND fecha_factura < ($2::date + INTERVAL '1 day')
          `,
          [inicio, fin]
        );

      const total =
        Number(
          countResult.rows[0].total
        );

      const totalPaginas =
        total === 0
          ? 0
          : Math.ceil(
              total / limit
            );

      // ------------------------------------------------------
      // DATOS DE ESTA PÁGINA
      // ------------------------------------------------------

      const dataResult =
        await pool.query(
          `
          SELECT
            id,
            sap_id,
            cliente,
            nit,
            ciudad,
            departamento,
            ciiu,
            numero_factura,
            fecha_factura,
            plazo,
            cupo_credito,
            cupo_usado,
            asesor,
            meta_anual_asesor,
            sede,
            meta_anual_sede,
            nombre_almacen,
            codigo_articulo,
            articulo,
            grupo,
            meta_anual_grupo,
            factura_paga_total,
            valor_pagado,
            valor_total_articulo,
            dias_mora,
            kilos,
            valor_kilo,
            costo_kilo,
            peso_unitario,
            fecha_sincronizacion
          FROM facturacion_sap
          WHERE fecha_factura >= $1::date
            AND fecha_factura < ($2::date + INTERVAL '1 day')
          ORDER BY fecha_factura ASC, id ASC
          LIMIT $3
          OFFSET $4
          `,
          [
            inicio,
            fin,
            limit,
            offset
          ]
        );

      return res.json({
        ok: true,
        fuente: 'Neon',
        inicio,
        fin,

        pagina: page,
        limite: limit,
        total,
        totalPaginas,

        siguientePagina:
          page < totalPaginas
            ? page + 1
            : null,

        anteriorPagina:
          page > 1
            ? page - 1
            : null,

        registros:
          dataResult.rows.length,

        data:
          dataResult.rows
      });

    } catch (error) {

      console.error(
        '[NEON FACTURACION] ERROR:',
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          'No fue posible consultar facturacion_sap.',
        detalle:
          error.message
      });
    }
  }
);

// ============================================================
// GET /api/sap/neon/facturacion/summary
//
// Resumen para dashboards.
// No devuelve todos los registros.
// ============================================================

router.get(
  '/sap/neon/facturacion/summary',
  async (req, res) => {

    const {
      inicio,
      fin
    } = req.query;

    if (!validateDates(inicio, fin)) {
      return res.status(400).json({
        ok: false,
        error:
          'Usa ?inicio=YYYY-MM-DD&fin=YYYY-MM-DD'
      });
    }

    try {

      const result =
        await pool.query(
          `
          SELECT
            COUNT(*)::bigint AS total_registros,

            COALESCE(
              SUM(valor_total_articulo),
              0
            ) AS valor_total,

            COALESCE(
              SUM(valor_pagado),
              0
            ) AS valor_pagado,

            COALESCE(
              SUM(kilos),
              0
            ) AS kilos,

            COALESCE(
              SUM(costo_kilo * kilos),
              0
            ) AS costo_total,

            COUNT(
              DISTINCT cliente
            )::bigint AS clientes,

            COUNT(
              DISTINCT asesor
            )::bigint AS asesores,

            COUNT(
              DISTINCT sede
            )::bigint AS sedes,

            COUNT(
              DISTINCT grupo
            )::bigint AS grupos

          FROM facturacion_sap

          WHERE fecha_factura >= $1::date
            AND fecha_factura < ($2::date + INTERVAL '1 day')
          `,
          [inicio, fin]
        );

      return res.json({
        ok: true,
        fuente: 'Neon',
        inicio,
        fin,
        resumen: result.rows[0]
      });

    } catch (error) {

      console.error(
        '[NEON SUMMARY] ERROR:',
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          'No fue posible generar el resumen.',
        detalle:
          error.message
      });
    }
  }
);

export default router;
