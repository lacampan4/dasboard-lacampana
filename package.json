// backend/scripts/import-hoja-ruta.js
//
// Carga el export "Hoja de Ruta" (una fila por línea de factura, tal como
// sale de SAP) a Neon: sap_clientes, sap_ventas, sap_cartera.
//
// Uso:
//   cd backend
//   npm install
//   DATABASE_URL="postgres://..." npm run import:hoja-ruta -- /ruta/al/archivo.xls
//   DATABASE_URL="postgres://..." npm run import:hoja-ruta -- /ruta/al/archivo.xls --dry-run
//
// El archivo suele traer extensión .xls pero en realidad es texto plano
// delimitado por TAB en UTF-16 (export directo de SAP GUI). Este script
// detecta el formato automáticamente:
//   - Si empieza con "PK" (zip) -> se trata como .xlsx real (usa la librería xlsx).
//   - Si no -> se decodifica como texto (UTF-16 LE/BE con BOM, o UTF-8/latin1)
//     y se parte por TAB o por coma, lo que encuentre en la primera línea.

import { readFileSync } from 'fs';
import { pool } from '../db.js';

const COLS = {
  cliente: 'Cliente',
  nit: 'Nit',
  ciudad: 'Ciudad',
  departamento: 'Departamento',
  factura: 'Numero de Factura',
  fecha: 'Fecha de Factura',
  plazo: 'Plazo',
  cupoCredito: 'Cupo de Credito',
  cupoUsado: 'Cupo Usado',
  asesor: 'Asesor',
  codigoArticulo: 'Codigo de Articulo',
  articulo: 'Articulo',
  grupo: 'Grupo',
  facturaPagaTotal: 'Factura Paga Total',
  valorPagado: 'Valor Pagado',
  valorTotalArticulo: 'Valor Total Articulo',
  diasMora: 'Dias de Mora',
  kilos: 'Kilos',
  valorKilo: 'Valor Kilo',
  costoKilo: 'Costo Kilo',
  pesoUnitario: 'Peso Unitario'
};

// -------------------------------------------------------------------------
// 1) Lectura del archivo -> filas como array de objetos {header: valor}
// -------------------------------------------------------------------------
function decodeBuffer(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE: swap bytes y decodifica como LE
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  // Sin BOM: heurística simple — si hay muchos bytes \x00 alternados, es UTF-16 LE sin BOM.
  let nullCount = 0;
  for (let i = 1; i < Math.min(buf.length, 2000); i += 2) if (buf[i] === 0) nullCount++;
  if (nullCount > 400) return buf.toString('utf16le');
  return buf.toString('utf8');
}

function parseDelimited(text) {
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.length > 0);
  if (!lines.length) return [];
  const delim = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') ? ';' : ',');
  const headers = lines[0].split(delim).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delim);
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = (cells[idx] ?? '').trim(); });
    rows.push(row);
  }
  return rows;
}

async function readRows(path) {
  const buf = readFileSync(path);
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    // ZIP signature -> .xlsx real. Carga perezosa para no exigir la dependencia
    // si nunca se usa un archivo en este formato.
    const XLSX = await import('xlsx').catch(() => {
      throw new Error('El archivo es un .xlsx real. Instala la dependencia: npm install xlsx');
    });
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  }
  const text = decodeBuffer(buf);
  return parseDelimited(text);
}

// -------------------------------------------------------------------------
// 2) Limpieza de valores
// -------------------------------------------------------------------------
function num(v) {
  if (v === undefined || v === null) return 0;
  const s = String(v).replace(/\./g, m => m).trim(); // no-op, claridad
  const cleaned = String(v).replace(/,/g, '').replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseFechaDDMMYYYY(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const d2 = new Date(s);
  if (!isNaN(d2.getTime())) return d2.toISOString().slice(0, 10);
  return null;
}

function periodoDe(fechaISO) {
  if (!fechaISO) return null;
  return fechaISO.slice(0, 7) + '-01';
}

function parsePlazo(texto) {
  if (!texto) return { dias: null, texto: null };
  const t = String(texto).trim();
  if (/contado/i.test(t)) return { dias: 0, texto: t };
  const m = t.match(/(\d+)/);
  return { dias: m ? parseInt(m[1], 10) : null, texto: t };
}

// -------------------------------------------------------------------------
// 3) Agregación en memoria (el archivo trae una fila por línea de factura;
//    lo agrupamos como necesita cada tabla antes de tocar la base de datos)
// -------------------------------------------------------------------------
function buildAggregates(rows) {
  const clientes = new Map();   // codigo_cliente (nit) -> {..., _lastFecha}
  const ventas = new Map();     // nit|codigo|periodo -> acumulado
  const carteraFacturas = new Map(); // nit|factura -> {...}

  for (const r of rows) {
    const nit = (r[COLS.nit] || '').trim();
    const nombre = (r[COLS.cliente] || '').trim();
    if (!nit || !nombre) continue; // filas sin cliente identificable, se descartan

    const fechaISO = parseFechaDDMMYYYY(r[COLS.fecha]);
    const periodo = periodoDe(fechaISO);

    // --- cliente (datos que son constantes por NIT en el export) ---
    let cli = clientes.get(nit);
    if (!cli) {
      cli = {
        codigo_cliente: nit,
        nombre,
        nit,
        ciudad: r[COLS.ciudad] || null,
        departamento: r[COLS.departamento] || null,
        asesor: r[COLS.asesor] || null,
        plazo_dias: null,
        plazo_texto: null,
        cupo_credito: num(r[COLS.cupoCredito]),
        cupo_usado: num(r[COLS.cupoUsado]),
        _lastFecha: fechaISO || ''
      };
      clientes.set(nit, cli);
    }
    // Asesor y plazo pueden variar entre filas del mismo cliente (cambios de
    // asesor en el periodo); nos quedamos con el de la factura más reciente.
    if (fechaISO && fechaISO >= (cli._lastFecha || '')) {
      cli._lastFecha = fechaISO;
      if (r[COLS.asesor]) cli.asesor = r[COLS.asesor];
      const p = parsePlazo(r[COLS.plazo]);
      cli.plazo_dias = p.dias;
      cli.plazo_texto = p.texto;
    }

    // --- ventas: cliente + articulo + mes ---
    if (periodo) {
      const codigoArticulo = (r[COLS.codigoArticulo] || '').trim();
      if (codigoArticulo) {
        const key = `${nit}|${codigoArticulo}|${periodo}`;
        let v = ventas.get(key);
        if (!v) {
          v = {
            codigo_cliente: nit,
            codigo_articulo: codigoArticulo,
            descripcion: r[COLS.articulo] || null,
            grupo: r[COLS.grupo] || null,
            periodo,
            kg: 0,
            valor_kilo_sum: 0,
            costo_kilo_sum: 0,
            peso_unitario: num(r[COLS.pesoUnitario]) || null,
            n: 0
          };
          ventas.set(key, v);
        }
        v.kg += num(r[COLS.kilos]);
        const vk = num(r[COLS.valorKilo]);
        const ck = num(r[COLS.costoKilo]);
        if (vk) { v.valor_kilo_sum += vk; v.n++; }
        if (ck) v.costo_kilo_sum += ck;
        if (r[COLS.articulo]) v.descripcion = r[COLS.articulo];
        if (r[COLS.grupo]) v.grupo = r[COLS.grupo];
      }
    }

    // --- cartera: facturas con Factura Paga Total = NO ---
    const pagaTotal = (r[COLS.facturaPagaTotal] || '').trim().toUpperCase();
    if (pagaTotal === 'NO') {
      const factura = (r[COLS.factura] || '').trim();
      if (factura) {
        const key = `${nit}|${factura}`;
        let f = carteraFacturas.get(key);
        if (!f) {
          f = {
            codigo_cliente: nit,
            factura,
            fecha_factura: fechaISO,
            dias_vencido: 0,
            valor_articulos_sum: 0,
            valor_pagado: num(r[COLS.valorPagado])
          };
          carteraFacturas.set(key, f);
        }
        f.valor_articulos_sum += num(r[COLS.valorTotalArticulo]);
        const dm = num(r[COLS.diasMora]);
        if (dm > f.dias_vencido) f.dias_vencido = dm;
        if (fechaISO && (!f.fecha_factura || fechaISO < f.fecha_factura)) f.fecha_factura = fechaISO;
      }
    }
  }

  // valor de cartera = total facturado - lo ya pagado (puede ser 0)
  const cartera = [...carteraFacturas.values()].map(f => ({
    codigo_cliente: f.codigo_cliente,
    factura: f.factura,
    fecha_factura: f.fecha_factura,
    dias_vencido: Math.round(f.dias_vencido),
    valor: Math.max(0, f.valor_articulos_sum - f.valor_pagado)
  }));

  const ventasFinal = [...ventas.values()].map(v => ({
    codigo_cliente: v.codigo_cliente,
    codigo_articulo: v.codigo_articulo,
    descripcion: v.descripcion,
    grupo: v.grupo,
    periodo: v.periodo,
    kg: Math.round(v.kg * 100) / 100,
    valor_kilo: v.n ? Math.round((v.valor_kilo_sum / v.n) * 100) / 100 : null,
    costo_kilo: v.n ? Math.round((v.costo_kilo_sum / v.n) * 100) / 100 : null,
    peso_unitario: v.peso_unitario
  }));

  const clientesFinal = [...clientes.values()].map(c => {
    const { _lastFecha, ...rest } = c;
    return rest;
  });

  return { clientes: clientesFinal, ventas: ventasFinal, cartera };
}

// -------------------------------------------------------------------------
// 4) Escritura en Neon (batches con ON CONFLICT ... DO UPDATE)
// -------------------------------------------------------------------------
async function ensureSchema(client) {
  await client.query(`ALTER TABLE sap_clientes ADD COLUMN IF NOT EXISTS plazo_texto VARCHAR(60);`);
}

async function upsertClientes(client, clientes) {
  const sql = `
    INSERT INTO sap_clientes
      (codigo_cliente, nombre, nit, ciudad, departamento, asesor, plazo_dias, plazo_texto, cupo_credito, cupo_usado, sincronizado_en)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
    ON CONFLICT (codigo_cliente) DO UPDATE SET
      nombre=EXCLUDED.nombre, nit=EXCLUDED.nit, ciudad=EXCLUDED.ciudad,
      departamento=EXCLUDED.departamento, asesor=EXCLUDED.asesor,
      plazo_dias=EXCLUDED.plazo_dias, plazo_texto=EXCLUDED.plazo_texto,
      cupo_credito=EXCLUDED.cupo_credito, cupo_usado=EXCLUDED.cupo_usado,
      sincronizado_en=NOW();
  `;
  for (const c of clientes) {
    await client.query(sql, [
      c.codigo_cliente, c.nombre, c.nit, c.ciudad, c.departamento, c.asesor,
      c.plazo_dias, c.plazo_texto, c.cupo_credito, c.cupo_usado
    ]);
  }
}

async function upsertVentas(client, ventas) {
  const sql = `
    INSERT INTO sap_ventas
      (codigo_cliente, codigo_articulo, descripcion, grupo, periodo, kg, valor_kilo, costo_kilo, peso_unitario, sincronizado_en)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
    ON CONFLICT (codigo_cliente, codigo_articulo, periodo) DO UPDATE SET
      descripcion=EXCLUDED.descripcion, grupo=EXCLUDED.grupo, kg=EXCLUDED.kg,
      valor_kilo=EXCLUDED.valor_kilo, costo_kilo=EXCLUDED.costo_kilo,
      peso_unitario=EXCLUDED.peso_unitario, sincronizado_en=NOW();
  `;
  for (const v of ventas) {
    await client.query(sql, [
      v.codigo_cliente, v.codigo_articulo, v.descripcion, v.grupo, v.periodo,
      v.kg, v.valor_kilo, v.costo_kilo, v.peso_unitario
    ]);
  }
}

async function upsertCartera(client, cartera) {
  const sql = `
    INSERT INTO sap_cartera
      (codigo_cliente, factura, fecha_factura, dias_vencido, valor, sincronizado_en)
    VALUES ($1,$2,$3,$4,$5, NOW())
    ON CONFLICT (codigo_cliente, factura) DO UPDATE SET
      fecha_factura=EXCLUDED.fecha_factura, dias_vencido=EXCLUDED.dias_vencido,
      valor=EXCLUDED.valor, sincronizado_en=NOW();
  `;
  for (const f of cartera) {
    await client.query(sql, [f.codigo_cliente, f.factura, f.fecha_factura, f.dias_vencido, f.valor]);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const path = args.find(a => !a.startsWith('--'));
  if (!path) {
    console.error('Uso: node scripts/import-hoja-ruta.js /ruta/al/archivo.xls [--dry-run]');
    process.exit(1);
  }

  console.log(`[import] Leyendo ${path} ...`);
  const rows = await readRows(path);
  console.log(`[import] ${rows.length} filas leídas`);
  if (!rows.length) {
    console.error('[import] El archivo no produjo filas. Revisa el formato/columnas.');
    process.exit(1);
  }
  const missing = Object.values(COLS).filter(c => !(c in rows[0]));
  if (missing.length) {
    console.warn('[import] Aviso: columnas no encontradas en la primera fila:', missing.join(', '));
  }

  const { clientes, ventas, cartera } = buildAggregates(rows);
  console.log(`[import] Agregado: ${clientes.length} clientes, ${ventas.length} combinaciones cliente+articulo+mes, ${cartera.length} facturas en mora`);

  if (dryRun) {
    console.log('[import] --dry-run: no se escribió nada en la base de datos.');
    process.exit(0);
  }

  const client = await pool.connect();
  try {
    console.log('[import] Verificando esquema...');
    await ensureSchema(client);

    console.log('[import] Escribiendo sap_clientes...');
    await upsertClientes(client, clientes);

    console.log('[import] Escribiendo sap_ventas...');
    await upsertVentas(client, ventas);

    console.log('[import] Escribiendo sap_cartera...');
    await upsertCartera(client, cartera);

    await client.query(`
      INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, registros_actualizados, estado)
      VALUES ('hoja_ruta_comercial', NOW(), $1, 'ok')
      ON CONFLICT (tabla) DO UPDATE SET
        ultima_sincronizacion=NOW(), registros_actualizados=EXCLUDED.registros_actualizados, estado='ok';
    `, [clientes.length + ventas.length + cartera.length]);

    console.log('[import] Listo.');
  } catch (err) {
    console.error('[import] Error escribiendo en la base de datos:', err);
    try {
      await client.query(`
        INSERT INTO sap_sync_log (tabla, ultima_sincronizacion, estado, detalle_error)
        VALUES ('hoja_ruta_comercial', NOW(), 'error', $1)
        ON CONFLICT (tabla) DO UPDATE SET ultima_sincronizacion=NOW(), estado='error', detalle_error=EXCLUDED.detalle_error;
      `, [String(err.message || err)]);
    } catch (_) { /* no bloquear el error original */ }
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
