import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import {pool} from './db.js';
dotenv.config();

const username = process.env.ADMIN_USERNAME || 'admin';
const usingDefaultPassword = !process.env.ADMIN_PASSWORD;
const password = process.env.ADMIN_PASSWORD || '515T3M45';

if (usingDefaultPassword) {
  console.warn('⚠️  ADMIN_PASSWORD no está definida: se está usando la contraseña ' +
    'por defecto del código fuente. Defínela antes de usar esto en producción.');
}

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(80) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(30) NOT NULL DEFAULT 'user',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const hash = await bcrypt.hash(password, 12);
  await pool.query(`
    INSERT INTO users(username,password_hash,role,active)
    VALUES($1,$2,'admin',TRUE)
    ON CONFLICT(username) DO UPDATE SET
      password_hash=EXCLUDED.password_hash,
      role='admin',
      active=TRUE
  `,[username,hash]);

  console.log(`Usuario listo: ${username}`);
  console.log('Cambia la contraseña antes de producción.');
} finally {
  await pool.end();
}
