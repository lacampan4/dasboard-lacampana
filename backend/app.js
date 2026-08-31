require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const pool = require('./db');

const app = express();

const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURACIÓN SAP
// ============================================================

const DEFAULT_SAP_URL =
  'https://170.239.154.46:4300/api_campana26/facturacion.xsodata/Facturacion';

let SAP_BASE_URL =
  process.env.SAP_SERVICE_URL ||
  process.env.SAP_BASE_URL ||
  DEFAULT_SAP_URL;

// ------------------------------------------------------------
// Evitar URL mal formada por variables de Render.
// Si accidentalmente quedó algo como:
//
// https://IP:4300/https://IP:4300/api...
//
// se corrige automáticamente.
// ------------------------------------------------------------

function normalizarSAPUrl(url) {
  if (!url) {
    return DEFAULT_SAP_URL;
  }

  let resultado = String(url).trim();

  const segundaUrl = resultado.indexOf('https://', 8);

  if (segundaUrl !== -1) {
    resultado = resultado.substring(segundaUrl);
  }

  const terceraUrl = resultado.indexOf('http://', 8);

  if (terceraUrl !== -1) {
    resultado = resultado.substring(terceraUrl);
  }

  return resultado;
}

SAP_BASE_URL = normalizarSAPUrl(SAP_BASE_URL);

const SAP_HOST =
  process.env.SAP_SYSTEM_HOST ||
  'NDB.n00.CAMPANADB02';

const SAP_USER =
  process.env.SAP_USER || '';

const SAP_PASS =
  process.env.SAP_PASS || '';

const SAP_PAGE_SIZE =
  parseInt(
    process.env.SAP_PAGE_SIZE || '5000',
    10
  );

// 500 filas x 29 columnas = 14.500 parámetros por consulta, muy por
// debajo del límite de Postgres (65.535). Se puede subir más si hace
// falta (ver COLUMNAS_FACTURACION más abajo para el cálculo).
const DB_BATCH_SIZE =
  parseInt(
    process.env.DB_BATCH_SIZE || '500',
    10
  );

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  cors({
    origin:
      process.env.CORS_ORIGIN || '*'
  })
);

app.use(
  express.json({
    limit: '10mb'
  })
);

// ============================================================
// ESTADO GLOBAL DE SINCRONIZACIÓN
// ============================================================

const syncState = {
  ejecutando: false,

  estado: 'idle',

  inicio: null,
  fin: null,

  paginaActual: 0,
  skipActual: 0,

  paginasProcesadas: 0,

  registrosSAP: 0,
  registrosProcesados: 0,

  iniciadoEn: null,
  terminadoEn: null,

  error: null,

  ultimaActividad: null
};

// ============================================================
// INFORMACIÓN DE ARRANQUE
// ============================================================

console.log('===========================================');
console.log('BACKEND LA CAMPANA');
console.log('===========================================');
console.log('SAP:', SAP_BASE_URL);
console.log('SAP HOST:', SAP_HOST);
console.log('SAP PAGE SIZE:', SAP_PAGE_SIZE);
console.log('DB BATCH SIZE:', DB_BATCH_SIZE);
console.log(
  'SAP USER CONFIGURADO:',
  Boolean(SAP_USER)
);
console.log(
  'SAP PASSWORD CONFIGURADA:',
  Boolean(SAP_PASS)
);
console.log('===========================================');

// ============================================================
// UTILIDADES
// ============================================================

function parseSAPDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value);

  // SAP OData:
  // /Date(1787788800000)/
  const match = text.match(
    /\/Date\((\d+)(?:[+-]\d+)?\)\//
  );

  if (match) {
    const timestamp =
      Number(match[1]);

    if (!Number.isNaN(timestamp)) {
      return new Date(timestamp)
        .toISOString()
        .slice(0, 10);
    }
  }

  // YYYY-MM-DD
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(text)
  ) {
    return text;
  }

  // ISO
  if (
    /^\d{4}-\d{2}-\d{2}T/.test(text)
  ) {
    return text.slice(0, 10);
  }

  return null;
}

// ============================================================

function toNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

// ============================================================

function toInteger(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number =
    parseInt(value, 10);

  return Number.isFinite(number)
    ? number
    : null;
}

// ============================================================

function actualizarActividad() {
  syncState.ultimaActividad =
    new Date().toISOString();
}

// ============================================================

function validarFecha(fecha) {
  return /^\d{4}-\d{2}-\d{2}$/.test(
    fecha
  );
}

// Si ya se sincronizó exactamente este mismo rango de fechas antes, no se
// vuelve a consultar SAP — se listo lo que ya está guardado en Postgres.
// Esto es permanente por defecto (no caduca). Si en algún momento quieres
// que sí caduque después de cierto tiempo, se puede fijar la variable de
// entorno SYNC_CACHE_HORAS en Render (ej. 24) y ese rango se revalidará
// contra SAP pasado ese tiempo.
const SYNC_CACHE_HORAS =
  process.env.SYNC_CACHE_HORAS
    ? parseFloat(process.env.SYNC_CACHE_HORAS)
    : null;

async function buscarSyncPrevio(inicio, fin) {
  const condicionTiempo =
    SYNC_CACHE_HORAS
      ? "AND creado_en > NOW() - ($3 || ' hours')::INTERVAL"
      : '';

  const params = [inicio, fin];
  if (SYNC_CACHE_HORAS) {
    params.push(SYNC_CACHE_HORAS);
  }

  const result =
    await pool.query(
      `
      SELECT
        registros,
        creado_en
      FROM sync_log
      WHERE inicio = $1::DATE
        AND fin = $2::DATE
        -- Si esa sincronización trajo 0 registros, no cuenta como caché
        -- válida: puede haber sido un fallo pasajero de SAP, y si no
        -- reintentamos, ese rango queda mostrando ceros para siempre.
        AND registros > 0
        ${condicionTiempo}
      ORDER BY creado_en DESC
      LIMIT 1
      `,
      params
    );

  return result.rows[0] || null;
}

async function registrarSync(inicio, fin, registros) {
  await pool.query(
    `
    INSERT INTO sync_log (inicio, fin, registros)
    VALUES ($1::DATE, $2::DATE, $3)
    `,
    [inicio, fin, registros]
  );
}

// ============================================================
// BASE DE DATOS
// ============================================================

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS facturacion (

        id SERIAL PRIMARY KEY,

        sap_id VARCHAR(100) UNIQUE NOT NULL,

        cliente TEXT,
        nit VARCHAR(50),
        ciudad TEXT,
        departamento TEXT,
        ciiu TEXT,

        numero_factura VARCHAR(100),
        fecha_factura DATE,

        plazo TEXT,

        cupo_credito NUMERIC(18,2),
        cupo_usado NUMERIC(18,2),

        asesor TEXT,
        meta_anual_asesor NUMERIC(18,2),

        sede TEXT,
        meta_anual_sede NUMERIC(18,2),

        nombre_almacen TEXT,

        codigo_articulo TEXT,
        articulo TEXT,
        grupo TEXT,

        meta_anual_grupo NUMERIC(18,2),

        factura_paga_total TEXT,

        valor_pagado NUMERIC(18,2),
        valor_total_articulo NUMERIC(18,2),

        dias_mora INTEGER,

        kilos NUMERIC(18,4),
        valor_kilo NUMERIC(18,4),
        costo_kilo NUMERIC(18,10),
        peso_unitario NUMERIC(18,4),

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migración: quita raw_data si la tabla venía de una versión anterior.
    // Esa columna duplicaba cada fila completa en JSON y era la principal
    // causa de que el proyecto de Neon llegara al límite de tamaño (512 MB).
    await pool.query(`
      ALTER TABLE facturacion
      DROP COLUMN IF EXISTS raw_data;
    `);

    // Registro de sincronizaciones ya hechas, para no volver a consultar
    // SAP si ya se trajo ese mismo rango de fechas hace poco (ver
    // /sync-sap: SYNC_CACHE_HORAS).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id SERIAL PRIMARY KEY,
        inicio DATE NOT NULL,
        fin DATE NOT NULL,
        registros INTEGER NOT NULL DEFAULT 0,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sync_log_rango
      ON sync_log(inicio, fin, creado_en DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_facturacion_fecha
      ON facturacion(fecha_factura);

      CREATE INDEX IF NOT EXISTS idx_facturacion_asesor
      ON facturacion(asesor);

      CREATE INDEX IF NOT EXISTS idx_facturacion_cliente
      ON facturacion(cliente);

      CREATE INDEX IF NOT EXISTS idx_facturacion_sede
      ON facturacion(sede);

      CREATE INDEX IF NOT EXISTS idx_facturacion_grupo
      ON facturacion(grupo);

      CREATE INDEX IF NOT EXISTS idx_facturacion_numero_factura
      ON facturacion(numero_factura);

      CREATE INDEX IF NOT EXISTS idx_facturacion_nit
      ON facturacion(nit);
    `);

    console.log(
      '✓ Base de datos inicializada'
    );
  } catch (error) {
    console.error(
      'Error inicializando la base de datos:',
      error.message
    );

    throw error;
  }
}

// ============================================================
// RUTA PRINCIPAL
// ============================================================

app.get('/', (req, res) => {
  res.json({
    ok: true,

    servicio:
      'Backend La Campana',

    mensaje:
      'Servidor funcionando correctamente',

    rutas: {
      health:
        '/health',

      syncSAP:
        '/sync-sap?inicio=YYYY-MM-DD&fin=YYYY-MM-DD',

      syncStatus:
        '/sync-status',

      facturacion:
        '/facturacion',

      hojaAsesor:
        '/dashboards/hoja-asesor',

      hojaCliente:
        '/dashboards/hoja-cliente',

      laborComercial:
        '/dashboards/labor-comercial',

      portafolioCartera:
        '/dashboards/portafolio-cartera',

      planeacionNogales:
        '/dashboards/planeacion-nogales'
    }
  });
});

// ============================================================
// HEALTH
// ============================================================

app.get('/health', async (req, res) => {
  try {
    await pool.query(
      'SELECT 1'
    );

    res.json({
      ok: true,

      estado:
        'ok',

      baseDatos:
        'conectada',

      sincronizacion: {
        ejecutando:
          syncState.ejecutando,

        estado:
          syncState.estado,

        paginaActual:
          syncState.paginaActual,

        paginasProcesadas:
          syncState.paginasProcesadas,

        registrosSAP:
          syncState.registrosSAP,

        registrosProcesados:
          syncState.registrosProcesados
      },

      fecha:
        new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,

      estado:
        'error',

      baseDatos:
        'desconectada',

      error:
        error.message
    });
  }
});

// ============================================================
// ESTADO DE SINCRONIZACIÓN
// ============================================================

app.get(
  '/sync-status',
  (req, res) => {
    // Nota: los campos van también en la raíz del JSON (además de
    // dentro de "sincronizacion") porque frontend/sap-helper.js
    // (el botón "Actualizar desde SAP") lee status.ejecutando,
    // status.registrosProcesados, status.registrosSAP,
    // status.paginaActual y status.estado directamente del nivel
    // raíz. Si solo van anidados, el botón nunca detecta que la
    // sincronización sigue corriendo.
    res.json({
      ok: true,

      ejecutando:
        syncState.ejecutando,

      estado:
        syncState.estado,

      paginaActual:
        syncState.paginaActual,

      registrosSAP:
        syncState.registrosSAP,

      registrosProcesados:
        syncState.registrosProcesados,

      error:
        syncState.error,

      sincronizacion: {
        ejecutando:
          syncState.ejecutando,

        estado:
          syncState.estado,

        fechas: {
          inicio:
            syncState.inicio,

          fin:
            syncState.fin
        },

        paginaActual:
          syncState.paginaActual,

        skipActual:
          syncState.skipActual,

        paginasProcesadas:
          syncState.paginasProcesadas,

        paginaSize:
          SAP_PAGE_SIZE,

        registrosSAP:
          syncState.registrosSAP,

        registrosProcesados:
          syncState.registrosProcesados,

        iniciadoEn:
          syncState.iniciadoEn,

        terminadoEn:
          syncState.terminadoEn,

        ultimaActividad:
          syncState.ultimaActividad,

        error:
          syncState.error
      }
    });
  }
);

// ============================================================
// CONSULTAR SAP - UNA PÁGINA
// ============================================================

async function consultarSAPPagina(
  inicio,
  fin,
  skip,
  top
) {
  const filter =
    `Fecha_Factura ge datetime'${inicio}' and ` +
    `Fecha_Factura le datetime'${fin}'`;

  console.log(
    `Consultando SAP: ${inicio} → ${fin} | skip=${skip} | top=${top}`
  );

  actualizarActividad();

  try {
    const response =
      await axios.get(
        SAP_BASE_URL,
        {
          params: {
            $filter:
              filter,

            $format:
              'json',

            $top:
              top,

            $skip:
              skip
          },

          httpsAgent:
            new https.Agent({
              rejectUnauthorized:
                false
            }),

          timeout:
            120000,

          headers: {
            Accept:
              'application/json',

            Host:
              SAP_HOST
          },

          auth:
            SAP_USER && SAP_PASS
              ? {
                  username:
                    SAP_USER,

                  password:
                    SAP_PASS
                }
              : undefined
        }
      );

    console.log(
      `✓ SAP respondió HTTP ${response.status}`
    );

    actualizarActividad();

    return response.data;

  } catch (error) {
    const status =
      error.response?.status ||
      null;

    let detalle =
      error.response?.data ||
      error.message;

    if (
      typeof detalle !== 'string'
    ) {
      try {
        detalle =
          JSON.stringify(
            detalle
          );
      } catch {
        detalle =
          String(detalle);
      }
    }

    const nuevoError =
      new Error(
        `SAP respondió con error${
          status
            ? ` HTTP ${status}`
            : ''
        }`
      );

    nuevoError.status =
      status;

    nuevoError.detalle =
      detalle;

    throw nuevoError;
  }
}

// ============================================================
// MAPEAR REGISTRO SAP
// ============================================================

function mapSAPRecord(row) {
  return {
    sap_id:
      row.ID || null,

    cliente:
      row.Cliente || null,

    nit:
      row.Nit !== null &&
      row.Nit !== undefined
        ? String(row.Nit)
        : null,

    ciudad:
      row.Ciudad || null,

    departamento:
      row.Departamento || null,

    ciiu:
      row.CIIU || null,

    numero_factura:
      row.Numero_Factura !== null &&
      row.Numero_Factura !== undefined
        ? String(
            row.Numero_Factura
          )
        : null,

    fecha_factura:
      parseSAPDate(
        row.Fecha_Factura
      ),

    plazo:
      row.Plazo || null,

    cupo_credito:
      toNumber(
        row.Cupo_Credito
      ),

    cupo_usado:
      toNumber(
        row.Cupo_Usado
      ),

    asesor:
      row.Asesor || null,

    meta_anual_asesor:
      toNumber(
        row.Meta_Anual_Asesor
      ),

    sede:
      row.Sede || null,

    meta_anual_sede:
      toNumber(
        row.Meta_Anual_Sede
      ),

    nombre_almacen:
      row.Nombre_Almacen || null,

    codigo_articulo:
      row.Codigo_Articulo || null,

    articulo:
      row.Articulo || null,

    grupo:
      row.Grupo || null,

    meta_anual_grupo:
      toNumber(
        row.Meta_Anual_Grupo
      ),

    factura_paga_total:
      row.Factura_Paga_Total ||
      null,

    valor_pagado:
      toNumber(
        row.Valor_Pagado
      ),

    valor_total_articulo:
      toNumber(
        row.Valor_Total_Articulo
      ),

    dias_mora:
      toInteger(
        row.Dias_Mora
      ),

    kilos:
      toNumber(
        row.Kilos
      ),

    valor_kilo:
      toNumber(
        row.Valor_Kilo
      ),

    costo_kilo:
      toNumber(
        row.Costo_Kilo
      ),

    peso_unitario:
      toNumber(
        row.Peso_Unitario
      )
  };
}

// ============================================================
// GUARDAR UN LOTE
// ============================================================

// Columnas insertadas por fila (sin contar updated_at, que siempre es
// CURRENT_TIMESTAMP y no viaja como parámetro).
const COLUMNAS_FACTURACION = 28;

async function guardarLote(
  registros
) {
  const validos = registros.filter(
    registro => registro.sap_id
  );

  if (!validos.length) {
    return 0;
  }

  const client =
    await pool.connect();

  try {
    await client.query(
      'BEGIN'
    );

    // Construye UNA sola consulta INSERT con varias filas en el VALUES,
    // en vez de una consulta por fila. Esto reduce drásticamente los
    // viajes de ida y vuelta a la base de datos (antes: 1 por fila;
    // ahora: 1 por lote completo), que es la parte que más tiempo tomaba
    // al sincronizar con SAP.
    const filasSQL = [];
    const values = [];

    validos.forEach((registro, i) => {
      const base = i * COLUMNAS_FACTURACION;
      const placeholders = [];
      for (let c = 1; c <= COLUMNAS_FACTURACION; c++) {
        placeholders.push('$' + (base + c));
      }
      filasSQL.push(
        '(' + placeholders.join(',') + ', CURRENT_TIMESTAMP)'
      );

      values.push(
        registro.sap_id,

        registro.cliente,
        registro.nit,
        registro.ciudad,
        registro.departamento,
        registro.ciiu,

        registro.numero_factura,
        registro.fecha_factura,

        registro.plazo,

        registro.cupo_credito,
        registro.cupo_usado,

        registro.asesor,
        registro.meta_anual_asesor,

        registro.sede,
        registro.meta_anual_sede,

        registro.nombre_almacen,

        registro.codigo_articulo,
        registro.articulo,
        registro.grupo,

        registro.meta_anual_grupo,

        registro.factura_paga_total,

        registro.valor_pagado,
        registro.valor_total_articulo,

        registro.dias_mora,

        registro.kilos,
        registro.valor_kilo,
        registro.costo_kilo,
        registro.peso_unitario
      );
    });

    const query = `
      INSERT INTO facturacion (

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

        updated_at
      )

      VALUES ${filasSQL.join(',\n')}

      ON CONFLICT (sap_id)

      DO UPDATE SET

        cliente =
          EXCLUDED.cliente,

        nit =
          EXCLUDED.nit,

        ciudad =
          EXCLUDED.ciudad,

        departamento =
          EXCLUDED.departamento,

        ciiu =
          EXCLUDED.ciiu,

        numero_factura =
          EXCLUDED.numero_factura,

        fecha_factura =
          EXCLUDED.fecha_factura,

        plazo =
          EXCLUDED.plazo,

        cupo_credito =
          EXCLUDED.cupo_credito,

        cupo_usado =
          EXCLUDED.cupo_usado,

        asesor =
          EXCLUDED.asesor,

        meta_anual_asesor =
          EXCLUDED.meta_anual_asesor,

        sede =
          EXCLUDED.sede,

        meta_anual_sede =
          EXCLUDED.meta_anual_sede,

        nombre_almacen =
          EXCLUDED.nombre_almacen,

        codigo_articulo =
          EXCLUDED.codigo_articulo,

        articulo =
          EXCLUDED.articulo,

        grupo =
          EXCLUDED.grupo,

        meta_anual_grupo =
          EXCLUDED.meta_anual_grupo,

        factura_paga_total =
          EXCLUDED.factura_paga_total,

        valor_pagado =
          EXCLUDED.valor_pagado,

        valor_total_articulo =
          EXCLUDED.valor_total_articulo,

        dias_mora =
          EXCLUDED.dias_mora,

        kilos =
          EXCLUDED.kilos,

        valor_kilo =
          EXCLUDED.valor_kilo,

        costo_kilo =
          EXCLUDED.costo_kilo,

        peso_unitario =
          EXCLUDED.peso_unitario,

        updated_at =
          CURRENT_TIMESTAMP
    `;

    await client.query(
      query,
      values
    );

    await client.query(
      'COMMIT'
    );

    return validos.length;

  } catch (error) {
    await client.query(
      'ROLLBACK'
    );

    throw error;

  } finally {
    client.release();
  }
}

// ============================================================
// GUARDAR REGISTROS POR LOTES
// ============================================================

async function guardarRegistros(
  registros
) {
  let totalGuardados = 0;

  for (
    let i = 0;
    i < registros.length;
    i += DB_BATCH_SIZE
  ) {
    const lote =
      registros.slice(
        i,
        i + DB_BATCH_SIZE
      );

    const guardados =
      await guardarLote(
        lote
      );

    totalGuardados +=
      guardados;

    actualizarActividad();

    console.log(
      `✓ Lote PostgreSQL: ${guardados} registros`
    );
  }

  return totalGuardados;
}

// ============================================================
// SINCRONIZACIÓN REAL
// ============================================================

async function ejecutarSincronizacion(
  inicio,
  fin
) {
  try {
    let skip = 0;
    let pagina = 0;

    while (true) {
      pagina++;

      syncState.paginaActual =
        pagina;

      syncState.skipActual =
        skip;

      actualizarActividad();

      console.log(
        '==========================================='
      );

      console.log(
        `Consultando SAP - página ${pagina} - skip ${skip} - top ${SAP_PAGE_SIZE}`
      );

      const data =
        await consultarSAPPagina(
          inicio,
          fin,
          skip,
          SAP_PAGE_SIZE
        );

      const resultados =
        data?.d?.results || [];

      const cantidad =
        resultados.length;

      console.log(
        `SAP devolvió ${cantidad} registros`
      );

      if (cantidad === 0) {
        break;
      }

      syncState.registrosSAP +=
        cantidad;

      const registros =
        resultados
          .map(
            mapSAPRecord
          )
          .filter(
            registro =>
              registro.sap_id
          );

      const guardados =
        await guardarRegistros(
          registros
        );

      syncState.registrosProcesados +=
        guardados;

      syncState.paginasProcesadas =
        pagina;

      actualizarActividad();

      console.log(
        `✓ Página ${pagina} procesada`
      );

      console.log(
        `✓ Total SAP: ${syncState.registrosSAP}`
      );

      console.log(
        `✓ Total PostgreSQL: ${syncState.registrosProcesados}`
      );

      if (
        cantidad < SAP_PAGE_SIZE
      ) {
        break;
      }

      skip +=
        SAP_PAGE_SIZE;
    }

    syncState.ejecutando =
      false;

    syncState.estado =
      'completado';

    syncState.terminadoEn =
      new Date().toISOString();

    actualizarActividad();

    try {
      await registrarSync(
        inicio,
        fin,
        syncState.registrosProcesados
      );
    } catch (errorLog) {
      console.error(
        'No se pudo registrar en sync_log:',
        errorLog.message
      );
    }

    console.log(
      '==========================================='
    );

    console.log(
      '✓ SINCRONIZACIÓN SAP COMPLETADA'
    );

    console.log(
      `✓ Registros SAP: ${syncState.registrosSAP}`
    );

    console.log(
      `✓ Registros procesados: ${syncState.registrosProcesados}`
    );

    console.log(
      `✓ Páginas: ${syncState.paginasProcesadas}`
    );

    console.log(
      '==========================================='
    );

  } catch (error) {
    console.error(
      '==========================================='
    );

    console.error(
      '✗ ERROR SINCRONIZANDO SAP'
    );

    console.error(
      error
    );

    console.error(
      '==========================================='
    );

    syncState.ejecutando =
      false;

    syncState.estado =
      'error';

    syncState.error = {
      mensaje:
        error.message,

      detalle:
        error.detalle ||
        null,

      httpStatusSAP:
        error.status ||
        null
    };

    syncState.terminadoEn =
      new Date().toISOString();

    actualizarActividad();
  }
}

// ============================================================
// INICIAR SINCRONIZACIÓN
// ============================================================

app.get(
  '/sync-sap',
  async (req, res) => {

    const inicio =
      req.query.inicio ||
      '2026-08-01';

    const fin =
      req.query.fin ||
      '2026-08-27';

    const forzar =
      req.query.forzar === '1' ||
      req.query.forzar === 'true';

    if (
      !validarFecha(inicio) ||
      !validarFecha(fin)
    ) {
      return res.status(400).json({
        ok: false,

        error:
          'Las fechas deben tener formato YYYY-MM-DD',

        ejemplo:
          '/sync-sap?inicio=2026-08-01&fin=2026-08-27'
      });
    }

    if (inicio > fin) {
      return res.status(400).json({
        ok: false,

        error:
          'La fecha inicio no puede ser mayor que la fecha fin'
      });
    }

    // ========================================================
    // CACHÉ: si este mismo rango ya se sincronizó hace poco, no
    // volvemos a golpear SAP — los datos ya están en Postgres.
    // Se puede forzar con ?forzar=1.
    // ========================================================

    if (!forzar) {
      let previo = null;

      try {
        previo =
          await buscarSyncPrevio(
            inicio,
            fin
          );
      } catch (errorCache) {
        console.error(
          'No se pudo consultar sync_log:',
          errorCache.message
        );
      }

      if (previo) {
        return res.status(200).json({
          ok: true,

          yaSincronizado:
            true,

          mensaje:
            'Este rango ya se sincronizó antes (' +
            previo.registros +
            ' registros). Mostrando lo que ya está guardado en Postgres, sin volver a consultar SAP.',

          sincronizadoEn:
            previo.creado_en,

          registros:
            previo.registros,

          fechas: {
            inicio,
            fin
          },

          forzarConsulta:
            '/sync-sap?inicio=' + inicio + '&fin=' + fin + '&forzar=1'
        });
      }
    }

    // ========================================================
    // BLOQUEO
    // ========================================================

    if (
      syncState.ejecutando
    ) {
      return res.status(409).json({
        ok: false,

        mensaje:
          'Ya existe una sincronización SAP en ejecución',

        sincronizacion: {
          estado:
            syncState.estado,

          inicio:
            syncState.inicio,

          fin:
            syncState.fin,

          paginaActual:
            syncState.paginaActual,

          paginasProcesadas:
            syncState.paginasProcesadas,

          registrosSAP:
            syncState.registrosSAP,

          registrosProcesados:
            syncState.registrosProcesados
        },

        consultarEstado:
          '/sync-status'
      });
    }

    // ========================================================
    // NUEVA SINCRONIZACIÓN
    // ========================================================

    syncState.ejecutando =
      true;

    syncState.estado =
      'procesando';

    syncState.inicio =
      inicio;

    syncState.fin =
      fin;

    syncState.paginaActual =
      0;

    syncState.skipActual =
      0;

    syncState.paginasProcesadas =
      0;

    syncState.registrosSAP =
      0;

    syncState.registrosProcesados =
      0;

    syncState.iniciadoEn =
      new Date().toISOString();

    syncState.terminadoEn =
      null;

    syncState.error =
      null;

    actualizarActividad();

    console.log(
      '==========================================='
    );

    console.log(
      'SYNC SAP INICIADA EN SEGUNDO PLANO'
    );

    console.log(
      `${inicio} → ${fin}`
    );

    console.log(
      '==========================================='
    );

    // ========================================================
    // SEGUNDO PLANO
    // ========================================================

    ejecutarSincronizacion(
      inicio,
      fin
    ).catch(error => {
      console.error(
        'Error no controlado en sincronización:',
        error
      );
    });

    // ========================================================
    // RESPUESTA INMEDIATA
    // ========================================================

    return res.status(202).json({
      ok: true,

      mensaje:
        'Sincronización SAP iniciada en segundo plano',

      fechas: {
        inicio,
        fin
      },

      paginaSize:
        SAP_PAGE_SIZE,

      lotePostgreSQL:
        DB_BATCH_SIZE,

      estado:
        'procesando',

      consultarEstado:
        '/sync-status'
    });
  }
);

// ============================================================
// FACTURACIÓN
// ============================================================

app.get(
  '/facturacion',
  async (req, res) => {

    const limit =
      Math.min(
        parseInt(
          req.query.limit
        ) || 50,
        1000
      );

    const offset =
      Math.max(
        parseInt(
          req.query.offset
        ) || 0,
        0
      );

    const fecha_inicio =
      req.query.fecha_inicio ||
      '2026-08-01';

    const fecha_fin =
      req.query.fecha_fin ||
      '2026-08-27';

    if (
      !validarFecha(fecha_inicio) ||
      !validarFecha(fecha_fin)
    ) {
      return res.status(400).json({
        ok: false,

        error:
          'Las fechas deben tener formato YYYY-MM-DD'
      });
    }

    try {
      const result =
        await pool.query(
          `
          SELECT *

          FROM facturacion

          WHERE fecha_factura
            BETWEEN $1::DATE
            AND $2::DATE

          ORDER BY
            fecha_factura DESC,
            id DESC

          LIMIT $3
          OFFSET $4
          `,
          [
            fecha_inicio,
            fecha_fin,
            limit,
            offset
          ]
        );

      const countResult =
        await pool.query(
          `
          SELECT
            COUNT(*)::INTEGER AS total

          FROM facturacion

          WHERE fecha_factura
            BETWEEN $1::DATE
            AND $2::DATE
          `,
          [
            fecha_inicio,
            fecha_fin
          ]
        );

      res.json({
        ok: true,

        data:
          result.rows,

        total:
          countResult.rows[0].total,

        limit,
        offset,

        fechas: {
          inicio:
            fecha_inicio,

          fin:
            fecha_fin
        }
      });

    } catch (error) {
      console.error(
        'Error en /facturacion:',
        error
      );

      res.status(500).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// HOJA DE ASESOR
// ============================================================

app.get(
  '/dashboards/hoja-asesor',
  async (req, res) => {

    const inicio =
      req.query.inicio ||
      '2026-08-01';

    const fin =
      req.query.fin ||
      '2026-08-27';

    try {
      const result =
        await pool.query(
          `
          SELECT

            asesor,

            COUNT(*)::INTEGER
              AS total_lineas,

            COUNT(
              DISTINCT numero_factura
            )::INTEGER
              AS total_facturas,

            COALESCE(
              SUM(valor_total_articulo),
              0
            ) AS total_monto,

            COALESCE(
              SUM(valor_pagado),
              0
            ) AS total_pagado,

            COALESCE(
              SUM(kilos),
              0
            ) AS total_kilos,

            CASE
              WHEN COALESCE(
                SUM(kilos),
                0
              ) > 0

              THEN
                COALESCE(
                  SUM(valor_total_articulo),
                  0
                )
                /
                SUM(kilos)

              ELSE 0
            END AS promedio_valor_kilo,

            COALESCE(
              SUM(
                CASE
                  WHEN factura_paga_total = 'SI'
                  THEN 1
                  ELSE 0
                END
              ),
              0
            )::INTEGER
              AS lineas_pagadas

          FROM facturacion

          WHERE fecha_factura
            BETWEEN $1::DATE
            AND $2::DATE

            AND asesor IS NOT NULL

          GROUP BY asesor

          ORDER BY total_monto DESC
          `,
          [
            inicio,
            fin
          ]
        );

      res.json({
        ok: true,

        data:
          result.rows,

        fechas: {
          inicio,
          fin
        }
      });

    } catch (error) {
      console.error(
        'Error en hoja-asesor:',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// HOJA DE CLIENTE
// ============================================================

app.get(
  '/dashboards/hoja-cliente',
  async (req, res) => {

    const inicio =
      req.query.inicio ||
      '2026-08-01';

    const fin =
      req.query.fin ||
      '2026-08-27';

    try {
      const result =
        await pool.query(
          `
          SELECT

            cliente,

            nit,

            ciudad,

            COUNT(*)::INTEGER
              AS total_lineas,

            COUNT(
              DISTINCT numero_factura
            )::INTEGER
              AS total_facturas,

            COALESCE(
              SUM(valor_total_articulo),
              0
            ) AS total_monto,

            COALESCE(
              SUM(valor_pagado),
              0
            ) AS total_pagado,

            COALESCE(
              SUM(kilos),
              0
            ) AS total_kilos,

            MAX(fecha_factura)
              AS ultima_factura,

            COALESCE(
              SUM(
                CASE
                  WHEN factura_paga_total = 'SI'
                  THEN 1
                  ELSE 0
                END
              ),
              0
            )::INTEGER
              AS lineas_pagadas,

            COALESCE(
              MAX(dias_mora),
              0
            ) AS max_dias_mora

          FROM facturacion

          WHERE fecha_factura
            BETWEEN $1::DATE
            AND $2::DATE

            AND cliente IS NOT NULL

          GROUP BY
            cliente,
            nit,
            ciudad

          ORDER BY
            total_monto DESC

          LIMIT 100
          `,
          [
            inicio,
            fin
          ]
        );

      res.json({
        ok: true,

        data:
          result.rows,

        fechas: {
          inicio,
          fin
        }
      });

    } catch (error) {
      console.error(
        'Error en hoja-cliente:',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// LABOR COMERCIAL
// ============================================================

app.get(
  '/dashboards/labor-comercial',
  async (req, res) => {

    const inicio =
      req.query.inicio ||
      '2026-08-01';

    const fin =
      req.query.fin ||
      '2026-08-27';

    try {
      const result =
        await pool.query(
          `
          SELECT

            sede,

            asesor,

            COUNT(*)::INTEGER
              AS total_lineas,

            COUNT(
              DISTINCT numero_factura
            )::INTEGER
              AS total_facturas,

            COALESCE(
              SUM(valor_total_articulo),
              0
            ) AS total_monto,

            COALESCE(
              SUM(valor_pagado),
              0
            ) AS total_pagado,

            COALESCE(
              SUM(kilos),
              0
            ) AS total_kilos

          FROM facturacion

          WHERE fecha_factura
            BETWEEN $1::DATE
            AND $2::DATE

            AND sede IS NOT NULL

          GROUP BY
            sede,
            asesor

          ORDER BY
            total_monto DESC
          `,
          [
            inicio,
            fin
          ]
        );

      res.json({
        ok: true,

        data:
          result.rows,

        fechas: {
          inicio,
          fin
        },

        camposSAP: [
          'Sede',
          'Asesor',
          'Numero_Factura',
          'Valor_Total_Articulo',
          'Valor_Pagado',
          'Kilos'
        ],

        nota:
          'El endpoint SAP consultado no entrega actualmente un campo denominado Labor_Comercial. El resultado se construye con Sede y Asesor.'
      });

    } catch (error) {
      console.error(
        'Error en labor-comercial:',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// PORTAFOLIO Y CARTERA
// ============================================================

app.get(
  '/dashboards/portafolio-cartera',
  async (req, res) => {

    const inicio =
      req.query.inicio ||
      '2026-08-01';

    const fin =
      req.query.fin ||
      '2026-08-27';

    try {
      const result =
        await pool.query(
          `
          SELECT

            grupo,

            codigo_articulo,

            articulo,

            COUNT(*)::INTEGER
              AS total_lineas,

            COUNT(
              DISTINCT numero_factura
            )::INTEGER
              AS total_facturas,

            COALESCE(
              SUM(valor_total_articulo),
              0
            ) AS total_monto,

            COALESCE(
              SUM(valor_pagado),
              0
            ) AS total_pagado,

            COALESCE(
              SUM(kilos),
              0
            ) AS total_kilos,

            CASE
              WHEN COALESCE(
                SUM(kilos),
                0
              ) > 0

              THEN
                SUM(valor_total_articulo)
                /
                SUM(kilos)

              ELSE 0
            END AS promedio_valor_kilo

          FROM facturacion

          WHERE fecha_factura
            BETWEEN $1::DATE
            AND $2::DATE

            AND grupo IS NOT NULL

          GROUP BY
            grupo,
            codigo_articulo,
            articulo

          ORDER BY
            total_monto DESC
          `,
          [
            inicio,
            fin
          ]
        );

      res.json({
        ok: true,

        data:
          result.rows,

        fechas: {
          inicio,
          fin
        },

        camposSAP: [
          'Grupo',
          'Codigo_Articulo',
          'Articulo',
          'Valor_Total_Articulo',
          'Valor_Pagado',
          'Kilos',
          'Valor_Kilo'
        ],

        nota:
          'El endpoint SAP consultado no entrega actualmente campos denominados Portafolio o Cartera. El resultado se construye con Grupo, Artículo y valores de facturación.'
      });

    } catch (error) {
      console.error(
        'Error en portafolio-cartera:',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// PLANEACIÓN NOGALES
// ============================================================

app.get(
  '/dashboards/planeacion-nogales',
  async (req, res) => {

    const inicio =
      req.query.inicio ||
      '2026-08-01';

    const fin =
      req.query.fin ||
      '2026-08-27';

    try {
      const result =
        await pool.query(
          `
          SELECT

            sede,

            nombre_almacen,

            grupo,

            COUNT(*)::INTEGER
              AS total_lineas,

            COUNT(
              DISTINCT numero_factura
            )::INTEGER
              AS total_facturas,

            COALESCE(
              SUM(valor_total_articulo),
              0
            ) AS total_monto,

            COALESCE(
              SUM(valor_pagado),
              0
            ) AS total_pagado,

            COALESCE(
              SUM(kilos),
              0
            ) AS total_kilos

          FROM facturacion

          WHERE fecha_factura
            BETWEEN $1::DATE
            AND $2::DATE

            AND sede IS NOT NULL

          GROUP BY
            sede,
            nombre_almacen,
            grupo

          ORDER BY
            total_monto DESC
          `,
          [
            inicio,
            fin
          ]
        );

      res.json({
        ok: true,

        data:
          result.rows,

        fechas: {
          inicio,
          fin
        },

        camposSAP: [
          'Sede',
          'Nombre_Almacen',
          'Grupo',
          'Numero_Factura',
          'Valor_Total_Articulo',
          'Valor_Pagado',
          'Kilos'
        ],

        nota:
          'El endpoint SAP consultado no entrega actualmente un campo denominado Planeacion. El resultado se construye con Sede, Nombre_Almacen y Grupo.'
      });

    } catch (error) {
      console.error(
        'Error en planeacion-nogales:',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,

      error:
        'Ruta no encontrada',

      ruta:
        req.originalUrl
    });
  }
);

// ============================================================
// MANEJO DE ERRORES GENERALES
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      'ERROR GENERAL:',
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      ok: false,

      error:
        'Error interno del servidor',

      detalle:
        error.message
    });
  }
);

// ============================================================
// INICIAR SERVIDOR
// ============================================================

async function startServer() {
  try {
    await initDB();

    app.listen(
      PORT,
      '0.0.0.0',
      () => {

        console.log(
          `✓ Server running on port ${PORT}`
        );

        console.log(
          '✓ GET /'
        );

        console.log(
          '✓ GET /health'
        );

        console.log(
          '✓ GET /sync-sap'
        );

        console.log(
          '✓ GET /sync-status'
        );

        console.log(
          '✓ GET /facturacion'
        );

        console.log(
          '✓ GET /dashboards/hoja-asesor'
        );

        console.log(
          '✓ GET /dashboards/hoja-cliente'
        );

        console.log(
          '✓ GET /dashboards/labor-comercial'
        );

        console.log(
          '✓ GET /dashboards/portafolio-cartera'
        );

        console.log(
          '✓ GET /dashboards/planeacion-nogales'
        );
      }
    );

  } catch (error) {

    console.error(
      'Error iniciando servidor:',
      error
    );

    process.exit(1);
  }
}

startServer();

module.exports = app;
