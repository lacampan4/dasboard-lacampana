/**
 * Drive Helper - Cargar datos desde Google Drive
 * Uso: setupDriveButton('googleDriveId', callback)
 */

function setupDriveButton(googleDriveIdInputSelector, onDataLoaded) {
    const GOOGLE_DRIVE_ID_KEY = 'googleDriveId_saved';
    
    // Restaurar ID guardado
    const savedId = localStorage.getItem(GOOGLE_DRIVE_ID_KEY);
    if (savedId && document.querySelector(googleDriveIdInputSelector)) {
        document.querySelector(googleDriveIdInputSelector).value = savedId;
    }

    // Listener del botón
    document.getElementById('btn-cargar-automatico')?.addEventListener('click', async () => {
        const fileId = document.querySelector(googleDriveIdInputSelector)?.value?.trim();
        
        if (!fileId) {
            alert('❌ Por favor ingresa un ID válido de Google Sheets');
            return;
        }

        // Guardar para próxima vez
        localStorage.setItem(GOOGLE_DRIVE_ID_KEY, fileId);

        console.log('⏳ Descargando archivo desde Google Drive...');
        
        try {
            // 1. Descargar CSV
            const downloadResponse = await fetch(`/api/drive/download?fileId=${fileId}`);
            
            if (!downloadResponse.ok) {
                throw new Error(`HTTP ${downloadResponse.status}`);
            }

            const csvText = await downloadResponse.text();
            console.log(`✅ CSV descargado: ${csvText.length} caracteres`);

            // 2. Parsear CSV
            console.log('⏳ Parseando datos...');
            
            const parseResponse = await fetch('/api/drive/parse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ csv: csvText })
            });

            if (!parseResponse.ok) {
                throw new Error(`Error parseando: HTTP ${parseResponse.status}`);
            }

            const datos = await parseResponse.json();
            console.log(`✅ Datos parseados: ${datos.length} registros`);

            // 3. Llamar callback con los datos
            if (typeof onDataLoaded === 'function') {
                onDataLoaded(datos);
            }

        } catch (error) {
            console.error('❌ Error:', error);
            alert(`Error al cargar: ${error.message}`);
        }
    });
}

// Exportar para uso global
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { setupDriveButton };
}
