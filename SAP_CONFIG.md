# Configuración de Conexión a SAP - Solución para Error HTTP 503

## Información del Sistema SAP

**URL Base:** `https://170.239.154.46:4300`  
**API:** `/api_campana26/facturacion.xsodata`  
**Usuario:** `B1ADMIN`  
**Host interno:** `NDB.n00.CAMPANADB02:4300`

### Ejemplo de Consulta
```
GET https://170.239.154.46:4300/api_campana26/facturacion.xsodata/Facturacion?$filter=Fecha_Factura ge datetime'2026-08-01' and Fecha_Factura le datetime'2026-08-25'&$format=json
```

## Problemas Identificados y Solucionados

### 1. **Archivo corrupto `backend/routes/sap.js`**
- ✅ El archivo tenía código duplicado (router de SAP + router de auth pegado)
- ✅ Limpiado y reorganizado correctamente

### 2. **Mismatch de rutas**
- ❌ Frontend esperaba: `POST /api/sap/sync/produccion?inicio=...&fin=...`
- ❌ Backend respondía en: `GET /api/produccion?inicio=...&fin=...`
- ✅ Ambas rutas ahora funcionan correctamente

### 3. **Certificado HTTPS autofirmado de SAP**
- ❌ SAP usa HTTPS con certificado autofirmado (IP interna)
- ✅ Agregado `httpsAgent` que acepta certificados autofirmados
- ✅ Manejo específico de errores de TLS

### 4. **Timeout insuficiente**
- ❌ Timeout original: 10 segundos
- ✅ Timeout actualizado: 30 segundos
- ✅ Agregados reintentos automáticos (3 intentos con 2 segundos entre ellos)

### 5. **Manejo de errores mejorado**
- ✅ Logs detallados de errores 503, 502, timeouts, errores de TLS, etc.
- ✅ Mensajes de error más descriptivos al cliente
- ✅ Validación de estructura de respuesta SAP

## Variables de Entorno Requeridas

En Render o Vercel, configura estas variables de entorno:

```env
# Base de datos (Neon)
DATABASE_URL=postgresql://usuario:contraseña@host/database

# SAP OData Service
SAP_SERVICE_URL=https://170.239.154.46:4300/api_campana26/facturacion.xsodata/Facturacion
SAP_USER=B1ADMIN
SAP_PASS=tu_contraseña_sap_aqui

# JWT
JWT_SECRET=tu_secret_seguro_aqui

# Admin (opcional, para seed inicial)
SEED_ON_BOOT=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=tu_contraseña_admin

# CORS (si se despliega por separado)
CORS_ORIGIN=https://tu-frontend-domain.com
```

## Detalles de Implementación

### Reintentos Automáticos
Cuando ocurren errores temporales (HTTP 5xx, timeouts, certificado):
1. Primer intento
2. Espera 2 segundos → Segundo intento
3. Espera 2 segundos → Tercer intento
4. Si falla, retorna error al cliente

### Certificados Autofirmados
El backend ahora acepta certificados HTTPS autofirmados de SAP gracias a:
```javascript
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});
```

### Logs en el Servidor
Para debugging, revisa los logs en tu plataforma de deployment:

```
[SAP] Intentando conexión a: https://170.239.154.46:4300/api_campana26/... (intento 1/3)
[SAP] Error: HTTP 503 Service Unavailable
[SAP] Código: 503
[SAP] Reintentando en 2000ms...
[SAP] Intentando conexión a: https://170.239.154.46:4300/api_campana26/... (intento 2/3)
[SAP] Conexión exitosa
```

## Validación de la Configuración

### 1. Verificar Variables de Entorno en Render
```bash
# En la terminal de Render
echo $SAP_SERVICE_URL
echo $SAP_USER
```

### 2. Probar la Conexión Manualmente
```bash
# Desde tu máquina local (con variables configuradas)
# Nota: El certificado es autofirmado, así que curl necesita -k
curl -k -u "B1ADMIN:contraseña" \
  "https://170.239.154.46:4300/api_campana26/facturacion.xsodata/Facturacion?$filter=Fecha_Factura ge datetime'2026-08-01'&$format=json"
```

### 3. Verificar Logs en Deployment
- **Render**: Dashboard → Logs
- **Vercel**: Deployments → View logs
- Busca líneas que comiencen con `[SAP]`

## Estructura de Respuesta Esperada de SAP

El backend espera que SAP responda en este formato:

```json
{
  "d": {
    "results": [
      {
        "id": "123",
        "Fecha_Factura": "/Date(1703030400000)/",
        "monto": 100000,
        ...
      }
    ]
  }
}
```

Si SAP retorna un formato diferente, el backend lo adaptará automáticamente.

## Troubleshooting

### Error: "SAP respondió HTTP 503"
1. ✅ Verifica que `SAP_SERVICE_URL`, `SAP_USER`, `SAP_PASS` estén configuradas
2. ✅ Confirma que el servidor SAP está en línea: ping a `170.239.154.46:4300`
3. ✅ Verifica que las credenciales de SAP sean correctas
4. ✅ Revisa los logs en Render/Vercel para mensajes de error específicos

### Error: "conexión rechazada"
- El host SAP no está disponible o la URL es incorrecta
- Verifica que el servidor `170.239.154.46:4300` esté accesible desde Render/Vercel
- Posible problema de firewall o red

### Error: "certificado TLS inválido"
- ✅ **RESUELTO** - El backend ahora acepta certificados autofirmados
- Si aún falla, revisa si la IP ha cambiado

### Timeout (después de 30 segundos)
- SAP está muy lento o no responde
- Verifica el status del servicio SAP
- Considera aumentar el timeout en `backend/routes/sap.js` (línea: `timeout: 30000`)

## Cambios Realizados

### Archivo: `backend/routes/sap.js`
- [x] Eliminado código duplicado
- [x] Aumentado timeout de 10s a 30s
- [x] Implementado sistema de reintentos (3 intentos)
- [x] Agregadas rutas POST `/api/sap/sync/produccion`
- [x] **[NUEVO]** Soporte para certificados HTTPS autofirmados
- [x] Mejorado manejo de errores con logs detallados
- [x] Validación de estructura de respuesta SAP

### Archivo: `backend/server.js`
- Ya está correctamente configurado (no requería cambios)

### Archivo: `backend/routes/auth.js`
- Sin cambios requeridos

## Próximas Mejoras (Opcionales)

- [ ] Agregar caché de datos de SAP con expiración
- [ ] Implementar rate limiting para SAP
- [ ] Agregar métricas de disponibilidad de SAP
- [ ] Notificaciones cuando SAP no esté disponible
- [ ] Validar formato de fecha según lo que espera SAP

