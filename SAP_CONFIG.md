# Configuración de Conexión a SAP - Solución para Error HTTP 503

## Problema Original
El proyecto estaba retornando el error: `"No se pudo actualizar desde SAP: SAP respondió HTTP 503"`

## Problemas Identificados y Solucionados

### 1. **Archivo corrupto `backend/routes/sap.js`**
- ✅ El archivo tenía código duplicado (router de SAP + router de auth pegado)
- ✅ Limpiado y reorganizado correctamente

### 2. **Mismatch de rutas**
- ❌ Frontend esperaba: `POST /api/sap/sync/produccion?inicio=...&fin=...`
- ❌ Backend respondía en: `GET /api/produccion?inicio=...&fin=...`
- ✅ Ambas rutas ahora funcionan correctamente

### 3. **Timeout insuficiente**
- ❌ Timeout original: 10 segundos
- ✅ Timeout actualizado: 30 segundos
- ✅ Agregados reintentos automáticos (3 intentos con 2 segundos entre ellos)

### 4. **Manejo de errores mejorado**
- ✅ Logs detallados de errores 503, 502, timeouts, etc.
- ✅ Mensajes de error más descriptivos al cliente
- ✅ Validación de estructura de respuesta SAP

## Variables de Entorno Requeridas

En Render o Vercel, configura estas variables de entorno:

```env
# Base de datos (Neon)
DATABASE_URL=postgresql://usuario:contraseña@host/database

# SAP OData Service
SAP_SERVICE_URL=https://tu-sap-odata-endpoint/path/to/service   # Ej: https://sap.tucompania.com/odata/v4/Produccion
SAP_USER=tu_usuario_sap
SAP_PASS=tu_contraseña_sap

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
Cuando ocurren errores temporales (HTTP 5xx, timeouts, conexión rechazada):
1. Primer intento
2. Espera 2 segundos → Segundo intento
3. Espera 2 segundos → Tercer intento
4. Si falla, retorna error al cliente

### Logs en el Servidor
Para debugging, revisa los logs en tu plataforma de deployment:

```
[SAP] Intentando conexión a: https://sap... (intento 1/3)
[SAP] Error: HTTP 503 Service Unavailable
[SAP] Reintentando en 2000ms...
[SAP] Intentando conexión a: https://sap... (intento 2/3)
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
curl -u "usuario_sap:contraseña_sap" \
  "https://sap.com/odata/v4/Produccion?$filter=Fecha ge datetime'2024-01-01T00:00:00'&$format=json"
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
        "Fecha": "/Date(1703030400000)/",
        "cantidad": 100,
        ...
      }
    ]
  }
}
```

Si SAP retorna un formato diferente, el backend lo adaptará automáticamente.

## Troubleshooting

### Error: "SAP respondió HTTP 503"
1. Verifica que `SAP_SERVICE_URL`, `SAP_USER`, `SAP_PASS` estén configuradas
2. Confirma que el servidor SAP está en línea
3. Verifica que las credenciales de SAP sean correctas
4. Revisa los logs en Render/Vercel para mensajes de error específicos

### Error: "conexión rechazada"
- El host SAP no está disponible o la URL es incorrecta
- Verifica la URL con `ping` o `curl`

### Error: "no se pudo resolver el host"
- El dominio SAP es inválido
- Verifica la URL en tu navegador o con `nslookup`

### Timeout (después de 30 segundos)
- SAP está muy lento
- Verifica el status del servicio SAP
- Considera aumentar el timeout en `backend/routes/sap.js` (línea: `timeout: 30000`)

## Cambios Realizados

### Archivo: `backend/routes/sap.js`
- [x] Eliminado código duplicado
- [x] Aumentado timeout de 10s a 30s
- [x] Implementado sistema de reintentos (3 intentos)
- [x] Agregadas rutas POST `/api/sap/sync/produccion`
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
