import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMcpRegistry, buildTaskRegistry, buildToolRegistry, buildWorkspaceRegistry } from '../src/registry.js'

const state = {
  services: { hermes: { up: true }, comfy: { up: false } },
  processes: { groups: { mcp: 1 } },
  composio: { cliPresent: true, toolkits: ['github'], connections: { counts: { active: 1 }, accounts: [{ toolkit: 'github', status: 'ACTIVE' }] } },
}

test('tool registry exposes capability, risk, approval, and truthful availability', () => {
  const tools = buildToolRegistry(state, { runtimes: [{ id: 'comfyui-wan', available: false }] })
  const terminal = tools.find(tool => tool.id === 'terminal')
  assert.equal(terminal.status, 'connected')
  assert.equal(terminal.approval, 'explicit')
  assert.deepEqual(terminal.requiredCredentials, [])
  assert.ok(tools.find(tool => tool.id === 'github').allowedAgents.includes('builder'))
  assert.equal(tools.find(tool => tool.id === 'github').status, 'connected')
  assert.equal(tools.find(tool => tool.id === 'browser').status, 'unavailable')
  assert.equal(JSON.stringify(tools).includes('token'), false)
})

test('MCP registry distinguishes detected and connected services', () => {
  const servers = buildMcpRegistry(state)
  assert.equal(servers.find(server => server.id === 'gitnexus').status, 'connected')
  assert.equal(servers.find(server => server.id === 'composio').status, 'connected')
  assert.equal(servers.find(server => server.id === 'hermes').connected, true)
})

test('workspace and task registries join real room and mission state', () => {
  const missions = [{ id: 'm1', title: 'Ship', workspace: '/tmp/project', tasks: [{ id: 't1', status: 'queued' }] }]
  const workspaces = buildWorkspaceRegistry({ projects: { rooms: [{ id: 'room', label: 'Project', cwd: '/tmp/project', agents: ['codex'], sessionCount: 1, active: true }] } }, missions)
  assert.equal(workspaces[0].missionCount, 1)
  assert.ok(workspaces[0].capabilities.includes('memory'))
  assert.equal(buildTaskRegistry(missions)[0].missionId, 'm1')
})
