// Build a throwaway HOME shaped like the machine the perf survey measured.
// Large files are sparse (real head + real tail, hole in between) so 26k files
// with realistic stat.size cost megabytes of disk, not gigabytes: the artifact
// indexer only ever reads SAMPLE_BYTES from each end, so a sparse file
// exercises exactly the same code path as a dense one.
import fs from 'node:fs'
import path from 'node:path'

const WORDS = ['deploy', 'roundtable', 'cockpit', 'artifact', 'quorum', 'session', 'evidence', 'licence', 'collector', 'gateway', 'render', 'verify', 'cursor', 'index', 'broadcast', 'retention']
let seed = 1
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const words = n => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ')

function writeFileOfSize(file, head, tail, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const fd = fs.openSync(file, 'w')
  const headBuf = Buffer.from(head, 'utf8')
  const tailBuf = Buffer.from(tail, 'utf8')
  fs.writeSync(fd, headBuf, 0, headBuf.length, 0)
  if (size > headBuf.length + tailBuf.length) {
    fs.ftruncateSync(fd, size - tailBuf.length)
    fs.writeSync(fd, tailBuf, 0, tailBuf.length, size - tailBuf.length)
  }
  fs.closeSync(fd)
}

function markdown(i) {
  return `# Note ${i}\n\n#tag${i % 40} #quorum\n\n## Context\n\n${words(140)}\n\n## Decision\n\n[[Linked Note ${i % 200}]] ${words(140)}\n`
}

function jsonl(i, agent) {
  const lines = []
  for (let n = 0; n < 6; n++) {
    lines.push(JSON.stringify(agent === 'codex'
      ? { timestamp: new Date().toISOString(), payload: { type: 'agent_message', message: words(30), cwd: '/tmp/project' } }
      : { type: 'assistant', cwd: '/tmp/project', gitBranch: 'main', message: { model: 'claude', content: [{ type: 'text', text: words(30) }] } }))
  }
  return lines.join('\n') + '\n'
}

export function buildCorpus(home, scale = 1) {
  const counts = { vault: Math.round(6000 * scale), codex: Math.round(3000 * scale), claude: Math.round(12000 * scale), workspace: Math.round(5000 * scale) }
  const vault = path.join(home, 'Documents', 'Obsidian Vault')
  for (let i = 0; i < counts.vault; i++) {
    const body = markdown(i)
    writeFileOfSize(path.join(vault, `area-${i % 20}`, `topic-${i % 120}`, `note-${i}.md`), body, '', body.length)
  }
  for (let i = 0; i < counts.codex; i++) {
    const body = jsonl(i, 'codex')
    const size = 20_000 + Math.floor(rand() * 900_000)
    writeFileOfSize(path.join(home, '.codex', 'sessions', '2026', '09', String(10 + (i % 12)).padStart(2, '0'), `rollout-${i}.jsonl`), body, body, size)
  }
  for (let i = 0; i < counts.claude; i++) {
    const body = jsonl(i, 'claude')
    const size = 20_000 + Math.floor(rand() * 3_000_000)
    writeFileOfSize(path.join(home, '.claude', 'projects', `-tmp-project-${i % 60}`, `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000.jsonl`), body, body, size)
  }
  for (let i = 0; i < counts.workspace; i++) {
    const ext = ['.md', '.js', '.json', '.ts'][i % 4]
    const body = ext === '.md' ? markdown(i) : `// file ${i}\n${words(200)}\n`
    writeFileOfSize(path.join(home, 'CLAUDE', `project-${i % 30}`, `src`, `file-${i}${ext}`), body, '', body.length)
  }
  // Tasks + jobs for the tasks/sessions collectors.
  for (let i = 0; i < Math.round(400 * scale); i++) {
    const dir = path.join(home, '.claude', 'tasks', `session-${i % 40}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `task-${i}.json`), JSON.stringify({ id: `t${i}`, subject: words(6), description: words(20), activeForm: words(3), status: ['pending', 'in_progress', 'completed'][i % 3] }))
  }
  fs.mkdirSync(path.join(home, '.claude', 'jobs'), { recursive: true })
  return counts
}

if (process.argv[1] && process.argv[1].endsWith('corpus.mjs')) {
  const home = process.argv[2]
  if (!home) { console.error('usage: corpus.mjs <scratch-home> [scale]'); process.exit(1) }
  const started = Date.now()
  const counts = buildCorpus(home, Number(process.argv[3] || 1))
  console.log(JSON.stringify({ home, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), ms: Date.now() - started }))
}
