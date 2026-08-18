/**
 * Build the loopback health payload without exposing collector internals or secrets.
 * A missing Hermes gateway is degraded service, not a reason to crash the cockpit.
 */
export function buildHealth(stateData = {}, { now = Date.now(), startedAt = now } = {}) {
  const services = stateData.services || {}
  const sessions = stateData.sessions?.cards || []
  const projects = stateData.projects?.rooms || []
  const hermes = services.hermes?.up === true
  const comfy = services.comfy?.up === true

  return {
    status: hermes ? 'ok' : 'degraded',
    uptimeMs: Math.max(0, now - startedAt),
    services: { hermes, comfy },
    sessions: {
      total: sessions.length,
      active: sessions.filter(session => session.active === true).length,
    },
    projects: {
      total: projects.length,
      active: projects.filter(project => project.active === true).length,
    },
    ts: now,
  }
}
