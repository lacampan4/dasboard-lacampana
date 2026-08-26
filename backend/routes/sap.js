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

// Host que funciona correctamente desde Postman
const SAP_HOST = 'NDB.n00.CAMPANADB02:4300';

// El certificado de SAP se presenta por IP.
// La conexión sigue siendo HTTPS, pero no validamos la CA.
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

    timeout: 120000,

    headers: {
      Accept: 'application/json',
      'User-Agent': 'PostmanRuntime/7.43.0',
      Host: SAP_HOST,
      Connection: 'keep-alive'
    },

    validateStatus: () => true
  };
}

// ============================================================
// VALIDAR FECHAS
// ============================================================

function validateDates(inicio, fin) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(inicio || '') &&
    /^\d{4}-\d{2}-\d{2}$/.test(fin || '')
  );
}

// ============================================================
// URL SAP
// ============================================================

function facturacionUrl(inicio, fin) {
  const filtro =
    `Fecha_Factura ge datetime'${inicio}' and Fecha_Factura le datetime'${fin}'`;

  return (
    `${SAP_SERVICE_URL}/facturacion.xsodata/Facturacion` +
    `?$filter=${encodeURIComponent(filtro)}` +
    `&$format=json`
  );
}

// ============================================================
// EXTRAER DATOS ODATA
// ============================================================

function extractRows(data) {
  return data?.d?.results || data?.value || [];
}

// ============================================================
// FECHA SAP
//
// SAP devuelve:
// /Date(1786406400000)/
// ============================================================

function parseSapDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  const match = String(value).match(/\/Date\((\d+)\)\//);

  if (match) {
    const date = new Date(Number(match[1]));

    return Number.isNaN(date.getTime())
      ? null
      : date;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

// ============================================================
// NÚMEROS
// ============================================================

function numberOrNull(value) {
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

// ============================================================
// ENTEROS
// ============================================================

function integerOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? Math.trunc(number)
    : null;
}

// ============================================================
// MAPEAR SAP → NEON
// ============================================================

function mapFacturacion(row) {
  return {
    sap_id: row.ID
      ? String(row.ID)
      : null,

    cliente: row.Cliente ?? null,

    nit: row.Nit ?? null,

    ciudad: row.Ciudad ?? null,

    departamento: row.Departamento ?? null,

    ciiu: row.CIIU ?? null,

    numero_factura:
      integerOrNull(row.Numero_Factura),

    fecha_factura:
      parseSapDate(row.Fecha_Factura),

    plazo:
      row.Plazo ?? null,

    cupo_credito:
      numberOrNull(row.Cupo_Credito),

    cupo_usado:
      numberOrNull(row.Cupo_Usado),

    asesor:
      row.Asesor ?? null,

    meta_anual_asesor:
      numberOrNull(row.Meta_Anual_Asesor),

    sede:
      row.Sede ?? null,

    meta_anual_sede:
      numberOrNull(row.Meta_Anual_Sede),

    nombre_almacen:
      row.Nombre_Almacen ?? null,

    codigo_articulo:
      row.Codigo_Articulo ?? null,

    articulo:
      row.Articulo ?? null,

    grupo:
      row.Grupo ?? null,

    meta_anual_grupo:
      numberOrNull(row.Meta_Anual_Grupo),

    factura_paga_total:
      row.Factura_Paga_Total ?? null,

    valor_pagado:
      numberOrNull(row.Valor_Pagado),

    valor_total_articulo:
      numberOrNull(row.Valor_Total_Articulo),

    dias_mora:
      integerOrNull(row.Dias_Mora),

    kilos:
      numberOrNull(row.Kilos),

    valor_kilo:
      numberOrNull(row.Valor_Kilo),

    costo_kilo:
      numberOrNull(row.Costo_Kilo),

    peso_unitario:
      numberOrNull(row.Peso_Unitario)
  };
}

// ============================================================
// ERROR SAP
// ============================================================

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
// UPSERT POR LOTES
// ============================================================
//
// En lugar de:
// 21.067 consultas
//
// hacemos aproximadamente:
// 43 lotes de 500 registros.
//
// ============================================================

async function upsertBatch(client, batch) {
  if (!batch.length) {
    return {
      insertados: 0,
      actualizados: 0
    };
  }

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
    'peso_unitario'
  ];

  const values = [];

  const rowsSql = batch.map((row, rowIndex) => {
    const placeholders = columns.map((_, columnIndex) => {
      const parameterNumber =
        rowIndex * columns.length +
        columnIndex +
        1;

      return `$${parameterNumber}`;
    });

    values.push(
      row.sap_id,
      row.cliente,
      row.nit,
      row.ciudad,
      row.departamento,
      row.ciiu,
      row.numero_factura,
      row.fecha_factura,
      row.plazo,
      row.cupo_credito,
      row.cupo_usado,
      row.asesor,
      row.meta_anual_asesor,
      row.sede,
      row.meta_anual_sede,
      row.nombre_almacen,
      row.codigo_articulo,
      row.articulo,
      row.grupo,
      row.meta_anual_grupo,
      row.factura_paga_total,
      row.valor_pagado,
      row.valor_total_articulo,
      row.dias_mora,
      row.kilos,
      row.valor_kilo,
      row.costo_kilo,
      row.peso_unitario
    );

    return `(${placeholders.join(', ')})`;
  });

  const sql = `
    INSERT INTO facturacion_sap (
      ${columns.join(', ')}
    )
    VALUES
      ${rowsSql.join(',\n')}

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
      fecha_sincronizacion = CURRENT_TIMESTAMP

    RETURNING
      (xmax = 0) AS inserted;
  `;

  const result =
    await client.query(
      sql,
      values
    );

  let insertados = 0;
  let actualizados = 0;

  for (const row of result.rows) {
    if (row.inserted) {
      insertados++;
    } else {
      actualizados++;
    }
  }

  return {
    insertados,
    actualizados
  };
}

// ============================================================
// CONFIG
// ============================================================

router.get('/sap/config', (_req, res) => {
  res.json({
    ok: true,

    modulo: 'Hoja de Ruta',

    servicioApi: 'facturacion.xsodata',

    entidadApi: 'Facturacion',

    sapServiceUrl:
      SAP_SERVICE_URL,

    endpointFacturacion:
      `${SAP_SERVICE_URL}/facturacion.xsodata/Facturacion`,

    usuarioConfigurado:
      Boolean(SAP_USER),

    passwordConfigurada:
      Boolean(SAP_PASS),

    neonConfigurado:
      Boolean(process.env.DATABASE_URL)
  });
});

// ============================================================
// TEST SAP
// ============================================================

router.get('/sap/test', async (req, res) => {
  const { inicio, fin } =
    req.query;

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

  const url =
    facturacionUrl(
      inicio,
      fin
    );

  try {

    console.log(
      `[SAP TEST] GET ${url}`
    );

    const response =
      await axios.get(
        url,
        sapConfig()
      );

    const rows =
      extractRows(
        response.data
      );

    console.log(
      `[SAP TEST] HTTP ${response.status} · ${rows.length} registros`
    );

    if (
      response.status < 200 ||
      response.status >= 300
    ) {
      return res.status(502).json({
        ok: false,

        conexionSAP: true,

        httpStatusSAP:
          response.status,

        error:
          `SAP respondió HTTP ${response.status}`,

        detalle:
          response.data,

        headersSAP:
          response.headers
      });
    }

    return res.json({
      ok: true,

      conexionSAP: true,

      modulo:
        'Hoja de Ruta',

      servicioApi:
        'facturacion.xsodata',

      entidadApi:
        'Facturacion',

      httpStatusSAP:
        response.status,

      registros:
        rows.length,

      columnas:
        rows[0]
          ? Object.keys(rows[0])
          : [],

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
// SINCRONIZAR SAP → NEON
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
          'Faltan las fechas o tienen formato incorrecto. Usa ?inicio=YYYY-MM-DD&fin=YYYY-MM-DD'
      });
    }

    if (!SAP_USER || !SAP_PASS) {
      return res.status(500).json({
        ok: false,

        error:
          'Faltan SAP_USER o SAP_PASS en Render.'
      });
    }

    if (!process.env.DATABASE_URL) {
      return res.status(500).json({
        ok: false,

        error:
          'Falta DATABASE_URL en Render.'
      });
    }

    const client =
      await pool.connect();

    try {

      console.log(
        '=================================================='
      );

      console.log(
        `[SAP → NEON] Iniciando sincronización ${inicio} → ${fin}`
      );

      // ------------------------------------------------------
      // CONSULTAR SAP
      // ------------------------------------------------------

      const url =
        facturacionUrl(
          inicio,
          fin
        );

      console.log(
        '[SAP → NEON] Consultando SAP...'
      );

      const response =
        await axios.get(
          url,
          sapConfig()
        );

      const rows =
        extractRows(
          response.data
        );

      console.log(
        `[SAP → NEON] SAP respondió HTTP ${response.status}`
      );

      console.log(
        `[SAP → NEON] Registros recibidos: ${rows.length}`
      );

      if (
        response.status < 200 ||
        response.status >= 300
      ) {
        return res.status(502).json({
          ok: false,

          conexionSAP: true,

          httpStatusSAP:
            response.status,

          error:
            `SAP respondió HTTP ${response.status}`,

          detalle:
            response.data
        });
      }

      // ------------------------------------------------------
      // MAPEAR
      // ------------------------------------------------------

      const mappedRows =
        rows
          .map(mapFacturacion)
          .filter(row => row.sap_id);

      const omitidos =
        rows.length -
        mappedRows.length;

      console.log(
        `[SAP → NEON] Registros válidos: ${mappedRows.length}`
      );

      console.log(
        `[SAP → NEON] Registros omitidos: ${omitidos}`
      );

      // ------------------------------------------------------
      // TRANSACCIÓN
      // ------------------------------------------------------

      await client.query(
        'BEGIN'
      );

      let insertados = 0;
      let actualizados = 0;

      const BATCH_SIZE = 500;

      const totalBatches =
        Math.ceil(
          mappedRows.length /
          BATCH_SIZE
        );

      console.log(
        `[SAP → NEON] Procesando ${totalBatches} lotes de máximo ${BATCH_SIZE} registros`
      );

      for (
        let i = 0;
        i < mappedRows.length;
        i += BATCH_SIZE
      ) {

        const batch =
          mappedRows.slice(
            i,
            i + BATCH_SIZE
          );

        const batchNumber =
          Math.floor(
            i / BATCH_SIZE
          ) + 1;

        console.log(
          `[SAP → NEON] Lote ${batchNumber}/${totalBatches} (${batch.length} registros)`
        );

        const result =
          await upsertBatch(
            client,
            batch
          );

        insertados +=
          result.insertados;

        actualizados +=
          result.actualizados;
      }

      // ------------------------------------------------------
      // COMMIT
      // ------------------------------------------------------

      await client.query(
        'COMMIT'
      );

      // ------------------------------------------------------
      // TOTAL NEON
      // ------------------------------------------------------

      const countResult =
        await client.query(
          `
          SELECT COUNT(*)::integer AS total
          FROM facturacion_sap
          `
        );

      const totalNeon =
        countResult.rows[0]?.total ||
        0;

      console.log(
        '--------------------------------------------------'
      );

      console.log(
        `[SAP → NEON] INSERTADOS: ${insertados}`
      );

      console.log(
        `[SAP → NEON] ACTUALIZADOS: ${actualizados}`
      );

      console.log(
        `[SAP → NEON] OMITIDOS: ${omitidos}`
      );

      console.log(
        `[SAP → NEON] TOTAL NEON: ${totalNeon}`
      );

      console.log(
        '=================================================='
      );

      return res.json({
        ok: true,

        mensaje:
          'Datos de SAP sincronizados correctamente con Neon.',

        conexionSAP: true,

        httpStatusSAP:
          response.status,

        inicio,

        fin,

        registrosSAP:
          rows.length,

        registrosValidos:
          mappedRows.length,

        insertados,

        actualizados,

        omitidos,

        totalNeon
      });

    } catch (error) {

      try {
        await client.query(
          'ROLLBACK'
        );
      } catch (_) {
        // Ignorar error de rollback
      }

      console.error(
        '[SAP → NEON] ERROR:',
        {
          code:
            error.code,

          message:
            error.message,

          detail:
            error.detail,

          hint:
            error.hint
        }
      );

      return res.status(500).json({
        ok: false,

        error:
          'No fue posible sincronizar SAP con Neon.',

        codigo:
          error.code ||
          'SAP_NEON_SYNC_ERROR',

        detalle:
          error.message,

        detail:
          error.detail || null,

        hint:
          error.hint || null
      });

    } finally {

      client.release();
    }
  }
);

// ============================================================
// CONTAR REGISTROS EN NEON
// ============================================================

router.get(
  '/sap/neon/count',
  async (_req, res) => {

    try {

      const result =
        await pool.query(
          `
          SELECT COUNT(*)::integer AS total
          FROM facturacion_sap
          `
        );

      return res.json({
        ok: true,

        baseDatos:
          'Neon',

        tabla:
          'facturacion_sap',

        total:
          result.rows[0].total
      });

    } catch (error) {

      console.error(
        '[NEON COUNT] ERROR:',
        error.message
      );

      return res.status(500).json({
        ok: false,

        error:
          'No se pudo consultar Neon.',

        detalle:
          error.message
      });
    }
  }
);

// ============================================================
// CONSULTAR FACTURACIÓN DESDE NEON
// ============================================================

router.get(
  '/sap/neon/facturacion',
  async (req, res) => {

    const { inicio, fin } =
      req.query;

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
          SELECT *
          FROM facturacion_sap
          WHERE fecha_factura >= $1::date
            AND fecha_factura < ($2::date + INTERVAL '1 day')
          ORDER BY fecha_factura ASC, id ASC
          `,
          [
            inicio,
            fin
          ]
        );

      return res.json({
        ok: true,

        fuente:
          'Neon',

        inicio,

        fin,

        registros:
          result.rows.length,

        data:
          result.rows
      });

    } catch (error) {

      console.error(
        '[NEON FACTURACION] ERROR:',
        error.message
      );

      return res.status(500).json({
        ok: false,

        error:
          'No se pudo consultar la facturación en Neon.',

        detalle:
          error.message
      });
    }
  }
);

export default router;
