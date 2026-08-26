# Dashboard La Campana

Dashboard de panorama de producción y facturación conectado a SAP.

## 🚀 Quick Start

### En Render

1. **Configura variables de entorno** en el dashboard de Render:
   - Ver archivo `SETUP.md` para valores exactos
   - Variables más importantes:
     - `SAP_SERVICE_URL`
     - `SAP_USER`
     - `SAP_PASS`
     - `DATABASE_URL`
     - `JWT_SECRET`

2. **Redeploy** el servicio backend

3. **Verifica** los logs para mensajes `[SAP] Conexión exitosa`

### En Local

```bash
cd backend
npm install
npm run dev
```

Requiere `.env` con variables configuradas (ver `.env.example`)

## 📊 Dashboards

| Dashboard | Propósito |
|-----------|-----------|
| Panorama Producción | Vista general de producción desde SAP |
| Hoja de Asesor | Datos de asesoría |
| Hoja de Cliente | Datos del cliente |
| Labor Comercial | Información comercial |
| Portafolio y Cartera | Análisis de portafolio |
| Planeación Nogales | Planeación de Nogales |

## 🔧 Stack

- **Frontend**: HTML5 + JavaScript vanilla
- **Backend**: Express.js (Node.js)
- **Base de Datos**: PostgreSQL (Neon en producción)
- **Autenticación**: JWT
- **Datos**: SAP OData v4

## 📝 Configuración

### Variables de Entorno Requeridas

```env
# SAP
SAP_SERVICE_URL=https://170.239.154.46:4300/api_campana26/facturacion.xsodata/Facturacion
SAP_USER=B1ADMIN
SAP_PASS=contraseña

# Base de datos
DATABASE_URL=postgresql://...

# Autenticación
JWT_SECRET=tu_secret

# Admin (opcional)
SEED_ON_BOOT=false
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme123
```

Ver `backend/.env.example` para template completo.

## 🔄 Integración con SAP

### Endpoint de Producción

```
GET /api/produccion?inicio=2026-08-01&fin=2026-08-25
POST /api/sap/sync/produccion?inicio=2026-08-01&fin=2026-08-25
```

**Respuesta:**
```json
[
  {
    "id": "123",
    "Fecha_Factura": "/Date(1703030400000)/",
    "monto": 100000
  }
]
```

### Características

✅ Reintentos automáticos (3 intentos)  
✅ Timeout de 30 segundos  
✅ Soporte para certificados HTTPS autofirmados  
✅ Logs detallados para debugging  
✅ Manejo específico de errores 503, 502, etc.  

## 📚 Documentación Adicional

- `SETUP.md` - Instrucciones de deployment paso a paso
- `SAP_CONFIG.md` - Configuración detallada de SAP
- `backend/.env.example` - Variables de entorno

## 🐛 Troubleshooting

### Error HTTP 503 desde SAP

1. Verifica que `SAP_SERVICE_URL`, `SAP_USER`, `SAP_PASS` están configuradas
2. Confirma que el servidor SAP `170.239.154.46:4300` está disponible
3. Revisa logs en Render (busca `[SAP]`)
4. El sistema reintentar automáticamente 3 veces

### Error de certificado

✅ El backend ya soporta certificados autofirmados de SAP

### Timeout

Verifica si SAP está respondiendo lentamente. El timeout es de 30 segundos.

## 👨‍💻 Desarrollo

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend
cd frontend
# Sirve archivos estáticos desde backend
```

## 📦 Deployment

Usar Render con el archivo `Dockerfile` incluido.

Variables de entorno se configuran en Render Dashboard.

## ✅ Checklist Pre-Production

- [ ] SAP_SERVICE_URL está configurada
- [ ] SAP_USER y SAP_PASS son correctas
- [ ] DATABASE_URL apunta a Neon
- [ ] JWT_SECRET es seguro y largo
- [ ] CORS_ORIGIN si frontend está en dominio diferente
- [ ] Redeploy después de cambiar variables

## 📞 Soporte

Revisa los logs en Render Dashboard para mensajes de error específicos.

Busca líneas que comiencen con `[SAP]` para debugging de conexión.
