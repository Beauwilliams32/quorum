// Identities for Quorum HQ: every author in a channel has its own key.
//
// Buzz's idea, applied locally: an agent is a member of the room, not a bot
// voice, so what it says is signed by its own Ed25519 key. The board (you) and
// the system have keys too. A message whose text was edited after the fact no
// longer verifies against its author's public key, and `quorum hq verify`
// says which one.
//
// What this is NOT: a security boundary between processes on this machine. The
// private keys live in ~/.quorum/hq/keys (0700 dir, 0600 files) and any process
// running as your OS user can read them. Signing makes the history
// attributable and tamper-evident; it does not make a local agent unable to
// impersonate another. The docs say so rather than implying otherwise.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const IDENTITY = /^(?:board|system|agent:[a-z][a-z0-9-]{1,31})$/

/** Canonical JSON: sorted keys, no whitespace, undefined dropped. What gets signed and hashed. */
export function canonical(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonical(item === undefined ? null : item)).join(',')}]`
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

export const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex')

export function assertIdentity(id) {
  const value = String(id || '')
  if (!IDENTITY.test(value)) throw new Error(`invalid identity: ${value || '(empty)'}`)
  return value
}

/** Verify one signature against a base64 SPKI public key. Never throws. */
export function verifySignature(publicKey, payload, signature) {
  try {
    if (!publicKey || !signature) return false
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'base64'))
  } catch { return false }
}

export class Keyring {
  constructor(dir) {
    this.dir = path.resolve(dir)
    this.privateKeys = new Map()
    this.publicKeys = new Map()
  }

  file(id) { return path.join(this.dir, `${assertIdentity(id).replace(':', '-')}.pem`) }

  /** The identity's public key (base64 SPKI DER), creating the pair on first use. */
  ensure(id) {
    const identity = assertIdentity(id)
    if (this.publicKeys.has(identity)) return this.publicKeys.get(identity)
    const file = this.file(identity)
    let privateKey
    if (fs.existsSync(file)) {
      privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'))
    } else {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const pair = crypto.generateKeyPairSync('ed25519')
      privateKey = pair.privateKey
      // `wx` refuses to overwrite: two writers racing on first use keep the
      // first key rather than silently orphaning signatures made with it.
      try { fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' }) }
      catch (error) { if (error.code === 'EEXIST') privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf8')); else throw error }
    }
    const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64')
    this.privateKeys.set(identity, privateKey)
    this.publicKeys.set(identity, publicKey)
    return publicKey
  }

  sign(id, payload) {
    const identity = assertIdentity(id)
    this.ensure(identity)
    return crypto.sign(null, Buffer.from(canonical(payload)), this.privateKeys.get(identity)).toString('base64')
  }
}
