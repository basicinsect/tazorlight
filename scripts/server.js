const express = require('express');
const { spawnSync } = require('child_process');
const path = require('path');

const app = express();
const port = 3000;

const repoRoot = path.join(__dirname, '..'); // run LuaJIT from repo root so ./libengine.so resolves

app.use(express.static(path.join(__dirname, 'public')));

app.get('/set', (req, res) => {
  const value = req.query.value || '0';
  console.log(`[noop:/set] value=${value}`);
  res.send('OK');
});

app.post('/run', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
  const plan = req.body || '';
  const luaScript = path.join(__dirname, 'lua', 'run_graph.lua');

  const result = spawnSync('luajit', [luaScript], {
    input: plan,
    encoding: 'utf8',
    cwd: repoRoot, // critical: lets run_graph.lua load "./libengine.so"
  });

  if (result.error) {
    console.error(result.error);
    return res.status(500).json({ error: String(result.error) });
  }

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();

  if (result.status !== 0) {
    if (stderr) return res.status(400).type('application/json').send(stderr);
    return res.status(400).json({ error: 'Run failed' });
  }

  res.type('application/json').send(stdout || '{"outputs":[]}');
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
