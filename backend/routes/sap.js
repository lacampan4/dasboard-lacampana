import { Router } from 'express';
import axios from 'axios';
import https from 'https';

const router = Router();

// Credenciales desde las Variables de Entorno en Render/Vercel
const SAP_SERVICE_URL = process.env.SAP_SERVICE_URL;
const SAP_USER = process.env.SAP_USER;
const SAP_PASS = process.env.SAP_PASS;

// Reintentos automáticos en caso de fallo temporal
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 segundos entre reintentos

// Agente HTTPS que acepta certificados autofirmados (SAP en ambientes internos)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

async function connectToSAP(url, retries = 0) {
  try {
    console.log(`[SAP] Intentando conexión a: ${url.split('?')[0]} (intento ${retries + 1}/${MAX_RETRIES})`);
    
    const respuestaSAP = await axios.get(url, {
      auth: {
        username: SAP_USER,
        password: SAP_PASS
      },
      timeout: 30000, // 30 segundos para dar más tiempo a SAP
      httpsAgent, // Acepta certificados autofirmados
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PanoramaProduccion/1.0'
      }
    });

    console.log('[SAP] Conexión exitosa');
    return respuestaSAP;
  } catch (error) {
    const statusCode = error.response?.status;
    const statusText = error.response?.statusText;
    
    console.error(`[SAP] Error: HTTP ${statusCode} ${statusText}`);
    console.error(`[SAP] Mensaje: ${error.message}`);
    console.error(`[SAP] Código: ${error.code}`);
    
    // Reintentar si es un error temporal (503, 502, timeout, etc.)
    if (retries < MAX_RETRIES && (statusCode >= 500 || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ERR_TLS_CERT_ALTNAME_INVALID')) {
      console.log(`[SAP] Reintentando en ${RETRY_DELAY}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return connectToSAP(url, retries + 1);
    }
    
    throw error;
  }
}

const getData = async (req, res) => {
  const { inicio, fin } = req.query;

  if (!inicio || !fin) {
    return res.status(400).json({ error: 'Faltan las fechas de inicio o fin' });
  }

  if (!SAP_SERVICE_URL || !SAP_USER || !SAP_PASS) {
    console.error('[SAP] Variables de entorno no configuradas');
    return res.status(500).json({ 
      error: 'No se pudo actualizar desde SAP: Credenciales no configuradas' 
    });
  }

  try {
    const urlOData = `${SAP_SERVICE_URL}?$filter=Fecha ge datetime'${inicio}T00:00:00' and Fecha le datetime'${fin}T23:59:59'&$format=json`;
    
    const respuestaSAP = await connectToSAP(urlOData);
    
    // Validar estructura de respuesta
    if (!respuestaSAP.data || !respuestaSAP.data.d || !respuestaSAP.data.d.results) {
      console.warn('[SAP] Respuesta con estructura inesperada');
      return res.json([]);
    }

    res.json(respuestaSAP.data.d.results);
  } catch (error) {
    const statusCode = error.response?.status;
    const statusText = error.response?.statusText;
    
    let mensaje = 'Error al consultar la información de SAP';
    if (statusCode) {
      mensaje = `No se pudo actualizar desde SAP: SAP respondió HTTP ${statusCode}`;
    } else if (error.code === 'ECONNREFUSED') {
      mensaje = 'No se pudo conectar con SAP: conexión rechazada';
    } else if (error.code === 'ENOTFOUND') {
      mensaje = 'No se pudo resolver el host de SAP';
    }
    
    console.error(`[SAP] Respuesta al cliente: ${mensaje}`);
    res.status(503).json({ error: mensaje });
  }
};

// Rutas para GET /api/produccion (compatibilidad)
router.get('/produccion', getData);

// Rutas para POST /api/sap/sync/* (frontend esperado)
router.post('/sap/sync/:tabla', async (req, res) => {
  const { tabla } = req.params;
  
  if (tabla !== 'produccion') {
    return res.status(400).json({ error: `Tabla no soportada: ${tabla}` });
  }
  
  await getData(req, res);
});

export default router;
