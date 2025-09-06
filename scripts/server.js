const express = require('express');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3000;

const repoRoot = path.join(__dirname, '..'); // run LuaJIT from repo root so ./libengine.so resolves

function resolveLuajit() {
  const env = process.env.LUAJIT || process.env.LUAJIT_PATH;
  const candidates = [
    env,
    // Prefer a locally built binary first
    path.join(repoRoot, 'scripts', 'bin', 'luajit'),
    path.join(repoRoot, 'luajit', 'src', 'luajit'),
    // System-wide fallbacks
    'luajit',
    '/usr/local/bin/luajit',
    '/usr/bin/luajit',
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-v'], { encoding: 'utf8' });
      const out = (r.stdout || '') + (r.stderr || '');
      if (!r.error && /LuaJIT/i.test(out)) return c;
    } catch (_) {
      // try next candidate
    }
  }
  return null;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/set', (req, res) => {
  const value = req.query.value || '0';
  console.log(`[noop:/set] value=${value}`);
  res.send('OK');
});

// Node types API endpoints
app.get('/types', (req, res) => {
  const luaScript = path.join(__dirname, 'lua', 'list_types.lua');
  const luajitCmd = resolveLuajit();
  
  if (!luajitCmd) {
    return res.status(500).json({
      error: 'LuaJIT not found. Build the vendored ./luajit (see scripts/build_luajit.sh) or install system luajit, or set $LUAJIT.',
    });
  }

  // Include local libs so luajit runs without system install
  const extraLibDirs = [
    path.join(repoRoot, 'scripts', 'bin'),
    path.join(repoRoot, 'luajit', 'src'),
  ];
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [extraLibDirs.join(':'), process.env.LD_LIBRARY_PATH || '']
      .filter(Boolean)
      .join(':'),
  };

  const result = spawnSync(luajitCmd, [luaScript], {
    encoding: 'utf8',
    cwd: repoRoot,
    env,
  });

  if (result.error) {
    console.error(result.error);
    return res.status(500).json({ error: String(result.error) });
  }

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();

  if (result.status !== 0) {
    if (stderr) return res.status(400).type('application/json').send(stderr);
    return res.status(400).json({ error: 'Failed to list types' });
  }

  res.type('application/json').send(stdout || '[]');
});

app.get('/types/:typeName', (req, res) => {
  const typeName = req.params.typeName;
  const luaScript = path.join(__dirname, 'lua', 'get_type_spec.lua');
  const luajitCmd = resolveLuajit();
  
  if (!luajitCmd) {
    return res.status(500).json({
      error: 'LuaJIT not found. Build the vendored ./luajit (see scripts/build_luajit.sh) or install system luajit, or set $LUAJIT.',
    });
  }

  // Include local libs so luajit runs without system install
  const extraLibDirs = [
    path.join(repoRoot, 'scripts', 'bin'),
    path.join(repoRoot, 'luajit', 'src'),
  ];
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [extraLibDirs.join(':'), process.env.LD_LIBRARY_PATH || '']
      .filter(Boolean)
      .join(':'),
  };

  const result = spawnSync(luajitCmd, [luaScript, typeName], {
    encoding: 'utf8',
    cwd: repoRoot,
    env,
  });

  if (result.error) {
    console.error(result.error);
    return res.status(500).json({ error: String(result.error) });
  }

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();

  if (result.status !== 0) {
    if (stderr) return res.status(400).type('application/json').send(stderr);
    return res.status(404).json({ error: `Type '${typeName}' not found` });
  }

  res.type('application/json').send(stdout || '{}');
});

app.post('/run', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const plan = req.body ? req.body.toString('utf8') : '';
  const luaScript = path.join(__dirname, 'lua', 'run_graph.lua');

  const luajitCmd = resolveLuajit();
  if (!luajitCmd) {
    return res.status(500).json({
      error: 'LuaJIT not found. Build the vendored ./luajit (see scripts/build_luajit.sh) or install system luajit, or set $LUAJIT.',
    });
  }

  // Include local libs so luajit runs without system install
  const extraLibDirs = [
    path.join(repoRoot, 'scripts', 'bin'),
    path.join(repoRoot, 'luajit', 'src'),
  ];
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [extraLibDirs.join(':'), process.env.LD_LIBRARY_PATH || '']
      .filter(Boolean)
      .join(':'),
  };

  const result = spawnSync(luajitCmd, [luaScript], {
    input: plan,
    encoding: 'utf8',
    cwd: repoRoot, // critical: lets run_graph.lua load "./libengine.so"
    env,
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
