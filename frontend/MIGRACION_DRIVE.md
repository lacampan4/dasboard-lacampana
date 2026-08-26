# Migración: Reemplazar "Actualizar desde SAP" por "Cargar desde Google Drive"

## 📋 Resumen

En cada HTML que uses, necesitas:
1. ❌ Eliminar el botón "ACTUALIZAR DESDE SAP"
2. ✅ Agregar el input para Google Sheets ID
3. ✅ Agregar el botón "CARGAR INFORME"
4. ✅ Cargar el helper JavaScript
5. ✅ Conectar tu función de datos

## 🔧 Pasos para Cada HTML

### PASO 1: Importar el Helper
Agrega esta línea en el `<head>` o antes del `</body>`:
```html
<script src="drive-helper.js"></script>
```

### PASO 2: Reemplazar el Botón SAP

**ANTES:**
```html
<button id="sapSyncBtn">
  <svg>...</svg>
  ACTUALIZAR DESDE SAP
</button>
```

**DESPUÉS:**
```html
<input type="text" 
       id="googleDriveId" 
       placeholder="ID del Google Sheets"
       style="padding: 8px; border: 1px solid #ccc;">

<button id="btn-cargar-automatico">
  Cargar Informe
</button>
```

### PASO 3: Inicializar el Helper

Agrega este código JavaScript (adaptado a tu función):

```javascript
document.addEventListener('DOMContentLoaded', () => {
    // Reemplaza 'tuFuncion' por la que renderiza tus datos
    setupDriveButton('#googleDriveId', (datos) => {
        console.log('Datos cargados:', datos);
        // Aquí llama tu función para dibujar gráficos/tablas
        // Ejemplo: crearVistaPanorama(datos);
    });
});
```

## 📝 Archivos a Actualizar

### ✅ panorama-produccion.html
```javascript
setupDriveButton('#googleDriveId', (datos) => {
    crearVistaPanorama(datos);
});
```

### ✅ panorama-comercial.html
```javascript
setupDriveButton('#googleDriveId', (datos) => {
    crearVistaComercial(datos);
});
```

### ✅ hoja-asesor.html
```javascript
setupDriveButton('#googleDriveId', (datos) => {
    crearHojaAsesor(datos);
});
```

### ✅ hoja-cliente.html
```javascript
setupDriveButton('#googleDriveId', (datos) => {
    crearHojaCliente(datos);
});
```

### (Repite para otros...)

## 🎯 Ejemplo Completo

```html
<!DOCTYPE html>
<html>
<head>
    <title>Mi Dashboard</title>
</head>
<body>
    <h1>Dashboard La Campana</h1>
    
    <!-- Input y Botón -->
    <input type="text" 
           id="googleDriveId" 
           placeholder="Pega aquí ID del Google Sheets">
    
    <button id="btn-cargar-automatico">Cargar Informe</button>
    
    <!-- Área de datos -->
    <div id="panorama"></div>

    <!-- Helper -->
    <script src="drive-helper.js"></script>
    
    <!-- Tu código -->
    <script>
        function crearVista(datos) {
            console.log('Datos:', datos);
            // Tu lógica aquí
        }

        document.addEventListener('DOMContentLoaded', () => {
            setupDriveButton('#googleDriveId', crearVista);
        });
    </script>
</body>
</html>
```

## 🔄 Flujo Completo

```
Usuario
  ↓
Input: Pega ID Google Sheets
  ↓
Click: Botón "Cargar Informe"
  ↓
drive-helper.js
  ↓
Backend /api/drive/download
  ↓
Backend /api/drive/parse
  ↓
Llama tu función: crearVista(datos)
  ↓
Tus gráficos se actualizan
```

## 📌 Notas Importantes

1. **ID del Google Sheets:**
   - URL: `https://docs.google.com/spreadsheets/d/1A2B3C4D.../edit`
   - ID: `1A2B3C4D...` (entre `/d/` y `/edit`)

2. **El CSV debe tener:**
   - Primera fila: Headers (nombres de columnas)
   - Siguientes filas: Datos

3. **Llamar tu función:**
   - Cambia `crearVista` por tu función real
   - Recibirá array de objetos JSON

4. **Almacenamiento:**
   - El ID se guarda en localStorage automáticamente

## ✅ Checklist

- [ ] Agregué `<script src="drive-helper.js"></script>`
- [ ] Reemplacé el botón SAP por input + button
- [ ] Inicialicé `setupDriveButton()`
- [ ] Agregué mi función callback
- [ ] Probé con un Google Sheets público
- [ ] Los datos se muestran correctamente

## 🆘 Troubleshooting

**Error: "btn-cargar-automatico not found"**
- Verifica que el button tenga exactamente id="btn-cargar-automatico"

**Error: "No se puede descargar"**
- Verifica que el Google Sheets está compartido públicamente
- Copia correctamente el ID de la URL

**Los datos no llegan a mi función**
- Abre F12 → Console para ver logs
- Verifica que el callback está correctamente nombrado

## 🚀 Siguiente Paso

1. Elige un HTML para empezar (ej: panorama-comercial.html)
2. Haz los cambios según los pasos arriba
3. Prueba cargando un Google Sheets
4. Repite con los demás archivos

¡Haz como si estuvieras haciendo un copy-paste estructurado! 📋
