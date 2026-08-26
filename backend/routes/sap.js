const express = require('express');
const router = express.Router();
const axios = require('axios');
const https = require('https');

// Agente HTTPS que ignora certificados autofirmados / no válidos (TLS)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

router.get('/test', async (req, res) => {
  const sapUrl = process.env.SAP_SERVICE_URL;
  const sapUser = process.env.SAP_USER;
  const sapPass = process.env.SAP_PASS;

  // Construcción de credenciales en formato Basic Auth
  const authHeader = 'Basic ' + Buffer.from(`${sapUser}:${sapPass}`).toString('base64');

  // Configuración de Axios replicando la firma de Postman
  const config = {
    method: 'get',
    url: sapUrl,
    httpsAgent,
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json',
      'User-Agent': 'PostmanRuntime/7.36.3'
    },
    // Uso de 'params' para enviar la query OData en la URL y NO en el body
    params: {
      '$filter': "Fecha_Factura ge datetime'2026-08-01' and Fecha_Factura le datetime'2026-08-25'",
      '$format': 'json'
    },
    timeout: 10000
  };

  try {
    const response = await axios(config);
    
    // Logs detallados en Render (omitimos credenciales por seguridad)
    console.log('[SAP Test Success] HTTP Status:', response.status);
    console.log('[SAP Test Success] Request URL:', response.config.url);
    console.log('[SAP Test Success] Response Headers:', response.headers);

    return res.json({
      ok: true,
      conexionSAP: true,
      httpStatusSAP: response.status,
      headers: response.headers,
      data: response.data
    });

  } catch (error) {
    if (error.response) {
      // SAP o el Servidor Web respondieron con un código de error (ej: 503, 401, 404)
      console.error('[SAP Test Error] HTTP Status:', error.response.status);
      console.error('[SAP Test Error] Response Headers:', error.response.headers);
      console.error('[SAP Test Error] Data:', error.response.data);

      return res.status(502).json({
        ok: false,
        conexionSAP: true,
        httpStatusSAP: error.response.status,
        mensaje: `SAP respondió HTTP ${error.response.status}`,
        headers: error.response.headers,
        errorData: error.response.data
      });
    } else {
      // Error a nivel de red, DNS o timeout (sin respuesta de SAP)
      console.error('[SAP Test Error] Request Error:', error.message);

      return res.status(500).json({
        ok: false,
        conexionSAP: false,
        mensaje: 'No se pudo conectar con el servidor SAP',
        error: error.message
      });
    }
  }
});

module.exports = router;
