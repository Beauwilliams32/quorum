import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const script = join(root, 'scripts', 'install-local.mjs');

function fixture() {
  const source = mkdtempSync(join(tmpdir(), 'quorum-installer-source-'));
  mkdirSync(join(source, 'node_modules', 'node-pty'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'quorum' }));
  writeFileSync(join(source, 'server.js'), '');
  return source;
}

test('installer dry-run is portable and writes nothing', () => {
  const source = fixture();
  const home = mkdtempSync(join(tmpdir(), 'quorum-installer-home-'));
  const output = execFileSync(process.execPath, [script, '--source', source, '--home', home, '--port', '4877'], { encoding: 'utf8' });
  const start = output.indexOf('{');
  const end = output.indexOf('\nNo files were written');
  const plan = JSON.parse(output.slice(start, end));
  assert.equal(plan.action, 'dry-run');
  assert.equal(plan.source, source);
  assert.equal(plan.port, '4877');
  assert.match(output, /No files were written/);
});

test('installer writes a client-specific LaunchAgent without loading it', () => {
  const source = fixture();
  const home = mkdtempSync(join(tmpdir(), 'quorum-installer-home-'));
  execFileSync(process.execPath, [script, '--source', source, '--home', home, '--port', '4878', '--install'], { encoding: 'utf8' });
  const plistPath = join(home, 'Library', 'LaunchAgents', 'com.tridentsocial.quorum.plist');
  const plist = readFileSync(plistPath, 'utf8');
  assert.match(plist, new RegExp(`<string>${source}/server\\.js</string>`));
  assert.match(plist, /<key>PORT<\/key>\s*<string>4878<\/string>/);
  assert.match(plist, new RegExp(`${home}/\\.npm-global/bin`));
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
});

test('installer refuses to overwrite an existing agent unless explicitly replaced', () => {
  const source = fixture();
  const home = mkdtempSync(join(tmpdir(), 'quorum-installer-home-'));
  const args = [script, '--source', source, '--home', home, '--install'];
  execFileSync(process.execPath, args, { encoding: 'utf8' });
  assert.throws(() => execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' }), /already exists/);
});

test('Linux dry-run produces a user systemd unit without writing or registering it', () => {
  const source = fixture();
  const home = mkdtempSync(join(tmpdir(), 'quorum-installer-linux-home-'));
  const output = execFileSync(process.execPath, [script, '--platform', 'linux', '--source', source, '--home', home, '--port', '4880'], { encoding: 'utf8' });
  const plan = JSON.parse(output.slice(output.indexOf('{'), output.indexOf('\nNo files were written')));
  assert.equal(plan.serviceType, 'systemd-user');
  assert.match(plan.servicePath, /\.config\/systemd\/user\/com\.tridentsocial\.quorum\.service$/);
  assert.match(plan.contents, /WantedBy=default\.target/);
  assert.match(output, /systemctl --user daemon-reload/);
});

test('Windows dry-run produces a least-privilege scheduled-task artifact', () => {
  const source = fixture();
  const home = mkdtempSync(join(tmpdir(), 'quorum-installer-windows-home-'));
  const output = execFileSync(process.execPath, [script, '--platform', 'win32', '--source', source, '--home', home, '--port', '4881'], { encoding: 'utf8' });
  const plan = JSON.parse(output.slice(output.indexOf('{'), output.indexOf('\nNo files were written')));
  assert.equal(plan.serviceType, 'scheduled-task');
  assert.match(plan.servicePath, /AppData[\\/]Roaming[\\/]TridentSocial[\\/]Quorum/);
  assert.match(plan.contents, /<LogonTrigger>/);
  assert.match(plan.contents, /LeastPrivilege/);
  assert.match(plan.contents, /server\.js.*--port 4881/);
  assert.match(plan.activation, /schtasks/);
});
