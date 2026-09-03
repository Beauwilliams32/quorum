const TOOL_DEFINITIONS = [
  { id: 'terminal', name: 'Terminal', provider: 'Quorum', risk: 'high', capabilities: ['pty.create', 'pty.input', 'pty.stop'], requiredCredentials: [], allowedAgents: ['builder', 'operator', 'recovery'], approval: 'explicit' },
  { id: 'filesystem', name: 'Workspace filesystem', provider: 'Quorum', risk: 'high', capabilities: ['read', 'workspace-write'], requiredCredentials: [], allowedAgents: ['builder', 'researcher', 'operator', 'recovery'], approval: 'policy' },
  { id: 'git', name: 'Git', provider: 'local', risk: 'medium', capabilities: ['status', 'diff', 'log', 'branch', 'worktree', 'commit'], requiredCredentials: [], allowedAgents: ['builder', 'researcher', 'operator', 'recovery'], approval: 'policy' },
  { id: 'github', name: 'GitHub', provider: 'Composio', risk: 'high', capabilities: ['read', 'issues', 'pull-requests', 'write'], requiredCredentials: ['github.default'], allowedAgents: ['builder', 'researcher', 'operator'], approval: 'on-request' },
  { id: 'browser', name: 'Browser', provider: 'local', risk: 'high', capabilities: ['navigate', 'inspect', 'interact'], requiredCredentials: [], allowedAgents: ['researcher', 'operator'], approval: 'on-request' },
  { id: 'web_search', name: 'Web search', provider: 'network', risk: 'medium', capabilities: ['search'], requiredCredentials: [], allowedAgents: ['researcher', 'operator'], approval: 'on-request' },
  { id: 'database', name: 'Database', provider: 'external', risk: 'critical', capabilities: ['read', 'write'], requiredCredentials: ['database.project'], allowedAgents: ['operator'], approval: 'always-approval' },
  { id: 'cloudflare', name: 'Cloudflare', provider: 'Composio', risk: 'critical', capabilities: ['read', 'deploy', 'dns'], requiredCredentials: ['cloudflare.production'], allowedAgents: ['operator'], approval: 'always-approval' },
  { id: 'image_generation', name: 'Image generation', provider: 'ComfyUI', risk: 'medium', capabilities: ['generate'], requiredCredentials: [], allowedAgents: ['operator', 'builder'], approval: 'policy' },
  { id: 'notifications', name: 'Notifications', provider: 'local', risk: 'low', capabilities: ['notify'], requiredCredentials: [], allowedAgents: ['operator', 'recovery'], approval: 'policy' },
]

const MCP_DEFINITIONS = [
  { id: 'gitnexus', name: 'GitNexus', transport: 'stdio', toolIds: ['git', 'filesystem'], detect: state => (state.processes?.groups?.mcp || 0) > 0 },
  { id: 'composio', name: 'Composio tool bridge', transport: 'cli', toolIds: ['github', 'cloudflare'], detect: state => state.composio?.cliPresent === true },
  { id: 'hermes', name: 'Hermes gateway', transport: 'http', toolIds: ['terminal', 'filesystem'], detect: state => state.services?.hermes?.up === true },
]

function statusFor(available, connected = available) {
  if (connected) return 'connected'
  if (available) return 'available'
  return 'unavailable'
}

export function buildToolRegistry(stateData = {}, catalog = {}) {
  const runtimes = catalog.runtimes || []
  const runtime = id => runtimes.find(item => item.id === id)
  const composio = stateData.composio || {}
  const activeToolkit = toolkit => Boolean(composio.connections?.accounts?.some(item => item.toolkit === toolkit && item.status === 'ACTIVE'))
  const availableToolkit = toolkit => Boolean(composio.toolkits?.includes(toolkit) || activeToolkit(toolkit))
  const available = {
    terminal: true,
    filesystem: true,
    git: true,
    github: availableToolkit('github'),
    browser: false,
    web_search: false,
    database: false,
    cloudflare: availableToolkit('cloudflare'),
    image_generation: Boolean(stateData.services?.comfy?.up || runtime('comfyui-wan')?.available),
    notifications: true,
  }
  return TOOL_DEFINITIONS.map(definition => ({
    ...definition,
    status: statusFor(available[definition.id]),
    available: Boolean(available[definition.id]),
    source: definition.provider === 'Quorum' ? 'native' : definition.provider === 'Composio' ? 'composio' : 'runtime-detection',
  }))
}

export function buildMcpRegistry(stateData = {}) {
  return MCP_DEFINITIONS.map(definition => {
    const detected = Boolean(definition.detect(stateData))
    const connection = definition.id === 'composio' ? stateData.composio?.connections?.counts?.active > 0 : definition.id === 'hermes' ? stateData.services?.hermes?.up === true : detected
    return {
      ...definition,
      status: statusFor(detected, connection),
      detected,
      connected: connection,
      toolIds: [...definition.toolIds],
    }
  })
}

export function buildWorkspaceRegistry(stateData = {}, missions = []) {
  const rooms = stateData.projects?.rooms || []
  const missionList = Array.isArray(missions) ? missions : []
  return rooms.map(room => ({
    id: room.id,
    label: room.label,
    cwd: room.cwd,
    exists: room.exists !== false,
    active: room.active === true,
    agents: room.agents || [],
    sessionCount: room.sessionCount || 0,
    missionCount: missionList.filter(mission => mission.workspace === room.cwd || mission.repository === room.cwd || mission.workspace === room.id).length,
    capabilities: ['files', 'git', 'terminal', 'agents', 'missions', 'memory', 'activity'],
  }))
}

export function buildTaskRegistry(missions = []) {
  return missions.flatMap(mission => (mission.tasks || []).map(task => ({
    ...task,
    missionId: mission.id,
    missionTitle: mission.title,
    workspace: mission.workspace,
    repository: mission.repository,
    branch: mission.branch,
    worktree: task.worktree || null,
  })))
}
