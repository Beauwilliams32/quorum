export function buildCityState(data = {}, scheduler = null, services = []) {
  const rooms = data.projects?.rooms || []
  const agents = data.agents?.agents || []
  const processes = data.processes?.inventory || data.processes?.procs || []
  const buildings = rooms.map((room, index) => ({ schemaVersion: 1, id: `building:${room.id}`, entityType: 'building', projectId: room.id, label: room.label, cwd: room.cwd, status: room.active ? 'active' : 'monitoring', district: room.source || 'workspace', index, sessionCount: (data.sessions?.cards || []).filter(item => item.projectId === room.id).length }))
  buildings.push({ schemaVersion: 1, id: 'building:memory', entityType: 'infrastructure', label: 'Memory Archive', status: data.memory?.ok ? 'monitoring' : 'attention', district: 'core', index: buildings.length }, { schemaVersion: 1, id: 'building:approvals', entityType: 'infrastructure', label: 'Approval Hall', status: (data.agentControl?.actions || []).some(item => item.status === 'pending-approval') ? 'attention' : 'monitoring', district: 'core', index: buildings.length + 1 })
  const gateways = [['openclaw', 'OpenClaw Gateway'], ['hermes', 'Hermes Gateway']]
  for (const [id, label] of gateways) {
    const service = id === 'openclaw' ? { ...(data.services?.[id] || {}), ...(data.openclaw || {}) } : (data.services?.[id] || {})
    const connectionState = service.connectionState || (service.up ? 'reachable' : 'offline')
    const live = service.up === true || ['reachable', 'connecting', 'connected', 'degraded', 'auth-required'].includes(connectionState)
    buildings.push({ schemaVersion: 1, id: `building:gateway:${id}`, entityType: 'infrastructure', label, status: connectionState === 'connected' ? 'active' : live ? 'attention' : 'failed', district: 'gateways', index: buildings.length, connectionState, authState: service.authState || 'unknown', port: service.port || null })
  }
  const characters = agents.map(agent => ({ schemaVersion: 1, id: `agent:${agent.sessionId}`, entityType: 'agent', label: agent.name, state: agent.status || 'monitoring', projectId: agent.projectId, sessionId: agent.sessionId }))
  const workers = processes.filter(item => ['agent-runtime', 'terminal', 'container'].includes(item.kind)).slice(0, 180).map(item => ({ schemaVersion: 1, id: item.id || `process:${item.pid}`, entityType: 'process', label: item.name, state: item.state || 'monitoring', pid: item.pid, kind: item.kind, ownership: item.ownership, projectId: item.projectId || null }))
  return { schemaVersion: 1, buildings, characters, workers, services: services.slice(0, 400), standingJobs: scheduler?.jobs || [], ts: Date.now() }
}
