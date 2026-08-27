import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import authRouter from './routes/auth.js';
import sapRouter from './routes/sap.js';
import driveRouter from './routes/drive.js';
import comercialRouter from './routes/comercial.js';
import { pool } from './db.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3001);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendPath = path.join(__dirname, '..', 'frontend');

// API: permite peticiones del frontend cuando se publique por separado.
const corsOrigin = process.env.CORS_ORIGIN || true;
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'panorama-produccion' });
});

app.use('/api/auth', authRouter);
app.use('/api', sapRouter);
app.use('/api/drive', driveRouter);
app.use('/api/comercial', comercialRouter);

// En local, el mismo backend sirve login.html y panorama.html.
app.use(express.static(frontendPath));

app.get('/', (_req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: 'Error interno del servidor.' });
});

async function seedAdminIfNeeded() {
  if (process.env.SEED_ON_BOOT !== 'true') return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const usingDefaultPassword = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || '515T3M45';

  if (usingDefaultPassword) {
    console.warn('⚠️  ADMIN_PASSWORD no está definida: se está usando la contraseña ' +
      'por defecto del código fuente. Define ADMIN_PASSWORD en las variables de ' +
      'entorno de Render y vuelve a desplegar antes de usar esto en producción.');
  }

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
  `, [username, hash]);

  console.log(`[SEED_ON_BOOT] Usuario listo: ${username}`);
}

seedAdminIfNeeded()
  .catch((e) => console.error('[SEED_ON_BOOT] Error al sembrar admin:', e))
  .finally(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Servidor ejecutándose en puerto ${PORT}`);
    });
  });
