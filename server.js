const express = require('express');
const axios   = require('axios');
const mysql   = require('mysql2/promise');

const app  = express();
const PORT = process.env.PORT || 3000;
const NAME = 'vanitum-test-node';
const DATABASE_URL = process.env.DATABASE_URL || process.env.MYSQL_URL;

let pool;
let schemaReady;

app.use(express.json());

app.get('/', (_req, res) => {
  res.json({
    service: NAME,
    status: 'ok',
    routes: [
      '/health',
      '/env',
      '/mysql/health',
      '/mysql/notes',
      '/call/:slug',
      '/chain/:slug1/:slug2'
    ]
  });
});

/* Health check — used by other services when they call this one */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: NAME, timestamp: new Date().toISOString() });
});

/* Show injected env vars (filters to _INTERNAL_URL keys only — safe) */
app.get('/env', (_req, res) => {
  const links = Object.entries(process.env)
    .filter(([k]) => k.endsWith('_INTERNAL_URL'))
    .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
  res.json({
    service: NAME,
    linkedServices: links,
    databaseConfigured: Boolean(DATABASE_URL)
  });
});

function getPool() {
  if (pool) return pool;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }

  const databaseUrl = new URL(DATABASE_URL);
  if (databaseUrl.protocol !== 'mysql:') {
    throw new Error('DATABASE_URL must use the mysql:// protocol');
  }

  pool = mysql.createPool({
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: decodeURIComponent(databaseUrl.pathname.replace(/^\//, '')),
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  });
  return pool;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().execute(`
      CREATE TABLE IF NOT EXISTS notes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        message VARCHAR(500) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `).catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

function databaseError(res, error) {
  console.error('MySQL operation failed:', error.message);
  res.status(503).json({
    ok: false,
    error: 'The database is temporarily unavailable. Check the application database configuration.'
  });
}

app.get('/mysql/health', async (_req, res) => {
  try {
    const [rows] = await getPool().query(
      'SELECT DATABASE() AS databaseName, CURRENT_TIMESTAMP AS serverTime'
    );
    res.json({
      ok: true,
      engine: 'mysql',
      database: rows[0].databaseName,
      serverTime: rows[0].serverTime
    });
  } catch (error) {
    databaseError(res, error);
  }
});

app.get('/mysql/notes', async (_req, res) => {
  try {
    await ensureSchema();
    const [notes] = await getPool().query(
      'SELECT id, message, created_at AS createdAt FROM notes ORDER BY id DESC LIMIT 100'
    );
    res.json({ ok: true, notes });
  } catch (error) {
    databaseError(res, error);
  }
});

app.post('/mysql/notes', async (req, res) => {
  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!message || message.length > 500) {
    return res.status(400).json({
      ok: false,
      error: 'Message is required and must not exceed 500 characters.'
    });
  }

  try {
    await ensureSchema();
    const [result] = await getPool().execute(
      'INSERT INTO notes (message) VALUES (?)',
      [message]
    );
    const [rows] = await getPool().execute(
      'SELECT id, message, created_at AS createdAt FROM notes WHERE id = ?',
      [result.insertId]
    );
    res.status(201).json({ ok: true, note: rows[0] });
  } catch (error) {
    databaseError(res, error);
  }
});

/* Call another linked service by its slug and return its /health response */
app.get('/call/:slug', async (req, res) => {
  const slug = req.params.slug;
  const key  = slug.toUpperCase().replace(/-/g, '_') + '_INTERNAL_URL';
  const url  = process.env[key];
  if (!url) {
    return res.status(404).json({
      error: `Service "${slug}" is not linked. Expected env var: ${key}`
    });
  }
  try {
    const { data } = await axios.get(`${url}/health`, { timeout: 5000 });
    res.json({ caller: NAME, callee: slug, internalUrl: url, result: data });
  } catch (err) {
    res.status(502).json({ caller: NAME, callee: slug, error: err.message });
  }
});

/* Chain call — call A, which calls B, returns nested result */
app.get('/chain/:slug1/:slug2', async (req, res) => {
  const { slug1, slug2 } = req.params;
  const key = slug1.toUpperCase().replace(/-/g, '_') + '_INTERNAL_URL';
  const url = process.env[key];
  if (!url) {
    return res.status(404).json({ error: `Service "${slug1}" not linked. Expected: ${key}` });
  }
  try {
    const { data } = await axios.get(`${url}/call/${slug2}`, { timeout: 8000 });
    res.json({ initiator: NAME, chain: [slug1, slug2], result: data });
  } catch (err) {
    res.status(502).json({ initiator: NAME, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`${NAME} listening on :${PORT}`);
  const links = Object.keys(process.env).filter(k => k.endsWith('_INTERNAL_URL'));
  if (links.length) console.log('Linked services:', links.join(', '));
  console.log(`MySQL configured: ${Boolean(DATABASE_URL)}`);
});

async function shutdown() {
  if (pool) await pool.end();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
