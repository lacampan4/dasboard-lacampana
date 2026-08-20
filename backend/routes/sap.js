import express from 'express';
import axios from 'axios';

const router = express.Router();

// Credenciales desde las Variables de Entorno en Render
const SAP_SERVICE_URL = process.env.SAP_SERVICE_URL;
const SAP_USER = process.env.SAP_USER;
const SAP_PASS = process.env.SAP_PASS;

router.get('/produccion', async (req, res) => {
    const { inicio, fin } = req.query;

    if (!inicio || !fin) {
        return res.status(400).json({ error: 'Faltan las fechas de inicio o fin' });
    }

    if (!SAP_SERVICE_URL || !SAP_USER || !SAP_PASS) {
        return res.status(500).json({ error: 'Variables de entorno de SAP no configuradas' });
    }

    try {
        const urlOData = `${SAP_SERVICE_URL}?$filter=Fecha ge datetime'${inicio}T00:00:00' and Fecha le datetime'${fin}T23:59:59'&$format=json`;

        const respuestaSAP = await axios.get(urlOData, {
            auth: {
                username: SAP_USER,
                password: SAP_PASS
            },
            timeout: 10000
        });

        res.json(respuestaSAP.data.d.results);
    } catch (error) {
        console.error('Error al conectar con SAP:', error.message);
        res.status(500).json({ error: 'Error al consultar la información de SAP' });
    }
});

export default router;
