// Licence verification for Quorum Pro.
//
// ── What this is, honestly ──────────────────────────────────────────────────
// This is a lock on the front door, not a vault. Quorum ships as source, so a
// determined buyer can delete the check in about a minute. That is fine and it
// is not what the gate is for: the gate exists so that honest people know what
// they bought and when it expires, and so that the Pro personas are simply not
// present in the free distribution. The real protection is distribution — the
// personas live in a private repo — not this file.
//
// Because of that, the verification is deliberately offline and deliberately
// simple. No licence server, no phone-home, no telemetry. A licence is an
// Ed25519 signature over a canonical JSON payload; the public key below is
// baked in, and the private key never leaves the seller's machine (it is not
// in any repository — see docs/pro/README.md).
//
// A licence being invalid is never a crash. It degrades to the free edition
// with a stated reason, because the worst outcome here is a paying customer
// locked out of a tool that runs on their own machine.

import crypto from 'node:crypto'
import fs from 'node:fs'
import { dataDir, findFile } from './paths.js'

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1jbYSh0RuATlBGVo4bpPsK9ua/afFBvoW5vsO+UjDy0=
-----END PUBLIC KEY-----`

export const LICENCE_FILE = dataDir('licence.json')

/**
 * The exact bytes that get signed. Field order is fixed here rather than
 * relying on JSON.stringify's key order at the call site — a licence that
 * verifies on the issuing machine and fails on the buyer's because a key moved
 * would be an unfixable-looking support ticket.
 */
export function canonicalPayload(licence) {
  return JSON.stringify({
    product: String(licence.product ?? ''),
    tier: String(licence.tier ?? ''),
    name: String(licence.name ?? ''),
    email: String(licence.email ?? ''),
    issued: String(licence.issued ?? ''),
    expires: licence.expires == null ? null : String(licence.expires),
  })
}

/**
 * @returns {{valid: boolean, tier: string, reason: string, licence: object|null}}
 */
export function verifyLicence(licence, now = Date.now()) {
  if (!licence || typeof licence !== 'object')
    return fail('no licence found')
  if (licence.product !== 'quorum')
    return fail('licence is for a different product')
  if (typeof licence.signature !== 'string' || !licence.signature)
    return fail('licence has no signature')

  let ok = false
  try {
    ok = crypto.verify(
      null,
      Buffer.from(canonicalPayload(licence), 'utf8'),
      crypto.createPublicKey(PUBLIC_KEY),
      Buffer.from(licence.signature, 'base64'),
    )
  } catch {
    return fail('licence signature is malformed')
  }
  if (!ok) return fail('licence signature does not match')

  if (isExpired(licence, now))
    return { valid: false, tier: 'free', reason: `licence expired ${licence.expires}`, licence }

  const tier = licence.tier === 'pro' ? 'pro' : 'free'
  if (tier !== 'pro') return fail('licence is not a Pro licence')

  return { valid: true, tier: 'pro', reason: 'ok', licence }
}

const fail = reason => ({ valid: false, tier: 'free', reason, licence: null })

/**
 * Expiry covers updates, not the software itself: a perpetual licence has a
 * null expiry, and an expired one still runs the version it was bought for.
 *
 * Separated from verifyLicence so it can be tested without the seller's private
 * key — inside verifyLicence the signature check fires first (correctly), which
 * would make every expiry test unreachable without shipping the key to CI.
 * An unparseable date is treated as no expiry rather than as expired: locking a
 * paying customer out over a typo is the worse failure.
 */
export function isExpired(licence, now = Date.now()) {
  if (!licence?.expires) return false
  const t = Date.parse(licence.expires)
  return Number.isFinite(t) && t < now
}

/** Read the licence from disk (current home, then the pre-rename one). */
export function readLicence() {
  const file = findFile('licence.json')
  if (!file) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Never returns the signature or the buyer's email to the UI. The cockpit only
 * needs to know which tier is active and who it is registered to.
 */
export function publicLicenceInfo(result) {
  if (!result?.valid) return { tier: 'free', reason: result?.reason || 'no licence found' }
  return {
    tier: 'pro',
    registeredTo: result.licence.name || null,
    expires: result.licence.expires || null,
  }
}
