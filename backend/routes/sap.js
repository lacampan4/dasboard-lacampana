import express from 'express';
import axios from 'axios';

const router = express.Router();

// Credenciales desde las Variables de Entorno en Render
const SAP_SERVICE_URL = process.env.SAP_SERVICE_URL;
const SAP_USER = process.env.SAP_USER;
const SAP_PASS = process.env.SAP_PASS;

router.get('/produccion', async (req, res) => {
    const { inicio, fin } = req.query;

    if (!inicio || !fin) {
        return res.status(400).json({ error: 'Faltan las fechas de inicio o fin' });
    }

    if (!SAP_SERVICE_URL || !SAP_USER || !SAP_PASS) {
        return res.status(500).json({ error: 'Variables de entorno de SAP no configuradas' });
    }

    try {
        const urlOData = `${SAP_SERVICE_URL}?$filter=Fecha ge datetime'${inicio}T00:00:00' and Fecha le datetime'${fin}T23:59:59'&$format=json`;

        const respuestaSAP = await axios.get(urlOData, {
            auth: {
                username: SAP_USER,
                password: SAP_PASS
            },
            timeout: 10000
        });

        res.json(respuestaSAP.data.d.results);
    } catch (error) {
        console.error('Error al conectar con SAP:', error.message);
        res.status(500).json({ error: 'Error al consultar la información de SAP' });
    }
});

export default router;

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
