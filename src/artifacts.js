import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendOps, archiveLegacyIndex, compactLog, indexPaths, readLog, readMeta, shouldCompact, writeMeta } from './artifact-store.js'

const HOME = os.homedir()
const DEFAULT_VAULT = path.join(HOME, 'Documents', 'Obsidian Vault')
const QUORUM_DIR = path.join(HOME, '.quorum')
const PATHS = indexPaths(QUORUM_DIR)
const MAX_FILES = 40_000
const SAMPLE_BYTES = 6_000
const READ_BYTES = 240_000
const BASE_INTERVAL_MS = 30_000
const MAX_INTERVAL_MS = 120_000
const IDLE_TICKS_BEFORE_BACKOFF = 3
const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.log', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm', '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.rs', '.swift', '.java', '.kt', '.sql', '.graphql', '.xml'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', 'Library', 'Applications'])
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._~+/=-]+|(?:sk|gh[pousr]|github_pat|xox[baprs]|AIza|AKIA|ASIA)[a-z0-9_:-]{8,})/gi
const PRIVATE_KEY = /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi
const SECRET_ASSIGNMENT = /((?:["']?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|authorization|cookie|token|secret|private[-_ ]?key)["']?\s*[:=]\s*))(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi

// One copy of every entry, keyed by absolute path. This replaces the old pair
// of `currentIndex.entries` (an array rebuilt every tick) and `fileCache` (a
// parallel Map that was never evicted, so a file deleted from disk stayed
// resident for the life of the process). A path that stops appearing in a full
// walk is dropped from here and a `del` op is appended to the log.
const byPath = new Map()
let sortedCache = null
let currentIndex = { generatedAt: null, roots: [], stats: emptyStats() }
let scanInFlight = false
// Append-only log bookkeeping: how many ops the on-disk log holds, so the
// index knows when compaction is worth its one large write.
let logLines = 0
let logLoaded = false

function emptyStats() {
  // `degraded` and `unreadable` exist because the vault root on the author's
  // machine resolves, is a directory, and then fails `readdirSync` with EPERM
  // (macOS withholds Documents from the launchd-started server). `walk()`
  // swallowed that error, so the index reported a healthy zero-entry vault.
  return { total: 0, truncated: false, degraded: false, unreadable: [], bySource: { vault: 0, codex: 0, claude: 0, workspace: 0 }, rescanned: 0, reused: 0, removed: 0, evictionHeld: 0, hydratedFromDisk: false, bytesWritten: 0, compacted: false, legacyIndexArchived: null }
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
  // `''.split(':')` is `['']`, and `existingDir('')` resolves to the process
  // CWD — so an unset QUORUM_ARTIFACT_ROOTS silently added whatever directory
  // the server was started from as a fifth indexed root, four levels deep.
  // Started from the repo, that indexed the repo.
  const configured = String(process.env.QUORUM_ARTIFACT_ROOTS || '')
    .split(path.delimiter).map(item => item.trim()).filter(Boolean).map(existingDir).filter(Boolean)
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

/**
 * Note a directory the index could not read. A root that cannot be listed is
 * not an empty root, and the difference has to reach the operator.
 */
function recordUnreadable(problems, dir, error) {
  if (!problems) return
  // `dirs` is uncapped because eviction depends on it: a walk with 41 or more
  // unreadable directories must still protect every one of their subtrees,
  // even though only the first 40 are reported to the operator.
  problems.dirs.add(String(dir))
  if (problems.list.length >= 40) return
  problems.list.push({ path: String(dir), code: String(error?.code || 'EUNKNOWN'), message: String(error?.message || error).slice(0, 240) })
}

function newProblems() { return { list: [], dirs: new Set() } }

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

function buildEntry(file, stat, roots) {
  const source = sourceFor(file, roots)
  const ext = path.extname(file).toLowerCase()
  const text = sampleFile(file, stat.size)
  const meta = ext === '.md' || ext === '.markdown' ? markdownMetadata(text, file) : { title: path.basename(file), headings: [], tags: [], links: [] }
  const title = ext === '.jsonl' ? (source.id === 'codex' ? `Codex · ${path.basename(file, ext)}` : `Claude · ${path.basename(file, ext)}`) : meta.title
  const id = crypto.createHash('sha256').update(`${source.id}\0${file}`).digest('hex').slice(0, 24)
  return {
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
}

/**
 * The mtime cursor. A file whose mtime, size and source all match the entry we
 * already hold is reused untouched — no open, no read, no hash, no regex
 * sweep, and no line appended to the log. Only the `statSync` is paid.
 */
function syncEntry(file, stat, roots, delta) {
  const existing = byPath.get(file)
  if (existing && existing.mtimeMs === stat.mtimeMs && existing.bytes === stat.size) {
    const source = sourceFor(file, roots)
    if (existing.source === source.id) { delta.reused += 1; return existing }
  }
  const entry = buildEntry(file, stat, roots)
  byPath.set(file, entry)
  delta.put.push(entry)
  delta.rescanned += 1
  return entry
}

function walk(root, files, maxFiles, depth = 0, maxDepth = Infinity, problems = null) {
  if (files.length >= maxFiles || depth > maxDepth) return
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch (error) { recordUnreadable(problems, root, error); return }
  for (const item of entries) {
    if (files.length >= maxFiles) return
    if (item.name.startsWith('.') && item.name !== '.obsidian') continue
    if (item.isDirectory()) {
      if (!SKIP_DIRS.has(item.name)) walk(path.join(root, item.name), files, maxFiles, depth + 1, maxDepth, problems)
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
  const problems = newProblems()
  for (const root of roots) {
    const before = problems.list.length
    walk(root.path, files, maxFiles, 0, root.maxDepth ?? Infinity, problems)
    annotateRoot(root, problems, before)
  }
  return finishIndex(files, roots, persist, maxFiles, problems)
}

/**
 * Mark a root as unreadable when the very first directory read — the root
 * itself — failed. A deeper permission error degrades the index but does not
 * make the whole root unreadable, so the two are reported differently.
 */
function annotateRoot(root, problems, before) {
  const own = problems.list.slice(before)
  const rootFailure = own.find(problem => problem.path === root.path)
  root.readable = !rootFailure
  root.error = rootFailure ? rootFailure.message : (own.length ? `${own.length} subdirector${own.length === 1 ? 'y' : 'ies'} could not be read` : null)
  return root
}

function finishIndex(files, roots, persist, maxFiles, problems = newProblems()) {
  const delta = newDelta()
  const uniqueFiles = dedupeFiles(files)
  const seen = new Set()
  for (const { file, stat } of uniqueFiles) {
    syncEntry(file, stat, roots, delta)
    seen.add(file)
  }
  const truncated = uniqueFiles.length >= maxFiles
  delta.held = evictMissing(seen, delta, { roots, problems, truncated })
  return commitIndex(roots, persist, truncated, problems, delta)
}

function newDelta() { return { put: [], del: [], rescanned: 0, reused: 0, held: 0 } }

/**
 * Paths whose absence from this walk means nothing, because the walk could
 * not see them. A root that failed its own `readdir` protects its whole
 * subtree; a deeper failure protects only that directory's subtree.
 */
function unsafePrefixes({ roots = [], problems = newProblems() } = {}) {
  const prefixes = []
  for (const root of roots) if (root.readable === false) prefixes.push(String(root.path))
  for (const dir of problems.dirs) prefixes.push(dir)
  return prefixes
}

/**
 * Drop entries whose files no longer appear in a full walk. The old index kept
 * them forever in `fileCache`, which is why a long-lived process kept growing
 * even when the trees it watched shrank.
 */
function evictMissing(seen, delta, guard = {}) {
  // A truncated walk saw only the first MAX_FILES files, so everything past
  // the cut looks "missing" and is not. Same shape as an unreadable root.
  if (guard.truncated) return byPath.size - seen.size
  const unsafe = unsafePrefixes(guard)
  if (!unsafe.length) {
    for (const file of byPath.keys()) {
      if (seen.has(file)) continue
      byPath.delete(file)
      delta.del.push(file)
    }
    return 0
  }
  // One transient EPERM on a root — the launchd/Documents case this file's own
  // comments describe — used to drop every entry under it AND append a `del`
  // op per entry, tripping compaction and rewriting the whole log. Recovery
  // then cost a full re-read of every file. A root the walk could not read is
  // not an empty root.
  let held = 0
  for (const file of byPath.keys()) {
    if (seen.has(file)) continue
    if (unsafe.some(prefix => file === prefix || file.startsWith(prefix + path.sep))) { held += 1; continue }
    byPath.delete(file)
    delta.del.push(file)
  }
  return held
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

function sortedEntries() {
  if (!sortedCache) sortedCache = [...byPath.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
  return sortedCache
}

function commitIndex(roots, persist, truncated = false, problems = newProblems(), delta = newDelta()) {
  sortedCache = null
  const stats = emptyStats()
  stats.total = byPath.size
  stats.truncated = truncated
  stats.unreadable = problems.list.slice(0, 40)
  stats.degraded = problems.dirs.size > 0
  // What the walk could not see, so did not evict. Zero on a healthy tick.
  stats.evictionHeld = delta.held || 0
  stats.rescanned = delta.rescanned
  stats.reused = delta.reused
  stats.removed = delta.del.length
  stats.hydratedFromDisk = logLoaded
  for (const entry of byPath.values()) stats.bySource[entry.source] = (stats.bySource[entry.source] || 0) + 1
  currentIndex = { generatedAt: new Date().toISOString(), roots: roots.map(root => ({ id: root.id, label: root.label, path: root.path, readable: root.readable !== false, error: root.error || null })), stats }
  if (persist) persistDelta(delta, stats)
  return buildArtifactState()
}

/**
 * Write only what changed. A tick where nothing moved writes zero bytes to the
 * log; the meta file (a few KB of roots and counters) is the only thing that
 * is rewritten, and only when its contents actually differ.
 */
function persistDelta(delta, stats) {
  try {
    const archived = archiveLegacyIndex(PATHS)
    if (archived) stats.legacyIndexArchived = archived.archivedTo
    let bytes = 0
    if (shouldCompact(logLines + delta.put.length + delta.del.length, byPath.size)) {
      bytes += compactLog(PATHS, byPath.values())
      logLines = byPath.size
      stats.compacted = true
    } else {
      bytes += appendOps(PATHS, delta)
      logLines += delta.put.length + delta.del.length
    }
    bytes += writeMeta(PATHS, { generatedAt: currentIndex.generatedAt, roots: currentIndex.roots, stats: { ...stats, bytesWritten: 0 }, logLines, entries: byPath.size })
    stats.bytesWritten = bytes
  } catch { /* an index is an optimization; the live scan remains usable */ }
}

/**
 * Restore the index from disk. This is what the old 107 MB file never did —
 * it was written 120 times an hour and read exactly never. Called once, lazily,
 * before the first scan, so a restart serves a populated artifact panel
 * immediately instead of after a full walk.
 */
export function hydrateFromDisk(paths = PATHS) {
  if (logLoaded) return { restored: 0, alreadyLoaded: true }
  logLoaded = true
  const { entries, lines, present } = readLog(paths.log)
  if (!present) return { restored: 0, alreadyLoaded: false }
  for (const [file, entry] of entries) if (entry && entry.path === file) byPath.set(file, entry)
  logLines = lines
  sortedCache = null
  const meta = readMeta(paths.meta)
  if (meta?.roots) currentIndex = { generatedAt: meta.generatedAt || null, roots: meta.roots, stats: { ...emptyStats(), ...meta.stats, total: byPath.size, hydratedFromDisk: true } }
  return { restored: byPath.size, alreadyLoaded: false }
}

const yieldToServer = () => new Promise(resolve => setImmediate(resolve))

async function walkAsync(root, files, maxFiles, depth = 0, maxDepth = Infinity, problems = null) {
  if (files.length >= maxFiles || depth > maxDepth) return
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch (error) { recordUnreadable(problems, root, error); return }
  for (const item of entries) {
    if (files.length >= maxFiles) return
    if (item.name.startsWith('.') && item.name !== '.obsidian') continue
    if (item.isDirectory()) {
      if (!SKIP_DIRS.has(item.name)) await walkAsync(path.join(root, item.name), files, maxFiles, depth + 1, maxDepth, problems)
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
  const problems = newProblems()
  for (const root of roots) {
    const before = problems.list.length
    await walkAsync(root.path, files, maxFiles, 0, root.maxDepth ?? Infinity, problems)
    annotateRoot(root, problems, before)
  }
  const uniqueFiles = dedupeFiles(files)
  const delta = newDelta()
  const seen = new Set()
  let since = 0
  for (const { file, stat } of uniqueFiles) {
    syncEntry(file, stat, roots, delta)
    seen.add(file)
    // Yield on work actually done, not on files seen: a tick where every file
    // is reused from the mtime cursor does no blocking work worth yielding on.
    if (delta.rescanned > since + 20) { since = delta.rescanned; await yieldToServer() }
  }
  const truncated = uniqueFiles.length >= maxFiles
  delta.held = evictMissing(seen, delta, { roots, problems, truncated })
  return commitIndex(roots, persist, truncated, problems, delta)
}

export async function reindexArtifacts(options = {}) {
  if (scanInFlight) return buildArtifactState()
  scanInFlight = true
  try {
    if (!logLoaded && options.persist !== false) hydrateFromDisk()
    return await buildArtifactIndexAsync(options)
  } finally { scanInFlight = false }
}

export function buildArtifactState() {
  return {
    generatedAt: currentIndex.generatedAt,
    indexPath: PATHS.log,
    roots: currentIndex.roots,
    stats: currentIndex.stats,
    entries: sortedEntries().slice(0, 300).map(publicEntry),
    policy: 'metadata-first; content previews are bounded and secret-redacted',
    ts: Date.now(),
  }
}

export function searchArtifacts(query = '', { source = '', limit = 40 } = {}) {
  const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12)
  const candidates = sortedEntries()
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

function entryById(id) {
  const wanted = String(id)
  for (const entry of byPath.values()) if (entry.id === wanted) return entry
  return null
}

export function readArtifact(id) {
  const entry = entryById(id)
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
  const entry = entryById(id)
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

/**
 * Next delay for the scan loop. Nothing changing on disk is the common case on
 * a machine at rest, and a full 30s walk of four large trees to learn that
 * again is wasted work — so idle ticks back the interval off towards two
 * minutes and the first changed file snaps it straight back to 30s.
 */
export function nextInterval(idleTicks, base = BASE_INTERVAL_MS, max = MAX_INTERVAL_MS) {
  if (idleTicks < IDLE_TICKS_BEFORE_BACKOFF) return base
  return Math.min(max, base * 2 ** (idleTicks - IDLE_TICKS_BEFORE_BACKOFF + 1))
}

export function startArtifacts(state, { base = BASE_INTERVAL_MS, max = MAX_INTERVAL_MS, firstDelay = 2_000 } = {}) {
  let idleTicks = 0
  let timer = null
  let stopped = false
  const tick = async () => {
    if (!stopped && !scanInFlight) {
      try {
        const result = await reindexArtifacts()
        const changed = (result.stats.rescanned || 0) + (result.stats.removed || 0)
        idleTicks = changed > 0 ? 0 : idleTicks + 1
        state.update('artifacts', result)
      } catch { /* collectors must never stop the cockpit */ }
    }
    if (stopped) return
    timer = setTimeout(tick, nextInterval(idleTicks, base, max))
  }
  // A workspace-wide scan is useful but must not hold the HTTP server hostage
  // during boot. Let the server accept requests before the first live refresh.
  timer = setTimeout(tick, firstDelay)
  return { stop() { stopped = true; if (timer) clearTimeout(timer) }, get idleTicks() { return idleTicks } }
}

/** Test seam: drop every cached entry and forget the on-disk log. */
export function resetArtifactIndexForTests() {
  byPath.clear()
  sortedCache = null
  logLines = 0
  logLoaded = false
  currentIndex = { generatedAt: null, roots: [], stats: emptyStats() }
}
