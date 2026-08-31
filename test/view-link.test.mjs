import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

test('requested view is applied before websocket snapshot data arrives', () => {
  const initialView = app.indexOf("view: new URLSearchParams(location.search).get('view')");
  const immediateSet = app.indexOf('setView(S.view)');
  const connect = app.lastIndexOf('\nconnect()');

  assert.ok(initialView >= 0, 'state reads ?view before localStorage fallback');
  assert.ok(immediateSet >= 0, 'initial view is applied immediately');
  assert.ok(connect >= 0, 'websocket connect call exists');
  assert.ok(immediateSet < connect, 'view activation happens before websocket connect/snapshot');
  assert.ok(
    app.includes("!localStorage.getItem('quorum-tour-done') && S.view === 'office'"),
    'first-visit tour does not override linked non-office views'
  );
});
