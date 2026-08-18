// Which edition of Quorum is running, and what that unlocks.
//
// Two independent things have to be true for the Pro cast to appear: the Pro
// module has to be present on disk (it is absent from the open-core repo), and
// a valid licence has to verify. Either one missing means free edition — with a
// reason the UI can show, because "why is Sable greyed out" is the single most
// likely support question and it should answer itself.
//
// Custom cast authoring is a Pro feature and it loads from the same place, so a
// buyer can add their own specialists without editing the source.

import fs from 'node:fs'
import { registerCast } from './cast.js'
import { LOCKED_CAST } from './cast-locked.js'
import { readLicence, verifyLicence, publicLicenceInfo } from './licence.js'
import { findFile } from './paths.js'

const state = { tier: 'free', reason: 'not loaded', licence: null, custom: 0 }

/**
 * Resolve the edition and register whatever it unlocks. Call once, before the
 * server starts listening, so the very first websocket handshake already
 * carries the right cast — a client that connects during loading would
 * otherwise cache a free cast for the life of the page.
 */
export async function loadEdition() {
  const result = verifyLicence(readLicence())
  state.tier = result.tier
  state.reason = result.reason
  state.licence = publicLicenceInfo(result)

  if (result.valid) {
    // The Pro module is genuinely absent in the open-core build, so a failed
    // import is the expected path there, not an error worth surfacing.
    try {
      const mod = await import('./cast-pro.js')
      registerCast(mod.PRO_CAST || [])
    } catch {
      state.tier = 'free'
      state.reason = 'licence is valid but the Pro cast is not installed'
    }
  }

  if (state.tier === 'pro') state.custom = loadCustomCast()
  return editionInfo()
}

/**
 * Buyer-authored personas from `~/.quorum/cast/*.json`. Deliberately not read
 * in the free edition: it would be a trivial way to reconstruct the Pro cast,
 * and it is the headline Pro feature.
 *
 * A malformed file is skipped rather than fatal — one bad character file must
 * not stop the cockpit from starting.
 */
function loadCustomCast() {
  const dir = findFile('cast')
  if (!dir) return 0
  let files = []
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')) } catch { return 0 }

  const members = []
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'))
      if (!m?.id || !m?.prompt || !m?.palette?.body) continue
      members.push({
        id: String(m.id).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24),
        name: String(m.name || m.id).slice(0, 24),
        role: String(m.role || 'Specialist').slice(0, 24),
        tagline: String(m.tagline || '').slice(0, 80),
        edition: 'custom',
        palette: {
          body: colour(m.palette.body, '#94a3b8'),
          trim: colour(m.palette.trim, '#475569'),
          glow: colour(m.palette.glow, '#e2e8f0'),
        },
        visor: String(m.visor || 'dot'),
        crest: String(m.crest || 'spark'),
        prop: String(m.prop || 'clipboard'),
        model: ['sonnet', 'opus', 'haiku'].includes(m.model) ? m.model : 'sonnet',
        prompt: String(m.prompt).slice(0, 4000),
      })
    } catch { /* skip this character, keep the rest */ }
  }
  return registerCast(members).length
}

// Palettes are interpolated straight into SVG attributes, so a hostile value
// in a hand-edited character file must not become markup.
const colour = (v, fallback) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v)) ? String(v) : fallback)

export function editionInfo() {
  return {
    tier: state.tier,
    reason: state.reason,
    licence: state.licence,
    customCount: state.custom,
    // Advertised but unusable in the free edition — the UI greys these out.
    locked: state.tier === 'pro' ? [] : LOCKED_CAST,
  }
}

export function isPro() {
  return state.tier === 'pro'
}
