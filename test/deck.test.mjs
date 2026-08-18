import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');

test('Deck view exposes the 3D command-room surfaces', () => {
  for (const id of ['view-deck', 'deck-space', 'deck-nodes', 'deck-detail', 'deck-sessions']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /data-view=["']deck["']/);
});

test('Deck view is connected to live state and CLI actions', () => {
  assert.match(app, /function renderDeck\(\)/);
  assert.match(app, /S\.projects\?\.rooms/);
  assert.match(app, /send\(\{ type: 'pty\.create'/);
  assert.match(app, /selectSession\(/);
  assert.match(app, /selectChat\(/);
});

test('Deck styling is genuinely 3D and remains interactive', () => {
  assert.match(css, /perspective:/);
  assert.match(css, /transform-style:\s*preserve-3d/);
  assert.match(css, /\.deck-node/);
  assert.match(css, /\.deck-node:hover/);
});
