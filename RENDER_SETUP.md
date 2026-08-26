# Configuración en Render - Dashboard La Campana

## 📋 Pasos para Configurar el Proyecto en Render

### 1. Accede al Dashboard de Render

1. Ve a [https://dashboard.render.com](https://dashboard.render.com)
2. Selecciona tu servicio `panorama-produccion-auth` (o similar)
3. Haz clic en la pestaña **Environment**

### 2. Agrega Variables de Entorno

Copia y pega estas variables en la sección "Environment Variables":

#### Variables SAP (IMPORTANTE ⚠️)
```
SAP_SERVICE_URL
Valor: https://170.239.154.46:4300/api_campana26/facturacion.xsodata/Facturacion

SAP_USER
Valor: B1ADMIN

SAP_PASS
Valor: [Tu contraseña de SAP]
```

#### Base de Datos
```
DATABASE_URL
Valor: [Tu URL de Neon PostgreSQL]
Ejemplo: postgresql://user:pass@ep-xxxxx.neon.tech/dbname
```

#### Autenticación
```
JWT_SECRET
Valor: [Genera un string largo y seguro - puede ser cualquier valor complejo]
Ejemplo: aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zAbCdEfGhI
```

#### Admin Inicial (opcional)
```
SEED_ON_BOOT
Valor: false

ADMIN_USERNAME
Valor: admin

ADMIN_PASSWORD
Valor: changeme123
```

#### Otros
```
CORS_ORIGIN
Valor: true

PORT
Valor: 3001
```

### 3. Guardar y Redeploy

1. Haz clic en **Save Changes**
2. Render te preguntará si quieres redeploy - haz clic en **Yes, deploy now**
3. Espera a que termine (2-5 minutos aproximadamente)

### 4. Verificar que Funciona

1. Una vez deployado, haz clic en **Logs**
2. Busca mensajes como:
   ```
   [SAP] Intentando conexión a: https://170.239.154.46:4300/api_campana26...
   [SAP] Conexión exitosa
   ```
3. Si ves esto, ¡está funcionando! ✅

## 🔍 Troubleshooting en Render

### Error: "Variables de entorno no configuradas"
- Verifica que todas las variables SAP estén guardadas
- Redeploy después de guardar
- Espera 1-2 minutos a que el deploy termine

### Error: "HTTP 503 Service Unavailable"
1. Verifica que SAP está disponible:
   - Accede a `https://170.239.154.46:4300/` desde tu máquina
   - Si no puedes, SAP está down
2. Confirma credenciales (SAP_USER y SAP_PASS)
3. El sistema reintentar automáticamente 3 veces
4. Revisa logs para `[SAP]` mensajes

### Error: "certificado SSL"
✅ **RESUELTO** - El backend ya acepta certificados autofirmados

### Logs no muestran nada
- Espera a que termine el deploy completo
- Refresca la página
- Si persiste, haz click en **Restart** en la parte superior

## 📊 Verificar Configuración

Desde la terminal, puedes verificar que las variables están correctas:

```bash
# En Render dashboard, abre la consola del servicio
curl https://tu-servicio-render.onrender.com/api/health

# Deberías ver:
# {"ok":true,"service":"panorama-produccion"}
```

## 🚀 Test de Conexión a SAP

Una vez deployado, prueba accediendo a:

```
https://tu-servicio-render.onrender.com/api/produccion?inicio=2026-08-01&fin=2026-08-25
```

**Con autenticación mínima** (si es necesario desde frontend, tendrás que pasar token)

## 📝 Notas Importantes

1. **SAP está en red interna** (170.239.154.46) - Render podrá acceder si está en la misma red VPN/firewall
2. **Certificado autofirmado** - No hay problema, ya está soportado
3. **Reintentos automáticos** - Si SAP falla temporalmente, reintentar 3 veces
4. **Timeout 30 segundos** - Suficiente para SAP OData

## ✅ Checklist Final

- [ ] SAP_SERVICE_URL está configurada correctamente
- [ ] SAP_USER = B1ADMIN
- [ ] SAP_PASS es correcta
- [ ] DATABASE_URL apunta a Neon
- [ ] JWT_SECRET está configurado (valor largo)
- [ ] Deploy finalizó correctamente
- [ ] Logs muestran `[SAP] Conexión exitosa` ✅

## 🆘 Si Aún No Funciona

1. Revisa los **logs en tiempo real** en Render
2. Busca líneas con `[SAP]` para ver qué está pasando
3. Si ves `[SAP] Error: HTTP 503`, SAP está respondiendo pero no disponible
4. Si ves `[SAP] Reintentando`, significa que está reinintentando automáticamente
5. Si no ves líneas `[SAP]`, verifica que las variables estén guardadas

## 📞 Soporte Rápido

- **Render Dashboard**: https://dashboard.render.com
- **SAP Acceso**: https://170.239.154.46:4300 (desde tu red)
- **Documentación**: Ver `SAP_CONFIG.md` en el repositorio
