# Integración con Google Sheets

La fuente central de datos del proyecto es una hoja de Google Sheets publicada en formato CSV.

## Flujo

1. El usuario abre un dashboard.
2. **Cargar Excel** permite cargar datos manualmente para pruebas.
3. **Actualizar desde Drive** consulta la hoja publicada.
4. El backend descarga el CSV mediante `/api/drive/download`.
5. `drive-helper.js` transforma el CSV a objetos JSON.
6. Los datos se guardan por dashboard en `localStorage` y se emite el evento `campana:data-loaded`.

## Configuración

La URL publicada se encuentra en:

`frontend/drive-helper.js`

Si cambia la hoja publicada, se reemplaza la constante `PUBLISHED_SHEET_URL`.
