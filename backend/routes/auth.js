import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';

const router = Router();

function authRequired(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({message:'Token requerido.'});
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({message:'Sesión inválida o vencida.'});
  }
}

router.post('/login', async (req,res) => {
  const {username,password} = req.body || {};
  if (!username || !password) return res.status(400).json({message:'Usuario y contraseña son obligatorios.'});

  try {
    const {rows} = await pool.query(
      'SELECT id, username, password_hash, role, active FROM users WHERE username=$1 LIMIT 1',
      [username]
    );
    const user = rows[0];
    if (!user || !user.active) return res.status(401).json({message:'Usuario o contraseña incorrectos.'});

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({message:'Usuario o contraseña incorrectos.'});

    const token = jwt.sign(
      {sub:user.id, username:user.username, role:user.role},
      process.env.JWT_SECRET,
      {expiresIn:'8h'}
    );

    res.json({token, user:{id:user.id, username:user.username, role:user.role}});
  } catch (e) {
    console.error(e);
    res.status(500).json({message:'Error al iniciar sesión.'});
  }
});

router.get('/me', authRequired, async (req,res) => {
  try {
    const {rows} = await pool.query(
      'SELECT id, username, role, active FROM users WHERE id=$1 LIMIT 1',
      [req.user.sub]
    );
    const user = rows[0];
    if (!user || !user.active) return res.status(401).json({message:'Usuario no disponible.'});
    res.json({user});
  } catch {
    res.status(500).json({message:'Error al validar la sesión.'});
  }
});

export default router;
