import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

// Neon, Render Postgres, Supabase, etc. requieren SSL. Solo lo desactivamos
// cuando la conexión es explícitamente local (desarrollo en tu máquina).
// Antes esto solo miraba si la URL traía 'dpg-' (prefijo de Render), por lo
// que con una DATABASE_URL de Neon el SSL quedaba en `false` y la conexión
// fallaba, aunque las credenciales fueran correctas.
const isLocalDb = connectionString
  ? /localhost|127\.0\.0\.1/.test(connectionString)
  : true;

export const pool = new Pool({
  connectionString,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }
});
