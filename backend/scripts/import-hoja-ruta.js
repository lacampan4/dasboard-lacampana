/**
 * Importa el export "Hoja de Ruta" (CSV de SAP) hacia Neon/Postgres,
 * llenando sap_clientes, sap_ventas y sap_cartera (ver database/schema.sql).
 *
 * Uso:
 *   node scripts/import-hoja-ruta.js /ruta/al/archivo.csv
 *   node scripts/import-hoja-ruta.js /ruta/al/archivo.csv --dry-run
 *
 * Requiere la variable de entorno DATABASE_URL (la misma que usa db.js).
 * Con --dry-run NO se conecta a la base: solo procesa el archivo y muestra
 * cuántos clientes/ventas/facturas encontró, para verificar el mapeo antes
 * de tocar datos reales.
 *
 * Columnas esperadas del CSV (en este orden):
 * #, Cliente, Nit, Ciudad, Departamento, CIIU, Numero de Factura,
 * Fecha de Factura, Plazo, Cupo de Credito, Cupo Usado, Asesor,
 * Meta Anual Asesor, Sede, Meta Anual Sede, Nombre Almacen,
 * Codigo de Articulo, Articulo, Grupo, Meta Anual Grupo,
 * Factura Paga Total, Valor Pagado, Valor Total Articulo, Dias de Mora,
 * Kilos, Valor Kilo, Costo Kilo, Peso Unitario
 *
 * Notas sobre el mapeo (revísalas contra tu SAP real antes de confiar
 * ciegamente en la cartera):
 *  - codigo_cliente en la base = Nit (si viene vacío, se usa el nombre
 *    del cliente tal cual, en mayúsculas, como llave de respaldo).
 *  - periodo (mes) sale de "Fecha de Factura" (formato dd/mm/aa).
 *  - "Valor Pagado" se repite igual en todas las líneas de una misma
 *    factura -> se interpreta como el VALOR TOTAL de la factura, y es lo
 *    que se guarda en sap_cartera.valor.
 *  - "Valor Total Articulo" es la porción de esa factura para ese
 *    artículo -> no se usa en sap_cartera (podrías necesitarla si más
 *    adelante agregas detalle de factura, pero hoy el esquema no lo pide).
 *  - "Dias de Mora" viene vacío/0 cuando la factura está al día; se toma
 *    el máximo por factura (por si alguna línea trae el dato y otra no).
 *  - sap_ventas se agrega por (cliente, artículo, mes): si el mismo
 *    artículo aparece en varias facturas del mismo cliente en el mismo
 *    mes, los kilos se SUMAN.
 */

import fs from 'fs';
import readline from 'readline';

const filePath = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!filePath) {
  console.error('Uso: node scripts/import-hoja-ruta.js <archivo.csv> [--dry-run]');
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error('No existe el archivo:', filePath);
  process.exit(1);
}

const EXPECTED_HEADER = [
  '#', 'Cliente', 'Nit', 'Ciudad', 'Departamento', 'CIIU', 'Numero de Factura',
  'Fecha de Factura', 'Plazo', 'Cupo de Credito', 'Cupo Usado', 'Asesor',
  'Meta Anual Asesor', 'Sede', 'Meta Anual Sede', 'Nombre Almacen',
  'Codigo de Articulo', 'Articulo', 'Grupo', 'Meta Anual Grupo',
  'Factura Paga Total', 'Valor Pagado', 'Valor Total Articulo', 'Dias de Mora',
  'Kilos', 'Valor Kilo', 'Costo Kilo', 'Peso Unitario'
];

// Parser CSV simple que respeta comillas (soporta "1,234.56" y comas dentro de campos).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function num(s) {
  if (s == null) return 0;
  s = String(s).trim();
  if (!s) return 0;
  const v = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(v) ? v : 0;
}

function intOrNull(s) {
  const v = parseInt(String(s || '').trim(), 10);
  return Number.isFinite(v) ? v : null;
}

function periodoFromFecha(fecha) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(String(fecha || '').trim());
  if (!m) return null;
  const [, dd, mm, yy] = m;
  return `20${yy}-${mm}-01`;
}

async function main() {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let header = null;
  let rowNum = 0;
  let badRows = 0;

  const clientes = new Map();  // codigo_cliente -> {nombre,nit,ciudad,depto,asesor,plazo,cupoCred,cupoUsado}
  const ventas = new Map();    // "cliente|articulo|periodo" -> {codigo_cliente,codigo_articulo,descripcion,grupo,periodo,kg,valorKilo,costoKilo,pesoUnit}
  const facturas = new Map();  // numFactura -> {codigo_cliente,fecha,dias,valor,pagada}

  for await (const line of rl) {
    if (line === '') continue;
    const f = parseCsvLine(line);

    if (!header) {
      header = f;
      const mismatch = header.length !== EXPECTED_HEADER.length ||
        header.some((h, i) => h.trim() !== EXPECTED_HEADER[i]);
      if (mismatch) {
        console.warn('⚠ El encabezado del archivo no coincide exactamente con el esperado.');
        console.warn('  Esperado:', EXPECTED_HEADER.join(' | '));
        console.warn('  Recibido:', header.join(' | '));
        console.warn('  Se continúa por posición de columna; revisa el resultado con --dry-run.');
      }
      continue;
    }

    rowNum++;
    if (f.length !== EXPECTED_HEADER.length) { badRows++; continue; }

    const [
      , cliente, nit, ciudad, departamento, /*ciiu*/, numFactura, fechaFactura, plazo,
      cupoCredito, cupoUsado, asesor, /*metaAsesor*/, /*sede*/, /*metaSede*/, /*almacen*/,
      codArticulo, articulo, grupo, /*metaGrupo*/,
      facturaPagaTotal, valorPagado, /*valorTotalArticulo*/, diasMora,
      kilos, valorKilo, costoKilo, pesoUnitario
    ] = f;

    const codigoCliente = (nit || '').trim() || (cliente || '').trim().toUpperCase();
    if (!codigoCliente) continue;

    if (!clientes.has(codigoCliente)) {
      clientes.set(codigoCliente, {
        nombre: (cliente || '').trim(),
        nit: (nit || '').trim() || null,
        ciudad: (ciudad || '').trim() || null,
        departamento: (departamento || '').trim() || null,
        asesor: (asesor || '').trim() || null,
        plazo: (plazo || '').trim() || null,
        cupoCredito: num(cupoCredito),
        cupoUsado: num(cupoUsado)
      });
    }

    const periodo = periodoFromFecha(fechaFactura);
    if (periodo && codArticulo) {
      const vkey = `${codigoCliente}|${codArticulo}|${periodo}`;
      const kg = num(kilos);
      if (!ventas.has(vkey)) {
        ventas.set(vkey, {
          codigoCliente, codigoArticulo: codArticulo.trim(),
          descripcion: (articulo || '').trim() || null,
          grupo: (grupo || '').trim() || null,
          periodo, kg,
          valorKilo: num(valorKilo), costoKilo: num(costoKilo), pesoUnitario: num(pesoUnitario)
        });
      } else {
        const v = ventas.get(vkey);
        v.kg += kg;
        // conserva el último precio/costo visto (referencial, no se promedia)
        v.valorKilo = num(valorKilo) || v.valorKilo;
        v.costoKilo = num(costoKilo) || v.costoKilo;
      }
    }

    if (numFactura) {
      const dias = intOrNull(diasMora) || 0;
      if (!facturas.has(numFactura)) {
        facturas.set(numFactura, {
          codigoCliente,
          fecha: periodo,
          dias,
          valor: num(valorPagado),
          pagada: (facturaPagaTotal || '').trim().toUpperCase() === 'SI'
        });
      } else {
        const ff = facturas.get(numFactura);
        ff.dias = Math.max(ff.dias, dias);
      }
    }
  }

  console.log(`Filas leídas: ${rowNum} (descartadas por formato: ${badRows})`);
  console.log(`Clientes únicos: ${clientes.size}`);
  console.log(`Combinaciones cliente+artículo+mes: ${ventas.size}`);
  console.log(`Facturas únicas: ${facturas.size}`);
  const pendientes = [...facturas.values()].filter(f => !f.pagada);
  console.log(`Facturas marcadas como NO pagadas (van a sap_cartera): ${pendientes.length}`);

  if (dryRun) {
    console.log('\n--dry-run: no se escribió nada en la base.');
    process.exit(0);
  }

  const { pool } = await import('../db.js');
  const client = await pool.connect();
  try {
    console.log('\nConectado a la base. Cargando...');
    await client.query('BEGIN');

    let i = 0;
    for (const [codigoCliente, c] of clientes) {
      await client.query(`
        INSERT INTO sap_clientes (codigo_cliente, nombre, nit, ciudad, departamento, asesor, plazo_dias, cupo_credito, cupo_usado, sincronizado_en)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
        ON CONFLICT (codigo_cliente) DO UPDATE SET
          nombre=EXCLUDED.nombre, nit=EXCLUDED.nit, ciudad=EXCLUDED.ciudad,
          departamento=EXCLUDED.departamento, asesor=EXCLUDED.asesor,
          plazo_dias=EXCLUDED.plazo_dias, cupo_credito=EXCLUDED.cupo_credito,
          cupo_usado=EXCLUDED.cupo_usado, sincronizado_en=NOW()
      `, [codigoCliente, c.nombre, c.nit, c.ciudad, c.departamento, c.asesor,
          /^\d+$/.test(c.plazo || '') ? parseInt(c.plazo, 10) : null,
          c.cupoCredito, c.cupoUsado]);
      if (++i % 2000 === 0) console.log(`  clientes: ${i}/${clientes.size}`);
    }

    i = 0;
    for (const v of ventas.values()) {
      await client.query(`
        INSERT INTO sap_ventas (codigo_cliente, codigo_articulo, descripcion, grupo, periodo, kg, valor_kilo, costo_kilo, peso_unitario, sincronizado_en)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
        ON CONFLICT (codigo_cliente, codigo_articulo, periodo) DO UPDATE SET
          descripcion=EXCLUDED.descripcion, grupo=EXCLUDED.grupo, kg=EXCLUDED.kg,
          valor_kilo=EXCLUDED.valor_kilo, costo_kilo=EXCLUDED.costo_kilo,
          peso_unitario=EXCLUDED.peso_unitario, sincronizado_en=NOW()
      `, [v.codigoCliente, v.codigoArticulo, v.descripcion, v.grupo, v.periodo, v.kg,
          v.valorKilo, v.costoKilo, v.pesoUnitario]);
      if (++i % 5000 === 0) console.log(`  ventas: ${i}/${ventas.size}`);
    }

    i = 0;
    for (const [numFactura, f] of facturas) {
      if (f.pagada) continue; // sap_cartera solo guarda cartera pendiente
      await client.query(`
        INSERT INTO sap_cartera (codigo_cliente, factura, fecha_factura, dias_vencido, valor, sincronizado_en)
        VALUES ($1,$2,$3,$4,$5, NOW())
        ON CONFLICT (codigo_cliente, factura) DO UPDATE SET
          fecha_factura=EXCLUDED.fecha_factura, dias_vencido=EXCLUDED.dias_vencido,
          valor=EXCLUDED.valor, sincronizado_en=NOW()
      `, [f.codigoCliente, numFactura, f.fecha, f.dias, f.valor]);
      if (++i % 2000 === 0) console.log(`  cartera: ${i}/${pendientes.length}`);
    }

    await client.query('COMMIT');
    console.log('\n✓ Importación completa.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('✗ Error importando, se revirtió todo:', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
