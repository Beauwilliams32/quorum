#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform as hostPlatform } from 'node:os';
import { basename, join, resolve } from 'node:path';

const LABEL = 'com.tridentsocial.quorum';
const args = parseArgs(process.argv.slice(2));
const source = resolve(args.source || process.cwd());
const home = resolve(args.home || homedir());
const targetPlatform = args.platform || hostPlatform();
const port = String(args.port || '4747');

assertSource(source);
if (!['darwin', 'linux', 'win32'].includes(targetPlatform)) fail('--platform must be darwin, linux, or win32');
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) fail('--port must be between 1024 and 65535');

const plan = buildPlan({ source, home, node: process.execPath, port, platform: targetPlatform, install: args.install });

if (!args.install) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write('No files were written. Review the plan, then re-run with --install to create the user-scoped service artifact.\n');
  process.exit(0);
}

if (existsSync(plan.servicePath) && !args.replace) {
  fail(`${plan.servicePath} already exists; use --replace only after reviewing the existing service artifact`);
}

if (existsSync(plan.servicePath) && args.replace) {
  mkdirSync(plan.backupDirectory, { recursive: true });
  copyFileSync(plan.servicePath, join(plan.backupDirectory, `${basename(plan.servicePath)}.${Date.now()}.bak`));
}

mkdirSync(plan.serviceDirectory, { recursive: true });
mkdirSync(plan.logDirectory, { recursive: true });
writeFileSync(plan.servicePath, plan.contents);
process.stdout.write(`Installed ${plan.servicePath}\n`);
process.stdout.write(`The service is not registered or started automatically. Review it, then run: ${plan.activation}\n`);

export function buildPlan({ source: root, home: userHome, node, port: listenPort, platform, install = false }) {
  const common = { source: root, node, port: listenPort, platform, action: install ? 'install' : 'dry-run' };
  if (platform === 'darwin') {
    const serviceDirectory = join(userHome, 'Library', 'LaunchAgents');
    const logDirectory = join(userHome, 'Library', 'Logs');
    const servicePath = join(serviceDirectory, `${LABEL}.plist`);
    return {
      ...common, serviceType: 'launchagent', serviceDirectory, logDirectory, servicePath, backupDirectory: join(userHome, '.quorum', 'agent-control', 'backups'),
      stdout: join(logDirectory, 'quorum.log'), stderr: join(logDirectory, 'quorum.error.log'),
      activation: `launchctl bootstrap gui/$(id -u) ${servicePath}`,
      contents: renderPlist({ source: root, home: userHome, node, port: listenPort, stdout: join(logDirectory, 'quorum.log'), stderr: join(logDirectory, 'quorum.error.log') }),
    };
  }
  if (platform === 'linux') {
    const serviceDirectory = join(userHome, '.config', 'systemd', 'user');
    const logDirectory = join(userHome, '.local', 'state', 'quorum');
    const servicePath = join(serviceDirectory, `${LABEL}.service`);
    return {
      ...common, serviceType: 'systemd-user', serviceDirectory, logDirectory, servicePath, backupDirectory: join(userHome, '.quorum', 'agent-control', 'backups'),
      stdout: join(logDirectory, 'quorum.log'), stderr: join(logDirectory, 'quorum.error.log'),
      activation: `systemctl --user daemon-reload && systemctl --user enable --now ${LABEL}.service`,
      contents: renderSystemd({ source: root, node, port: listenPort, stdout: join(logDirectory, 'quorum.log'), stderr: join(logDirectory, 'quorum.error.log') }),
    };
  }
  const serviceDirectory = join(userHome, 'AppData', 'Roaming', 'TridentSocial', 'Quorum');
  const logDirectory = join(userHome, 'AppData', 'Local', 'TridentSocial', 'Quorum');
  const servicePath = join(serviceDirectory, `${LABEL}.xml`);
  return {
    ...common, serviceType: 'scheduled-task', serviceDirectory, logDirectory, servicePath, backupDirectory: join(userHome, '.quorum', 'agent-control', 'backups'),
    activation: `schtasks /Create /TN "TridentSocial\\Quorum" /XML "${servicePath}" /F`,
    contents: renderTaskXml({ source: root, node, port: listenPort, logDirectory }),
  };
}

function assertSource(root) {
  for (const relative of ['package.json', 'server.js', 'node_modules/node-pty']) {
    if (!existsSync(join(root, relative))) fail(`Quorum source is missing ${relative}: ${root}`);
  }
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (packageJson.name !== 'quorum') fail(`expected a Quorum package.json, found ${packageJson.name || 'unnamed'}`);
}

function renderPlist({ source: root, home: userHome, node, port: listenPort, stdout, stderr }) {
  const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const string = (value) => `    <string>${escape(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>', '  <key>Label</key>', `  <string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>', '  <array>', string(node), string(join(root, 'server.js')), '  </array>',
    '  <key>WorkingDirectory</key>', `  <string>${escape(root)}</string>`,
    '  <key>RunAtLoad</key><true/>', '  <key>KeepAlive</key><true/>', '  <key>EnvironmentVariables</key>', '  <dict>',
    '    <key>PORT</key>', `    <string>${escape(listenPort)}</string>`,
    '    <key>PATH</key>', `    <string>${escape([join(userHome, '.npm-global', 'bin'), join(userHome, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'))}</string>`, '  </dict>',
    '  <key>StandardOutPath</key>', `  <string>${escape(stdout)}</string>`,
    '  <key>StandardErrorPath</key>', `  <string>${escape(stderr)}</string>`, '</dict>', '</plist>', '',
  ].join('\n');
}

function renderSystemd({ source: root, node, port: listenPort, stdout, stderr }) {
  return [
    '[Unit]', 'Description=Trident Social Quorum local operator cockpit', 'After=default.target', '',
    '[Service]', 'Type=simple', `WorkingDirectory=${quoteSystemd(root)}`,
    `ExecStart=${quoteSystemd(node)} ${quoteSystemd(join(root, 'server.js'))}`,
    `Environment=PORT=${listenPort}`, 'Restart=on-failure', 'RestartSec=2',
    `StandardOutput=append:${quoteSystemd(stdout)}`, `StandardError=append:${quoteSystemd(stderr)}`, '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n');
}

function renderTaskXml({ source: root, node, port: listenPort }) {
  const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task" version="1.4">',
    '  <RegistrationInfo><Description>Trident Social Quorum local operator cockpit</Description></RegistrationInfo>',
    '  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>',
    '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
    '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings>',
    '  <Actions Context="Author"><Exec>', `    <Command>${escape(node)}</Command>`, `    <Arguments>"${escape(join(root, 'server.js'))}" --port ${escape(listenPort)}</Arguments>`, `    <WorkingDirectory>${escape(root)}</WorkingDirectory>`,
    '  </Exec></Actions>', '</Task>', '',
  ].join('\n');
}

function quoteSystemd(value) { return /\s/.test(value) ? `"${String(value).replaceAll('"', '\\"')}"` : value; }

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--install') result.install = true;
    else if (value === '--replace') result.replace = true;
    else if (value === '--source' || value === '--home' || value === '--port' || value === '--platform') result[value.slice(2)] = values[++index];
    else if (value === '--help' || value === '-h') usage(0);
    else usage(64, `unknown option: ${value}`);
  }
  return result;
}

function usage(code, message) {
  if (message) console.error(`ERROR: ${message}`);
  console.error('Usage: node scripts/install-local.mjs [--platform darwin|linux|win32] [--source DIR] [--home DIR] [--port 4747] [--install [--replace]]');
  process.exit(code);
}

function fail(message) { console.error(`ERROR: ${message}`); process.exit(1); }
