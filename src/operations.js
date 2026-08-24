// Build the operator-facing view from already-collected local state. This is
// intentionally a projection: it never reads a second source, returns raw
// transcripts, or exposes credentials/config contents.
export function buildOperations(stateData = {}, feed = [], ptys = [], catalog = {}) {
  const sessions = (stateData.sessions?.cards || []).slice(0, 40).map(session => ({
    id: session.id,
    agent: session.agent,
    model: session.model,
    projectId: session.projectId,
    branch: session.branch,
    kind: session.kind,
    active: Boolean(session.active),
    summary: String(session.summary || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    updatedAt: session.mtimeMs || null,
  }))
  const agents = (stateData.agents?.agents || []).slice(0, 40).map(agent => ({
    sessionId: agent.sessionId,
    name: agent.name,
    projectId: agent.projectId,
    kind: agent.kind,
    status: agent.status,
    chatCapable: Boolean(agent.chatCapable),
    startedAt: agent.startedAt || null,
  }))
  const runtimes = (catalog.runtimes || []).map(runtime => ({
    id: runtime.id,
    label: runtime.label,
    kind: runtime.kind,
    available: Boolean(runtime.available),
    authReady: Boolean(runtime.authReady),
    capabilities: runtime.capabilities || [],
  }))
  const capabilityMap = new Map()
  for (const runtime of runtimes) for (const capability of runtime.capabilities) {
    const entry = capabilityMap.get(capability) || { id: capability, label: capability.replaceAll('-', ' '), runtimes: 0, ready: 0 }
    entry.runtimes++
    if (runtime.available) entry.ready++
    capabilityMap.set(capability, entry)
  }
  const services = stateData.services || {}
  const nodes = [
    { id: 'quorum', label: 'Quorum loopback', kind: 'control plane', status: 'ready', detail: '127.0.0.1:4747' },
    { id: 'openclaw', label: 'OpenClaw Gateway', kind: 'agent gateway', status: services.openclaw?.up ? 'ready' : 'offline', detail: services.openclaw?.port ? `127.0.0.1:${services.openclaw.port}` : '18789' },
    { id: 'hermes', label: 'Hermes Gateway', kind: 'local harness', status: services.hermes?.up ? 'ready' : 'offline', detail: '127.0.0.1:8644' },
    { id: 'comfyui', label: 'ComfyUI / Wan', kind: 'media node', status: services.comfy?.up ? 'ready' : 'offline', detail: '127.0.0.1:8188' },
  ]
  const channels = [
    { id: 'roundtable', label: 'Quorum roundtable', status: 'ready', detail: 'decision records + cost preview' },
    { id: 'project-rooms', label: 'Project rooms', status: 'ready', detail: `${stateData.projects?.rooms?.length || 0} known rooms` },
    { id: 'pty', label: 'Managed terminals', status: ptys.length ? 'active' : 'ready', detail: `${ptys.length} tracked PTYs` },
    { id: 'composio', label: 'Tool connections', status: stateData.composio?.cliPresent ? 'ready' : 'offline', detail: `${stateData.composio?.toolkits?.length || 0} local toolkits` },
  ]
  return {
    ts: Date.now(),
    overview: {
      activeSessions: sessions.filter(s => s.active).length,
      sessions: sessions.length,
      agents: agents.length,
      trackedPtys: ptys.filter(p => !p.exited).length,
      skills: capabilityMap.size,
      nodes: nodes.filter(n => n.status !== 'offline').length,
    },
    sessions,
    agents,
    runtimes,
    skills: [...capabilityMap.values()].sort((a, b) => a.label.localeCompare(b.label)),
    nodes,
    channels,
    cronJobs: (stateData.tasks?.tasks || []).filter(task => task.status !== 'completed').slice(0, 30).map(task => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      live: Boolean(task.live),
      projectId: task.projectId,
      agent: task.agent,
    })),
    events: feed.slice(-30).map(item => ({ kind: item.kind, ts: item.ts, text: String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 180) })),
  }
}
