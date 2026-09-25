import { execFileSync } from 'node:child_process'

// A real repository check, bounded in both breadth and time.
//
// `repository-health` was one of the five standing jobs that advertised a
// watch and measured nothing. This reads each known project room with git and
// reports what it actually found — including the rooms it could not read,
// which are a finding rather than a silence.

const MAX_ROOMS = 24

function parseBranchLine(line) {
  // `## main...origin/main [ahead 2, behind 1]`
  const match = String(line).match(/^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(.+)\])?/)
  if (!match) return { branch: '', ahead: 0, behind: 0 }
  const tracking = match[2] || ''
  const ahead = Number(tracking.match(/ahead (\d+)/)?.[1] || 0)
  const behind = Number(tracking.match(/behind (\d+)/)?.[1] || 0)
  return { branch: match[1], ahead, behind }
}

/**
 * Read one repository. Returns `{ readable: false, error }` for a directory
 * git will not answer about — never a clean bill of health by default.
 */
export function readRepository(cwd, { execImpl = execFileSync } = {}) {
  let output
  try {
    output = String(execImpl('git', ['status', '--porcelain=v1', '-b'], { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }))
  } catch (error) {
    return { cwd, readable: false, error: String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200), branch: '', dirty: 0, conflicts: 0, ahead: 0, behind: 0 }
  }
  const lines = output.split('\n').filter(Boolean)
  const head = parseBranchLine(lines.find(line => line.startsWith('## ')) || '')
  const changes = lines.filter(line => !line.startsWith('## '))
  // Unmerged index states: both-modified, both-added, both-deleted and the
  // one-sided variants. These are the states that actually stop work.
  const conflicts = changes.filter(line => /^(DD|AU|UD|UA|DU|AA|UU)/.test(line)).length
  return { cwd, readable: true, error: null, branch: head.branch, dirty: changes.length, conflicts, ahead: head.ahead, behind: head.behind }
}

/**
 * Check the project rooms Quorum knows about. Attention is raised for a
 * repository with unmerged paths or one that could not be read — both are
 * states a person has to resolve — and never for ordinary uncommitted work.
 */
export function checkRepositories(rooms = [], { execImpl = execFileSync, maxRooms = MAX_ROOMS } = {}) {
  const candidates = rooms.filter(room => room?.cwd).slice(0, maxRooms)
  const repositories = candidates.map(room => ({ id: room.id || room.cwd, label: room.label || room.id || room.cwd, ...readRepository(room.cwd, { execImpl }) }))
  const unreadable = repositories.filter(repo => !repo.readable)
  const conflicted = repositories.filter(repo => repo.readable && repo.conflicts > 0)
  const dirty = repositories.filter(repo => repo.readable && repo.dirty > 0)
  const truncated = rooms.length > candidates.length
  const detail = repositories.length
    ? [
      `${repositories.length - unreadable.length}/${repositories.length} repositories read`,
      `${dirty.length} with uncommitted work`,
      conflicted.length ? `${conflicted.length} with unmerged paths` : '',
      unreadable.length ? `${unreadable.length} unreadable` : '',
      truncated ? `${rooms.length - candidates.length} not checked (bounded to ${maxRooms})` : '',
    ].filter(Boolean).join(' · ')
    : 'no project rooms are configured, so nothing was checked'
  return { repositories, attention: conflicted.length > 0 || unreadable.length > 0, detail, truncated }
}
