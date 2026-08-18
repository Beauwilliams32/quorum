import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTurn, Roundtable, RoundtableRegistry } from '../src/roundtable.js'
import { cast, debaters, registerCast, MODERATOR_ID, castMember, publicCast } from '../src/cast.js'
import { LOCKED_CAST } from '../src/cast-locked.js'

// A fake State: the engine only ever calls broadcast/event on it.
const fakeState = () => ({ sent: [], broadcast(m) { this.sent.push(m) }, event(m) { this.sent.push(m) } })

test('parseTurn reads the documented schema', () => {
  const t = parseTurn('{"position":"ship it","confidence":80,"body":"because x","targets":["vex"],"conceded":false}')
  assert.equal(t.position, 'ship it')
  assert.equal(t.confidence, 80)
  assert.equal(t.body, 'because x')
  assert.deepEqual(t.targets, ['vex'])
  assert.equal(t.conceded, false)
  assert.equal(t.parsed, true)
})

test('parseTurn survives a fenced block', () => {
  const t = parseTurn('```json\n{"position":"no","confidence":10,"body":"nope"}\n```')
  assert.equal(t.position, 'no')
  assert.equal(t.confidence, 10)
  assert.equal(t.parsed, true)
})

test('parseTurn survives prose wrapped around the object', () => {
  const t = parseTurn('Sure, here you go:\n{"position":"maybe","confidence":50,"body":"hedged"}\nHope that helps!')
  assert.equal(t.position, 'maybe')
  assert.equal(t.parsed, true)
})

// A model that ignores the schema entirely still cost money, so its argument
// has to reach the UI rather than being dropped as a parse failure.
test('parseTurn degrades to plain text rather than throwing', () => {
  const t = parseTurn('I think we should just use a queue.')
  assert.equal(t.parsed, false)
  assert.equal(t.body, 'I think we should just use a queue.')
  assert.equal(t.confidence, null)
  assert.deepEqual(t.targets, [])
})

test('parseTurn clamps a confidence outside 0-100', () => {
  assert.equal(parseTurn('{"confidence":400,"body":"x"}').confidence, 100)
  assert.equal(parseTurn('{"confidence":-9,"body":"x"}').confidence, 0)
  assert.equal(parseTurn('{"confidence":"high","body":"x"}').confidence, null)
})

test('a roundtable needs a topic and at least two participants', () => {
  const s = fakeState()
  assert.throws(() => new Roundtable(s, { topic: '', participants: ['vex', 'bolt'] }), /topic/)
  assert.throws(() => new Roundtable(s, { topic: 'x', participants: ['vex'] }), /at least 2/)
  assert.throws(() => new Roundtable(s, { topic: 'x', participants: [] }), /at least 2/)
})

// The moderator has no side, so seating it as a debater would put an agent in
// the room with a prompt that refuses to hold a position.
test('the moderator cannot be seated as a participant', () => {
  const s = fakeState()
  assert.throws(() => new Roundtable(s, { topic: 'x', participants: [MODERATOR_ID, 'vex'] }), /at least 2/)
  const rt = new Roundtable(s, { topic: 'x', participants: [MODERATOR_ID, 'vex', 'bolt'] })
  assert.deepEqual(rt.participants, ['vex', 'bolt'])
})

test('unknown and duplicate participants are dropped, and the table is capped', () => {
  const s = fakeState()
  const rt = new Roundtable(s, { topic: 'x', participants: ['vex', 'vex', 'ghost', 'bolt'] })
  assert.deepEqual(rt.participants, ['vex', 'bolt'])

  const big = new Roundtable(s, { topic: "x", participants: [...debaters().map(c => c.id), "vex", "extra1", "extra2"] })
  assert.ok(big.participants.length <= 5, 'no more than 5 seats')
})

test('turnCount matches the protocol: brief + 3 per participant + verdict', () => {
  assert.equal(Roundtable.turnCount(2), 8)
  assert.equal(Roundtable.turnCount(3), 11)
  assert.equal(Roundtable.turnCount(5), 17)
})

test('an unknown model falls back to sonnet rather than being passed through', () => {
  const s = fakeState()
  assert.equal(new Roundtable(s, { topic: 'x', participants: ['vex', 'bolt'], model: 'gpt-9' }).model, 'sonnet')
  assert.equal(new Roundtable(s, { topic: 'x', participants: ['vex', 'bolt'], model: 'opus' }).model, 'opus')
})

test('the topic is truncated rather than sent unbounded to the model', () => {
  const s = fakeState()
  const rt = new Roundtable(s, { topic: 'a'.repeat(5000), participants: ['vex', 'bolt'] })
  assert.ok(rt.topic.length <= 600)
})

test('snapshot carries what the UI renders and nothing that costs a fetch', () => {
  const s = fakeState()
  const rt = new Roundtable(s, { topic: 'ship or wait', participants: ['vex', 'bolt'], roomId: 'uao' })
  const snap = rt.snapshot()
  for (const k of ['id', 'topic', 'phase', 'turns', 'participants', 'costUsd'])
    assert.ok(k in snap, `snapshot is missing ${k}`)
  assert.equal(snap.phase, 'idle')
  assert.deepEqual(snap.turns, [])
})

// Two tables arguing the same question in one project is duplicate spend.
test('the registry refuses a second live debate in the same room', () => {
  const s = fakeState()
  const reg = new RoundtableRegistry(s)
  const rt = new Roundtable(s, { topic: 'x', participants: ['vex', 'bolt'], roomId: 'uao' })
  reg.live.set('uao', rt)
  assert.throws(() => reg.start({ topic: 'y', participants: ['vex', 'bolt'], roomId: 'uao' }), /already running/)
  // A different room is unaffected.
  assert.doesNotThrow(() => {
    const other = new Roundtable(s, { topic: 'y', participants: ['vex', 'bolt'], roomId: 'portal' })
    reg.live.set('portal', other)
  })
})

test('cancel is idempotent and safe on a debate that never started', () => {
  const s = fakeState()
  const rt = new Roundtable(s, { topic: 'x', participants: ['vex', 'bolt'] })
  rt.cancel()
  rt.cancel()
  assert.equal(rt.cancelled, true)
})

/* ── cast ─────────────────────────────────────────────────────────────── */

test('every cast member has the fields the art layer indexes on', () => {
  for (const c of cast()) {
    assert.ok(c.id && c.name && c.role, `${c.id} is missing identity`)
    assert.ok(c.palette?.body && c.palette?.trim && c.palette?.glow, `${c.id} has an incomplete palette`)
    assert.ok(c.visor && c.crest, `${c.id} is missing visor/crest`)
    assert.ok(c.prompt && c.prompt.length > 80, `${c.id} has no real persona`)
  }
})

test('cast ids are unique', () => {
  assert.equal(new Set(cast().map(c => c.id)).size, cast().length)
})

// The free edition has to be able to run a genuine debate on its own, or the
// open-core repo is a demo rather than a product.
test('the free cast can seat a real two-sided debate', () => {
  const free = cast()
  assert.ok(free.length >= 3, 'need a moderator plus two opposed debaters')
  assert.ok(debaters().length >= 2)
  assert.doesNotThrow(() => new Roundtable(fakeState(), { topic: 'x', participants: ['vex', 'bolt'] }))
})

// The personas are the product's actual IP; shipping them to the browser puts
// them in devtools for anyone who opens the page.
test('publicCast never leaks the persona prompts', () => {
  const pub = publicCast()
  assert.equal(pub.length, cast().length)
  for (const c of pub) assert.equal(c.prompt, undefined)
  assert.ok(pub.every(c => c.palette && c.name))
  // The server-side cast is untouched by the redaction.
  assert.ok(castMember('vex').prompt.length > 80)
})

// Locked characters are advertised to sell the upgrade, so they cross the wire
// on purpose — but appearance only, never the persona.
test('publicCast advertises locked members without their prompts', () => {
  const pub = publicCast(LOCKED_CAST)
  const sable = pub.find(c => c.id === 'sable')
  assert.ok(sable, 'locked members should be advertised')
  assert.equal(sable.locked, true)
  assert.equal(sable.prompt, undefined)
  assert.ok(sable.palette.body, 'appearance is public')
  assert.ok(pub.filter(c => !c.locked).every(c => c.locked === false))
})

test('locked metadata carries no personas at all', () => {
  for (const c of LOCKED_CAST) assert.equal(c.prompt, undefined, `${c.id} leaked a prompt`)
})

test('exactly one moderator, and it is excluded from the debater pool', () => {
  assert.equal(cast().filter(c => c.mascot).length, 1)
  assert.equal(cast().find(c => c.mascot).id, MODERATOR_ID)
  assert.ok(!debaters().some(c => c.id === MODERATOR_ID))
  assert.equal(debaters().length, cast().length - 1)
})

// A Pro pack that could overwrite Vex would change how an archived debate reads
// when it is re-opened months later.
test('registerCast refuses to overwrite an existing character', () => {
  const before = castMember('vex').prompt
  const added = registerCast([{ id: 'vex', name: 'Fake', palette: { body: '#fff' }, prompt: 'x'.repeat(100) }])
  assert.deepEqual(added, [])
  assert.equal(castMember('vex').prompt, before)
})

test('registerCast rejects members missing a palette or a persona', () => {
  assert.deepEqual(registerCast([{ id: 'ghost1', prompt: 'x' }]), [])
  assert.deepEqual(registerCast([{ id: 'ghost2', palette: { body: '#fff' } }]), [])
  assert.equal(castMember('ghost1'), null)
  assert.equal(castMember('ghost2'), null)
})

test('castMember returns null for an unknown id instead of throwing', () => {
  assert.equal(castMember('nobody'), null)
  assert.equal(castMember(undefined), null)
})
