-- =========================================================================
-- Esquema de base de datos - Panorama La Campana
-- Cache de datos de SAP para todos los paneles (Neon / PostgreSQL)
-- Ejecutar completo en el SQL Editor de Neon.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 0) Usuarios (login) — ya existente, se conserva igual
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(80) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(30) NOT NULL DEFAULT 'user',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);


-- -------------------------------------------------------------------------
-- 1) PRODUCCIÓN (IPN) — Panorama Producción / Producción Diaria
--    Espejo del export IPN que hoy se sube por Excel.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sap_produccion (
  id BIGSERIAL PRIMARY KEY,
  fecha DATE NOT NULL,
  codigo_almacen VARCHAR(20),
  nombre_usuario VARCHAR(120),
  grupo VARCHAR(120),
  maquina VARCHAR(120),
  codigo_articulo VARCHAR(40) NOT NULL,
  articulo VARCHAR(255),
  cantidad_kg NUMERIC(14,2) NOT NULL DEFAULT 0,
  comentarios TEXT,               -- N° de planilla / orden
  sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_produccion_fecha ON sap_produccion (fecha);
CREATE INDEX IF NOT EXISTS idx_produccion_maquina ON sap_produccion (maquina);
CREATE INDEX IF NOT EXISTS idx_produccion_articulo ON sap_produccion (codigo_articulo);
CREATE INDEX IF NOT EXISTS idx_produccion_almacen ON sap_produccion (codigo_almacen);

-- Catálogo de máquinas y metas (config de la app, no viene de SAP)
CREATE TABLE IF NOT EXISTS maquinas (
  id BIGSERIAL PRIMARY KEY,
  nombre VARCHAR(120) UNIQUE NOT NULL,
  tipo VARCHAR(40),                       -- ej. 'corte' | 'transformacion'
  meta_kg_mes NUMERIC(14,2) NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT TRUE
);

-- Diccionario: código de artículo -> máquina (para cuando SAP no trae 'Maquina')
CREATE TABLE IF NOT EXISTS articulo_maquina_map (
  codigo_articulo VARCHAR(40) PRIMARY KEY,
  maquina_id BIGINT REFERENCES maquinas(id) ON DELETE SET NULL
);


-- -------------------------------------------------------------------------
-- 2) COMERCIAL — Clientes / Ventas / Cartera / Inventario
--    Usado por: Comercial, Portafolio, Asesor, Ruta Cliente, Planeación Nogales
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sap_clientes (
  codigo_cliente VARCHAR(40) PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL,
  nit VARCHAR(30),
  ciudad VARCHAR(120),
  departamento VARCHAR(120),
  asesor VARCHAR(120),
  plazo_dias INT,
  plazo_texto VARCHAR(60),
  cupo_credito NUMERIC(16,2) DEFAULT 0,
  cupo_usado NUMERIC(16,2) DEFAULT 0,
  sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clientes_asesor ON sap_clientes (asesor);

CREATE TABLE IF NOT EXISTS sap_ventas (
  id BIGSERIAL PRIMARY KEY,
  codigo_cliente VARCHAR(40) REFERENCES sap_clientes(codigo_cliente) ON DELETE CASCADE,
  codigo_articulo VARCHAR(40) NOT NULL,
  descripcion VARCHAR(255),
  grupo VARCHAR(120),
  periodo DATE NOT NULL,          -- primer día del mes, ej. 2026-01-01
  kg NUMERIC(14,2) NOT NULL DEFAULT 0,
  valor_kilo NUMERIC(14,2),
  costo_kilo NUMERIC(14,2),
  peso_unitario NUMERIC(10,3),
  sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (codigo_cliente, codigo_articulo, periodo)
);
CREATE INDEX IF NOT EXISTS idx_ventas_periodo ON sap_ventas (periodo);
CREATE INDEX IF NOT EXISTS idx_ventas_articulo ON sap_ventas (codigo_articulo);
CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON sap_ventas (codigo_cliente);
CREATE INDEX IF NOT EXISTS idx_ventas_grupo ON sap_ventas (grupo);

CREATE TABLE IF NOT EXISTS sap_cartera (
  id BIGSERIAL PRIMARY KEY,
  codigo_cliente VARCHAR(40) REFERENCES sap_clientes(codigo_cliente) ON DELETE CASCADE,
  factura VARCHAR(40) NOT NULL,
  fecha_factura DATE,
  dias_vencido INT NOT NULL DEFAULT 0,
  valor NUMERIC(16,2) NOT NULL DEFAULT 0,
  sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (codigo_cliente, factura)
);
CREATE INDEX IF NOT EXISTS idx_cartera_cliente ON sap_cartera (codigo_cliente);
CREATE INDEX IF NOT EXISTS idx_cartera_dias ON sap_cartera (dias_vencido);

CREATE TABLE IF NOT EXISTS sap_inventario (
  codigo_articulo VARCHAR(40) PRIMARY KEY,
  descripcion VARCHAR(255),
  grupo VARCHAR(120),
  stock_kg NUMERIC(14,2) NOT NULL DEFAULT 0,
  sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inventario_grupo ON sap_inventario (grupo);


-- -------------------------------------------------------------------------
-- 3) DESPACHO — facturas del día (export VF05N)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sap_despacho_facturas (
  id BIGSERIAL PRIMARY KEY,
  factura VARCHAR(40) NOT NULL,
  fecha DATE NOT NULL,
  codigo_cliente VARCHAR(40),
  cliente VARCHAR(255),
  direccion VARCHAR(255),
  asesor VARCHAR(120),
  correo VARCHAR(160),
  codigo_articulo VARCHAR(40),
  texto_breve VARCHAR(255),
  grupo VARCHAR(120),
  cantidad NUMERIC(14,2),
  kilos NUMERIC(14,2),
  sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_despacho_fecha ON sap_despacho_facturas (fecha);
CREATE INDEX IF NOT EXISTS idx_despacho_cliente ON sap_despacho_facturas (codigo_cliente);
CREATE INDEX IF NOT EXISTS idx_despacho_factura ON sap_despacho_facturas (factura);

-- Flota de vehículos usada en Hoja de Despacho (config de la app)
CREATE TABLE IF NOT EXISTS flota_vehiculos (
  id BIGSERIAL PRIMARY KEY,
  placa VARCHAR(10) UNIQUE NOT NULL,
  descripcion VARCHAR(255)
);


-- -------------------------------------------------------------------------
-- 4) SEDE — stock por sede para sugerir surtido
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sap_inventario_sede (
  id BIGSERIAL PRIMARY KEY,
  sede VARCHAR(120) NOT NULL,
  codigo_articulo VARCHAR(40) NOT NULL,
  descripcion VARCHAR(255),
  stock_kg NUMERIC(14,2) DEFAULT 0,
  stock_unidades NUMERIC(14,2) DEFAULT 0,
  sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sede, codigo_articulo)
);
CREATE INDEX IF NOT EXISTS idx_invsede_sede ON sap_inventario_sede (sede);
CREATE INDEX IF NOT EXISTS idx_invsede_articulo ON sap_inventario_sede (codigo_articulo);

-- Parámetros de reposición por sede (config de la app)
CREATE TABLE IF NOT EXISTS sede_config (
  sede VARCHAR(120) PRIMARY KEY,
  metodo VARCHAR(20) NOT NULL DEFAULT 'dias_cobertura', -- 'dias_cobertura' | 'pct_venta'
  min_valor NUMERIC(10,2) NOT NULL DEFAULT 15,
  max_valor NUMERIC(10,2) NOT NULL DEFAULT 30,
  prioridad INT NOT NULL DEFAULT 0,
  meses_promedio INT NOT NULL DEFAULT 6
);


-- -------------------------------------------------------------------------
-- 5) COSTOS DE PRODUCCIÓN — parámetros de costeo (materia prima, mano de
--    obra, CIF, energía). Estos valores normalmente se digitan/ajustan en
--    la app y se combinan con sap_produccion para calcular costo por kg.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS costos_config (
  id BIGSERIAL PRIMARY KEY,
  periodo DATE NOT NULL,              -- mes al que aplica el costeo
  grupo VARCHAR(120),                 -- opcional: por grupo de producto
  costo_materia_prima_kg NUMERIC(14,2) DEFAULT 0,
  costo_mano_obra_kg NUMERIC(14,2) DEFAULT 0,
  costo_cif_kg NUMERIC(14,2) DEFAULT 0,
  costo_energia_kwh NUMERIC(14,4) DEFAULT 0,
  sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (periodo, grupo)
);


-- -------------------------------------------------------------------------
-- 6) Registro de sincronización — para saber cuándo se refrescó cada caché
--    y evitar golpear SAP en cada carga de página.
-- -------------------------------------------------------------------------
-- Por si sap_clientes ya existía de una corrida anterior sin esta columna.
ALTER TABLE sap_clientes ADD COLUMN IF NOT EXISTS plazo_texto VARCHAR(60);


CREATE TABLE IF NOT EXISTS sap_sync_log (
  tabla VARCHAR(60) PRIMARY KEY,
  ultima_sincronizacion TIMESTAMPTZ,
  registros_actualizados INT DEFAULT 0,
  estado VARCHAR(20) DEFAULT 'ok',     -- 'ok' | 'error'
  detalle_error TEXT
);
