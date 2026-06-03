const express = require('express');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;
const NAME = 'vanitum-test-node';

app.use(express.json());

/* Health check — used by other services when they call this one */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: NAME, timestamp: new Date().toISOString() });
});

/* Show injected env vars (filters to _INTERNAL_URL keys only — safe) */
app.get('/env', (_req, res) => {
  const links = Object.entries(process.env)
    .filter(([k]) => k.endsWith('_INTERNAL_URL'))
    .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
  res.json({ service: NAME, linkedServices: links });
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
});
