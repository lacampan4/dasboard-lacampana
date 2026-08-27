import { Router } from 'express';
import axios from 'axios';

const router = Router();

// Descargar CSV desde Google Drive
// URL esperada: /api/drive/download?fileId=GOOGLE_DRIVE_FILE_ID
router.get('/download', async (req, res) => {
  const { fileId } = req.query;
  
  if (!fileId) {
    return res.status(400).json({ error: 'fileId es requerido' });
  }

  try {
    console.log(`[DRIVE] Descargando archivo ${fileId}...`);
    
    // URL de exportación de Google Drive (export as CSV)
    const driveUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`;
    
    const response = await axios.get(driveUrl, {
      timeout: 30000,
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="datos-drive.csv"`);
    
    console.log('[DRIVE] Archivo descargado exitosamente');
    response.data.pipe(res);
  } catch (error) {
    console.error(`[DRIVE] Error al descargar: ${error.message}`);
    res.status(500).json({ error: 'Error al descargar archivo desde Google Drive' });
  }
});

// Parse CSV a JSON (helper para frontend)
// Espera un POST con el contenido CSV
router.post('/parse', async (req, res) => {
  const { csv } = req.body;
  
  if (!csv) {
    return res.status(400).json({ error: 'csv es requerido en el body' });
  }

  try {
    console.log('[DRIVE] Parseando CSV...');
    
    // Dividir por líneas
    const lines = csv.trim().split('\n');
    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV vacío o sin datos' });
    }

    // Primera línea son los headers
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    
    // Resto son datos
    const data = lines.slice(1).map(line => {
      const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      const row = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx] || '';
      });
      return row;
    });

    console.log(`[DRIVE] Parseados ${data.length} registros`);
    res.json(data);
  } catch (error) {
    console.error(`[DRIVE] Error parseando CSV: ${error.message}`);
    res.status(500).json({ error: 'Error al parsear CSV' });
  }
});

export default router;
