# Google Drive Integration - Carga de Datos CSV

## 🎯 Objetivo

Reemplazar la lectura de archivos locales y datos de SAP por una descarga directa desde Google Sheets.

## 🚀 Cómo Funciona

### 1. **Usuario Comparte Google Sheets**
- Crea o abre tu Google Sheets
- Ve a **Compartir** → Cualquiera con el enlace
- Copia el ID (está en la URL entre `/d/` y `/edit`)

### 2. **Usuario Pega el ID en el Botón**
```
URL: https://docs.google.com/spreadsheets/d/1A2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P/edit
ID:  1A2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P
```

### 3. **Backend Descarga CSV**
- El endpoint `/api/drive/download?fileId=...` descarga como CSV
- Google Drive auto-convierte el Sheets a CSV

### 4. **Backend Parsea a JSON**
- El endpoint `/api/drive/parse` recibe el CSV
- Lo convierte a array de objetos JSON
- Lo devuelve al frontend

### 5. **Frontend Muestra los Datos**
- Tabla con preview de datos
- Guarda el ID en localStorage

## 📋 Estructura del CSV

El CSV debe tener:
- **Primera fila**: Headers (nombres de columnas)
- **Siguientes filas**: Datos

### Ejemplo:
```csv
Fecha,Monto,Cliente,Concepto
2026-08-01,100000,Cliente A,Factura
2026-08-02,50000,Cliente B,Nota Crédito
2026-08-03,75000,Cliente A,Factura
```

## 🔌 Endpoints del Backend

### GET `/api/drive/download?fileId=GOOGLE_SHEET_ID`
Descarga el Google Sheet como CSV.

**Query Parameters:**
- `fileId` (requerido): ID del Google Sheet

**Response:** CSV en texto plano

### POST `/api/drive/parse`
Parsea CSV a JSON.

**Body:**
```json
{
  "csv": "Encabezado1,Encabezado2\nvalor1,valor2\n..."
}
```

**Response:**
```json
[
  { "Encabezado1": "valor1", "Encabezado2": "valor2" },
  { "Encabezado1": "valor3", "Encabezado2": "valor4" }
]
```

## 📝 Ejemplo HTML Simple

Ver archivo: `frontend/drive-loader.html`

Funcionalidad:
1. Input para pegar ID del Google Sheets
2. Botón "Cargar Informe"
3. Descarga automática desde Drive
4. Parsea a JSON
5. Muestra preview en tabla
6. Guarda ID en localStorage

## 🔧 Integración en tus Dashboards

### En tu HTML:
```html
<!-- Quita el input[type="file"] -->
<!-- Deja solo el botón -->
<button id="btn-cargar-automatico">Cargar Informe</button>
```

### En tu JavaScript:
```javascript
const URL_CSV = 'GOOGLE_SHEETS_ID_AQUI';  // Ejemplo: '1A2B3C...'

document.getElementById('btn-cargar-automatico').addEventListener('click', async () => {
    try {
        // Descargar CSV
        const res = await fetch(`/api/drive/download?fileId=${URL_CSV}`);
        const csvText = await res.text();
        
        // Parsear
        const parseRes = await fetch('/api/drive/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ csv: csvText })
        });
        
        const datos = await parseRes.json();
        
        // Usar datos
        crearVistaComercial(datos);  // Tu función
    } catch (error) {
        alert('Error al cargar: ' + error.message);
    }
});
```

## 🎨 Usando en Panorama Comercial

### Antes (con input file):
```html
<input type="file" id="csvFileInput" accept=".csv">
<button id="btn-cargar-automatico">Cargar Informe</button>
```

### Después (solo botón):
```html
<!-- Input para el ID del Drive (opcional) -->
<input type="text" id="googleDriveId" placeholder="ID del Google Sheets">
<button id="btn-cargar-automatico">Cargar Informe</button>
```

## 🔒 Seguridad

### ¿Es seguro compartir el Google Sheets?
- El Google Sheet debe estar **compartido públicamente** o con link accesible
- Cualquiera que tenga el link puede ver los datos
- Para máxima seguridad, usar authentication de Google (futura mejora)

### Consideraciones:
- No guardes datos sensibles en los Google Sheets públicos
- Si necesitas autenticación, implementar OAuth 2.0 de Google
- Para ahora: funciona bien con datos públicos/internos

## 📊 Flujo Completo

```
Usuario
  ↓
  Copia ID del Google Sheets
  ↓
  Pega en input del dashboard
  ↓
  Hace click en "Cargar Informe"
  ↓
Frontend
  ↓
  POST /api/drive/download?fileId=...
  ↓
Google Drive
  ↓
  Devuelve CSV
  ↓
Frontend
  ↓
  POST /api/drive/parse (CSV → JSON)
  ↓
Backend
  ↓
  Devuelve array de objetos
  ↓
Frontend
  ↓
  Renderiza tabla/gráficos
  ↓
Usuario ve datos
```

## 🚀 Próximas Mejoras

- [ ] OAuth 2.0 de Google para autenticación
- [ ] Guardar datos en base de datos
- [ ] Validación de esquema CSV
- [ ] Soporte para Excel .xlsx (además de CSV)
- [ ] Actualización automática cada X minutos
- [ ] Almacenamiento en caché

## 📞 Troubleshooting

### Error: "No se puede descargar"
- ✅ Verifica que el Google Sheets está compartido públicamente
- ✅ Copia correctamente el ID de la URL
- ✅ El ID debe estar entre `/d/` y `/edit`

### Error: "Error parseando CSV"
- ✅ Verifica que la primera fila tiene los headers
- ✅ No debe haber filas vacías entre headers y datos
- ✅ Los campos pueden estar entre comillas si tienen comas

### Datos no se muestran
- ✅ Verifica los logs en el navegador (F12 → Console)
- ✅ Abre Render logs para ver errores del backend
- ✅ Prueba con el archivo `drive-loader.html` primero

## 🎓 Ejemplo Completo

```html
<!DOCTYPE html>
<html>
<head>
    <title>Mi Dashboard</title>
</head>
<body>
    <h1>Dashboard La Campana</h1>
    
    <input type="text" id="driveId" placeholder="ID Google Sheets">
    <button id="cargar">Cargar Informe</button>
    <div id="datos"></div>

    <script>
        document.getElementById('cargar').onclick = async () => {
            const id = document.getElementById('driveId').value;
            const res1 = await fetch(`/api/drive/download?fileId=${id}`);
            const csv = await res1.text();
            
            const res2 = await fetch('/api/drive/parse', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({csv})
            });
            
            const data = await res2.json();
            document.getElementById('datos').innerHTML = 
                `<pre>${JSON.stringify(data, null, 2)}</pre>`;
        };
    </script>
</body>
</html>
```

## ✅ Checklist de Implementación

- [ ] Endpoint `/api/drive/download` funciona
- [ ] Endpoint `/api/drive/parse` funciona
- [ ] Archivo `drive-loader.html` se abre sin errores
- [ ] Puedes cargar un Google Sheets de prueba
- [ ] Los datos se muestran correctamente en la tabla
- [ ] El ID se guarda en localStorage
- [ ] Los datos se pueden usar en tu lógica

¡Listo para integrar en tus dashboards! 🎉
