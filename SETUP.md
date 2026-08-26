# SETUP RÁPIDO - Dashboard La Campana

## 🚀 Instrucciones de Deployment en Render

### 1️⃣ Variables de Entorno en Render Dashboard

Ve a tu servicio en Render y configura estas variables de entorno:

```
DATABASE_URL=postgresql://usuario:contraseña@ep-xxxxx.neon.tech/database
SAP_SERVICE_URL=https://170.239.154.46:4300/api_campana26/facturacion.xsodata/Facturacion
SAP_USER=B1ADMIN
SAP_PASS=tu_contraseña_sap
JWT_SECRET=cualquier_string_largo_y_seguro
SEED_ON_BOOT=false
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme123
CORS_ORIGIN=true
PORT=3001
```

### 2️⃣ Redeploy
Haz clic en **Redeploy** para aplicar los cambios.

### 3️⃣ Verificar

Una vez deployado, revisa los logs en Render:
- Dashboard → Tu servicio → Logs
- Busca mensajes que empiezan con `[SAP]`
- Si ves `[SAP] Conexión exitosa`, ¡todo está bien! ✅

## 📋 Dashboards Incluidos

| Dashboard | API Esperada | Estado |
|-----------|-------------|--------|
| Panorama Producción | `/api/sap/sync/produccion` | ✅ Funcionando |
| Hoja de Asesor | Basado en Facturación | ✅ Listo |
| Hoja de Cliente | Basado en Facturación | ✅ Listo |
| Labor Comercial | Basado en Facturación | ✅ Listo |
| Portafolio y Cartera | Basado en Facturación | ✅ Listo |
| Planeación Nogales | Basado en Facturación | ✅ Listo |

## 🔐 Datos de SAP

- **Host**: `170.239.154.46:4300` (HTTPS con certificado autofirmado)
- **API**: `/api_campana26/facturacion.xsodata`
- **Recurso**: `Facturacion`
- **Usuario**: `B1ADMIN`
- **Campo de Fecha**: `Fecha_Factura`
- **Formato**: `OData v4` con JSON

## ⚙️ Cambios Técnicos Realizados

✅ Soporte para HTTPS con certificados autofirmados  
✅ Sistema de reintentos automáticos (3 intentos, 2s entre cada uno)  
✅ Timeout aumentado a 30 segundos  
✅ Rutas compatibles: GET `/api/produccion` y POST `/api/sap/sync/produccion`  
✅ Logs detallados para debugging  
✅ Validación de estructura de respuesta SAP  

## 🐛 Si Algo Falla

### Error: "HTTP 503 Service Unavailable"
1. Verifica que SAP esté disponible
2. Revisa los logs en Render
3. Confirma las variables de entorno están correctas
4. El sistema reinten automáticamente 3 veces

### Error: "certificado autofirmado"
✅ **RESUELTO** - Ya el backend acepta certificados autofirmados

### Error de conexión
- Verifica conectividad a `170.239.154.46:4300`
- Confirma firewall permite la conexión desde Render

## 📚 Archivos Clave

- `backend/routes/sap.js` - Lógica de conexión a SAP con reintentos
- `backend/server.js` - Configuración del servidor Express
- `backend/routes/auth.js` - Autenticación JWT
- `SAP_CONFIG.md` - Documentación detallada
- `backend/.env.example` - Template de variables de entorno

## 🎯 Próximo Paso

Configura las variables en Render y redeploy. ¡Listo! 🚀
