import express from 'express';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

// ============================================================
// SAP - HOJA DE RUTA
//
// IMPORTANTE:
// - En SAP el módulo se conoce funcionalmente como "Hoja de Ruta".
// - En la API OData el servicio/entidad se llama "Facturacion".
// - Este flujo NO usa Neon ni ninguna base de datos.
// ============================================================

const SAP_SERVICE_URL = (
  process.env.SAP_SERVICE_URL ||
  'https://170.239.154.46:4300/api_campana26'
).replace(/\/$/, '');

const SAP_USER = process.env.SAP_USER;
const SAP_PASS = process.env.SAP_PASS;

// ============================================================
// HTTPS
// ============================================================
//
// El servidor SAP usa HTTPS directamente sobre una IP.
// Se desactiva la validación del certificado porque puede no
// coincidir con la IP pública.
//
// La conexión sigue siendo HTTPS/cifrada.
// ============================================================

const sapHttpsAgent = new https.Agent({
  rejectUnauthorized: false
});

// ============================================================
// CONFIGURACIÓN DE AXIOS
// ============================================================
//
// Esta configuración intenta reproducir la petición de Postman.
//
// Postman está utilizando:
//
// Basic Auth
// Usuario: B1ADMIN
//
// Host:
// NDB.n00.CAMPANADB02:4300
// ============================================================

function sapConfig() {
  return {
    auth: {
      username: SAP_USER,
      password: SAP_PASS
    },

    httpsAgent: sapHttpsAgent,

    timeout: 30000,

    headers: {
      Accept: 'application/json',

      // Intentamos utilizar un User-Agent similar al de Postman.
      'User-Agent': 'PostmanRuntime/7.43.0',

      // Host utilizado por la petición que funciona en Postman.
      Host: 'NDB.n00.CAMPANADB02:4300',

      Connection: 'keep-alive'
    },

    // Permite recibir respuestas 4xx/5xx para poder diagnosticarlas.
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
// CONSTRUIR URL DE FACTURACION
// ============================================================

function facturacionUrl(inicio, fin) {
  const filtro =
    `Fecha_Factura ge datetime'${inicio}' and Fecha_Factura le datetime'${fin}'`;

  return `${SAP_SERVICE_URL}/facturacion.xsodata/Facturacion?$filter=${encodeURIComponent(
    filtro
  )}&$format=json`;
}

// ============================================================
// INFORMACIÓN DE ERRORES
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
    return 'La conexión con SAP agotó el tiempo de espera. Revisa firewall/red y acceso de Render al puerto 4300.';
  }

  if (code === 'ECONNRESET') {
    return 'SAP cerró la conexión antes de completar la respuesta.';
  }

  if (code === 'ENOTFOUND') {
    return 'No se pudo resolver el servidor SAP.';
  }

  if (status === 401) {
    return 'SAP rechazó las credenciales. Verifica SAP_USER y SAP_PASS en Render.';
  }

  if (status === 403) {
    return 'SAP rechazó el acceso (HTTP 403). El usuario no tiene permisos suficientes.';
  }

  if (status === 404) {
    return 'SAP no encontró el endpoint Facturacion.';
  }

  if (status >= 500) {
    return `SAP respondió con HTTP ${status}.`;
  }

  return (
    error?.message ||
    `Error desconocido${
      status ? ` (HTTP ${status})` : ''
    }.`
  );
}

// ============================================================
// EXTRAER REGISTROS ODATA
// ============================================================

function extractRows(data) {
  return data?.d?.results || data?.value || [];
}

// ============================================================
// GET /api/sap/config
//
// No consulta SAP.
// Solo confirma las variables cargadas.
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

    passwordConfigurada: Boolean(SAP_PASS)
  });
});

// ============================================================
// GET /api/sap/test
//
// Ejemplo:
//
// /api/sap/test?inicio=2026-08-01&fin=2026-08-25
//
// PRUEBA REAL:
//
// Render
//   ↓
// SAP
//
// NO utiliza Neon.
// ============================================================

router.get('/sap/test', async (req, res) => {
  const { inicio, fin } = req.query;

  // ----------------------------------------------------------
  // Validar fechas
  // ----------------------------------------------------------

  if (!validateDates(inicio, fin)) {
    return res.status(400).json({
      ok: false,

      error:
        'Fechas inválidas. Usa ?inicio=YYYY-MM-DD&fin=YYYY-MM-DD'
    });
  }

  // ----------------------------------------------------------
  // Validar variables
  // ----------------------------------------------------------

  if (!SAP_USER || !SAP_PASS) {
    return res.status(500).json({
      ok: false,

      error:
        'Faltan SAP_USER o SAP_PASS en las variables de entorno de Render.'
    });
  }

  const url = facturacionUrl(
    inicio,
    fin
  );

  try {
    console.log(
      '=================================================='
    );

    console.log(
      '[SAP TEST] INICIANDO CONSULTA'
    );

    console.log(
      '=================================================='
    );

    console.log(
      '[SAP TEST] URL:',
      url
    );

    // No mostramos la contraseña.
    console.log(
      '[SAP TEST] Usuario:',
      SAP_USER
    );

    console.log(
      '[SAP TEST] Host SAP:',
      'NDB.n00.CAMPANADB02:4300'
    );

    console.log(
      '[SAP TEST] Realizando petición...'
    );

    const response = await axios.get(
      url,
      sapConfig()
    );

    const rows =
      extractRows(response.data);

    // --------------------------------------------------------
    // DIAGNÓSTICO
    // --------------------------------------------------------

    console.log(
      '[SAP TEST] RESPUESTA SAP:',
      {
        status: response.status,

        statusText:
          response.statusText,

        headers:
          response.headers,

        url:
          response.config?.url
      }
    );

    console.log(
      `[SAP TEST] HTTP ${response.status} · ${rows.length} registros`
    );

    console.log(
      '=================================================='
    );

    // --------------------------------------------------------
    // SAP respondió error
    // --------------------------------------------------------

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
          typeof response.data === 'string'
            ? response.data
            : response.data,

        headersSAP:
          response.headers,

        endpoint:
          `${SAP_SERVICE_URL}/facturacion.xsodata/Facturacion`,

        inicio,

        fin
      });
    }

    // --------------------------------------------------------
    // SAP respondió correctamente
    // --------------------------------------------------------

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

    const causa =
      errorInfo(error);

    console.error(
      '[SAP TEST] ERROR:',
      {
        code:
          error.code,

        message:
          error.message,

        causa
      }
    );

    return res.status(502).json({
      ok: false,

      conexionSAP: false,

      error:
        'Render no pudo consultar SAP.',

      codigo:
        error.code ||
        'SAP_REQUEST_ERROR',

      causa,

      detalleTecnico:
        error.message,

      endpoint:
        `${SAP_SERVICE_URL}/facturacion.xsodata/Facturacion`,

      inicio,

      fin
    });
  }
});

// ============================================================
// GET /api/sap/debug/facturacion
//
// Consulta las columnas reales de SAP.
// ============================================================

router.get(
  '/sap/debug/facturacion',
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

    if (!SAP_USER || !SAP_PASS) {
      return res.status(500).json({
        ok: false,

        error:
          'Faltan SAP_USER o SAP_PASS en Render.'
      });
    }

    try {

      const url =
        facturacionUrl(
          inicio,
          fin
        );

      console.log(
        `[SAP DEBUG] GET ${url}`
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
        '[SAP DEBUG] RESPUESTA:',
        {
          status:
            response.status,

          statusText:
            response.statusText,

          headers:
            response.headers,

          url:
            response.config?.url
        }
      );

      if (
        response.status < 200 ||
        response.status >= 300
      ) {
        return res.status(502).json({
          ok: false,

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

        httpStatusSAP:
          response.status,

        total:
          rows.length,

        columnas:
          rows[0]
            ? Object.keys(rows[0])
            : [],

        primer_registro:
          rows[0] || null
      });

    } catch (error) {

      return res.status(502).json({
        ok: false,

        error:
          'Render no pudo consultar SAP.',

        codigo:
          error.code ||
          'SAP_REQUEST_ERROR',

        causa:
          errorInfo(error),

        detalle:
          error.message
      });
    }
  }
);

// ============================================================
// POST /api/sap/sync/hoja-ruta
//
// Endpoint utilizado por los dashboards.
//
// NO utiliza Neon.
// Devuelve directamente los datos de SAP.
// ============================================================

router.post(
  '/sap/sync/hoja-ruta',
  async (req, res) => {

    const { inicio, fin } =
      req.query;

    // --------------------------------------------------------
    // Validar fechas
    // --------------------------------------------------------

    if (!validateDates(inicio, fin)) {
      return res.status(400).json({
        ok: false,

        error:
          'Faltan las fechas o tienen formato incorrecto. Usa ?inicio=YYYY-MM-DD&fin=YYYY-MM-DD'
      });
    }

    // --------------------------------------------------------
    // Validar credenciales
    // --------------------------------------------------------

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
        `[SAP HOJA DE RUTA] Consultando ${inicio} → ${fin}`
      );

      console.log(
        `[SAP HOJA DE RUTA] URL: ${url}`
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
        '[SAP HOJA DE RUTA] RESPUESTA:',
        {
          status:
            response.status,

          statusText:
            response.statusText,

          headers:
            response.headers,

          url:
            response.config?.url
        }
      );

      console.log(
        `[SAP HOJA DE RUTA] HTTP ${response.status} · ${rows.length} registros`
      );

      // ------------------------------------------------------
      // SAP respondió error
      // ------------------------------------------------------

      if (
        response.status < 200 ||
        response.status >= 300
      ) {
        return res.status(502).json({
          ok: false,

          error:
            'SAP respondió con error.',

          httpStatusSAP:
            response.status,

          detalle:
            response.data,

          inicio,

          fin
        });
      }

      // ------------------------------------------------------
      // SAP respondió correctamente
      // ------------------------------------------------------

      return res.json({
        ok: true,

        modulo:
          'Hoja de Ruta',

        servicioApi:
          'facturacion.xsodata',

        entidadApi:
          'Facturacion',

        inicio,

        fin,

        registros:
          rows.length,

        data:
          rows
      });

    } catch (error) {

      const causa =
        errorInfo(error);

      console.error(
        '[SAP HOJA DE RUTA] ERROR:',
        {
          code:
            error.code,

          message:
            error.message,

          causa
        }
      );

      return res.status(502).json({
        ok: false,

        error:
          'No fue posible consultar Hoja de Ruta en SAP.',

        codigo:
          error.code ||
          'SAP_REQUEST_ERROR',

        causa,

        detalleTecnico:
          error.message,

        endpoint:
          `${SAP_SERVICE_URL}/facturacion.xsodata/Facturacion`,

        inicio,

        fin
      });
    }
  }
);

// ============================================================
// EXPORTAR ROUTER
// ============================================================

export default router;
