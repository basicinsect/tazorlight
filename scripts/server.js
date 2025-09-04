const express = require('express');
const { execSync } = require('child_process');
const path = require('path');

const app = express();
const port = 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/set', (req, res) => {
  const value = req.query.value || '0';
  try {
    execSync(`luajit ${path.join(__dirname, 'lua/set_value.lua')} ${value}`, { stdio: 'inherit' });
    res.send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
