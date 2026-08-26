import express from 'express';
import axios from 'axios';
import https from 'https';

const router = express.Router();

// Agente HTTPS para omitir validación estricta de TLS/certificados
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

router.get('/test', async (req, res) => {
  try {
    // 1. Fechas desde la URL (?inicio=YYYY-MM-DD&fin=YYYY-MM-DD) o valores por defecto
    const inicio = req.query.inicio || '2026-08-01';
    const fin = req.query.fin || '2026-08-25';

    if (!inicio || !fin) {
      return res.status(400).json({
        ok: false,
        error: 'Fechas inválidas. Usa ?inicio=YYYY-MM-DD&fin=YYYY-MM-DD'
      });
    }

    const sapUrl = process.env.SAP_SERVICE_URL;
    const sapUser = process.env.SAP_USER;
    const sapPass = process.env.SAP_PASS;

    // Autenticación Basic Auth
    const authHeader = 'Basic ' + Buffer.from(`${sapUser}:${sapPass}`).toString('base64');

    // Configuración de Axios adaptada a Postman
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
      timeout: 10000
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
      console.error('[SAP Error] Data:', error.response.data);

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
});

// Exportación por defecto para ES Modules
export default router;
