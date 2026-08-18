import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { verifyLicence, canonicalPayload, publicLicenceInfo, isExpired } from '../src/licence.js'

// A throwaway keypair standing in for the seller's. The point of these tests is
// that a signature from the WRONG key is rejected — so this key must not be the
// one baked into src/licence.js, and it isn't.
const { privateKey } = crypto.generateKeyPairSync('ed25519')

const sign = (payload, key = privateKey) =>
  crypto.sign(null, Buffer.from(canonicalPayload(payload), 'utf8'), key).toString('base64')

const base = {
  product: 'quorum',
  tier: 'pro',
  name: 'Test Buyer',
  email: 'buyer@example.com',
  issued: '2026-08-17',
  expires: null,
}

test('an unsigned licence never unlocks Pro', () => {
  const r = verifyLicence({ ...base })
  assert.equal(r.valid, false)
  assert.equal(r.tier, 'free')
  assert.match(r.reason, /signature/)
})

// The whole gate rests on this: anyone can write a licence file, but only the
// holder of the private key can produce one that verifies.
test('a licence signed with the wrong key is rejected', () => {
  const licence = { ...base, signature: sign(base) }
  const r = verifyLicence(licence)
  assert.equal(r.valid, false)
  assert.match(r.reason, /does not match/)
})

test('a hand-edited field invalidates an otherwise real signature', () => {
  const licence = { ...base, signature: sign(base) }
  licence.tier = 'pro'
  licence.name = 'Someone Else'
  assert.equal(verifyLicence(licence).valid, false)
})

test('missing, malformed and foreign licences all degrade to free without throwing', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, { product: 'other', tier: 'pro', signature: 'x' }]) {
    const r = verifyLicence(bad)
    assert.equal(r.valid, false)
    assert.equal(r.tier, 'free')
    assert.ok(r.reason, 'a rejection must always explain itself')
  }
})

test('a garbage signature is reported, not thrown', () => {
  assert.doesNotThrow(() => verifyLicence({ ...base, signature: '!!!not base64!!!' }))
  assert.equal(verifyLicence({ ...base, signature: '!!!not base64!!!' }).valid, false)
})

// Field order is pinned in canonicalPayload precisely so a licence that
// verifies on the issuing machine cannot fail on the buyer's.
test('canonicalPayload is stable regardless of key order at the call site', () => {
  const a = canonicalPayload({ product: 'quorum', tier: 'pro', name: 'A', email: 'e', issued: 'i', expires: null })
  const b = canonicalPayload({ expires: null, issued: 'i', email: 'e', name: 'A', tier: 'pro', product: 'quorum' })
  assert.equal(a, b)
})

test('canonicalPayload ignores extra fields such as the signature itself', () => {
  const a = canonicalPayload(base)
  const b = canonicalPayload({ ...base, signature: 'zzz', note: 'hello' })
  assert.equal(a, b)
})

// Tested directly rather than through verifyLicence: the signature check fires
// first, so reaching the expiry branch would mean shipping the seller's private
// key to the test suite.
test('expiry is judged against the given clock', () => {
  const now = Date.parse('2026-08-17')
  assert.equal(isExpired({ ...base, expires: '2020-01-01' }, now), true)
  assert.equal(isExpired({ ...base, expires: '2099-01-01' }, now), false)
})

test('a perpetual licence never expires', () => {
  assert.equal(isExpired({ ...base, expires: null }), false)
  assert.equal(isExpired({ ...base }), false)
})

// Locking a paying customer out of software on their own machine because a
// date failed to parse is the worse of the two failures.
test('an unparseable expiry is treated as perpetual, not as expired', () => {
  assert.equal(isExpired({ ...base, expires: 'whenever' }), false)
})

// A "pro" tier claim on a free licence must not sneak through the tier check.
test('a validly-signed non-pro licence does not unlock Pro', () => {
  const freeTier = { ...base, tier: 'trial' }
  const r = verifyLicence({ ...freeTier, signature: sign(freeTier) })
  assert.equal(r.tier, 'free')
})

// The cockpit shows the buyer's name; it must never show what they paid with.
test('publicLicenceInfo never exposes the signature or the email', () => {
  const info = publicLicenceInfo({ valid: true, tier: 'pro', licence: { ...base, signature: 'secret' } })
  assert.equal(info.tier, 'pro')
  assert.equal(info.registeredTo, 'Test Buyer')
  assert.equal(info.signature, undefined)
  assert.equal(info.email, undefined)
})

test('publicLicenceInfo reports the reason when there is no licence', () => {
  const info = publicLicenceInfo({ valid: false, tier: 'free', reason: 'no licence found' })
  assert.equal(info.tier, 'free')
  assert.equal(info.reason, 'no licence found')
})
