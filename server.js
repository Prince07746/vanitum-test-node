const express = require('express');
const axios   = require('axios');
const mysql   = require('mysql2/promise');

const app  = express();
const PORT = process.env.PORT || 3000;
const NAME = 'vanitum-test-node';
const DATABASE_URL = process.env.DATABASE_URL || process.env.MYSQL_URL;

let pool;
let schemaReady;

function log(level, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: NAME,
    event,
    ...details
  };
  const output = JSON.stringify(entry);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

app.use(express.json());
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'http_request', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2))
    });
  });
  next();
});

app.get('/', (_req, res) => {
  res.json({
    service: NAME,
    status: 'ok',
    routes: [
      '/health',
      '/env',
      '/mysql/health',
      '/mysql/notes',
      '/mysql/notes/:id',
      '/mysql/notes/seed',
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
  log('info', 'mysql_pool_created', {
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    database: decodeURIComponent(databaseUrl.pathname.replace(/^\//, '')),
    connectionLimit: 5
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
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `).catch((error) => {
      schemaReady = undefined;
      throw error;
    });
    log('info', 'mysql_schema_initializing', { table: 'notes' });
  }
  await schemaReady;
  await ensureUpdatedAtColumn();
  log('info', 'mysql_schema_ready', { table: 'notes' });
}

async function ensureUpdatedAtColumn() {
  const [columns] = await getPool().query(
    "SHOW COLUMNS FROM notes LIKE 'updated_at'"
  );
  if (columns.length === 0) {
    await getPool().execute(`
      ALTER TABLE notes
      ADD COLUMN updated_at TIMESTAMP NOT NULL
      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    `);
    log('info', 'mysql_schema_migrated', { table: 'notes', column: 'updated_at' });
  }
}

function parseNoteId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readMessage(body) {
  return typeof body?.message === 'string' ? body.message.trim() : '';
}

function validateMessage(message) {
  return message.length > 0 && message.length <= 500;
}

async function findNote(id) {
  const [rows] = await getPool().execute(
    `SELECT id, message, created_at AS createdAt, updated_at AS updatedAt
     FROM notes WHERE id = ?`,
    [id]
  );
  return rows[0] || null;
}

function databaseError(res, error) {
  log('error', 'mysql_operation_failed', {
    code: error.code || 'UNKNOWN',
    errno: error.errno || null,
    sqlState: error.sqlState || null
  });
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
    log('info', 'mysql_health_ok', { database: rows[0].databaseName });
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
      `SELECT id, message, created_at AS createdAt, updated_at AS updatedAt
       FROM notes ORDER BY id DESC LIMIT 100`
    );
    log('info', 'mysql_notes_read', { count: notes.length });
    res.json({ ok: true, notes });
  } catch (error) {
    databaseError(res, error);
  }
});

app.post('/mysql/notes', async (req, res) => {
  const message = readMessage(req.body);
  if (!validateMessage(message)) {
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
    const note = await findNote(result.insertId);
    log('info', 'mysql_note_created', { noteId: result.insertId });
    res.status(201).json({ ok: true, note });
  } catch (error) {
    databaseError(res, error);
  }
});

app.post('/mysql/notes/seed', async (_req, res) => {
  try {
    await ensureSchema();
    const [countRows] = await getPool().query('SELECT COUNT(*) AS count FROM notes');
    if (Number(countRows[0].count) > 0) {
      log('info', 'mysql_seed_skipped', { reason: 'notes_not_empty' });
      return res.json({
        ok: true,
        inserted: 0,
        message: 'Seed skipped because notes already contain data.'
      });
    }

    const sampleMessages = [
      'Vanitum MySQL connection verified',
      'Runtime logs are visible',
      'CRUD operations are ready'
    ];
    await getPool().query(
      'INSERT INTO notes (message) VALUES ?',
      [sampleMessages.map((message) => [message])]
    );
    log('info', 'mysql_notes_seeded', { count: sampleMessages.length });
    res.status(201).json({ ok: true, inserted: sampleMessages.length });
  } catch (error) {
    databaseError(res, error);
  }
});

app.get('/mysql/notes/:id', async (req, res) => {
  const id = parseNoteId(req.params.id);
  if (!id) {
    return res.status(400).json({ ok: false, error: 'A valid note ID is required.' });
  }

  try {
    await ensureSchema();
    const note = await findNote(id);
    if (!note) {
      return res.status(404).json({ ok: false, error: 'Note not found.' });
    }
    log('info', 'mysql_note_read', { noteId: id });
    res.json({ ok: true, note });
  } catch (error) {
    databaseError(res, error);
  }
});

app.put('/mysql/notes/:id', async (req, res) => {
  const id = parseNoteId(req.params.id);
  const message = readMessage(req.body);
  if (!id) {
    return res.status(400).json({ ok: false, error: 'A valid note ID is required.' });
  }
  if (!validateMessage(message)) {
    return res.status(400).json({
      ok: false,
      error: 'Message is required and must not exceed 500 characters.'
    });
  }

  try {
    await ensureSchema();
    const [result] = await getPool().execute(
      'UPDATE notes SET message = ? WHERE id = ?',
      [message, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: 'Note not found.' });
    }
    const note = await findNote(id);
    log('info', 'mysql_note_updated', { noteId: id });
    res.json({ ok: true, note });
  } catch (error) {
    databaseError(res, error);
  }
});

app.delete('/mysql/notes/:id', async (req, res) => {
  const id = parseNoteId(req.params.id);
  if (!id) {
    return res.status(400).json({ ok: false, error: 'A valid note ID is required.' });
  }

  try {
    await ensureSchema();
    const [result] = await getPool().execute(
      'DELETE FROM notes WHERE id = ?',
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: 'Note not found.' });
    }
    log('info', 'mysql_note_deleted', { noteId: id });
    res.json({ ok: true, deletedId: id });
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

const server = app.listen(PORT, () => {
  const links = Object.keys(process.env).filter(k => k.endsWith('_INTERNAL_URL'));
  log('info', 'service_started', {
    port: Number(PORT),
    mysqlConfigured: Boolean(DATABASE_URL),
    linkedServiceCount: links.length
  });
});

async function shutdown() {
  log('info', 'service_stopping');
  server.close(async () => {
    if (pool) await pool.end();
    log('info', 'service_stopped');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
