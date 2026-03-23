const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-jwt-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const N8N_RUNTIME_TOKEN = process.env.N8N_RUNTIME_TOKEN || 'change-me-runtime-token';

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'prompt_manager';
const DB_SSL = /^true$/i.test(process.env.DB_SSL || 'false');
const DB_SSL_REJECT_UNAUTHORIZED = !/^false$/i.test(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true');
const DB_CONNECT_TIMEOUT = Number(process.env.DB_CONNECT_TIMEOUT || 10000);

const DEFAULT_CONFIG = {
  prompt: 'Eres un asistente de ventas amigable de Odoo CRM. Tu objetivo es calificar al lead y obtener su información.',
  proveedor: 'Groq',
  modelo: 'llama-3.1-70b-versatile',
  apiKeys: {
    ChatGPT: '',
    OpenAI: '',
    Gemini: '',
    Groq: '',
    Claude: '',
  },
  proveedoresList: ['ChatGPT', 'OpenAI', 'Groq', 'Claude', 'Gemini'],
};

let pool;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!token) {
    return res.status(401).json({ success: false, message: 'Falta token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token inválido' });
  }
}

function runtimeTokenMiddleware(req, res, next) {
  const token = req.headers['x-n8n-token'];
  if (!token || token !== N8N_RUNTIME_TOKEN) {
    return res.status(401).json({ success: false, message: 'No autorizado para runtime' });
  }
  return next();
}

function parseJsonSafe(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getMysqlConnectionOptions(includeDatabase = false) {
  const base = {
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    connectTimeout: DB_CONNECT_TIMEOUT,
  };

  if (DB_SSL) {
    base.ssl = { rejectUnauthorized: DB_SSL_REJECT_UNAUTHORIZED };
  }

  if (includeDatabase) {
    base.database = DB_NAME;
  }

  return base;
}

async function ensureDatabase() {
  const bootstrap = await mysql.createConnection({
    ...getMysqlConnectionOptions(false),
    multipleStatements: true,
  });

  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await bootstrap.end();

  pool = mysql.createPool({
    ...getMysqlConnectionOptions(true),
    waitForConnections: true,
    connectionLimit: 10,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      id INT PRIMARY KEY,
      prompt LONGTEXT NOT NULL,
      proveedor VARCHAR(100) NOT NULL,
      modelo VARCHAR(150) NOT NULL,
      api_keys_json LONGTEXT NOT NULL,
      proveedores_list_json LONGTEXT NOT NULL,
      updated_by INT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_app_config_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config_versions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      prompt LONGTEXT NOT NULL,
      proveedor VARCHAR(100) NOT NULL,
      modelo VARCHAR(150) NOT NULL,
      api_keys_json LONGTEXT NOT NULL,
      proveedores_list_json LONGTEXT NOT NULL,
      changed_by INT NULL,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_versions_user FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const [userRows] = await pool.query('SELECT id FROM users WHERE username = ? LIMIT 1', [ADMIN_USER]);
  if (!userRows.length) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [ADMIN_USER, passwordHash, 'admin']);
  }

  const [configRows] = await pool.query('SELECT id FROM app_config WHERE id = 1 LIMIT 1');
  if (!configRows.length) {
    await pool.query(
      'INSERT INTO app_config (id, prompt, proveedor, modelo, api_keys_json, proveedores_list_json) VALUES (1, ?, ?, ?, ?, ?)',
      [
        DEFAULT_CONFIG.prompt,
        DEFAULT_CONFIG.proveedor,
        DEFAULT_CONFIG.modelo,
        JSON.stringify(DEFAULT_CONFIG.apiKeys),
        JSON.stringify(DEFAULT_CONFIG.proveedoresList),
      ],
    );
  }
}

async function getActiveConfig() {
  const [rows] = await pool.query('SELECT * FROM app_config WHERE id = 1 LIMIT 1');
  const row = rows[0];
  const apiKeys = parseJsonSafe(row?.api_keys_json, DEFAULT_CONFIG.apiKeys);
  const proveedoresList = parseJsonSafe(row?.proveedores_list_json, DEFAULT_CONFIG.proveedoresList);
  const proveedor = row?.proveedor || DEFAULT_CONFIG.proveedor;
  let activeApiKey = apiKeys[proveedor] || '';
  if (!activeApiKey && /^chatgpt$/i.test(proveedor)) activeApiKey = apiKeys.OpenAI || '';
  if (!activeApiKey && /^openai$/i.test(proveedor)) activeApiKey = apiKeys.ChatGPT || '';

  return {
    prompt: row?.prompt || DEFAULT_CONFIG.prompt,
    proveedor,
    modelo: row?.modelo || DEFAULT_CONFIG.modelo,
    apiKeys,
    proveedoresList,
    apiKey: activeApiKey,
    updatedAt: row?.updated_at || null,
  };
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ success: true, status: 'ok' });
  } catch (error) {
    res.status(500).json({ success: false, status: 'db_error', detail: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const safeUsername = (username || ADMIN_USER).toString().trim();

    const [rows] = await pool.query('SELECT id, username, password_hash, role FROM users WHERE username = ? LIMIT 1', [safeUsername]);
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
    }

    const valid = await bcrypt.compare((password || '').toString(), user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
    }

    const token = signToken({ id: user.id, username: user.username, role: user.role });
    return res.json({ success: true, token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error interno', detail: error.message });
  }
});

app.get('/api/config', authMiddleware, async (_req, res) => {
  try {
    const config = await getActiveConfig();

    const [historyRows] = await pool.query(
      'SELECT prompt, changed_at AS date FROM app_config_versions ORDER BY id DESC LIMIT 20',
    );

    return res.json({ ...config, promptHistory: historyRows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error al cargar configuración', detail: error.message });
  }
});

app.post('/api/config', authMiddleware, async (req, res) => {
  try {
    const current = await getActiveConfig();

    const prompt = req.body.prompt !== undefined ? req.body.prompt : current.prompt;
    const proveedor = req.body.proveedor !== undefined ? req.body.proveedor : current.proveedor;
    const modelo = req.body.modelo !== undefined ? req.body.modelo : current.modelo;

    const apiKeys = req.body.apiKeys !== undefined
      ? { ...(current.apiKeys || {}), ...req.body.apiKeys }
      : current.apiKeys;

    const proveedoresList = Array.isArray(req.body.proveedoresList)
      ? req.body.proveedoresList
      : current.proveedoresList;

    await pool.query(
      `UPDATE app_config
       SET prompt = ?, proveedor = ?, modelo = ?, api_keys_json = ?, proveedores_list_json = ?, updated_by = ?
       WHERE id = 1`,
      [prompt, proveedor, modelo, JSON.stringify(apiKeys), JSON.stringify(proveedoresList), req.user.id],
    );

    await pool.query(
      `INSERT INTO app_config_versions (prompt, proveedor, modelo, api_keys_json, proveedores_list_json, changed_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [prompt, proveedor, modelo, JSON.stringify(apiKeys), JSON.stringify(proveedoresList), req.user.id],
    );

    const updated = await getActiveConfig();
    const [historyRows] = await pool.query(
      'SELECT prompt, changed_at AS date FROM app_config_versions ORDER BY id DESC LIMIT 20',
    );

    return res.json({
      success: true,
      message: 'Configuración guardada correctamente',
      config: { ...updated, promptHistory: historyRows },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error al guardar configuración', detail: error.message });
  }
});

app.get('/api/runtime/config', runtimeTokenMiddleware, async (_req, res) => {
  try {
    const config = await getActiveConfig();
    return res.json({
      prompt: config.prompt,
      proveedor: config.proveedor,
      modelo: config.modelo,
      apiKey: config.apiKey,
      updatedAt: config.updatedAt,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error runtime config', detail: error.message });
  }
});

app.post('/api/runtime/chat', runtimeTokenMiddleware, async (req, res) => {
  try {
    const config = await getActiveConfig();
    const provider = (config.proveedor || req.body.proveedor || '').toString();
    const model = (config.modelo || req.body.modelo || req.body.model || '').toString();
    const apiKey = (req.body.apiKey || config.apiKey || '').toString();

    if (!apiKey) {
      return res.status(400).json({ success: false, message: `No hay API key configurada para proveedor ${provider}` });
    }

    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const systemPrompt = (config.prompt || req.body.systemPrompt || '').toString();
    const withoutSystem = messages.filter((m) => (m?.role || '') !== 'system');
    const finalMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...withoutSystem]
      : withoutSystem;

    const temperature = req.body.temperature !== undefined ? req.body.temperature : 0.4;

    if (/^groq$/i.test(provider) || /^openai$/i.test(provider) || /^chatgpt$/i.test(provider)) {
      const url = /^groq$/i.test(provider)
        ? 'https://api.groq.com/openai/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';

      const payload = {
        model,
        messages: finalMessages,
        temperature,
        response_format: req.body.response_format,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ success: false, provider, model, error: data });
      }

      return res.json(data);
    }

    if (/^gemini$/i.test(provider)) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const mergedText = finalMessages
        .map((m) => `${(m.role || 'user').toUpperCase()}: ${m.content || ''}`)
        .join('\n\n');

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: mergedText }] }],
          generationConfig: { temperature },
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ success: false, provider, model, error: data });
      }

      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      return res.json({
        id: data?.responseId || null,
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        raw: data,
      });
    }

    if (/^claude$/i.test(provider)) {
      const system = finalMessages.find((m) => m.role === 'system')?.content || '';
      const chatMessages = finalMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content || '' }));

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: Number(req.body.max_tokens || 1024),
          temperature,
          system,
          messages: chatMessages,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ success: false, provider, model, error: data });
      }

      const text = (data?.content || [])
        .filter((c) => c?.type === 'text')
        .map((c) => c.text || '')
        .join('');

      return res.json({
        id: data?.id || null,
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: data?.stop_reason || 'stop' }],
        raw: data,
      });
    }

    return res.status(400).json({ success: false, message: `Proveedor no soportado: ${provider}` });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error runtime chat', detail: error.message });
  }
});

async function start() {
  try {
    await ensureDatabase();
    app.listen(PORT, () => {
      console.log(`Backend listo en http://localhost:${PORT}`);
      console.log(`DB: mysql://${DB_HOST}:${DB_PORT}/${DB_NAME}`);
    });
  } catch (error) {
    console.error('No se pudo iniciar backend:', error);
    process.exit(1);
  }
}

start();
