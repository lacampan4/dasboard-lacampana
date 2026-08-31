// db.js - Conexión a Neon (PostgreSQL)
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Escuchar errores en el pool
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = pool;
