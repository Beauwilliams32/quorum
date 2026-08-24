/**
 * Build the loopback health payload without exposing collector internals or secrets.
 * A missing Hermes gateway is degraded service, not a reason to crash the cockpit.
 */
export function buildHealth(stateData = {}, { now = Date.now(), startedAt = now } = {}) {
  const services = stateData.services || {}
  const auth = services.auth || {}
  const sessions = stateData.sessions?.cards || []
  const projects = stateData.projects?.rooms || []
  const hermes = services.hermes?.up === true
  const comfy = services.comfy?.up === true
  const openclaw = services.openclaw?.up === true

  return {
    status: hermes ? 'ok' : 'degraded',
    uptimeMs: Math.max(0, now - startedAt),
    services: { hermes, comfy, openclaw },
    readiness: {
      // The cockpit itself works without Hermes.  Only a roundtable needs the
      // Claude CLI plus local account state, so callers can recover the right
      // dependency instead of treating every optional service as an outage.
      cockpit: 'ready',
      roundtable: !auth.claude?.cli ? 'missing-claude-cli'
        : auth.claude?.configured && auth.anthropic?.apiKeyAvailable ? 'ready-cli-and-api-key'
          : auth.claude?.configured ? 'ready-cli'
            : auth.anthropic?.apiKeyAvailable ? 'ready-api-key'
              : 'needs-claude-login-or-api-key',
      hermes: hermes ? 'ready' : 'optional-offline',
      openclaw: openclaw ? 'ready' : 'optional-offline',
    },
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
