import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()
const DEFAULT_VAULT = path.join(HOME, 'Documents', 'Obsidian Vault')
const INDEX_PATH = path.join(HOME, '.quorum', 'artifact-index.json')
const MAX_FILES = 40_000
const SAMPLE_BYTES = 6_000
const READ_BYTES = 240_000
const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.log', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm', '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.rs', '.swift', '.java', '.kt', '.sql', '.graphql', '.xml'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', 'Library', 'Applications'])
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._~+/=-]+|(?:sk|gh[pousr]|github_pat|xox[baprs]|AIza|AKIA|ASIA)[a-z0-9_:-]{8,})/gi
const PRIVATE_KEY = /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi
const SECRET_ASSIGNMENT = /((?:["']?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|authorization|cookie|token|secret|private[-_ ]?key)["']?\s*[:=]\s*))(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi

let currentIndex = { generatedAt: null, roots: [], entries: [], stats: emptyStats() }
let scanInFlight = false
const fileCache = new Map()

function emptyStats() {
  return { total: 0, truncated: false, bySource: { vault: 0, codex: 0, claude: 0, workspace: 0 } }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function expand(value) {
  return path.resolve(String(value).replace(/^~(?=\/|$)/, HOME))
}

function existingDir(value) {
  const resolved = expand(value)
  try { return fs.statSync(resolved).isDirectory() ? resolved : null } catch { return null }
}

function configuredVault() {
  if (process.env.QUORUM_VAULT_PATH) return expand(process.env.QUORUM_VAULT_PATH)
  const config = readJson(path.join(HOME, 'CLAUDE', 'agent-memory-bridge', 'config.json'))
  return existingDir(config?.vaultPath) || DEFAULT_VAULT
}

export function artifactRoots() {
  const configured = String(process.env.QUORUM_ARTIFACT_ROOTS || '')
    .split(path.delimiter).map(existingDir).filter(Boolean)
  const roots = [
    { id: 'vault', label: 'Obsidian Vault', path: configuredVault() },
    { id: 'codex', label: 'Codex sessions + memories', path: path.join(HOME, '.codex') },
    { id: 'claude', label: 'Claude sessions + jobs', path: path.join(HOME, '.claude') },
    { id: 'workspace', label: 'CLAUDE workspace', path: path.join(HOME, 'CLAUDE'), maxDepth: 3 },
    ...configured.map((item, index) => ({ id: `custom-${index + 1}`, label: `Configured root ${index + 1}`, path: item, maxDepth: 4 })),
  ]
  const seen = new Set()
  return roots.filter(root => {
    const resolved = existingDir(root.path)
    if (!resolved || seen.has(resolved)) return false
    seen.add(resolved)
    root.path = resolved
    return true
  })
}

function sourceFor(file, roots) {
  const matches = roots.filter(root => file === root.path || file.startsWith(root.path + path.sep))
  if (!matches.length) return { id: 'workspace', root: path.dirname(file) }
  // More specific roots win, so ~/.codex/memories is still Codex even when a
  // user also configured a broad home directory as an extra root.
  matches.sort((a, b) => b.path.length - a.path.length)
  return { id: matches[0].id, root: matches[0].path }
}

function scrub(value) {
  return String(value || '')
    .replace(PRIVATE_KEY, '[redacted-private-key]')
    .replace(SECRET_VALUE, '[redacted-secret]')
    .replace(SECRET_ASSIGNMENT, '$1[redacted-secret]')
}

const PROTECTED_NAMES = new Set(['auth.json', 'auth.jsonl', 'credentials.json', 'secrets.json', 'token.json', 'id_rsa', 'id_ed25519'])
const PROTECTED_DIRS = new Set(['.ssh', 'secrets', 'credentials', 'keys'])

function protectedArtifactPath(file) {
  const parts = path.resolve(file).split(path.sep).filter(Boolean).map(part => part.toLowerCase())
  return parts.some(part => PROTECTED_DIRS.has(part) || PROTECTED_NAMES.has(part) || part.startsWith('.env') || /(?:private[-_ ]?key|credentials?|secrets?)\.(?:json|yaml|yml|txt|pem|key|p12|pfx)$/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part))
}

function artifactPath(entry) {
  const root = currentIndex.roots.find(item => item.id === entry.source)
  const resolved = path.resolve(entry.path)
  if (!root || !(resolved === root.path || resolved.startsWith(root.path + path.sep))) throw new Error('artifact path is outside an indexed root')
  let realRoot
  let realPath
  try { realRoot = fs.realpathSync(root.path); realPath = fs.realpathSync(resolved) } catch { throw new Error('artifact is no longer available') }
  if (!(realPath === realRoot || realPath.startsWith(realRoot + path.sep))) throw new Error('artifact path is outside an indexed root')
  return realPath
}

function sampleFile(file, size) {
  try {
    const fd = fs.openSync(file, 'r')
    const firstLength = Math.min(size, SAMPLE_BYTES)
    const first = Buffer.alloc(firstLength)
    const firstRead = fs.readSync(fd, first, 0, firstLength, 0)
    let text = first.toString('utf8', 0, firstRead)
    if (size > SAMPLE_BYTES) {
      const tailLength = Math.min(SAMPLE_BYTES, size)
      const tail = Buffer.alloc(tailLength)
      const tailRead = fs.readSync(fd, tail, 0, tailLength, Math.max(0, size - tailLength))
      text += `\n${tail.toString('utf8', 0, tailRead)}`
    }
    fs.closeSync(fd)
    return scrub(text)
  } catch { return '' }
}

function markdownMetadata(text, file) {
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map(match => match[1].trim()).slice(0, 24)
  const tags = [...text.matchAll(/(?:^|\s)#([a-z0-9][a-z0-9_/-]*)/gi)].map(match => match[1]).slice(0, 40)
  const links = [...text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]+)?\]\]/g)].map(match => match[1].trim()).slice(0, 40)
  const title = headings[0] || path.basename(file, path.extname(file))
  return { title: title.slice(0, 160), headings, tags: [...new Set(tags)], links: [...new Set(links)] }
}

function jsonlSummary(text, file) {
  let latest = ''
  for (const line of text.split('\n')) {
    try {
      const item = JSON.parse(line)
      const payload = item.payload || item
      const content = item.message?.content
      const assistant = Array.isArray(content) ? content.find(part => part.type === 'text' && part.text?.trim())?.text : null
      const candidate = assistant || (item.type === 'user' && typeof content === 'string' ? content : null) || payload.message || payload.command
      if (candidate) latest = String(candidate)
    } catch { /* samples can begin or end mid-line */ }
  }
  return latest.replace(/\s+/g, ' ').trim().slice(0, 240) || path.basename(file, path.extname(file))
}

function entryFor(file, stat, roots) {
  const source = sourceFor(file, roots)
  const ext = path.extname(file).toLowerCase()
  const cached = fileCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.bytes === stat.size && cached.source === source.id) return cached.entry
  const text = sampleFile(file, stat.size)
  const meta = ext === '.md' || ext === '.markdown' ? markdownMetadata(text, file) : { title: path.basename(file), headings: [], tags: [], links: [] }
  const title = ext === '.jsonl' ? (source.id === 'codex' ? `Codex · ${path.basename(file, ext)}` : `Claude · ${path.basename(file, ext)}`) : meta.title
  const id = crypto.createHash('sha256').update(`${source.id}\0${file}`).digest('hex').slice(0, 24)
  const entry = {
    id,
    source: source.id,
    sourceLabel: roots.find(root => root.id === source.id)?.label || source.id,
    path: file,
    relativePath: path.relative(source.root, file),
    title: title.slice(0, 160),
    extension: ext.slice(1) || 'file',
    bytes: stat.size,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    mtimeMs: stat.mtimeMs,
    headings: meta.headings,
    tags: meta.tags,
    links: meta.links,
    summary: ext === '.jsonl' ? jsonlSummary(text, file) : scrub(text.replace(/^\s+/, '').replace(/\s+/g, ' ').slice(0, 280)),
    searchText: `${title} ${file} ${meta.headings.join(' ')} ${meta.tags.join(' ')} ${meta.links.join(' ')} ${text}`.toLowerCase().slice(0, 4_000),
  }
  fileCache.set(file, { mtimeMs: stat.mtimeMs, bytes: stat.size, source: source.id, entry })
  return entry
}

function walk(root, files, maxFiles, depth = 0, maxDepth = Infinity) {
  if (files.length >= maxFiles || depth > maxDepth) return
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const item of entries) {
    if (files.length >= maxFiles) return
    if (item.name.startsWith('.') && item.name !== '.obsidian') continue
    if (item.isDirectory()) {
      if (!SKIP_DIRS.has(item.name)) walk(path.join(root, item.name), files, maxFiles, depth + 1, maxDepth)
      continue
    }
    if (!item.isFile() || !ALLOWED_EXTENSIONS.has(path.extname(item.name).toLowerCase())) continue
    const file = path.join(root, item.name)
    try {
      const stat = fs.statSync(file)
      if (stat.size <= 0 || stat.size > 12 * 1024 * 1024) continue
      files.push({ file, stat })
    } catch { /* a concurrent session file can disappear between scans */ }
  }
}

function publicEntry(entry) {
  const { searchText: _searchText, ...safe } = entry
  return { ...safe, openable: !protectedArtifactPath(entry.path) }
}

export function buildArtifactIndex({ roots = artifactRoots(), maxFiles = MAX_FILES, persist = true } = {}) {
  const files = []
  for (const root of roots) walk(root.path, files, maxFiles, 0, root.maxDepth ?? Infinity)
  return finishIndex(files, roots, persist, maxFiles)
}

function finishIndex(files, roots, persist, maxFiles) {
  const uniqueFiles = dedupeFiles(files)
  const entries = uniqueFiles.map(({ file, stat }) => entryFor(file, stat, roots)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  return commitIndex(entries, roots, persist, uniqueFiles.length >= maxFiles)
}

function dedupeFiles(files) {
  const seen = new Set()
  return files.filter(({ file }) => {
    const key = path.resolve(file)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function commitIndex(entries, roots, persist, truncated = false) {
  const stats = emptyStats()
  stats.total = entries.length
  stats.truncated = truncated
  for (const entry of entries) stats.bySource[entry.source] = (stats.bySource[entry.source] || 0) + 1
  currentIndex = { generatedAt: new Date().toISOString(), roots: roots.map(root => ({ id: root.id, label: root.label, path: root.path })), entries, stats }
  if (persist) {
    try {
      fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true, mode: 0o700 })
      const temp = `${INDEX_PATH}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(currentIndex) + '\n', { mode: 0o600 })
      fs.renameSync(temp, INDEX_PATH)
    } catch { /* an index is an optimization; the live scan remains usable */ }
  }
  return buildArtifactState()
}

const yieldToServer = () => new Promise(resolve => setImmediate(resolve))

async function walkAsync(root, files, maxFiles, depth = 0, maxDepth = Infinity) {
  if (files.length >= maxFiles || depth > maxDepth) return
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const item of entries) {
    if (files.length >= maxFiles) return
    if (item.name.startsWith('.') && item.name !== '.obsidian') continue
    if (item.isDirectory()) {
      if (!SKIP_DIRS.has(item.name)) await walkAsync(path.join(root, item.name), files, maxFiles, depth + 1, maxDepth)
    } else if (item.isFile() && ALLOWED_EXTENSIONS.has(path.extname(item.name).toLowerCase())) {
      const file = path.join(root, item.name)
      try {
        const stat = fs.statSync(file)
        if (stat.size > 0 && stat.size <= 12 * 1024 * 1024) files.push({ file, stat })
      } catch { /* concurrent file removal */ }
    }
    // Keep health, websocket, and terminal traffic responsive on large roots.
    if (files.length % 40 === 0) await yieldToServer()
  }
}

async function buildArtifactIndexAsync({ roots = artifactRoots(), maxFiles = MAX_FILES, persist = true } = {}) {
  const files = []
  for (const root of roots) await walkAsync(root.path, files, maxFiles, 0, root.maxDepth ?? Infinity)
  const uniqueFiles = dedupeFiles(files)
  const entries = []
  for (const item of uniqueFiles) {
    entries.push(entryFor(item.file, item.stat, roots))
    if (entries.length % 20 === 0) await yieldToServer()
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return commitIndex(entries, roots, persist, uniqueFiles.length >= maxFiles)
}

export async function reindexArtifacts(options = {}) {
  if (scanInFlight) return buildArtifactState()
  scanInFlight = true
  try { return await buildArtifactIndexAsync(options) }
  finally { scanInFlight = false }
}

export function buildArtifactState() {
  return {
    generatedAt: currentIndex.generatedAt,
    indexPath: INDEX_PATH,
    roots: currentIndex.roots,
    stats: currentIndex.stats,
    entries: currentIndex.entries.slice(0, 300).map(publicEntry),
    policy: 'metadata-first; content previews are bounded and secret-redacted',
    ts: Date.now(),
  }
}

export function searchArtifacts(query = '', { source = '', limit = 40 } = {}) {
  const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12)
  const candidates = currentIndex.entries
    .filter(entry => !source || entry.source === source)
    .map(entry => {
      if (!terms.length) return { entry, score: 0 }
      const haystack = entry.searchText
      const matches = terms.filter(term => haystack.includes(term))
      const score = matches.reduce((total, term) => total + (entry.title.toLowerCase().includes(term) ? 5 : 1), 0)
      return { entry, score, matches: matches.length }
    })
    .filter(item => !terms.length || item.matches === terms.length)
    .sort((a, b) => b.score - a.score || b.entry.mtimeMs - a.entry.mtimeMs)
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 40)))
  return { query: String(query).slice(0, 200), source: String(source), total: candidates.length, results: candidates.map(item => ({ ...publicEntry(item.entry), score: item.score })) }
}

export function readArtifact(id) {
  const entry = currentIndex.entries.find(item => item.id === String(id))
  if (!entry) throw new Error('unknown artifact')
  const resolved = artifactPath(entry)
  let stat
  try { stat = fs.statSync(resolved) } catch { throw new Error('artifact is no longer available') }
  if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw new Error('artifact preview is unavailable for this file size')
  const length = Math.min(READ_BYTES, stat.size)
  const buffer = Buffer.alloc(length)
  const fd = fs.openSync(resolved, 'r')
  const read = fs.readSync(fd, buffer, 0, length, 0)
  fs.closeSync(fd)
  return { ...publicEntry(entry), content: scrub(buffer.toString('utf8', 0, read)), truncated: stat.size > READ_BYTES, ts: Date.now() }
}

export function openArtifact(id, mode = 'default') {
  const entry = currentIndex.entries.find(item => item.id === String(id))
  if (!entry) throw new Error('unknown artifact')
  if (protectedArtifactPath(entry.path)) throw new Error('artifact is protected and cannot be opened')
  const resolved = artifactPath(entry)
  try { if (!fs.statSync(resolved).isFile()) throw new Error('artifact is no longer available') } catch (error) { throw new Error(error.message === 'artifact is no longer available' ? error.message : 'artifact is no longer available') }
  const args = mode === 'reveal' ? ['-R', resolved] : [resolved]
  const child = spawn('open', args, { detached: true, stdio: 'ignore' })
  child.unref()
  return { ok: true, mode: mode === 'reveal' ? 'reveal' : 'default', path: resolved, source: entry.source, ts: Date.now() }
}

export function openDirectory(directory, mode = 'default', roots = artifactRoots(), spawnImpl = spawn) {
  const candidate = path.resolve(String(directory || ''))
  const root = roots.find(item => candidate === path.resolve(item.path) || candidate.startsWith(path.resolve(item.path) + path.sep))
  if (!root) throw new Error('directory is outside an indexed root')
  let realRoot
  let resolved
  try {
    realRoot = fs.realpathSync(root.path)
    resolved = fs.realpathSync(candidate)
    if (!fs.statSync(resolved).isDirectory()) throw new Error('project folder is unavailable')
  } catch (error) { throw new Error(error.message === 'project folder is unavailable' ? error.message : 'project folder is unavailable') }
  if (!(resolved === realRoot || resolved.startsWith(realRoot + path.sep))) throw new Error('directory is outside an indexed root')
  const args = mode === 'reveal' ? ['-R', resolved] : [resolved]
  const child = spawnImpl('open', args, { detached: true, stdio: 'ignore' })
  child.unref()
  return { ok: true, mode: mode === 'reveal' ? 'reveal' : 'default', path: resolved, source: root.id, ts: Date.now() }
}

export function startArtifacts(state) {
  const tick = async () => {
    if (scanInFlight) return
    try { state.update('artifacts', await reindexArtifacts()) } catch { /* collectors must never stop the cockpit */ }
  }
  // A workspace-wide scan is useful but must not hold the HTTP server hostage
  // during boot. Let the server accept requests before the first live refresh.
  setTimeout(tick, 2_000)
  return setInterval(tick, 30_000)
}
