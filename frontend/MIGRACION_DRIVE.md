# Actualización desde Google Drive

Todos los dashboards utilizan `drive-helper.js` para ofrecer dos acciones:

- **Cargar Excel**
- **Actualizar desde Drive**

La actualización usa una hoja de Google Sheets publicada como CSV. El backend actúa como proxy mediante `/api/drive/download`.

Los datos quedan disponibles en `window.CAMPANA_DATA` y se almacenan en `localStorage` por página.
