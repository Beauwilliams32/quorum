// Appearance-only metadata for the Pro cast.
//
// This ships in the open-core repo on purpose. It carries how a Pro character
// looks and what they are *for* — but never how they think. The personas
// themselves live in `cast-pro.js`, which is not part of the public tree.
//
// Advertising the locked characters instead of hiding them is a deliberate
// product decision: a greyed-out Sable with "paid to break it" underneath sells
// the upgrade far better than an absence the user never notices. It is also the
// single source of truth for a Pro character's *appearance*, which `cast-pro.js`
// imports and adds prompts to — so a character cannot look one way in the free
// build and another way once unlocked.

export const LOCKED_CAST = [
  {
    id: 'sable',
    name: 'Sable',
    role: 'Adversary',
    tagline: 'paid to find the way it breaks',
    edition: 'pro',
    palette: { body: '#f87171', trim: '#991b1b', glow: '#ffc9c9' },
    visor: 'narrow',
    crest: 'horns',
    prop: 'magnifier',
    model: 'sonnet',
  },
  {
    id: 'muse',
    name: 'Muse',
    role: 'Designer',
    tagline: 'argues for the person holding it',
    edition: 'pro',
    palette: { body: '#f472b6', trim: '#9d174d', glow: '#ffd0e7' },
    visor: 'curve',
    crest: 'plume',
    prop: 'brush',
    model: 'sonnet',
  },
  {
    id: 'ledger',
    name: 'Ledger',
    role: 'Operator',
    tagline: 'carries the pager at 3am',
    edition: 'pro',
    palette: { body: '#4ade80', trim: '#15803d', glow: '#c4f7d6' },
    visor: 'square',
    crest: 'bolt',
    prop: 'lantern',
    model: 'sonnet',
  },
]

export function lockedMember(id) {
  return LOCKED_CAST.find(c => c.id === id) || null
}
