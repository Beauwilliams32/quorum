import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

const definedTokens = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map(m => m[1]));
const usedTokens = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map(m => m[1]));

test('professional theme defines every CSS token it uses', () => {
  const missing = [...usedTokens].filter(token => !definedTokens.has(token));
  assert.deepEqual(missing, []);
});

test('professional theme preserves the command/monitor visual contract', () => {
  for (const token of ['--sans', '--mono', '--accent-soft', '--surface', '--line-soft', '--fg0', '--fg1', '--fg2', '--bg0']) {
    assert.ok(definedTokens.has(token.replace(/^--/, '')), `${token} is defined`);
  }
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /#view-deck[\s\S]*grid-template-columns/);
  assert.match(css, /#view-board[\s\S]*grid-template-columns/);
  assert.match(css, /prefers-reduced-motion/);
});

test('terminal and charts use the same subdued cockpit palette', () => {
  assert.match(app, /background: '#08090d'/);
  assert.match(app, /foreground: '#d4dae4'/);
  assert.match(app, /cursor: '#72d4ff'/);
  assert.match(app, /cyan=used violet=\+comp red=pressure/);
});
