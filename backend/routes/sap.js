const express = require('express');
const router = express.Router();
const axios = require('axios');
const https = require('https');

// Agente HTTPS para omitir validación estricta de TLS/certificados (igual que Postman)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Función reutilizable para consultar SAP OData
async function consultarSAP(req, res) {
  try {
    // Tomar fechas desde req.query o asignarle valores por defecto
    const inicio = req.query.inicio || '2026-08-01';
    const fin = req.query.fin || '2026-08-25';

    const sapUrl = process.env.SAP_SERVICE_URL;
    const sapUser = process.env.SAP_USER;
    const sapPass = process.env.SAP_PASS;

    // Autenticación Basic Auth
    const authHeader = 'Basic ' + Buffer.from(`${sapUser}:${sapPass}`).toString('base64');

    const config = {
      method: 'get',
      url: sapUrl,
      httpsAgent,
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
        'User-Agent': 'PostmanRuntime/7.36.3'
      },
      params: {
        '$filter': `Fecha_Factura ge datetime'${inicio}' and Fecha_Factura le datetime'${fin}'`,
        '$format': 'json'
      },
      timeout: 15000
    };

    const response = await axios(config);
    
    console.log('[SAP Success] Status:', response.status);

    return res.json({
      ok: true,
      conexionSAP: true,
      rango: { inicio, fin },
      httpStatusSAP: response.status,
      data: response.data
    });

  } catch (error) {
    if (error.response) {
      console.error('[SAP Error] Status:', error.response.status);
      return res.status(502).json({
        ok: false,
        conexionSAP: true,
        httpStatusSAP: error.response.status,
        mensaje: `SAP respondió HTTP ${error.response.status}`,
        errorData: error.response.data
      });
    } else {
      console.error('[SAP Error] Network/Server:', error.message);
      return res.status(500).json({
        ok: false,
        conexionSAP: false,
        mensaje: 'No se pudo conectar con el servidor SAP',
        error: error.message
      });
    }
  }
}

// 1. Escuchar en /api/sap/test
router.get('/test', consultarSAP);

// 2. Escuchar en /api/sap/ (raíz)
router.get('/', consultarSAP);

// 3. Escuchar en /api/sap/facturas
router.get('/facturas', consultarSAP);

// 4. Escuchar en /api/sap/costos (frecuente en tu frontend)
router.get('/costos', consultarSAP);

module.exports = router;
