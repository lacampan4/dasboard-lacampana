# Fuente de datos La Campana

El proyecto ya no utiliza una integración de SAP. La fuente de actualización es Google Drive/Google Sheets y el usuario también puede cargar un Excel local.

- **Actualizar desde SAP**: el texto del botón se conserva por requerimiento del negocio, pero la acción real consulta la fuente configurada en `DRIVE_SOURCE_URL`.
- **Cargar Excel**: permite seleccionar un `.xlsx`, `.xls` o `.csv` desde el computador.
- El importador existente de los dashboards se reutiliza para que las gráficas, KPIs y tablas reciban exactamente el mismo esquema de datos que ya esperan.
- Los datos se guardan en IndexedDB del navegador y el tablero se recarga con la información nueva.

## Render

Configura `DRIVE_SOURCE_URL` con el enlace público de Google Sheets/Drive. Si no se configura, se conserva temporalmente la fuente publicada que ya traía este proyecto.
