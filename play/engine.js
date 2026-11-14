/* RUIN play engine — bundled from ruin-sim/src for the browser. Play page only. */
(function(root) {
'use strict';
const modules = Object.create(null);
function req(name) {
  const mapped = name;
  if (!modules[mapped]) throw new Error('Unknown module ' + name);
  return modules[mapped].exports;
}

modules["./rng"] = { exports: {} };
(function(module, exports, require) {
'use strict';
// mulberry32 seeded RNG
function makeRng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (n) => Math.floor(r() * n);
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  return r;
}
module.exports = { makeRng };

})(modules["./rng"], modules["./rng"].exports, req);


modules["./effects"] = { exports: {} };
(function(module, exports, require) {
'use strict';
// Card text -> effect objects. Each sentence of a card's text must match one pattern
// below or it is logged as VAGUE (and that sentence is ignored; the card keeps its stats
// and any sentences that did parse).
//
// Effect shapes:
//   { hook, fn(G,p,self,ctx), v? }        triggered (hooks: enter, death, anyDeath, friendlyDeath,
//                                          enemyDeath, riteCast, attack, hitLife, afterCombat, tithe,
//                                          startTurn, endTurn, resolve (Rites), activated, enemyMissed)
//   { income(G,p,self) -> n }              Economic income at step 2
//   { aura(G,p,self,soul) -> n }           Might bonus to a friendly soul (soul may === self)
//   { enemyAura(G,p,self,soul) -> n }      Might change on an enemy soul (negative)
//   { costMod(G,p,self,card) -> n }        Deploy change for cards p casts
//   { wageMod(G,p,self,perm) -> n }        Wage change for p's permanents
//   { flag: name, ... }                    misc flags read by engine/AI

const num = (s) => ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }[s] ?? parseInt(s, 10));
const NOOP = []; // matched, no mechanical effect (restates base rules / pure tag)

function norm(text) {
  return text.toLowerCase()
    .replace(/[\u2212\u2013]/g, '-').replace(/\u2014/g, ' - ')
    .replace(/\u2265/g, '>=').replace(/\u2264/g, '<=')
    .replace(/\s+/g, ' ').trim();
}

function splitSentences(t) {
  // split on ". " but keep "(min 0)" etc. inside
  const out = [];
  for (let part of t.split(/\.\s+|\.$/)) { part = part.trim(); if (part) out.push(part.replace(/\.$/, '')); }
  return out;
}

const isAnu = (c) => c.set === 'Anu';
const hasKw = (perm, kw) => (perm.card.keywords || []).includes(kw) || (perm.extraKw || []).includes(kw);
const isRaid = (perm) => hasKw(perm, 'Raid');
const isCustodes = (card) => /custodes/i.test(card.name);
const isWarsaber = (card) => /warsaber/i.test(card.name) || /warsaber/i.test(card.text);

// ---------- pattern table ----------
// [regex, (m, card, ctx) => effects[] | null]
const P = [];
const add = (re, fn) => P.push([re, fn]);
const addFirst = (re, fn) => P.unshift([re, fn]); // RITER 2026-11-14 rewrites take priority

// --- pure restatements / tags ---
add(/^enter by end of turn 1$/, () => NOOP);
add(/^(martialus|warsaber mount|hybrid|token-like|tithe reminder|tithe|timefall|annex hint.*never)$/, () => NOOP);
add(/^(same-turn attack if cohesion high|may attack on enter if cohesion is high|cannot attack the turn it enters unless cohesion high)$/, () => NOOP);
add(/^rites (deploy -0 reminder|that age gain \+0 specie reminder)$/, () => NOOP);
add(/^when you miss wages, lose only cohesion-not an extra life \(reminder\)$/, () => NOOP);
add(/^martialus enter with \+0; rites paint \+1 age$/, () => null); // vague
// bare keyword sentences
add(/^raid$/, (m, c) => c.type === 'Martial' ? [{ hook: 'hitLife', fn: async (G, p, s) => { if (G.high(p)) await G.steal(p, 1, s); } }] : null);
add(/^canopy$/, () => [{ hook: 'enter', fn: async (G, p) => { p.canopy += 1; } }]);
add(/^spire$/, () => [{ hook: 'startTurn', fn: async (G, p) => await G.scry(p, 1) }]);
add(/^uprising( bonus)?$/, (m, c) => c.type === 'Martial' ? [{ aura: (G, p, s, x) => (x === s && G.opp(p).missedLast ? 1 : 0) }] : null);
add(/^blood dune( fuel)?( when this dies)?$/, (m, c) => {
  if (c.type === 'Martial') return [{ hook: 'death', fn: async (G, p) => await G.bloodDune(p, 1) }];
  if (c.type === 'Rite') return [{ hook: 'resolve', fn: async (G, p) => await G.bloodDune(p, 1), v: 0.5 }];
  if (c.type === 'Economic') return [{ hook: 'friendlyDeath', once: true, fn: async (G, p) => await G.bloodDune(p, 1) }];
  return null;
});
add(/^dune age$/, () => [{ hook: 'resolve', fn: async (G, p) => await G.duneAge(p), v: 1.5 }]);
add(/^spire \+ canopy$/, () => [{ hook: 'enter', fn: async (G, p) => { p.canopy += 1; } }, { hook: 'startTurn', fn: async (G, p) => await G.scry(p, 1) }]);
add(/^canopy \+ spire scry 3$/, () => [{ hook: 'resolve', fn: async (G, p) => { p.canopy += 1; await G.scry(p, 3); }, v: 1.5 }]);
add(/^(spire\. )?canopy\. chain of command with deploy (\d)$/, () => null);
add(/^chain of command (with )?deploy (\d)$/, (m) => sameDeployBuff(+m[2]));
add(/^chain of command deploy (\d)\. (.*)$/, () => null);

function sameDeployBuff(d) { // +1 Might to this while another friendly soul shares its Deploy
  return [{ aura: (G, p, s, x) => (x === s && G.souls(p).some(o => o !== s && G.chainShares(o, d ?? s.deploy, s)) ? 1 : 0) }];
}

// --- Leaders / auras ---
add(/^while you have high cohesion, martialus you control get \+(\d) might$/, (m) => [{ aura: (G, p) => (G.high(p) ? +m[1] : 0) }]);
add(/^tithe: when you pay wages( in full)?, gain (\d) specie$/, (m) => [{ hook: 'tithe', fn: async (G, p) => G.gain(p, +m[2]) }]);
add(/^tithe: when you pay in full, gain (\d) specie$/, (m) => [{ hook: 'tithe', fn: async (G, p) => G.gain(p, +m[1]) }]);
add(/^tithe: gain (\d) specie when you pay wages$/, (m) => [{ hook: 'tithe', fn: async (G, p) => G.gain(p, +m[1]) }]);
add(/^tithe: \+(\d) specie when wages paid$/, (m) => [{ hook: 'tithe', fn: async (G, p) => G.gain(p, +m[1]) }]);
add(/^tithe: when you pay wages, gain 1 specie\. if wage bill >=5, gain 2 instead$/, () => [{ hook: 'tithe', fn: async (G, p, s, c) => G.gain(p, c.bill >= 5 ? 2 : 1) }]);
add(/^tithe: when you pay wages, gain 1 specie$/, () => [{ hook: 'tithe', fn: async (G, p) => G.gain(p, 1) }]);
add(/^once per turn, when martialus you control deals damage to life, gain 1 specie$/, () => [{ hook: 'hitLife', once: true, fn: async (G, p) => G.gain(p, 1) }]);
add(/^annex: if cohesion high, you may age an enemy martialus after combat$/, () => [{ hook: 'afterCombat', fn: async (G, p) => { if (G.high(p)) await G.ageEnemyBest(p, 1); } }]);
add(/^canopy: once per game, skip your timefall pulse choice$/, () => [{ hook: 'enter', fn: async (G, p) => { p.canopy += 1; } }]);
add(/^your custodes martialus cost 1 less deploy \(min 0\)$/, () => [{ costMod: (G, p, s, c) => (c.type === 'Martial' && isCustodes(c) ? -1 : 0) }]);
add(/^spire: at the start of your turn, look at the top card of your deck; leave or bottom it$/, () => [{ hook: 'startTurn', fn: async (G, p) => await G.scry(p, 1) }]);
add(/^while you control a spire economic, draw 1 the first time you pay wages each turn$/, () => [{ hook: 'tithe', fn: async (G, p) => { if (G.econs(p).some(e => hasKw(e, 'Spire'))) G.draw(p, 1); } }]);
add(/^chain of command: martialus you control get \+1 might$/, () => [{ aura: () => 1 }]);
add(/^spire: the first time you cast a rite each turn, look at the top card of your deck; leave it or bottom it$/, () => [{ hook: 'riteCast', once: true, fn: async (G, p) => await G.scry(p, 1) }]);
add(/^martialus you control with tithe or chain of command enter with \+1 might$/, () => [{ hook: 'friendlyEnter', fn: async (G, p, s, c) => { if (hasKw(c.soul, 'Tithe') || hasKw(c.soul, 'Chain of Command')) c.soul.mods += 1; } }]);
add(/^when you miss wages, lose 1 life instead of low cohesion once per game$/, () => [{ flag: 'abbadon' }]);
add(/^rites cost 1 less( deploy)?( \(min 0\))?( while this (is out|lives))?( \(min 0\))?$/, () => [{ costMod: (G, p, s, c) => (c.type === 'Rite' ? -1 : 0) }]);
add(/^when you cast a rite, if cohesion high, age one enemy martialus$/, () => [{ hook: 'riteCast', fn: async (G, p) => { if (G.high(p)) await G.ageEnemyBest(p, 1); } }]);
add(/^once per turn, pay 2 specie: deal 1 damage to enemy life$/, () => [{ hook: 'activated', fn: async (G, p) => { if (p.specie >= 2 + G.reserve(p)) { p.specie -= 2; G.dmgLife(p, (G.ownerHasCanopyCard(p) ? 2 : 1)); } } }]);
add(/^if you control a canopy card, deal 2 instead$/, () => NOOP); // folded into the line above
add(/^annex: when an enemy martialus dies in combat, if cohesion high, put a colovian levy token \(might 1, wage 1\) onto your board$/, () => [{ hook: 'enemyDeath', fn: async (G, p, s, c) => { if (c.combat && G.high(p)) await G.token(p, 1, 1, 'Colovian Levy'); } }]);
add(/^tithe: when you pay wages in full, your levy tokens get \+1 might until end of turn$/, () => [{ hook: 'tithe', fn: async (G, p) => G.souls(p).filter(x => x.token && /levy/i.test(x.name)).forEach(x => (x.temp += 1)) }]);
add(/^your wage bill may be paid 1 short and still count as high cohesion$/, () => [{ flag: 'oneShort' }]);
add(/^canopy: if you pay your full wage bill on a timefall turn, you may skip that pulse choice$/, () => [{ flag: 'samuelCanopy' }]);

// Anu leaders
add(/^raid martialus you control get \+(\d) might$/, (m) => [{ aura: (G, p, s, x) => (isRaid(x) ? +m[1] : 0) }]);
add(/^when umbuso's board has high cohesion, first attack each turn steals 1 specie$/, () => [{ hook: 'attack', once: true, fn: async (G, p, s) => { if (G.high(p)) await G.steal(p, 1, s); } }]);
add(/^once per turn: dune age$/, () => [{ hook: 'activated', fn: async (G, p) => await G.duneAge(p) }]);
add(/^blood dune: when a soul dies, your next martialus costs (\d) less deploy$/, (m) => [{ hook: 'anyDeath', fn: async (G, p) => await G.bloodDune(p, +m[1]) }]);
add(/^blood dune: when martialus you control dies, next martialus costs (\d) less deploy \(min 0\)$/, (m) => [{ hook: 'friendlyDeath', fn: async (G, p) => await G.bloodDune(p, +m[1]) }]);
add(/^uprising: if opponent missed wages, your raid martialus get \+(\d) might this turn$/, (m) => [{ aura: (G, p, s, x) => (isRaid(x) && G.opp(p).missedLast ? +m[1] : 0) }]);
add(/^once per turn: dune age; if you do, deal 1 to enemy life$/, () => [{ hook: 'activated', fn: async (G, p) => { if (await G.duneAge(p)) G.dmgLife(p, 1); } }]);
add(/^martialus with might >=4 deal \+1 life damage$/, () => [{ flag: 'bigHitter' }]);
add(/^blood dune triggers on enemy deaths too once\/turn$/, () => [{ hook: 'enemyDeath', once: true, fn: async (G, p) => await G.bloodDune(p, 1) }]);
add(/^when you cast a rite, put a 1-might anu dune-born token \(wage 0\) into play$/, () => [{ hook: 'riteCast', fn: async (G, p) => await G.token(p, 1, 0, 'Dune-Born') }]);
add(/^once\/turn pay 1 specie: undo age on one martialus$/, () => [{ hook: 'activated', fn: async (G, p) => { const t = G.souls(p).find(x => x.age > 0); if (t && p.specie >= 1 + G.reserve(p)) { p.specie -= 1; t.age -= 1; } } }]);
add(/^economic anu cards wage -1 \(min 0\)$/, () => [{ wageMod: (G, p, s, x) => (x.kind === 'econ' ? -1 : 0) }]);
add(/^blood dune: tokens you create get \+1 might$/, () => [{ aura: (G, p, s, x) => (x.token ? 1 : 0) }]);
add(/^when you would lose life to timefall pulse, you may age a token instead$/, () => [{ flag: 'tokenPulse' }]);
add(/^once per turn: deal 1 to enemy life at rite speed$/, () => [{ hook: 'activated', fn: async (G, p) => G.dmgLife(p, p.duneAgedThisTurn ? 2 : 1) }]);
add(/^if you used dune age this turn, deal 2 instead$/, () => NOOP); // folded above

// --- Colovian Martial ---
add(/^while another martialus with deploy (\d) is on your board, this has \+1 might$/, (m) => [{ aura: (G, p, s, x) => (x === s && G.souls(p).some(o => o !== s && o.deploy === +m[1]) ? 1 : 0) }]);
add(/^chain of command: \+1 might for each other martialus you control with deploy (\d)$/, (m) => [{ aura: (G, p, s, x) => (x === s ? G.souls(p).filter(o => o !== s && G.chainShares(o, +m[1], s)).length : 0) }]);
add(/^tithe: when you pay wages, this gains \+1 might until end of turn$/, () => [{ hook: 'tithe', fn: async (G, p, s) => { s.temp += 1; } }]);
add(/^canopy: the first timefall pulse after this enters, you may skip the choice$/, () => [{ hook: 'enter', fn: async (G, p) => { p.canopy += 1; } }]);
add(/^tithe: when you pay wages, deal 1 damage to enemy life$/, () => [{ hook: 'tithe', fn: async (G, p) => G.dmgLife(p, 1) }]);
add(/^tithe: deal 1 to enemy life$/, () => [{ hook: 'tithe', fn: async (G, p) => G.dmgLife(p, 1) }]);
add(/^raid martialus attacking you get -1 might this combat$/, () => [{ enemyAura: (G, p, s, x) => (isRaid(x) && x.attacking ? -1 : 0) }]);
add(/^enemy raid martialus get -1 might while attacking you$/, () => [{ enemyAura: (G, p, s, x) => (isRaid(x) && x.attacking ? -1 : 0) }]);
add(/^if you missed wages last turn, this costs 0 deploy$/, () => [{ flag: 'freeIfMissed' }]);
add(/^other martialus you control get \+1 might while this lives$/, () => [{ aura: (G, p, s, x) => (x !== s ? 1 : 0) }]);
add(/^other anu martialus \+1 might$/, () => [{ aura: (G, p, s, x) => (x !== s ? 1 : 0) }]);
add(/^other deploy-1 martialus you control get \+1 might$/, () => [{ aura: (G, p, s, x) => (x !== s && x.deploy === 1 ? 1 : 0) }]);
add(/^annex: if cohesion high after combat, steal 1 specie from opponent$/, () => [{ hook: 'afterCombat', fn: async (G, p, s) => { if (G.high(p)) await G.steal(p, 1, s); } }]);
add(/^annex: if cohesion high after combat, steal 1 specie if enemy has >=3$/, () => [{ hook: 'afterCombat', fn: async (G, p, s) => { if (G.high(p) && G.opp(p).specie >= 3) await G.steal(p, 1, s); } }]);
add(/^tithe: if you control an economic, draw 1 when you pay wages$/, () => [{ hook: 'tithe', fn: async (G, p) => { if (G.econs(p).length) G.draw(p, 1); } }]);
add(/^when you cast a rite, this gets \+(\d) might until end of turn$/, (m) => [{ hook: 'riteCast', fn: async (G, p, s) => { s.temp += +m[1]; } }]);
add(/^(rite cast|when you cast a rite|when a rite is cast): \+(\d) might until end of turn$/, (m) => [{ hook: 'riteCast', fn: async (G, p, s) => { s.temp += +m[2]; } }]);
add(/^when you cast a rite, \+(\d) might until end of turn$/, (m) => [{ hook: 'riteCast', fn: async (G, p, s) => { s.temp += +m[1]; } }]);
add(/^when a rite is cast, \+1 might until end of turn$/, () => [{ hook: 'riteCast', fn: async (G, p, s) => { s.temp += 1; } }]);
add(/^when you cast a rite, \+2 might until end of turn and deal 1 life$/, () => [{ hook: 'riteCast', fn: async (G, p, s) => { s.temp += 2; G.dmgLife(p, 1); } }]);
add(/^tithe: age enemy martialus when you pay wages$/, () => [{ hook: 'tithe', fn: async (G, p) => await G.ageEnemyBest(p, 1) }]);
add(/^tithe: when you pay wages, age an enemy martialus with wage >=2$/, () => [{ hook: 'tithe', fn: async (G, p) => await G.ageEnemyBest(p, 1, x => x.wage >= 2) }]);
add(/^reduce damage to your life from combat by 1 while this blocks$/, () => [{ flag: 'blockReduce' }]);
add(/^while you control an economic, this reduces combat damage to your life by 1$/, () => [{ flag: 'econReduce' }]);
add(/^when this would be aged, prevent 1 age once$/, () => [{ flag: 'ageShieldOnce' }]);
add(/^(ignore first age each game|enters with canopy-like once: ignore first age)$/, () => [{ flag: 'ageShieldOnce' }]);
add(/^hard to age: first age each turn prevented$/, () => [{ flag: 'ageShieldTurn' }]);
add(/^while you control an economic, prevent the first age on this each turn$/, () => [{ flag: 'ageShieldTurnEcon' }]);
add(/^annex: if cohesion high, enemy martialus with wage >=2 get -1 might$/, () => [{ enemyAura: (G, p, s, x) => (G.high(p) && x.wage >= 2 ? -1 : 0) }]);
add(/^if you control a canopy permanent effect this game, \+1 might$/, () => [{ aura: (G, p, s, x) => (x === s && p.canopyUsedOrHad ? 1 : 0) }]);
add(/^tithe: opponent discards a card when you pay wages \(once per turn\)$/, () => [{ hook: 'tithe', fn: async (G, p) => G.discard(G.opp(p), 1) }]);
add(/^while high cohesion, immune to age from opponent rites$/, () => [{ flag: 'riteAgeImmuneHigh' }]);
add(/^chain of command deploy 1: each such martialus gets \+1 might$/, () => [{ aura: (G, p, s, x) => (x.deploy === 1 && x !== s ? 1 : 0) }]);
add(/^when this dies, deal (\d) damage to enemy life$/, (m) => [{ hook: 'death', fn: async (G, p) => G.dmgLife(p, +m[1]) }]);
add(/^prevent the first 2 damage to your life each turn$/, () => [{ flag: 'prevent2' }]);
add(/^annex: convert a 1-might enemy martialus into a colovian levy under you if cohesion high$/, () => [{ hook: 'enter', fn: async (G, p) => { if (!G.high(p)) return; const t = G.souls(G.opp(p)).find(x => G.might(x) === 1); if (t) { await G.removeSoul(t, false); await G.token(p, 1, 1, 'Colovian Levy'); } } }]);
add(/^enters aged \(-1 might\) unless you paid wages this turn$/, () => [{ hook: 'enter', fn: async (G, p, s) => { if (!(p.paidThisTurn)) await G.age(s, 1, p, 'self'); } }]);
add(/^enters aged$/, () => [{ hook: 'enter', always: true, fn: async (G, p, s) => await G.age(s, 1, p, 'self') }]);
add(/^while you control an economic, \+1 might$/, () => [{ aura: (G, p, s, x) => (x === s && G.econs(p).length ? 1 : 0) }]);
add(/^while you control an economic with wage >=2, \+2 might$/, () => [{ aura: (G, p, s, x) => (x === s && G.econs(p).some(e => e.wage >= 2) ? 2 : 0) }]);
add(/^tithe: when you pay wages, remove 1 age from this$/, () => [{ hook: 'tithe', fn: async (G, p, s) => { if (s.age > 0) s.age -= 1; } }]);
add(/^same deploy siblings share \+1 might$/, () => sameDeployBuff(null));
add(/^chain of command: \+1 might if another martialus shares this deploy$/, () => sameDeployBuff(null));
add(/^when a sibling dies, this gets \+1 might until end of turn$/, () => [{ hook: 'friendlyDeath', fn: async (G, p, s, c) => { if (c.soul.deploy === s.deploy) s.temp += 1; } }]);
add(/^tithe: gain specie equal to half your wage bill rounded down \(once\/turn\)$/, () => [{ hook: 'tithe', fn: async (G, p, s, c) => G.gain(p, Math.floor(c.bill / 2)) }]);
add(/^tithe: gain specie equal to this card's wage when you pay wages \(once\/turn\)$/, () => [{ hook: 'tithe', fn: async (G, p, s) => G.gain(p, s.wage) }]);
add(/^tithe: opponent loses 1 specie when you pay wages \(once\/turn\)$/, () => [{ hook: 'tithe', fn: async (G, p, s) => { G.loseSpecie(G.opp(p), 1); s.temp += 1; } }]);
add(/^this \+1 might that turn$/, () => NOOP); // folded into line above
add(/^enters with -1 might unless you control a tithe martialus$/, () => [{ hook: 'enter', always: true, fn: async (G, p, s) => { if (!G.souls(p).some(o => o !== s && hasKw(o, 'Tithe'))) s.mods -= 1; } }]);
add(/^martyr: when this dies, deal 1 to enemy life$/, () => [{ hook: 'death', fn: async (G, p) => G.dmgLife(p, 1) }]);
add(/^martyr: deal 1 life to enemy$/, () => [{ hook: 'death', fn: async (G, p) => G.dmgLife(p, 1) }]);
add(/^enter: if you control an economic, gain 1 specie$/, () => [{ hook: 'enter', fn: async (G, p) => { if (G.econs(p).length) G.gain(p, 1); } }]);
add(/^\+1 might while you control one$/, () => [{ aura: (G, p, s, x) => (x === s && G.econs(p).length ? 1 : 0) }]);
add(/^while another martialus shares this deploy, this cannot be aged by enemy rites$/, () => [{ flag: 'riteAgeImmuneSibling' }]);
add(/^enter: you may age this to draw 1$/, () => [{ hook: 'enter', fn: async (G, p, s) => { if (G.might(s) >= 3) { await G.age(s, 1, p, 'self'); G.draw(p, 1); } } }]);
add(/^when this dies, put a 1-might wage-0 colovian levy token into play$/, () => [{ hook: 'death', fn: async (G, p) => await G.token(p, 1, 0, 'Colovian Levy') }]);
add(/^must attack if (cohesion high|able)$/, () => [{ flag: 'mustAttack' }]);
add(/^this cannot attack the turn it enters$/, () => [{ flag: 'noAttackOnEnter' }]);
add(/^cannot block martialus with might >=4$/, () => [{ cantBlock: (G, b, a) => G.might(a) >= 4 }]);
add(/^tithe: when you pay wages, rites cost 1 less deploy until end of turn \(min 0\)$/, () => [{ hook: 'tithe', fn: async (G, p) => { p.riteDiscountTurn += 1; } }]);
add(/^if enemy misses wages, deal 1 life$/, () => [{ hook: 'enemyMissed', fn: async (G, p) => G.dmgLife(p, 1) }]);
add(/^\+1 might vs anu$/, () => [{ aura: (G, p, s, x) => (x === s && G.opp(p).faction === 'Anu' ? 1 : 0) }]);
add(/^\+1 might vs anu martialus$/, () => [{ aura: (G, p, s, x) => (x === s && G.opp(p).faction === 'Anu' ? 1 : 0) }]);
add(/^\+2 might while enemy controls a raid martialus$/, () => [{ aura: (G, p, s, x) => (x === s && G.souls(G.opp(p)).some(isRaid) ? 2 : 0) }]);
add(/^when an anu soul dies, gain 1 specie$/, () => [{ hook: 'enemyDeath', fn: async (G, p) => { if (G.opp(p).faction === 'Anu') G.gain(p, 1); } }]);
add(/^when this attacks an anu martialus, that martialus gets -1 might this combat$/, () => [{ hook: 'attack', fn: async (G, p, s) => { s.flags.debuffBlockers = 1; } }]);
add(/^while enemy cohesion is low, \+2 might$/, () => [{ aura: (G, p, s, x) => (x === s && G.opp(p).missedLast ? 2 : 0) }]);
add(/^uprising bonuses on enemy are 0$/, () => [{ flag: 'noEnemyUprising' }]);
add(/^tithe: when you pay wages in full, choose an economic you control; it produces 1 more specie on your next turn \(once per turn\)$/, () => [{ hook: 'tithe', fn: async (G, p) => { if (G.econs(p).length) p.nextIncomeBonus += 1; } }]);
add(/^when you use canopy, gain 1 specie$/, () => [{ hook: 'canopyUsed', fn: async (G, p) => G.gain(p, 1) }]);
add(/^when you use canopy, deal 1 life to enemy$/, () => [{ hook: 'canopyUsed', fn: async (G, p) => G.dmgLife(p, 1) }]);
add(/^canopy charge shared once$/, () => [{ hook: 'enter', fn: async (G, p) => { p.canopy += 1; } }]);
add(/^canopy charge: skip one timefall choice while this lives \(shared once\)$/, () => [{ hook: 'enter', fn: async (G, p) => { p.canopy += 1; } }]);
add(/^deal \+1 life when damaging anu martialus \(black scale or not\)$/, () => null);
add(/^tithe: when you pay wages, enemy raid martialus get -1 might until your next turn$/, () => [{ hook: 'tithe', fn: async (G, p) => { p.raidDebuffUntilNext = 1; } }]);
add(/^same deploy siblings share \+1 might\. (.*)$/, () => null);
add(/^tithe: when you pay wages, siblings get \+1 might until end of turn$/, () => [{ hook: 'tithe', fn: async (G, p, s) => G.souls(p).filter(o => o !== s && o.deploy === s.deploy).forEach(o => (o.temp += 1)) }]);
add(/^annex \+ tithe: if cohesion high when you pay wages, steal 1 specie$/, () => [{ hook: 'tithe', fn: async (G, p, s) => await G.steal(p, 1, s) }]);
add(/^tithe\+annex: steal 1 specie when wages paid if cohesion high$/, () => [{ hook: 'tithe', fn: async (G, p, s) => await G.steal(p, 1, s) }]);
add(/^annex: when an enemy martialus dies in combat involving this, gain 1 specie if cohesion high$/, () => [{ hook: 'enemyDeath', fn: async (G, p, s, c) => { if (c.combat && c.involved && c.involved.includes(s) && G.high(p)) G.gain(p, 1); } }]);
add(/^annex: once\/turn if cohesion high, enemy martialus with deploy 1 get -1 might this combat$/, () => [{ enemyAura: (G, p, s, x) => (G.high(p) && G.inCombat && x.deploy === 1 ? -1 : 0) }]);
add(/^while this lives, the first age on another martialus you control each turn is prevented$/, () => [{ flag: 'shieldOthersTurn' }]);

// --- Anu Martial ---
add(/^raid: on attack, steal 1 specie if cohesion high; if low cohesion, still attack with -1 might$/, () => [{ hook: 'attack', fn: async (G, p, s) => { if (G.high(p)) await G.steal(p, 1, s); } }]);
add(/^(age: when this attacks, age defender|on attack, age defender|age defender on attack|on attack age defender|dune age on attack|sandfall: on attack,? age defender)$/, (m) => [{ hook: 'attack', fn: async (G, p, s) => (m[1].startsWith('dune') ? await G.duneAge(p) : await G.ageEnemyBest(p, 1)) }]);
add(/^uprising: \+(\d) might if enemy missed wages$/, (m) => [{ aura: (G, p, s, x) => (x === s && G.uprising(p) ? +m[1] : 0) }]);
add(/^when a friendly martialus dies, this \+1 might$/, () => [{ hook: 'friendlyDeath', fn: async (G, p, s) => { s.mods += 1; } }]);
add(/^raid\. dune age on this card's first attack each game$/, () => null);
add(/^dune age on this card's first attack each game$/, () => [{ hook: 'attack', fn: async (G, p, s) => { if (!s.flags.fa) { s.flags.fa = 1; await G.duneAge(p); } } }]);
add(/^age: age and opponent loses 1 specie$/, () => null);
add(/^must attack if able( that turn)?$/, () => [{ flag: 'mustAttack' }]);
add(/^when you cast a rite, deal 1 to enemy life$/, () => [{ hook: 'riteCast', fn: async (G, p) => G.dmgLife(p, 1) }]);
add(/^at end of turn, if cohesion high, put a 1-might wage-0 token$/, () => [{ hook: 'endTurn', fn: async (G, p) => { if (G.high(p)) await G.token(p, 1, 0, 'Token'); } }]);
add(/^raid: steal specie on hit if high cohesion$/, () => [{ hook: 'hitLife', fn: async (G, p, s) => { if (G.high(p)) await G.steal(p, 1, s); } }]);
add(/^steal specie on hit if high cohesion$/, () => [{ hook: 'hitLife', fn: async (G, p, s) => { if (G.high(p)) await G.steal(p, 1, s); } }]);
add(/^raid: on hit if cohesion high, steal 1 specie$/, () => [{ hook: 'hitLife', fn: async (G, p, s) => { if (G.high(p)) await G.steal(p, 1, s); } }]);
add(/^raid: on hit if cohesion high, steal 1 specie and age the defender$/, () => [{ hook: 'hitLife', fn: async (G, p, s) => { if (G.high(p)) { await G.steal(p, 1, s); await G.ageEnemyBest(p, 1); } } }]);
add(/^if enemy has <=2 specie, deal 1 life instead$/, () => null);
add(/^\+(\d) might while you control leader umbuso \(name check\)$/, (m) => [{ aura: (G, p, s, x) => (x === s && /umbuso/i.test(p.leaderCard.name) ? +m[1] : 0) }]);
add(/^unblockable while the enemy's total might is less than this martialus's might$/, () => [{ unblockable: (G, a) => G.souls(G.opp(a.owner)).reduce((t, x) => t + G.might(x), 0) < G.might(a) }]);
add(/^raid\. steal 1 specie on enter if enemy has >=3 specie$/, () => null);
add(/^steal 1 specie on enter if enemy has >=3 specie$/, () => [{ hook: 'enter', fn: async (G, p, s) => { if (G.opp(p).specie >= 3) await G.steal(p, 1, s); } }]);
add(/^blood dune triggers give you 1 specie as well$/, () => [{ hook: 'bloodDune', fn: async (G, p) => G.gain(p, 1) }]);
add(/^enemy shield\/chain martialus get -1 might while this attacks$/, () => [{ enemyAura: (G, p, s, x) => (s.attacking && (hasKw(x, 'Chain of Command') || /shield/i.test(x.name)) ? -1 : 0) }]);
add(/^the first time you use dune age each turn, age one additional enemy martialus$/, () => [{ hook: 'duneAged', once: true, fn: async (G, p) => await G.ageEnemyBest(p, 1) }]);
add(/^when any martialus dies, draw 1 once\/turn$/, () => [{ hook: 'anyDeath', once: true, fn: async (G, p) => G.draw(p, 1) }]);
add(/^uprising\. if low cohesion, still works \(text says so\)$/, () => [{ aura: (G, p, s, x) => (x === s && G.uprising(p) ? 1 : 0) }]);
add(/^enters: age all martialus with might 1$/, () => [{ hook: 'enter', fn: async (G, p, s) => { for (const q of G.players) for (const x of G.souls(q)) if (x !== s && G.might(x) === 1) await G.age(x, 1, p, 'effect'); } }]);
add(/^deal 1 to enemy life each time you age anything$/, () => [{ hook: 'aged', fn: async (G, p) => G.dmgLife(p, 1) }]);
add(/^(can't be blocked|unblockable) by deploy >=4 martialus$/, () => [{ unblockable: (G, a, b) => b && b.deploy >= 4 }]);
add(/^uprising\. raid\. climbs canopy: ignore enemy canopy skip once$/, () => null);
add(/^raid: steal specie on hit if high cohesion$/, () => [{ hook: 'hitLife', fn: async (G, p, s) => { if (G.high(p)) await G.steal(p, 1, s); } }]);
add(/^if the defender dies this combat, deal 1 to enemy life$/, () => null);
add(/^raid\. ignores \+might from enemy chain of command while attacking$/, () => null);
add(/^ignores \+might from enemy chain of command while attacking$/, () => null);
add(/^uprising: if enemy missed wages, this and one other deploy-1 martialus you control get \+1 might this turn$/, () => [{ aura: (G, p, s, x) => (G.uprising(p) && x.deploy === 1 && (x === s || G.souls(p).filter(o => o.deploy === 1 && o !== s)[0] === x) ? 1 : 0) }]);
add(/^if already aged, deal 1 life$/, () => [{ hook: 'attack', fn: async (G, p) => { if (G.souls(G.opp(p)).some(x => x.age > 0)) G.dmgLife(p, 1); } }]);
add(/^sandfall: on attack, age defender\. if already aged, deal 1 life$/, () => null);
add(/^enter: you may age this; if you do, next martialus costs 1 less$/, () => [{ hook: 'enter', fn: async (G, p, s) => { if (G.might(s) >= 3) { await G.age(s, 1, p, 'self'); await G.bloodDune(p, 1); } } }]);
add(/^uprising: \+2 might if enemy missed wages\. raid while uprising active$/, () => null);
add(/^raid while uprising active$/, () => NOOP);
add(/^raid\. while you control 2\+ raid martialus, \+1 might$/, () => null);
add(/^while you control 2\+ raid martialus, \+1 might$/, () => [{ aura: (G, p, s, x) => (x === s && G.souls(p).filter(isRaid).length >= 2 ? 1 : 0) }]);
add(/^enters with might 1; \+1 if a soul died this turn$/, () => [{ hook: 'enter', always: true, fn: async (G, p, s) => { s.mods -= (G.soulDiedThisTurn ? 0 : 1); } }]);
add(/^on first attack each game, age defender$/, () => [{ hook: 'attack', fn: async (G, p, s) => { if (!s.flags.fa) { s.flags.fa = 1; await G.ageEnemyBest(p, 1); } } }]);
add(/^steal specie if cohesion high$/, () => [{ hook: 'hitLife', fn: async (G, p, s) => { if (G.high(p)) await G.steal(p, 1, s); } }]);
add(/^enter: if enemy has >=4 specie, steal 1$/, () => [{ hook: 'enter', fn: async (G, p, s) => { if (G.opp(p).specie >= 4) await G.steal(p, 1, s); } }]);
add(/^sandfall: on attack age defender$/, () => [{ hook: 'attack', fn: async (G, p) => await G.ageEnemyBest(p, 1) }]);
add(/^enter: age yourself to draw 1$/, () => [{ hook: 'enter', fn: async (G, p, s) => { if (G.might(s) >= 3) { await G.age(s, 1, p, 'self'); G.draw(p, 1); } } }]);
add(/^uprising: if enemy missed wages, this attacks as though you have high cohesion$/, () => [{ flag: 'uprisingAttack' }]);
add(/^cannot be aged the turn it enters$/, () => [{ flag: 'noAgeOnEnter' }]);
add(/^uprising: \+1 might if enemy missed wages\. when uprising triggers, enemy loses 1 specie$/, () => null);
add(/^when uprising triggers, enemy loses 1 specie$/, () => null);
add(/^reduce first combat damage to this by 1 each turn$/, () => [{ flag: 'dr1' }]);
add(/^when this enters from a token-effect, draw 1 once\/turn$/, () => null);
add(/^raid\. age defender on attack\. (.*)$/, () => null);
add(/^when you age, deal 1 life once\/turn$/, () => [{ hook: 'aged', once: true, fn: async (G, p) => G.dmgLife(p, 1) }]);
add(/^when you steal specie, this gets \+1 might until end of turn$/, () => [{ hook: 'stole', fn: async (G, p, s) => { s.temp += 1; } }]);
add(/^sandfall: on attack age all enemy martialus with might 1$/, () => [{ hook: 'attack', fn: async (G, p) => { for (const x of G.souls(G.opp(p))) if (G.might(x) === 1) await G.age(x, 1, p, 'effect'); } }]);
add(/^if this died in combat, next martialus enters with \+1 might$/, () => [{ hook: 'death', fn: async (G, p, s, c) => { if (c.combat) p.nextMartialBonus += 1; } }]);
add(/^martyr: next martialus costs 1 less deploy$/, () => [{ hook: 'death', fn: async (G, p) => await G.bloodDune(p, 1) }]);
add(/^unblockable if defender is already aged$/, () => [{ unblockable: (G, a, b) => b && b.age > 0 }]);
add(/^you may undo age on one martialus$/, () => [{ hook: 'riteCast', fn: async (G, p) => { const t = G.souls(p).find(x => x.age > 0); if (t) t.age -= 1; } }]);
add(/^once\/turn when you age anything, gain 1 specie$/, () => [{ hook: 'aged', once: true, fn: async (G, p) => G.gain(p, 1) }]);
add(/^when any blood dune triggers, gain 1 specie once\/turn$/, () => [{ hook: 'bloodDune', once: true, fn: async (G, p) => G.gain(p, 1) }]);
add(/^enter: if enemy cohesion is already low, steal 1 specie$/, () => [{ hook: 'enter', fn: async (G, p, s) => { if (G.opp(p).missedLast) await G.steal(p, 1, s); } }]);
add(/^raid\. enemy chain of command gives them no \+might vs this$/, () => null);
add(/^enemy chain of command gives them no \+might vs this$/, () => null);
add(/^reduce damage to your life from combat by 1 while this blocks$/, () => [{ flag: 'blockReduce' }]);
add(/^uprising: \+1 might if enemy missed wages\. enemy economic produce 1 less specie while this lives \(min 0\)$/, () => null);
add(/^enemy economic produce 1 less specie while this lives \(min 0\)$/, () => [{ flag: 'econTax' }]);
add(/^on attack: if enemy has no economic, \+1 might$/, () => [{ aura: (G, p, s, x) => (x === s && s.attacking && !G.econs(G.opp(p)).length ? 1 : 0) }]);
add(/^at end of turn if cohesion high, \+1 might \(max 3\)$/, () => [{ hook: 'endTurn', fn: async (G, p, s) => { if (G.high(p) && s.baseMight + s.mods < 3) s.mods += 1; } }]);
add(/^while you control a rite in martyrs, \+1 might$/, () => [{ aura: (G, p, s, x) => (x === s && p.martyrs.some(c => c.type === 'Rite') ? 1 : 0) }]);
add(/^put a 1-might wage-0 token if cohesion high$/, () => [{ hook: 'riteCast', fn: async (G, p) => { if (G.high(p)) await G.token(p, 1, 0, 'Token'); } }]);
add(/^raid: steal 1 specie on hit$/, () => [{ hook: 'hitLife', fn: async (G, p, s) => await G.steal(p, p.duneAgedThisTurn ? 2 : 1, s) }]);
add(/^if you used dune age this turn, steal 2 instead$/, () => NOOP); // folded above
add(/^rites that age cost 1 less deploy while this lives \(min 0\)$/, () => [{ costMod: (G, p, s, c) => (c.type === 'Rite' && /\bage\b|dune age/i.test(c.text) ? -1 : 0) }]);
add(/^put a 1-might wage-0 token if cohesion was high on death$/, () => [{ hook: 'death', fn: async (G, p) => { if (G.high(p)) await G.token(p, 1, 0, 'Token'); } }]);
add(/^uprising: \+3 might if enemy missed wages, but this gets aged after that combat$/, () => [{ aura: (G, p, s, x) => (x === s && G.uprising(p) ? 3 : 0) }, { hook: 'afterCombat', fn: async (G, p, s) => { if (G.uprising(p) && s.attackedThisTurn && s.alive) await G.age(s, 1, p, 'self'); } }]);
add(/^dies: age an enemy martialus with might <=2$/, () => [{ hook: 'death', fn: async (G, p) => await G.ageEnemyBest(p, 1, x => G.might(x) <= 2) }]);
add(/^enemy spire cards do nothing the turn this attacks$/, () => null);
add(/^uprising: if enemy missed wages, steal specie even on low cohesion$/, () => [{ hook: 'hitLife', fn: async (G, p, s) => { if (!G.high(p) && G.uprising(p)) await G.steal(p, 1, s); } }]);
add(/^sandfall: on attack age defender and they get -1 might this combat$/, () => [{ hook: 'attack', fn: async (G, p, s) => { await G.ageEnemyBest(p, 1); s.flags.debuffBlockers = 1; } }]);
add(/^uprising: \+1 might if enemy missed wages\. other raid martialus you control get \+1 might that turn$/, () => [{ aura: (G, p, s, x) => (G.uprising(p) && (x === s || isRaid(x)) ? 1 : 0) }]);
add(/^once: pay 1 specie to undo age on this$/, () => [{ hook: 'activated', fn: async (G, p, s) => { if (s.age > 0 && !s.flags.undid && p.specie >= 1 + G.reserve(p)) { s.flags.undid = 1; p.specie -= 1; s.age -= 1; } } }]);
add(/^can deal its might to life instead of combat once\/turn if no martialus block$/, () => NOOP); // unblocked already hits Life
add(/^may deal might to life instead of combat once$/, () => null);
add(/^may attack the turn it enters if wage bill was 0$/, () => [{ flag: 'hasteIfZeroBill' }]);
add(/^may attack on enter if you stole specie this turn$/, () => [{ flag: 'hasteIfStole' }]);
add(/^while aged martialus are on either board, \+1 might$/, () => [{ aura: (G, p, s, x) => (x === s && G.players.some(q => G.souls(q).some(y => y.age > 0)) ? 1 : 0) }]);
add(/^while you control another blood dune martialus, \+1 might$/, () => [{ aura: (G, p, s, x) => (x === s && G.souls(p).some(o => o !== s && hasKw(o, 'Blood Dune')) ? 1 : 0) }]);
add(/^uprising: \+2 might if enemy missed wages\. age defender on that attack$/, () => null);
add(/^age defender on that attack$/, () => [{ hook: 'attack', fn: async (G, p) => { if (G.uprising(p)) await G.ageEnemyBest(p, 1); } }]);
add(/^enter: look at the top card of your deck; leave it or bottom it$/, () => [{ hook: 'enter', fn: async (G, p) => await G.scry(p, 1) }]);
add(/^enters: look at top 2 of your deck; put one in hand if it is martialus with deploy 1, else bottom both$/, () => [{ hook: 'enter', fn: async (G, p) => { const top = p.deck.splice(0, 2); const i = top.findIndex(c => c.type === 'Martial' && c.deploy === 1); if (i >= 0) { p.hand.push(top[i]); top.splice(i, 1); } p.deck.push(...top); } }]);

// --- Economic ---
add(/^gain (\d) specie( each turn)?( after base \+1)?$/, (m) => [{ income: () => +m[1] }]);
add(/^tithe: when you pay wages, gain 1 more$/, () => [{ hook: 'tithe', fn: async (G, p) => G.gain(p, 1) }]);
add(/^if cohesion low, gain only 1$/, () => [{ flag: 'treasuryLow' }]);
add(/^annex: while cohesion is high, enemy tithe effects gain them 1 less specie \(min 0\)$/, () => null);
add(/^once\/turn pay 1: prevent age on one martialus$/, () => null);
add(/^canopy stock: once per game skip timefall choice$/, () => [{ hook: 'enter', fn: async (G, p) => { p.canopy += 1; } }]);
add(/^tithe: draw 1 when wages paid$/, () => [{ hook: 'tithe', fn: async (G, p) => G.draw(p, 1) }]);
add(/^annex: if cohesion high, steal 1 specie from opponent each of your turns$/, () => [{ hook: 'startTurn', fn: async (G, p, s) => { if (p.highLast) await G.steal(p, 1, s); } }]);
add(/^martialus with might >=4 cost 1 less deploy$/, () => [{ costMod: (G, p, s, c) => (c.type === 'Martial' && c.might >= 4 ? -1 : 0) }]);
add(/^custodes martialus get \+1 might$/, () => [{ aura: (G, p, s, x) => (isCustodes(x.card) ? 1 : 0) }]);
add(/^once\/game: deal 3 to enemy life$/, () => [{ hook: 'activated', fn: async (G, p, s) => { if (!s.flags.used && (G.opp(p).life <= 3 || p.turnCount >= 8)) { s.flags.used = 1; G.dmgLife(p, 3); } } }]);
add(/^tithe: if you paid 3 or more wages, put a colovian levy token \(might 1, wage 1\) onto your board$/, () => [{ hook: 'tithe', fn: async (G, p, s, c) => { if (c.bill >= 3) await G.token(p, 1, 1, 'Colovian Levy'); } }]);
add(/^draw 1 when an economic enters under you$/, () => [{ hook: 'friendlyEconEnter', fn: async (G, p) => G.draw(p, 1) }]);
add(/^chain of command martialus get \+1 might$/, () => [{ aura: (G, p, s, x) => (hasKw(x, 'Chain of Command') ? 1 : 0) }]);
add(/^annex: look at opponent hand once\/game if cohesion high$/, () => NOOP); // info only; greedy AI ignores hidden info
add(/^canopy charges \+1 \(second skip once\)$/, () => [{ hook: 'enter', fn: async (G, p) => { p.canopy += 1; } }]);
add(/^tithe: age all enemy martialus with might 1$/, () => [{ hook: 'tithe', fn: async (G, p) => { for (const x of G.souls(G.opp(p))) if (G.might(x) === 1) await G.age(x, 1, p, 'effect'); } }]);
add(/^tithe: martialus may attack same turn even if you barely paid \(still high\)$/, () => NOOP);
add(/^when this enters, gain 2 specie immediately$/, () => [{ hook: 'enter', fn: async (G, p) => G.gain(p, 2) }]);
add(/^annex: raid martialus opponent controls get -1 might while this lives if cohesion high$/, () => [{ enemyAura: (G, p, s, x) => (G.high(p) && isRaid(x) ? -1 : 0) }]);
add(/^spire: scry 1 each turn$/, () => [{ hook: 'startTurn', fn: async (G, p) => await G.scry(p, 1) }]);
add(/^scry 2 each turn$/, () => [{ hook: 'startTurn', fn: async (G, p) => await G.scry(p, 2) }]);
add(/^your deploy-2 martialus wage -1 \(min 0\)$/, () => [{ wageMod: (G, p, s, x) => (x.kind === 'soul' && x.deploy === 2 ? -1 : 0) }]);
add(/^tithe: cast a deploy <=2 rite for free once\/turn$/, () => [{ hook: 'tithe', fn: async (G, p) => { p.freeRite = 2; } }]);
add(/^prevent first age on your martialus each turn$/, () => [{ flag: 'shieldAllTurn' }]);
add(/^prevent one age per turn on your martialus$/, () => [{ flag: 'shieldAllTurn' }]);
add(/^you may pay wages with specie gained this turn immediately$/, () => NOOP); // already how the engine works
add(/^tithe: \+1 might to one martialus until end of turn$/, () => [{ hook: 'tithe', fn: async (G, p) => { const s = G.souls(p)[0]; if (s) s.temp += 1; } }]);
add(/^if you control 3\+ economic, draw 1 each turn$/, () => [{ hook: 'startTurn', fn: async (G, p) => { if (G.econs(p).length >= 3) G.draw(p, 1); } }]);
add(/^annex token: 1 specie when enemy martialus dies$/, () => [{ hook: 'enemyDeath', fn: async (G, p) => G.gain(p, 1) }]);
add(/^warsaber martialus deploy -1$/, () => [{ costMod: (G, p, s, c) => (c.type === 'Martial' && isWarsaber(c) ? -1 : 0) }]);
add(/^rites draw 1 on cast once\/turn$/, () => [{ hook: 'riteCast', once: true, fn: async (G, p) => G.draw(p, 1) }]);
add(/^tithe: gain 1 life if life <=10 when wages paid$/, () => [{ hook: 'tithe', fn: async (G, p) => { if (p.life <= 10) G.gainLife(p, 1); } }]);
add(/^deploy-3 martialus enter with \+1 might$/, () => [{ hook: 'friendlyEnter', fn: async (G, p, s, c) => { if (c.soul.deploy === 3) c.soul.mods += 1; } }]);
add(/^custodes martialus wage -1 \(min 0\)$/, () => [{ wageMod: (G, p, s, x) => (x.kind === 'soul' && isCustodes(x.card) ? -1 : 0) }]);
add(/^discard 1: gain 2 specie once\/turn$/, () => null);
add(/^annex: opponent's wage bill \+1 this turn if cohesion high \(tax\)$/, () => [{ hook: 'startTurn', fn: async (G, p) => { if (p.highLast) G.opp(p).wageTax += 1; } }]);
add(/^tithe: enemy loses 1 specie$/, () => [{ hook: 'tithe', fn: async (G, p) => G.loseSpecie(G.opp(p), 1) }]);
add(/^your leader cannot be chosen for age from opponent effects$/, () => NOOP); // Leaders have no Might in this engine
add(/^when you play a martialus, gain 1 specie once\/turn$/, () => [{ hook: 'friendlyEnter', once: true, fn: async (G, p) => G.gain(p, 1) }]);
add(/^your martialus get \+1 might vs anu martialus$/, () => [{ aura: (G, p) => (G.opp(p).faction === 'Anu' ? 1 : 0) }]);
add(/^annex: once per turn if high cohesion, take control of an anu martialus with might <=2 until end of turn$/, () => null);
add(/^when enemy steals specie via raid, gain 1 specie$/, () => [{ hook: 'enemyStole', fn: async (G, p) => G.gain(p, 1) }]);
add(/^anu economic produce 1 less specie \(min 0\)$/, () => [{ flag: 'econTax' }]);
add(/^while enemy cohesion is low, they cannot gain specie from raid$/, () => [{ flag: 'noRaidStealWhenLow' }]);
add(/^raid martialus produce \+1 specie on successful steal once\/turn$/, () => [{ hook: 'stole', once: true, fn: async (G, p) => G.gain(p, 1) }]);
add(/^once per turn: dune age$/, () => [{ hook: 'activated', fn: async (G, p) => await G.duneAge(p) }]);
add(/^raid martialus deploy -1$/, () => [{ costMod: (G, p, s, c) => (c.type === 'Martial' && (c.keywords || []).includes('Raid') ? -1 : 0) }]);
add(/^blood dune: gain 1 specie when any martialus dies$/, () => [{ hook: 'anyDeath', fn: async (G, p) => G.gain(p, 1) }]);
add(/^rites with dune age cost 1 less deploy \(min 0\)$/, () => [{ costMod: (G, p, s, c) => (c.type === 'Rite' && /dune age/i.test(c.text) ? -1 : 0) }]);
add(/^uprising: if enemy missed wages, gain \+2 specie this turn$/, () => [{ hook: 'startTurn', fn: async (G, p) => { if (G.uprising(p)) G.gain(p, 2); } }]);
add(/^draw when you cast rite once\/turn$/, () => [{ hook: 'riteCast', once: true, fn: async (G, p) => G.draw(p, 1) }]);
add(/^blood dune deploy discount \+1$/, () => [{ flag: 'bdPlus1' }]);
add(/^martialus might >=4 get \+1 might$/, () => [{ aura: (G, p, s, x) => (x.baseMight + x.mods - x.age >= 4 ? 1 : 0) }]);
add(/^undo one age per turn for free$/, () => [{ hook: 'startTurn', fn: async (G, p) => { const t = G.souls(p).find(x => x.age > 0); if (t) t.age -= 1; } }]);
add(/^token martialus wage 0$/, () => [{ wageMod: (G, p, s, x) => (x.token ? -99 : 0) }]);
add(/^once\/turn deal 1 to life$/, () => [{ hook: 'activated', fn: async (G, p) => G.dmgLife(p, 1) }]);
add(/^after rite, \+1 might to all martialus this turn$/, () => [{ hook: 'riteCast', fn: async (G, p) => G.souls(p).forEach(x => (x.temp += 1)) }]);
add(/^martialus must attack if cohesion high$/, () => [{ flag: 'allMustAttack' }]);
add(/^uprising: martialus \+1 might$/, () => [{ aura: (G, p) => (G.uprising(p) ? 1 : 0) }]);
add(/^deploy 1-2 martialus enter ready if cohesion high$/, () => NOOP); // base rule already allows same-turn attacks at high Cohesion
add(/^ignore enemy annex text once\/turn$/, () => null);
add(/^raid: copy steal once$/, () => null);
add(/^track deaths: every 3rd death draw 1$/, () => [{ hook: 'anyDeath', fn: async (G, p, s) => { s.flags.d = (s.flags.d || 0) + 1; if (s.flags.d % 3 === 0) G.draw(p, 1); } }]);
add(/^once per game, when you use dune age, age each enemy martialus with might 1 instead$/, () => null);
add(/^raid steals from life \(1\) if no specie to steal$/, () => [{ flag: 'stealLife' }]);
add(/^enemy tithe effects fail once\/turn$/, () => null);
add(/^gain 1 life once\/game$/, () => [{ hook: 'activated', fn: async (G, p, s) => { if (!s.flags.used && p.life <= 24) { s.flags.used = 1; G.gainLife(p, 1); } } }]);
add(/^martialus \+1 might while you control a leader$/, () => [{ aura: (G, p) => (p.leader ? 1 : 0) }]);
add(/^when enemy martialus dies, gain 1 specie$/, () => [{ hook: 'enemyDeath', fn: async (G, p) => G.gain(p, 1) }]);
add(/^blood dune discounts stack twice$/, () => null);
add(/^when this enters, dune age$/, () => [{ hook: 'enter', fn: async (G, p) => await G.duneAge(p) }]);
add(/^move age from one martialus to another once\/turn$/, () => null);
add(/^raid: whenever you use dune age, steal 1 specie$/, () => [{ hook: 'duneAged', fn: async (G, p, s) => await G.steal(p, 1, s) }]);
add(/^whenever you use dune age, opponent loses 1 specie$/, () => [{ hook: 'duneAged', fn: async (G, p) => G.loseSpecie(G.opp(p), 1) }]);
add(/^wage bills on martialus -1 total \(min 0\) once-choose one$/, () => null);
add(/^at the start of your turn, dune age$/, () => [{ hook: 'startTurn', fn: async (G, p) => await G.duneAge(p) }]);
add(/^uprising pays specie = missed enemy wages$/, () => [{ hook: 'startTurn', fn: async (G, p) => { if (G.uprising(p)) G.gain(p, G.opp(p).lastMissedAmount || 0); } }]);
add(/^pay 1: \+2 might one martialus$/, () => [{ hook: 'preCombat', fn: async (G, p) => { const s = G.attackersPlanned(p)[0]; if (s && p.specie >= 1 + G.reserve(p)) { p.specie -= 1; s.temp += 2; } } }]);
add(/^all raid martialus attack simultaneously once\/game$/, () => NOOP); // all attacks are already simultaneous
add(/^timefall pulse: you may pay 2 specie to skip choice once$/, () => [{ flag: 'payPulse' }]);
add(/^tokens \+1 might$/, () => [{ aura: (G, p, s, x) => (x.token ? 1 : 0) }]);
add(/^undo age paying 0 once\/game$/, () => [{ hook: 'activated', fn: async (G, p, s) => { const t = G.souls(p).find(x => x.age > 0); if (t && !s.flags.used) { s.flags.used = 1; t.age -= 1; } } }]);
add(/^enemy tithe specie gains become yours once\/game$/, () => null);
add(/^after you cast second rite in a turn, deal 2 life$/, () => [{ hook: 'riteCast', fn: async (G, p) => { if (p.ritesThisTurn === 2) G.dmgLife(p, 2); } }]);
add(/^\+1 might all on death trigger$/, () => null);
add(/^train: rite draw 1$/, () => null);
add(/^raid steals 2$/, () => null);
add(/^if umbuso leader in play, wage of this is 2$/, () => [{ wageMod: (G, p, s, x) => (x === s && /umbuso/i.test(p.leaderCard.name) ? -1 : 0) }]);
add(/^blood dune \+ uprising$/, () => null);
add(/^gain 2 specie\. (.*)$/, () => null);
add(/^spire\. gain 2 specie each turn after base \+1$/, () => null);
add(/^once per game: when your timefall pulse would resolve, choose - skip it \(canopy\), or redirect it to age an enemy soul or deal 1 life to enemy$/, () => [{ flag: 'glowToll' }]);
add(/^sandfall: if you age an enemy this way, they lose 1 specie$/, () => [{ flag: 'glowTollSandfall' }]);
add(/^first raid attack each turn steals \+1 specie$/, () => [{ hook: 'stole', once: true, fn: async (G, p) => { const o = G.opp(p); if (o.specie > 0) { o.specie -= 1; p.specie += 1; } } }]);

// --- Rites (hook 'resolve'; v = AI value estimate) ---
const R = (fn, v) => [{ hook: 'resolve', fn: async function(G,p,s,c){ return await fn(G,p,s,c); }, v }];
add(/^age each enemy martialus$/, () => R(async (G, p) => { const _arr = G.souls(G.opp(p)).slice(); for (const x of _arr) await G.age(x, 1, p, 'rite'); }, (G, p) => G.souls(G.opp(p)).length * 1.5));
add(/^if it is anu\/raid tagged in text or has raid, age twice$/, () => R(async (G, p) => { const _arr = G.souls(G.opp(p)).filter(isRaid); for (const x of _arr) await G.age(x, 1, p, 'rite'); }, (G, p) => G.souls(G.opp(p)).filter(isRaid).length));
add(/^choose a deploy cost\. all your martialus with that deploy get \+2 might this turn$/, () => null);
add(/^choose a deploy cost$/, () => null);
add(/^all your martialus with that deploy get \+2 might this turn$/, () => R(async (G, p) => { const d = G.bestDeployGroup(p); G.souls(p).filter(x => x.deploy === d).forEach(x => (x.temp += 2)); }, (G, p) => G.precombatPumpValue(p, 2, true)));
add(/^deal (\d) (damage )?to enemy life$/, (m) => R(async (G, p) => G.dmgLife(p, +m[1]), (G, p) => G.burnValue(p, +m[1])));
add(/^if cohesion high, deal 5$/, () => R(async (G, p) => { if (G.high(p)) G.dmgLife(p, 2); }, (G, p) => (G.high(p) ? G.burnValue(p, 2) : 0)));
add(/^enemy wage bill \+2 this turn$/, () => R(async (G, p) => { G.opp(p).wageTax += 2; }, (G, p) => G.taxValue(p, 2)));
add(/^if they miss wages, deal 2 life$/, () => R(async (G, p) => { G.opp(p).missPunish += 2; }, () => 0.5));
add(/^gain specie equal to your wage bill$/, () => R(async (G, p) => G.gain(p, G.wageBill(p)), (G, p) => G.wageBill(p) * 0.7));
add(/^canopy: skip your next timefall pulse choice$/, () => R(async (G, p) => { p.canopy += 1; }, () => 0.7));
add(/^draw (\d)$/, (m) => R(async (G, p) => G.draw(p, +m[1]), (G, p, c) => +m[1] * 1.0));
add(/^annex: if cohesion is high, gain control of target enemy martialus with might <=3 until end of turn$/, () => null);
add(/^if cohesion high, take control of enemy martialus with might <=2 until end of turn$/, () => null);
add(/^pick deploy\. those martialus attack as one this turn \(\+1 might each\)$/, () => R(async (G, p) => { const d = G.bestDeployGroup(p); G.souls(p).filter(x => x.deploy === d).forEach(x => (x.temp += 1)); }, (G, p) => G.precombatPumpValue(p, 1, true)));
add(/^lose 1 life$/, () => R(async (G, p) => G.loseLife(p, 1), () => -0.5));
add(/^gain (\d) specie$/, (m) => R(async (G, p) => G.gain(p, +m[1]), () => +m[1] * 0.6));
add(/^prevent next 3 combat damage to your life this turn$/, () => null); // cast on own turn; no instant-speed play in v1
add(/^give one martialus \+3 might and canopy until end of turn$/, () => R(async (G, p) => { const s = G.attackersPlanned(p)[0] || G.souls(p)[0]; if (s) s.temp += 3; }, (G, p) => G.precombatPumpValue(p, 3, false)));
add(/^enemy leader abilities don't trigger this turn$/, () => R(async () => {}, () => 0));
add(/^economic you control produce double specie this turn$/, () => null);
add(/^if you have canopy charge left, deal 2 more$/, () => R(async (G, p) => { if (p.canopy > 0) G.dmgLife(p, 2); }, (G, p) => (p.canopy > 0 ? 1.5 : 0)));
add(/^reveal hand\. deploy-matching martialus in hand cost 1 less this turn$/, () => null);
add(/^destroy enemy economic with wage >=2$/, () => R(async (G, p) => { const e = G.econs(G.opp(p)).filter(x => x.wage >= 2).sort((a, b) => b.deploy - a.deploy)[0]; if (e) G.removePerm(e); }, (G, p) => (G.econs(G.opp(p)).some(x => x.wage >= 2) ? 3 : -5)));
add(/^high cohesion this turn$/, () => R(async (G, p) => { p.high = true; }, (G, p) => (G.high(p) ? 0 : 1)));
add(/^tithe: if you paid wages, deal 1 life to enemy$/, () => R(async (G, p) => { if (p.paidThisTurn) G.dmgLife(p, 1); }, () => 0.7));
add(/^prevent age on one martialus$/, () => null);
add(/^canopy fragment$/, () => null);
add(/^age one enemy martialus$/, () => R(async (G, p) => await G.ageEnemyBest(p, 1), (G, p) => (G.souls(G.opp(p)).length ? 1.5 : -5)));
add(/^gain specie equal to half your wage bill rounded up \(max 3\)$/, () => R(async (G, p) => G.gain(p, Math.min(3, Math.ceil(G.wageBill(p) / 2))), (G, p) => Math.min(3, Math.ceil(G.wageBill(p) / 2)) * 0.6));
add(/^cohesion counts as high this turn$/, () => R(async (G, p) => { p.high = true; }, (G, p) => (G.high(p) ? 0 : 1)));
add(/^if opponent missed wages last turn, they lose 3 life; else lose 1$/, () => R(async (G, p) => G.dmgLife(p, G.opp(p).missedLast ? 3 : 1), (G, p) => G.burnValue(p, G.opp(p).missedLast ? 3 : 1)));
add(/^\+1 might to all martialus until end of turn$/, () => R(async (G, p) => G.souls(p).forEach(x => (x.temp += 1)), (G, p) => G.precombatPumpValue(p, 1, true)));
add(/^enemy martialus can't attack this turn unless opponent pays 2 specie$/, () => null);
add(/^deal damage to enemy life equal to one martialus's might$/, () => R(async (G, p) => { const m = Math.max(0, ...G.souls(p).map(x => G.might(x))); G.dmgLife(p, m); }, (G, p) => G.burnValue(p, Math.max(0, ...G.souls(p).map(x => G.might(x))))));
add(/^put two 1-might wage-1 levy tokens onto your board$/, () => R(async (G, p) => { await G.token(p, 1, 1, 'Levy'); await G.token(p, 1, 1, 'Levy'); }, () => 1.2));
add(/^raid keyword martialus opponent controls can't attack this turn$/, () => null);
add(/^gain 2 specie\. next wage bill \+1 \(debt\)$/, () => R(async (G, p) => { G.gain(p, 2); p.wageTax += 1; }, () => 0.6));
add(/^next wage bill \+1 \(debt\)$/, () => R(async (G, p) => { p.wageTax += 1; }, () => -0.3));
add(/^one martialus becomes deploy\+0 but \+2 might and gains chain of command$/, () => R(async (G, p) => { const s = G.souls(p)[0]; if (s) { s.mods += 2; s.extraKw.push('Chain of Command'); } }, (G, p) => (G.souls(p).length ? 2 : -5)));
add(/^prevent all age this turn$/, () => R(async (G, p) => { p.ageImmuneTurn = true; }, () => 0));
add(/^gain 5 specie\. skip next turn's \+1 base specie$/, () => null);
add(/^gain 5 specie$/, () => R(async (G, p) => G.gain(p, 5), () => 2.5));
add(/^skip next turn's \+1 base specie$/, () => R(async (G, p) => { p.skipBase = true; }, () => -0.5));
add(/^spire: rearrange top 3$/, () => R(async (G, p) => await G.scry(p, 3), () => 0.5));
add(/^chain of command: martialus sharing deploy get \+1 might$/, () => R(async (G, p) => G.souls(p).filter(x => G.souls(p).some(o => o !== x && o.deploy === x.deploy)).forEach(x => (x.temp += 1)), (G, p) => G.precombatPumpValue(p, 1, true) * 0.6));
add(/^raid martialus enemy get -1 might this turn$/, () => R(async (G, p) => { G.souls(G.opp(p)).filter(isRaid).forEach(x => (x.temp -= 1)); }, (G, p) => G.souls(G.opp(p)).filter(isRaid).length * 0.5));
add(/^enemy blood dune discounts fail this turn$/, () => R(async () => {}, () => 0));
add(/^annex: if cohesion high, steal 1 specie$/, () => R(async (G, p) => { if (G.high(p)) await G.steal(p, 1, null); }, () => 0.5));
add(/^steal 2 specie$/, () => null);
add(/^if enemy controls raid martialus, steal 3 instead$/, () => null);
add(/^uprising bonuses enemy has are 0 this turn$/, () => R(async () => {}, () => 0));
add(/^deal 1 life if they missed wages$/, () => R(async (G, p) => { if (G.opp(p).missedLast) G.dmgLife(p, 1); }, (G, p) => (G.opp(p).missedLast ? 1 : 0)));
add(/^target anu martialus -2 might this turn$/, () => null);
add(/^anu martialus cannot use raid this turn$/, () => R(async () => {}, () => 0));
add(/^blood dune: put two drazah tokens \(might 2, wage 0\) onto your board$/, () => R(async (G, p) => { await G.token(p, 2, 0, 'Drazah', true); await G.token(p, 2, 0, 'Drazah', true); }, (G, p) => (G.high(p) ? 2.5 : 0.5)));
add(/^they vanish at end of turn$/, () => NOOP); // handled via vanish flag above
add(/^dune age\. raid: opponent loses 2 specie and you gain 1 of it$/, () => null);
add(/^raid: opponent loses 2 specie and you gain 1 of it$/, () => R(async (G, p) => { const o = G.opp(p); const t = Math.min(2, o.specie); o.specie -= t; if (t) G.gain(p, 1); }, () => 0.7));
add(/^deal 1 to enemy life$/, () => R(async (G, p) => G.dmgLife(p, 1), (G, p) => G.burnValue(p, 1)));
add(/^blood dune trigger as if a martialus died$/, () => R(async (G, p) => await G.bloodDune(p, 1), () => 0.5));
add(/^fully heal ages on one martialus \(might restored\)$/, () => R(async (G, p) => { const t = G.souls(p).sort((a, b) => b.age - a.age)[0]; if (t) t.age = 0; }, (G, p) => Math.max(0, ...G.souls(p).map(x => x.age)) - 0.5));
add(/^create (three|six) 1-might wage-0 tokens$/, (m) => R(async (G, p) => { for (let i = 0; i < num(m[1]); i++) await G.token(p, 1, 0, 'Token'); }, () => num(m[1]) * 0.9));
add(/^deal 1 to enemy life three times$/, () => R(async (G, p) => { G.dmgLife(p, 1); G.dmgLife(p, 1); G.dmgLife(p, 1); }, (G, p) => G.burnValue(p, 3)));
add(/^deal damage to enemy martialus totaling 5, split as you choose$/, () => R(async (G, p) => await G.splitDamage(p, 5), (G, p) => G.souls(G.opp(p)).length ? 3.5 : -5));
add(/^blood dune: next 2 martialus cost 0 deploy$/, () => R(async (G, p) => { p.freeMartials += 2; }, (G, p) => G.handMartials(p) >= 1 ? 2 : -2));
add(/^raid martialus get \+2 might and steal specie on hit this turn$/, () => R(async (G, p) => { G.souls(p).filter(isRaid).forEach(x => { x.temp += 2; x.flags.hornSteal = G.turn; }); }, (G, p) => G.precombatPumpValue(p, 2, true, isRaid)));
add(/^if opponent missed wages this game, they lose 3 life; else you lose 1 and draw 2$/, () => R(async (G, p) => { if (G.opp(p).missedEver) G.dmgLife(p, 3); else { G.loseLife(p, 1); G.draw(p, 2); } }, (G, p) => (G.opp(p).missedEver ? G.burnValue(p, 3) : 1.5)));
add(/^sandfall: age each enemy martialus with deploy 2 or less$/, () => R(async (G, p) => { const _arr = G.souls(G.opp(p)).filter(x => x.deploy <= 2); for (const x of _arr) await G.age(x, 1, p, 'rite'); }, (G, p) => G.souls(G.opp(p)).filter(x => x.deploy <= 2).length * 1.3));
add(/^raid: steal 1 specie$/, () => R(async (G, p) => await G.steal(p, 1, null), () => 0.5));
add(/^gain (\d) life$/, (m) => R(async (G, p) => G.gainLife(p, +m[1]), (G, p) => (p.life <= 15 ? +m[1] * 0.6 : 0.3)));
add(/^blood dune: your next martialus costs 1 less deploy$/, () => R(async (G, p) => await G.bloodDune(p, 1), () => 0.5));
add(/^draw 1$/, () => R(async (G, p) => G.draw(p, 1), () => 1));
add(/^all your martialus attack; raid steals stack$/, () => R(async (G, p) => { p.allAttack = true; }, () => 0));
add(/^enemy chain of command bonuses ignored this turn$/, () => null);
add(/^\+2 might your martialus$/, () => R(async (G, p) => G.souls(p).forEach(x => (x.temp += 2)), (G, p) => G.precombatPumpValue(p, 2, true)));
add(/^sandfall: age each enemy martialus, then age your lowest-might martialus$/, () => R(async (G, p) => { { const _arr = G.souls(G.opp(p)).slice(); for (const x of _arr) await G.age(x, 1, p, 'rite'); }; const mine = G.souls(p).sort((a, b) => G.might(a) - G.might(b))[0]; if (mine) await G.age(mine, 1, p, 'self'); }, (G, p) => G.souls(G.opp(p)).length * 1.5 - (G.souls(p).length ? 1 : 0)));
add(/^blood dune: if your martialus dies this way, your next martialus costs 1 less deploy$/, () => NOOP); // generic death -> handled by any death hooks; discount covered by Blood Dune bookkeeping below
add(/^your highest might martialus fights theirs$/, () => R(async (G, p) => await G.fight(p), (G, p) => G.fightValue(p)));
add(/^steal 2 specie if you win$/, () => NOOP); // folded into fight()
add(/^remove one enemy economic from board this turn \(returns next turn\)$/, () => null);
add(/^steal 1 specie$/, () => R(async (G, p) => await G.steal(p, 1, null), () => 0.5));
add(/^scry 3\. if you find a rite, draw it$/, () => R(async (G, p) => { const top = p.deck.slice(0, 3); const i = top.findIndex(c => c.type === 'Rite'); if (i >= 0) { p.hand.push(p.deck.splice(i, 1)[0]); } }, () => 0.6));
add(/^prevent all age this turn on one martialus\. \+1 might$/, () => null);
add(/^counter enemy annex or tithe effect$/, () => null);
add(/^return a martialus from your discard sense \(last died\) as 1-might wage-0 token$/, () => R(async (G, p) => { if (p.martyrs.some(c => c.type === 'Martial')) await G.token(p, 1, 0, 'Returned'); }, (G, p) => (p.martyrs.some(c => c.type === 'Martial') ? 1 : -5)));
add(/^uprising: enemy wage bill \+2 this turn$/, () => R(async (G, p) => { G.opp(p).wageTax += 2; }, (G, p) => G.taxValue(p, 2)));
add(/^copy martialus you control as a wage-0 token with same might until end of turn$/, () => R(async (G, p) => { const s = G.souls(p).sort((a, b) => G.might(b) - G.might(a))[0]; if (s) await G.token(p, G.might(s), 0, 'Mirage', true); }, (G, p) => G.high(p) && G.souls(p).length ? 2 : -2));
add(/^dune age two different enemy martialus$/, () => R(async (G, p) => { await G.duneAge(p); await G.duneAge(p); }, (G, p) => Math.min(2, G.souls(G.opp(p)).length) * 1.5));
add(/^uprising: if enemy cohesion is low, deal 1 to enemy life$/, () => R(async (G, p) => { if (G.opp(p).missedLast) G.dmgLife(p, 1); }, () => 0.3));
add(/^destroy a might <=3 martialus$/, () => R(async (G, p) => { const t = G.souls(G.opp(p)).filter(x => G.might(x) <= 3).sort((a, b) => G.might(b) - G.might(a))[0]; if (t) await G.destroy(t, p); }, (G, p) => (G.souls(G.opp(p)).some(x => G.might(x) <= 3) ? 3 : -5)));
add(/^enemy rite costs \+2 specie this turn$/, () => R(async () => {}, () => -1)); // cast on own turn: no effect on opponent's turn in v1 timing
add(/^tokens you control \+2 might this turn$/, () => R(async (G, p) => G.souls(p).filter(x => x.token).forEach(x => (x.temp += 2)), (G, p) => G.precombatPumpValue(p, 2, true, x => x.token)));
add(/^enemy can't gain specie from economic this turn$/, () => R(async () => {}, () => -1)); // enemy income already happened / timing
add(/^deal 1 to each enemy martialus\. draw 1 for each that dies$/, () => R(async (G, p) => { let k = 0; for (const x of G.souls(G.opp(p)).slice()) { x.dmg += 1; if (await G.checkDeath(x, p)) k++; } G.draw(p, k); }, (G, p) => G.souls(G.opp(p)).filter(x => G.might(x) <= 1).length * 2));
add(/^enemy tithe fails; you gain 2 specie$/, () => R(async (G, p) => G.gain(p, 2), () => 1));
add(/^blank enemy leader abilities this turn$/, () => R(async () => {}, () => 0));
add(/^sandfall: if that martialus dies this turn, opponent loses 1 life$/, () => null);
add(/^raid: each attack steals 1-even on low cohesion \(text allows\)$/, () => R(async (G, p) => { p.warCry = true; }, (G, p) => G.attackersPlanned(p).length * 0.6));
add(/^sacrifice a martialus: deal its might to life$/, () => R(async (G, p) => { const s = G.souls(p).sort((a, b) => G.might(b) - G.might(a))[0]; if (s) { const m = G.might(s); await G.destroy(s, p); G.dmgLife(p, m); } }, (G, p) => { const m = Math.max(0, ...G.souls(p).map(x => G.might(x))); return G.opp(p).life <= m ? 50 : -2; }));
add(/^sandfall: age each enemy martialus$/, () => R(async (G, p) => { const _arr = G.souls(G.opp(p)).slice(); for (const x of _arr) await G.age(x, 1, p, 'rite'); }, (G, p) => G.souls(G.opp(p)).length * 1.5));
add(/^enemy economic produce 0 specie this turn$/, () => R(async () => {}, () => 0)); // timing: enemy income is on their turn
add(/^regain control of stolen martialus$/, () => R(async () => {}, () => -1));
add(/^martialus enter attacking this turn if deploy <=2$/, () => R(async () => {}, () => -1)); // base rule already gives haste at high Cohesion
add(/^opponent discards 1$/, () => R(async (G, p) => G.discard(G.opp(p), 1), () => 0.7));
add(/^blood dune: when one dies this turn, next martialus costs 1 less$/, () => R(async () => {}, () => 0));
add(/^if life <=10, all martialus \+3 might and raid$/, () => R(async (G, p) => { if (p.life <= 10) G.souls(p).forEach(x => { x.temp += 3; }); }, (G, p) => (p.life <= 10 ? G.precombatPumpValue(p, 3, true) : -3)));
add(/^if you stole specie this turn, deal 3 life and draw 2$/, () => R(async (G, p) => { if (p.stoleThisTurn) { G.dmgLife(p, 3); G.draw(p, 2); } }, (G, p) => (p.stoleThisTurn ? 4 : -5)));


// --- second-pass fixes for sentences split across periods ---
add(/^if wage bill >=5, gain 2 instead$/, () => [{ hook: 'tithe', fn: async (G, p, s, c) => { if (c.bill >= 5) G.gain(p, 1); } }]);
add(/^chain of command deploy 1: when you pay wages, this gets \+1 might until end of turn$/, () => [{ hook: 'tithe', fn: async (G, p, s) => { s.temp += 1; } }]);
add(/^scry 3$/, () => R(async (G, p) => await G.scry(p, 3), () => 0.4));
add(/^if you find a rite, draw it$/, () => R(async (G, p) => { const i = p.deck.slice(0, 3).findIndex(c => c.type === 'Rite'); if (i >= 0) p.hand.push(p.deck.splice(i, 1)[0]); }, () => 0.4));
add(/^deal 1 to each enemy martialus$/, () => R(async (G, p) => { let k = 0; for (const x of G.souls(G.opp(p)).slice()) { x.dmg += 1; if (await G.checkDeath(x, p)) k++; } p.lastKills = k; }, (G, p) => G.souls(G.opp(p)).filter(x => G.might(x) <= 1).length * 1.5 + 0.3));
add(/^draw 1 for each that dies$/, () => R(async (G, p) => G.draw(p, p.lastKills || 0), (G, p) => G.souls(G.opp(p)).filter(x => G.might(x) <= 1).length));
add(/^raid: each attack steals 1 - even on low cohesion \(text allows\)$/, () => R(async (G, p) => { p.warCry = true; }, (G, p) => G.attackersPlanned(p).length * 0.6));
add(/^when you miss wages, lose only cohesion - not an extra life \(reminder\)$/, () => NOOP);
add(/^rites deploy -0 reminder; draw when you cast rite once\/turn$/, () => [{ hook: 'riteCast', once: true, fn: async (G, p) => G.draw(p, 1) }]);
add(/^other raid martialus you control get \+1 might that turn$/, () => [{ aura: (G, p, s, x) => (x !== s && isRaid(x) && G.uprising(p) ? 1 : 0) }]);
add(/^if low cohesion, still works \(text says so\)$/, () => [{ flag: 'worksLow' }]);
add(/^steal 2 specie$/, () => R(async (G, p) => await G.steal(p, 2, null), () => 1));
add(/^if enemy controls raid martialus, steal 3 instead$/, () => R(async (G, p) => { if (G.souls(G.opp(p)).some(isRaid)) await G.steal(p, 1, null); }, () => 0.3));
add(/^(choose a deploy cost|pick deploy)$/, () => NOOP);
add(/^those martialus attack as one this turn \(\+1 might each\)$/, () => R(async (G, p) => { const d = G.bestDeployGroup(p); G.souls(p).filter(x => x.deploy === d).forEach(x => (x.temp += 1)); }, (G, p) => G.precombatPumpValue(p, 1, true)));
add(/^target anu martialus -2 might this turn$/, () => R(async (G, p) => { const t = G.souls(G.opp(p)).sort((a, b) => G.might(b) - G.might(a)).find(x => G.might(x) <= 2) || G.souls(G.opp(p))[0]; if (t) { t.temp -= 2; await G.checkDeath(t, p); } }, (G, p) => (G.souls(G.opp(p)).some(x => G.might(x) <= 2) ? 2 : G.souls(G.opp(p)).length ? 0.5 : -5)));
add(/^while you control 2\+ economics, \+1 might and wage -1 \(min 0\)$/, () => [{ aura: (G, p, s, x) => (x === s && G.econs(p).length >= 2 ? 1 : 0) }, { wageMod: (G, p, s, x) => (x === s && G.econs(p).length >= 2 ? -1 : 0) }]);
add(/^rites you cast cost 1 less if 2\+ siblings live \(min 0\)$/, () => [{ costMod: (G, p, s, c) => (c.type === 'Rite' && G.souls(p).filter(o => o !== s && o.deploy === s.deploy).length >= 2 ? -1 : 0) }]);
add(/^economic you control produce double specie this turn$/, () => R(async (G, p) => G.gain(p, G.econIncome(p)), (G, p) => G.econIncome(p) * 0.6));
add(/^raid steals 2$/, () => [{ flag: 'raidSteal2' }]);
add(/^blood dune discounts stack twice$/, () => [{ flag: 'bdDouble' }]);
add(/^prevent all age this turn on one martialus$/, () => NOOP); // own-turn cast: only own pulse/self Age could matter
add(/^\+1 might$/, (m, c) => c.type === 'Rite' ? R(async (G, p) => { const s = G.attackersPlanned(p)[0]; if (s) s.temp += 1; }, (G, p) => G.precombatPumpValue(p, 1, false)) : null);


// ===== RITER VAGUE_FIX_2026-11-14 rewrites (sim copy only) =====
const pulseTurn = (p) => p.turnCount % 3 === 0;
addFirst(/^when this enters, if a rite you cast this turn would age a martialus, it ages that martialus one more time$/, () => [{ hook: 'enter', fn: async (G, p) => { p.riteExtraAgeTurn = G.turn; } }]);
addFirst(/^the turn your timefall pulse would happen, this has wage 0$/, () => [{ wageMod: (G, p, s, x) => (x === s && pulseTurn(p) ? -99 : 0) }]);
addFirst(/^choose another martialus you control; it has wage 0 this turn$/, () => [{ wageMod: (G, p, s, x) => { if (!pulseTurn(p) || x === s || x.kind !== 'soul') return 0; const t = G.souls(p).filter(o => o !== s).sort((a, b) => b.wage - a.wage)[0]; return t === x ? -99 : 0; } }]);
addFirst(/^when your timefall pulse would happen, you may age this and skip that pulse choice$/, () => [{ flag: 'ageSkipPulse' }]);
addFirst(/^only one card with this text may do so per pulse$/, () => NOOP); // engine uses at most one
addFirst(/^chain of command: once per turn, martialus you control with this deploy may block one attacker as one body$/, () => [{ flag: 'phalanx' }]);
addFirst(/^that body has might equal to their combined might$/, () => NOOP); // part of phalanx
addFirst(/^they all die if it takes that much damage; none die if it takes less$/, () => NOOP); // part of phalanx
addFirst(/^chain of command: while you control another martialus with deploy 3, ignore age on this$/, () => [{ aura: (G, p, s, x) => (x === s && G.souls(p).some(o => o !== s && G.chainShares(o, 3, s)) ? s.age : 0) }]);
addFirst(/^this has wage 0 the turn a spire effect lets you look at the top card of your deck$/, () => [{ wageMod: (G, p, s, x) => (x === s && p.scriedTurn === G.turn ? -99 : 0) }]);
addFirst(/^whenever an enemy martialus ages a martialus you control, that enemy martialus gets -1 might this turn$/, () => [{ flag: 'ageRetaliate' }]);
addFirst(/^enters aged unless you have skipped a timefall pulse with canopy this game$/, () => [{ hook: 'enter', always: true, fn: async (G, p, s) => { if (!p.canopySkippedEver) await G.age(s, 1, p, 'self'); } }]);
addFirst(/^this enters with \+1 might$/, () => [{ hook: 'enter', always: true, fn: async (G, p, s) => { s.mods += 1; } }]);
addFirst(/^while you control an economic, other martialus you control are treated as having this card's deploy for chain of command bonuses$/, () => [{ flag: 'chainAlias' }]);
addFirst(/^(annex: )?this may attack the turn it enters even if you have low cohesion$/, () => [{ flag: 'hasteLow' }, { flag: 'worksLow' }]);
addFirst(/^while aged, this has wage 0$/, () => [{ wageMod: (G, p, s, x) => (x === s && s.age > 0 ? -99 : 0) }]);
addFirst(/^once per turn, choose a deploy cost among martialus you control$/, () => NOOP); // engine picks the Deploy with the most fresh Souls
addFirst(/^martialus you control with that deploy may attack the turn they enter even if you have low cohesion$/, () => [{ flag: 'hornLow' }, { flag: 'worksLow' }]);
addFirst(/^when you skip a timefall pulse with canopy, deal 1 to enemy life$/, () => [{ hook: 'canopyUsed', fn: async (G, p) => G.dmgLife(p, 1) }]);
addFirst(/^until the end of the opponent's next turn, their raid abilities don't trigger$/, () => [{ hook: 'canopyUsed', fn: async (G, p) => { G.opp(p).raidOffUntil = G.turn + 1; } }]);
addFirst(/^whenever this deals combat damage to an anu martialus, deal 1 to enemy life$/, () => [{ hook: 'dmgSoul', fn: async (G, p, s, c) => { if (c.target && c.target.card.set === 'Anu') G.dmgLife(p, 1); } }]);
addFirst(/^whenever an enemy would use a raid ability, that player must pay 1 specie or the ability fails$/, () => [{ flag: 'raidTax' }]);
addFirst(/^this has \+1 might vs anu martialus$/, () => [{ aura: (G, p, s, x) => (x === s && G.opp(p).faction === 'Anu' ? 1 : 0) }]);
addFirst(/^reveal your hand$/, () => NOOP);
addFirst(/^each martialus in your hand with that deploy costs 1 less this turn \(min 0\)$/, () => R(async (G, p) => { p.handDiscount = { turn: G.turn, deploy: G.bestHandDeploy(p) }; }, (G, p) => G.handDiscountValue(p)));
addFirst(/^choose one martialus you control$/, () => NOOP);
addFirst(/^prevent the next age on it this turn$/, () => R(async (G, p) => { const t = G.souls(p).sort((a, b) => (b.deploy + G.might(b)) - (a.deploy + G.might(a)))[0]; if (t) t.flags.shieldThisTurn = G.turn; }, () => 0.1));
addFirst(/^canopy \(skip your next timefall pulse choice once\)$/, () => R(async (G, p) => { p.canopy += 1; }, (G, p) => (p.canopy ? 0.4 : 0.9)));
addFirst(/^age: when this attacks, age one enemy martialus of your choice$/, () => [{ hook: 'attack', fn: async (G, p) => await G.ageEnemyBest(p, 1) }]);
addFirst(/^the opponent loses 1 specie$/, (m, c) => (c.type === 'Martial' ? [{ hook: 'attack', fn: async (G, p) => G.loseSpecie(G.opp(p), 1) }] : null));
addFirst(/^once per turn, when the opponent would skip a timefall pulse with canopy, they don't skip it$/, () => [{ flag: 'antiCanopy' }]);
addFirst(/^raid: when this deals combat damage to the opponent, if you have high cohesion, steal 1 specie$/, () => [{ hook: 'hitLife', fn: async (G, p, s) => { if (!G.high(p)) return; if (G.permFlag(s, 'stealOrBurn') && G.opp(p).specie <= 2) G.dmgLife(p, 1); else await G.steal(p, 1, s); } }]);
addFirst(/^if the opponent has 2 or fewer specie, deal 1 to enemy life instead$/, () => [{ flag: 'stealOrBurn' }]);
addFirst(/^uprising: if the opponent missed wages, this gets \+1 might$/, () => [{ aura: (G, p, s, x) => (x === s && G.uprising(p) ? 1 : 0) }]);
addFirst(/^when that is true at the start of your turn, the opponent loses 1 specie once per turn$/, () => [{ hook: 'startTurn', once: true, fn: async (G, p) => { if (G.uprising(p)) G.loseSpecie(G.opp(p), 1); } }]);
addFirst(/^when this enters, if it is a token, draw 1$/, () => [{ hook: 'enter', fn: async (G, p, s) => { if (s.token) G.draw(p, 1); } }]);
addFirst(/^you may do this only once per turn$/, () => NOOP);
addFirst(/^once per turn, when this attacks, you may have it deal its combat damage to the opponent's life instead of to martialus$/, () => [{ flag: 'pierce' }]);
addFirst(/^once per turn, when an enemy annex ability would happen, you may ignore it$/, () => [{ flag: 'annexWard' }]);
addFirst(/^raid: once per turn, when a martialus you control steals specie, steal that much again$/, () => [{ hook: 'stole', once: true, fn: async (G, p, s, c) => { if (c.src && c.src.kind === 'soul' && !G.inCopySteal) { G.inCopySteal = true; await G.steal(p, c.amt, null); G.inCopySteal = false; } } }]);
addFirst(/^once per turn, when the opponent would get tithe effects, you choose one of those effects$/, () => [{ flag: 'titheBlock' }]);
addFirst(/^that effect fails$/, () => NOOP); // part of titheBlock
addFirst(/^when you cast a rite, age one enemy martialus of your choice$/, () => [{ hook: 'riteCast', fn: async (G, p) => await G.ageEnemyBest(p, 1) }]);
addFirst(/^once per turn, when you pay wages, choose one martialus you control$/, () => [{ wageMod: (G, p, s, x) => { if (x.kind !== 'soul') return 0; const t = G.souls(p).filter(o => o.wage > 0).sort((a, b) => b.wage - a.wage)[0]; return t === x ? -1 : 0; } }]);
addFirst(/^that martialus has wage 1 less this turn \(min 0\)$/, () => NOOP); // part of line above
addFirst(/^once per game, when the opponent would gain specie from tithe, you may gain that specie instead$/, () => [{ flag: 'titheSteal' }]);
addFirst(/^once per turn, when a martialus you control dies, martialus you control get \+1 might until end of turn$/, () => [{ hook: 'friendlyDeath', once: true, fn: async (G, p) => G.souls(p).forEach(x => (x.temp += 1)) }]);
addFirst(/^once per turn, when you cast a rite, draw 1$/, () => [{ hook: 'riteCast', once: true, fn: async (G, p) => G.draw(p, 1) }]);
addFirst(/^blood dune: once per turn, when a martialus you control dies, your next martialus costs 1 less deploy \(min 0\)$/, () => [{ hook: 'friendlyDeath', once: true, fn: async (G, p) => await G.bloodDune(p, 1) }]);
addFirst(/^uprising: if the opponent missed wages, martialus you control get \+1 might this turn$/, () => [{ aura: (G, p) => (G.uprising(p) ? 1 : 0) }]);
addFirst(/^the opponent's leader loses all abilities until the start of your next turn$/, () => R(async (G, p) => { G.opp(p).leaderBlankUntil = G.turn + 1; }, () => 0.8));
addFirst(/^dune age \(choose one enemy martialus; age it\)$/, () => R(async (G, p) => { const t = await G.pickEnemyAgeTarget(p); if (t) { t.flags.sandMark = { turn: G.turn, by: p }; await G.age(t, 1, p, 'rite'); p.duneAgedThisTurn = true; await G.fire(p, 'duneAged', {}); } }, (G, p) => (G.souls(G.opp(p)).length ? 1.5 : 0)));
addFirst(/^sandfall: if that martialus dies this turn, the opponent loses 1 life$/, () => [{ flag: 'sandMarkCard' }]); // handled in removeSoul via sandMark


// ===== RITER LEADER_BALANCE_DRAFT_2026-11-14 (sim copy only) =====
addFirst(/^once per turn, pay (\d) specie: dune age$/, (m) => [{ hook: 'activated', fn: async (G, p, s) => {
  const cost = +m[1]; if (p.specie < cost + G.reserve(p)) return;
  const t = await G.pickEnemyAgeTarget(p); if (!t) return;
  p.specie -= cost;
  if (G.permFlag(s, 'markDune')) t.flags.sandMark = { turn: G.turn, by: p };
  await G.age(t, 1, p, 'effect'); p.duneAgedThisTurn = true; await G.fire(p, 'duneAged', {});
} }]);
addFirst(/^if that martialus dies this turn, deal 1 to enemy life$/, () => [{ flag: 'markDune' }]);
addFirst(/^once per turn, pay (\d) specie: deal 1 damage to enemy life$/, (m) => [{ hook: 'activated', fn: async (G, p) => { const c = +m[1]; if (p.specie >= c + G.reserve(p)) { p.specie -= c; G.dmgLife(p, G.ownerHasCanopyCard(p) ? 2 : 1); } } }]);
addFirst(/^draw 1 the first time you pay wages in full each turn$/, () => [{ hook: 'paidFull', once: true, fn: async (G, p) => G.draw(p, 1) }]);
addFirst(/^while you control a spire economic, your first economic each turn costs 1 less deploy \(min 0\)$/, () => [{ costMod: (G, p, s, c) => (c.type === 'Economic' && p.econPlayedTurn !== G.turn && G.econs(p).some(e => hasKw(e, 'Spire')) ? -1 : 0) }]);


// ===== RITER LEADER_BALANCE_DRAFT round two (sim copy only) =====
addFirst(/^spire: at the start of your turn, look at the top two cards of your deck; put any on the bottom and the rest back in any order$/, () => [{ hook: 'startTurn', fn: async (G, p) => await G.scry(p, 2) }]);
addFirst(/^your first economic each turn costs 1 less deploy \(min 0\)$/, () => [{ costMod: (G, p, s, c) => (c.type === 'Economic' && p.econPlayedTurn !== G.turn ? -1 : 0) }]);
addFirst(/^chain of command: martialus you control that share a deploy cost with another martialus you control get \+1 might$/, () => [{ aura: (G, p, s, x) => (G.souls(p).some(o => o !== x && G.chainShares(o, x.deploy, x)) ? 1 : 0) }]);
addFirst(/^raid martialus you control get \+1 might while attacking$/, () => [{ aura: (G, p, s, x) => (isRaid(x) && x.attacking ? 1 : 0) }]);

// ===== RITER LEADER_BALANCE_DRAFT round three (sim copy only) =====
addFirst(/^once per turn, pay (\d) specie: deal 1 to enemy life$/, (m) => [{ hook: 'activated', fn: async (G, p) => {
  const c = +m[1]; if (p.specie >= c + G.reserve(p)) { p.specie -= c; G.dmgLife(p, p.duneAgedThisTurn ? 2 : 1); }
} }]);
addFirst(/^when you cast a rite, age one enemy martialus$/, () => [{ hook: 'riteCast', fn: async (G, p) => await G.ageEnemyBest(p, 1) }]);
addFirst(/^annex: when an enemy martialus dies, if cohesion high, put a colovian levy token \(might 1, wage 0\) onto your board$/, () => [{ hook: 'enemyDeath', fn: async (G, p) => { if (G.high(p)) await G.token(p, 1, 0, 'Colovian Levy'); } }]);
addFirst(/^canopy: on your timefall pulse, you may age one of your custodes martialus instead of choosing$/, () => [{ flag: 'michaelPulseAge' }]);

// ===== RITER LEADER_BALANCE_DRAFT round four (sim copy only) =====
addFirst(/^once per turn: deal 1 to enemy life$/, () => [{ hook: 'activated', fn: async (G, p) => {
  let n = 1;
  if (p.duneAgedThisTurn && p.specie >= 1 + G.reserve(p)) { p.specie -= 1; n = 2; }
  G.dmgLife(p, n);
} }]);
addFirst(/^if you used dune age this turn, you may pay 1 specie to deal 2 instead$/, () => NOOP);
addFirst(/^your custodes martialus cost 1 less deploy \(min 0\) and get \+1 might$/, () => [
  { costMod: (G, p, s, c) => (c.type === 'Martial' && isCustodes(c) ? -1 : 0) },
  { aura: (G, p, s, x) => (isCustodes(x.card) ? 1 : 0) }
]);
addFirst(/^the first time you cast a rite each turn, draw 1$/, () => [{ hook: 'riteCast', once: true, fn: async (G, p) => G.draw(p, 1) }]);

// ===== RITER LEADER_BALANCE_DRAFT round five (sim copy only); applied on (r), not (s) =====
addFirst(/^once per turn, pay (\d) specie: deal 2 to enemy life$/, (m) => [{ hook: 'activated', fn: async (G, p) => {
  const c = +m[1]; if (p.specie >= c + G.reserve(p)) { p.specie -= c; G.dmgLife(p, 2); }
} }]);
addFirst(/^your rites work even at low cohesion$/, () => [{ flag: 'ritesWorkLow' }]);
addFirst(/^your first martialus each turn costs 1 less deploy \(min 0\)$/, () => [{ costMod: (G, p, s, c) => (c.type === 'Martial' && p.martialPlayedTurn !== G.turn ? -1 : 0) }]);
addFirst(/^custodes martialus you control get \+1 might$/, () => [{ aura: (G, p, s, x) => (isCustodes(x.card) ? 1 : 0) }]);

function parseCard(card) {
  const t = norm(card.text || '');
  const sentences = splitSentences(t);
  const effects = [];
  const vague = [];
  for (const s of sentences) {
    let matched = false;
    for (const [re, fn] of P) {
      const m = s.match(re);
      if (!m) continue;
      const r = fn(m, card);
      if (r === null) continue; // explicitly vague here; a later pattern may still match
      matched = true;
      effects.push(...r);
      break;
    }
    if (!matched) vague.push(s);
  }
  // Truncated text (no closing period on a dangling clause) is always vague.
  if (/\b(have|has)$/.test(t)) { /* already captured as unmatched */ }
  return { effects, vague };
}

module.exports = { parseCard, norm, hasKw, isRaid };

})(modules["./effects"], modules["./effects"].exports, req);


modules["./ai"] = { exports: {} };
(function(module, exports, require) {
'use strict';
// Simple greedy AI: curve out without breaking payroll, attack when safe or lethal,
// block to preserve Life (good blocks, fair trades, chumps only when Life is in danger).

function fxOf(card) { return require('./engine').fxOf(card); }
const val = (G, s) => G.might(s) + s.deploy * 0.5 + (s.token ? -1 : 0);

function incomeOfCard(G, p, card) {
  let n = 0; for (const e of fxOf(card)) if (e.income) n += e.income(G, p, null) + (card.incomeMod || 0); return n;
}

function scoreTithe(G, p, card, cost) {
  // Colovian Tithe-economy mode: develop Economics, keep a sustainable non-zero bill, value Tithe hooks.
  const fx = fxOf(card);
  const wage = card.wage || 0;
  const tithes = fx.filter(e => e.hook === 'tithe').length;
  const other = fx.filter(e => !e.income && e.hook !== 'tithe').length;
  const boardTithes = G.perms(p).reduce((t, x) => t + x.fx.filter(e => e.hook === 'tithe').length, 0);
  const inc = card.type === 'Economic' ? incomeOfCard(G, p, card) : 0;
  const billNow = G.wageBill(p), billAfter = billNow + wage;
  const projAfter = G.projIncome(p) + inc + boardTithes * 0.6 + Math.floor(Math.max(0, p.specie - cost) / 2);
  const sustain = billAfter <= projAfter;
  if (card.type === 'Economic') {
    let s = (inc - wage) * 2.5 + tithes * 1.5 + other * 0.6 + (p.turnCount <= 8 ? 3 : 0.5);
    if (!p.high) s -= 1;
    if (!sustain) s -= 6;
    return s;
  }
  if (card.type === 'Martial') {
    let s = (card.might || 0) + 0.25 * fx.length + cost * 0.4 + 1 + tithes * 1.5;
    if (wage >= 2 && sustain) s += 1.5;
    if (billNow === 0 && wage >= 1 && sustain) s += 1; // a bill of 0 means Tithe never fires
    if (!sustain) s -= 6;
    return s;
  }
  if (card.type === 'Rite') {
    const base = scoreCard(G, p, card, cost, true);
    return base + (/tithe|wage bill/i.test(card.text) ? 1 : 0);
  }
  return -99;
}

function scoreCard(G, p, card, cost, raw) {
  if (!raw && p.aiMode === 'tithe') return scoreTithe(G, p, card, cost);
  const fx = fxOf(card);
  const wage = card.wage || 0;
  const billAfter = G.wageBill(p) + wage;
  const projAfter = G.projIncome(p) + (card.type === 'Economic' ? incomeOfCard(G, p, card) : 0) + (p.specie - cost);
  const unsafe = G.opts.wageCare === false ? false : billAfter > projAfter;
  if (card.type === 'Martial') {
    if (!p.high && !fx.some(e => e.flag === 'worksLow') && fx.length) { /* text is blank this turn; stats still fine */ }
    let s = (card.might || 0) + 0.25 * fx.length + cost * 0.4 + 1;
    if (unsafe) s -= 6;
    return s;
  }
  if (card.type === 'Economic') {
    const inc = incomeOfCard(G, p, card);
    const net = inc - wage;
    const tithes = fx.filter(e => e.hook === 'tithe').length;
    const other = fx.filter(e => !e.income && e.hook !== 'tithe').length;
    let s = net * 2 + tithes * 0.8 + other * 0.6 - 0.5 + (net > 0 ? (p.turnCount <= 6 ? 2.5 : p.turnCount <= 10 ? 0.5 : -1.5) : 0);
    if (!p.high) s -= 1;
    if (unsafe) s -= 6;
    return s;
  }
  if (card.type === 'Rite') {
    if (!p.high) return -99;
    let v = 0; for (const e of fx) if (e.hook === 'resolve' && e.v !== undefined) v += (typeof e.v === 'function' ? e.v(G, p, card) : e.v);
    if (!fx.length) v = -1; // fully vague Rite: nothing to resolve
    return v - cost * 0.35 - 0.4;
  }
  return -99;
}

async function mainPhase(G, p) {
  for (let guard = 0; guard < 20; guard++) {
    let best = null, bs = 0.01;
    for (const card of p.hand) {
      const c = G.cost(p, card);
      if (c > p.specie) continue;
      const s = scoreCard(G, p, card, c);
      if (s > bs) { bs = s; best = card; }
    }
    if (!best) return;
    await G.play(p, best);
  }
}

function chooseAttackers(G, p) {
  const o = G.opp(p);
  const elig = G.attackersPlanned(p);
  if (!elig.length) return [];
  if (p.allAttack) return elig;
  const blockers = o.souls.filter(s => !s.tapped);
  // lethal check: assume each blocker stops one of our biggest attackers
  const sorted = elig.slice().sort((a, b) => G.might(b) - G.might(a));
  const through = sorted.slice(blockers.length).reduce((t, s) => t + G.might(s), 0);
  if (through >= o.life) return elig;
  const out = [];
  const forced = G.hasFlag(p, 'allMustAttack') && p.high;
  // keep defenders back if their crack-back is dangerous
  const theirPower = o.souls.reduce((t, s) => t + Math.max(0, G.might(s)), 0);
  for (const a of sorted) {
    const ma = G.might(a);
    if (forced || G.permFlag(a, 'mustAttack')) { out.push(a); continue; }
    const threats = blockers.filter(b => G.might(b) >= ma && !(b.fx.some(e => e.cantBlock && e.cantBlock(G, b, a))));
    const unblock = a.fx.some(e => e.unblockable && e.unblockable(G, a, null));
    let go = unblock || threats.length === 0 || threats.every(b => G.might(b) <= ma && val(G, b) >= val(G, a));
    if (go && theirPower >= p.life - 2) {
      // racing danger: only send it if we keep enough back
      const keep = p.souls.filter(s => s !== a && !out.includes(s)).reduce((t, s) => t + G.might(s), 0);
      if (keep < theirPower - (p.life - 3)) go = false;
    }
    if (go) out.push(a);
  }
  return out;
}

function canBlock(G, b, a) {
  if (b.tapped || !b.alive) return false;
  if (b.fx.some(e => e.cantBlock && G.active(b) && e.cantBlock(G, b, a))) return false;
  if (a.fx.some(e => e.unblockable && G.active(a) && e.unblockable(G, a, b))) return false;
  return true;
}

function chooseBlocks(G, d, attackers) {
  const blocks = new Map();
  const used = new Set();
  const atk = attackers.slice().sort((x, y) => G.might(y) - G.might(x));
  let incoming = atk.reduce((t, a) => t + G.might(a), 0);
  for (const a of atk) {
    const ma = G.might(a);
    const cands = d.souls.filter(b => !used.has(b) && canBlock(G, b, a));
    if (!cands.length) continue;
    const danger = incoming >= d.life || d.life - incoming <= 4;
    // 1. block that kills and survives (cheapest such)
    let pick = cands.filter(b => G.might(b) > ma).sort((x, y) => val(G, x) - val(G, y))[0];
    // 2. even trade
    if (!pick) pick = cands.filter(b => G.might(b) === ma && val(G, b) <= val(G, a) + 0.5).sort((x, y) => val(G, x) - val(G, y))[0];
    let gang = null;
    // COL-MAR-053 Phalanx body: same-Deploy Souls block as one body (combined Might, all-or-nothing), once per turn
    if (!pick && d.flagsUsed.phalanx !== G.turn) {
      const ph = cands.find(x => G.permFlag(x, 'phalanx'));
      if (ph) {
        const grp = cands.filter(x => x.deploy === ph.deploy);
        const sum = grp.reduce((t, x) => t + G.might(x), 0);
        if (grp.length >= 2 && sum > ma) { gang = grp; gang.body = true; d.flagsUsed.phalanx = G.turn; }
      }
    }
    // 3. gang block: two blockers together kill it, attacker kills at most one
    if (!pick && !gang && cands.length >= 2) {
      const s2 = cands.slice().sort((x, y) => G.might(y) - G.might(x));
      for (let i = 0; i < s2.length && !gang; i++) for (let j = i + 1; j < s2.length && !gang; j++) {
        const b1 = s2[i], b2 = s2[j];
        if (G.might(b1) + G.might(b2) >= ma && ma < G.might(b1) + G.might(b2) + Math.min(G.might(b1), G.might(b2))) {
          const loss = Math.min(val(G, b1), val(G, b2));
          if (loss < val(G, a)) gang = [b1, b2];
        }
      }
    }
    // 4. chump if Life in danger
    if (!pick && !gang && danger) pick = cands.slice().sort((x, y) => val(G, x) - val(G, y))[0];
    const bs = gang || (pick ? [pick] : null);
    if (bs) { bs.forEach(b => used.add(b)); blocks.set(a, bs); incoming -= ma; }
  }
  return blocks;
}

function pulseChoice(G, p) {
  // Age a Soul (returns it) or null = lose 1 Life
  const souls = p.souls.slice();
  if (!souls.length) return null;
  const shielded = souls.find(s => G.permFlag(s, 'ageShieldOnce') && !s.flags.shieldUsed);
  if (shielded) return shielded;
  if (G.hasFlag(p, 'tokenPulse')) { const t = souls.find(s => s.token); if (t) return t; }
  const tok = souls.filter(s => s.token).sort((a, b) => G.might(a) - G.might(b))[0];
  if (p.life <= 6) return tok || souls.sort((a, b) => val(G, a) - val(G, b))[0];
  if (tok && G.might(tok) >= 2) return tok;
  return null;
}

module.exports = { mainPhase, chooseAttackers, chooseBlocks, pulseChoice, canBlock };

})(modules["./ai"], modules["./ai"].exports, req);


modules["./deck"] = { exports: {} };
(function(module, exports, require) {
'use strict';
// Deck builder. Rules: 60 cards + 1 Leader outside the deck, max 3 copies (DEV_RULES_HANDOFF §2).
// Assumption: decks are single-faction. Shape: 10 Martial / 5 Economic / 5 Rite distinct cards x3
// (30/15/15), drawn at random so every card gets sampled; at least 4 distinct Martials with Deploy <= 2.
function weightedPick(list, k, w, rng) {
  const pool = list.slice(), out = [];
  while (out.length < k && pool.length) {
    const tot = pool.reduce((t, c) => t + w(c), 0); let r = rng() * tot, i = 0;
    for (; i < pool.length - 1; i++) { r -= w(pool[i]); if (r <= 0) break; }
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}
const tagTithe = (c) => (c.keywords || []).includes('Tithe') || /tithe/i.test(c.text);
const econNet = (c) => { const m = c.text.match(/gain (\d) specie/i); return (m ? +m[1] : 0) - (c.wage || 0); };
// Colovian Tithe-economy builder: favors Tithe cards, net-positive / Tithe Economics, and wage-heavy but efficient Martials.
function buildTitheDeck(cards, rng, leaderId) {
  const pool = cards.filter(c => c.set === 'Colovian');
  const leaders = pool.filter(c => c.type === 'Leader');
  const titheLeaders = leaders.filter(tagTithe);
  const leader = leaderId ? leaders.find(l => l.id === leaderId) : rng.pick(leaders);
  const M = pool.filter(c => c.type === 'Martial'), E = pool.filter(c => c.type === 'Economic'), R = pool.filter(c => c.type === 'Rite');
  const wm = (c) => (tagTithe(c) ? 4 : 1) + (c.wage >= 2 && c.might >= c.deploy - 1 ? 1.5 : 0);
  let ms;
  for (let t = 0; t < 50; t++) { ms = weightedPick(M, 10, wm, rng); if (ms.filter(c => c.deploy <= 2).length >= 4) break; }
  const es = weightedPick(E, 5, c => 1 + (econNet(c) > 0 ? 3 : 0) + (tagTithe(c) ? 3 : 0), rng);
  const rs = weightedPick(R, 5, c => (tagTithe(c) || /wage bill/i.test(c.text) ? 3 : 1), rng);
  const list = []; for (const c of [...ms, ...es, ...rs]) for (let i = 0; i < 3; i++) list.push(c);
  return { faction: 'Colovian', leader, cards: list, distinct: [...ms, ...es, ...rs].map(c => c.id), aiMode: 'tithe', titheLeaders: titheLeaders.map(l => l.id) };
}
function buildDeck(cards, faction, rng, leaderId) {
  const pool = cards.filter(c => c.set === faction);
  const leaders = pool.filter(c => c.type === 'Leader');
  const M = pool.filter(c => c.type === 'Martial'), E = pool.filter(c => c.type === 'Economic'), R = pool.filter(c => c.type === 'Rite');
  const leader = leaderId ? leaders.find(l => l.id === leaderId) : rng.pick(leaders);
  let ms;
  for (let t = 0; t < 50; t++) {
    ms = rng.shuffle(M.slice()).slice(0, 10);
    if (ms.filter(c => c.deploy <= 2).length >= 4) break;
  }
  const es = rng.shuffle(E.slice()).slice(0, 5), rs = rng.shuffle(R.slice()).slice(0, 5);
  const list = [];
  for (const c of [...ms, ...es, ...rs]) for (let i = 0; i < 3; i++) list.push(c);
  if (list.length !== 60) throw new Error('bad deck size');
  return { faction, leader, cards: list, distinct: [...ms, ...es, ...rs].map(c => c.id) };
}
module.exports = { buildDeck, buildTitheDeck };

})(modules["./deck"], modules["./deck"].exports, req);


modules["./engine"] = { exports: {} };
(function(module, exports, require) {
'use strict';
const { parseCard, hasKw, isRaid } = require('./effects');
const AI = require('./ai');

const ECCLESIASTUS = /michael|gabriel|abbadon|zachariel|samuel/i;
class GameOver extends Error { constructor(w) { super('over'); this.winner = w; } }

const PARSE = new Map();
function fxOf(card) {
  const k = card.id + '|' + card.text; // keyed by text so per-run text drafts never hit a stale parse
  if (!PARSE.has(k)) PARSE.set(k, parseCard(card));
  return PARSE.get(k).effects;
}

function newStats() {
  return { played: {}, lowTurns: 0, wageTurns: 0, missed: 0, paid: 0, turns: 0, pulses: 0, pulseLife: 0, pulseAge: 0, pulseSkip: 0,
    fizzledRites: 0, blankedPerms: 0, specieStolen: 0, lifeFromCombat: 0, lifeFromEffects: 0, ages: 0, deaths: 0, decked: 0, tithes: 0 };
}

class Game {
  constructor(deckA, deckB, rng, opts = {}) {
    this.rng = rng; this.opts = opts; this.turn = 0; this.uid = 0; this.maxTurns = opts.maxTurns || 60; this.inCombat = false;
    this.notes = []; this.chooser = opts.chooser || null;
    const _log = opts.log; this.log = (m) => { this.notes.push(String(m)); if (typeof _log === 'function') _log(m); else if (_log) console.log(m); };
    this.players = [deckA, deckB].map((d, i) => ({
      idx: i, aiMode: d.aiMode || 'greedy', faction: d.faction || (d.leader && d.leader.set) || 'Colovian', leaderCard: d.leader, deck: rng.shuffle(d.cards.slice()), hand: [], souls: [], econsL: [], leader: null,
      martyrs: [], life: 25, specie: 0, high: true, highLast: true, missedLast: false, missedEver: false, turnCount: 0, canopy: 0,
      bdDiscount: 0, wageTax: 0, missPunish: 0, skipBase: false, ritesThisTurn: 0, stoleThisTurn: false, duneAgedThisTurn: false,
      riteDiscountTurn: 0, freeRite: 0, freeMartials: 0, nextIncomeBonus: 0, nextMartialBonus: 0, prevented: 0, paidThisTurn: false,
      flagsUsed: {}, stats: newStats(), canopyUsedOrHad: false, lastBill: 0, lastMissedAmount: 0, raidDebuffUntilNext: 0,
    }));
    for (const p of this.players) this.draw(p, 7, true);
  }

  // ---------- accessors ----------
  opp(p) { return this.players[1 - p.idx]; }
  souls(p) { return p.souls; }
  econs(p) { return p.econsL; }
  perms(p) { const a = []; if (p.leader) a.push(p.leader); a.push(...p.econsL, ...p.souls); return a; }
  active(perm) {
    if (perm.kind === 'leader' && perm.owner.leaderBlankUntil >= this.turn) return false;
    return perm.blankTurn !== this.turn;
  }
  // Chain of Command Deploy match, with COL-MAR-076 alias (other Souls count as the alias card's Deploy)
  chainShares(o, d, self) {
    if (o.deploy === d) return true;
    const p = o.owner;
    if (!p.econsL.length) return false;
    return p.souls.some(a => a !== o && this.permFlag(a, 'chainAlias') && a.deploy === d);
  }
  bestHandDeploy(p) { const c = {}; for (const x of p.hand) if (x.type === 'Martial') c[x.deploy] = (c[x.deploy] || 0) + 1; let b = null, n = 0; for (const k in c) if (c[k] > n) { n = c[k]; b = +k; } return b; }
  handDiscountValue(p) { const d = this.bestHandDeploy(p); if (d === null) return -2; const k = p.hand.filter(x => x.type === 'Martial' && x.deploy === d).length; return k >= 2 ? k * 0.6 : -0.5; }
  high(p) { return p.high; }
  uprising(p) { const o = this.opp(p); return o.missedLast && !this.hasFlag(o, 'noEnemyUprising'); }
  hasFlag(p, name) { return this.perms(p).some(x => this.active(x) && x.fx.some(e => e.flag === name)); }
  permFlag(perm, name) { return this.active(perm) && perm.fx.some(e => e.flag === name); }
  flagCount(p, name) { let n = 0; for (const x of this.perms(p)) if (this.active(x)) for (const e of x.fx) if (e.flag === name) n++; return n; }

  might(s) {
    let m = s.baseMight + s.mods - s.age + s.temp;
    const p = s.owner, o = this.opp(p);
    for (const x of this.perms(p)) if (this.active(x)) for (const e of x.fx) if (e.aura) m += e.aura(this, p, x, s);
    for (const x of this.perms(o)) if (this.active(x)) for (const e of x.fx) if (e.enemyAura) m += e.enemyAura(this, o, x, s);
    if (o.raidDebuffUntilNext && isRaid(s)) m -= 1;
    if (s.combatDebuff) m -= s.combatDebuff;
    return m;
  }
  wageOf(perm) {
    let w = perm.wage || 0; const p = perm.owner;
    for (const x of this.perms(p)) if (this.active(x)) for (const e of x.fx) if (e.wageMod) w += e.wageMod(this, p, x, perm);
    return Math.max(0, w);
  }
  wageBill(p) { return [...p.souls, ...p.econsL].reduce((t, x) => t + this.wageOf(x), 0); }
  econIncome(p) {
    const tax = this.flagCount(this.opp(p), 'econTax');
    let t = 0;
    for (const e of p.econsL) if (this.active(e)) for (const f of e.fx) if (f.income) {
      let n = f.income(this, p, e);
      if (e.fx.some(z => z.flag === 'treasuryLow') && !p.highLast) n = 1;
      if (e.card.incomeMod) n += e.card.incomeMod; // variant knob (report_wage0)
      t += Math.max(0, n - tax);
    }
    return t;
  }
  projIncome(p) { return (this.opts.baseIncome || 1) + this.econIncome(p); }
  reserve(p) { return Math.max(0, this.wageBill(p) - this.projIncome(p)); }
  ownerHasCanopyCard(p) { return this.perms(p).some(x => hasKw(x, 'Canopy')); }

  cost(p, card, peek = true) {
    let c = card.deploy;
    for (const x of this.perms(p)) if (this.active(x)) for (const e of x.fx) if (e.costMod) c += e.costMod(this, p, x, card);
    if (card.type === 'Rite') {
      c -= p.riteDiscountTurn;
      if (ECCLESIASTUS.test(p.leaderCard.name) && p.ritesThisTurn === 0) c -= 1;
      if (p.freeRite && card.deploy <= p.freeRite) c = 0;
    }
    if (card.type === 'Martial') {
      c -= p.bdDiscount;
      if (p.freeMartials > 0) c = 0;
      if (fxOf(card).some(e => e.flag === 'freeIfMissed') && p.missedLast) c = 0;
      if (p.handDiscount && p.handDiscount.turn === this.turn && p.handDiscount.deploy === card.deploy) c -= 1;
    }
    return Math.max(0, c);
  }

  // ---------- primitive actions ----------
  checkOver() {
    for (const p of this.players) if (p.life <= 0) throw new GameOver(this.opp(p).idx);
  }
  gain(p, n) {
    if (n <= 0) return;
    if (this.inTithe === p) { const o = this.opp(p); if (!o.flagsUsed.titheSteal && this.hasFlag(o, 'titheSteal')) { o.flagsUsed.titheSteal = 1; o.specie += n; return; } }
    p.specie += n;
  }
  loseSpecie(p, n) { p.specie = Math.max(0, p.specie - n); }
  gainLife(p, n) { p.life += n; }
  loseLife(p, n) { p.life -= n; this.checkOver(); }
  dmgLife(p, n, combat = false) {
    const o = this.opp(p);
    if (n <= 0) return 0;
    if (this.hasFlag(o, 'prevent2')) { const k = Math.min(n, 2 - o.prevented); if (k > 0) { o.prevented += k; n -= k; } }
    if (n <= 0) return 0;
    o.life -= n;
    if (combat) p.stats.lifeFromCombat += n; else p.stats.lifeFromEffects += n;
    this.checkOver();
    return n;
  }
  async steal(p, n, src) {
    const o = this.opp(p);
    if (!p.high && this.hasFlag(o, 'noRaidStealWhenLow') && src) return 0;
    if (src && this.hasFlag(p, 'raidSteal2')) n += 1;
    const amt = Math.min(n, o.specie);
    if (amt === 0) { if (src && this.hasFlag(p, 'stealLife')) this.dmgLife(p, 1); return 0; }
    o.specie -= amt; p.specie += amt; p.stoleThisTurn = true; p.stats.specieStolen += amt;
    await this.fire(p, 'stole', { amt, src }); await this.fire(o, 'enemyStole', { amt });
    return amt;
  }
  draw(p, n, setup = false) {
    for (let i = 0; i < n; i++) {
      if (!p.deck.length) { if (!setup) { p.stats.decked++; this.loseLife(p, 1); } continue; }
      p.hand.push(p.deck.shift());
    }
  }
  discard(p, n) {
    for (let i = 0; i < n && p.hand.length; i++) { const c = p.hand.splice(this.rng.int(p.hand.length), 1)[0]; p.martyrs.push(c); }
  }
  async scry(p, n) {
    p.scriedTurn = this.turn;
    const top = p.deck.splice(0, n);
    let keep = [], bottom = [];
    if (p.isHuman && this.chooser && this.chooser.pickScry && top.length) {
      const pick = await this.chooser.pickScry(this, p, top.slice());
      keep = (pick && pick.keep) || [];
      bottom = (pick && pick.bottom) || [];
      if (!keep.length && !bottom.length) keep = top;
    } else {
      const budget = p.specie + this.projIncome(p) + 2;
      for (const c of top) {
        const bad = (c.type === 'Economic' && p.turnCount > 8) || c.deploy > budget;
        (bad ? bottom : keep).push(c);
      }
    }
    p.deck.unshift(...keep); p.deck.push(...bottom);
  }
  async bloodDune(p, n) {
    if (this.hasFlag(p, 'bdDouble')) n *= 2;
    n += this.flagCount(p, 'bdPlus1');
    p.bdDiscount = Math.min(6, p.bdDiscount + n);
    await this.fire(p, 'bloodDune', {});
  }
  async age(s, n, actor, src) {
    if (!s.alive) return false;
    const p = s.owner;
    if (src !== 'self') {
      if (p.ageImmuneTurn) return false;
      if (s.enteredTurn === this.turn && this.permFlag(s, 'noAgeOnEnter')) return false;
      if (src === 'rite' && actor !== p && this.permFlag(s, 'riteAgeImmuneHigh') && p.high) return false;
      if (src === 'rite' && actor !== p && this.permFlag(s, 'riteAgeImmuneSibling') && p.souls.some(o => o !== s && o.deploy === s.deploy)) return false;
      if (this.permFlag(s, 'ageShieldOnce') && !s.flags.shieldUsed) { s.flags.shieldUsed = 1; return false; }
      if ((this.permFlag(s, 'ageShieldTurn') || (this.permFlag(s, 'ageShieldTurnEcon') && p.econsL.length)) && s.flags.shieldTurn !== this.turn) { s.flags.shieldTurn = this.turn; return false; }
      if (this.hasFlag(p, 'shieldAllTurn') && p.flagsUsed.shieldAll !== this.turn) { p.flagsUsed.shieldAll = this.turn; return false; }
      if (p.souls.some(o => o !== s && this.permFlag(o, 'shieldOthersTurn')) && p.flagsUsed.shieldOthers !== this.turn) { p.flagsUsed.shieldOthers = this.turn; return false; }
      if (s.flags.shieldThisTurn === this.turn) { s.flags.shieldThisTurn = -1; return false; }
    }
    if (src === 'rite' && actor && actor !== p && actor.riteExtraAgeTurn === this.turn) n += 1;
    if (this.curAger && this.curAger.owner !== p && this.curAger.alive) {
      const k = p.souls.filter(o => this.permFlag(o, 'ageRetaliate')).length;
      if (k) this.curAger.temp -= k;
    }
    s.age += n;
    (actor || p).stats.ages += n;
    if (actor && src !== 'pulse') await this.fire(actor, 'aged', { soul: s });
    await this.checkDeath(s, actor);
    return true;
  }
  async pickEnemyAgeTarget(p, filter) {
    const t = this.opp(p).souls.filter(x => x.alive && (!filter || filter(x)));
    if (!t.length) return null;
    t.sort((a, b) => {
      const ka = this.might(a) <= 1 ? 1 : 0, kb = this.might(b) <= 1 ? 1 : 0;
      if (ka !== kb) return kb - ka;
      return (b.deploy + this.might(b)) - (a.deploy + this.might(a));
    });
    if (p.isHuman && this.chooser && this.chooser.pickAgeTarget) return await this.chooser.pickAgeTarget(this, p, t, 'Age an enemy Martialus');
    return t[0];
  }
  async ageEnemyBest(p, n = 1, filter) { const t = await this.pickEnemyAgeTarget(p, filter); if (!t) return false; return await this.age(t, n, p, 'effect'); }
  async duneAge(p) {
    const t = await this.pickEnemyAgeTarget(p); if (!t) return false;
    await this.age(t, 1, p, 'effect');
    p.duneAgedThisTurn = true; await this.fire(p, 'duneAged', {});
    return true;
  }
  async checkDeath(s, killer, ctx = {}) {
    if (!s.alive) return false;
    const m = this.might(s);
    if (m <= 0 || (s.dmg > 0 && s.dmg >= m)) { await this.removeSoul(s, true, ctx); return true; }
    return false;
  }
  async destroy(s) { if (s.alive) await this.removeSoul(s, true, {}); }
  async removeSoul(s, died, ctx = {}) {
    const p = s.owner; const i = p.souls.indexOf(s); if (i < 0) return;
    p.souls.splice(i, 1); s.alive = false;
    if (!died) return;
    if (!s.token) p.martyrs.push(s.card);
    this.soulDiedThisTurn = true; p.stats.deaths++;
    if (s.flags.sandMark && s.flags.sandMark.turn === this.turn) { const by = s.flags.sandMark.by; s.flags.sandMark = null; this.dmgLife(by, 1); }
    const c = { soul: s, combat: !!ctx.combat, involved: ctx.involved };
    if (this.active(s)) await this.fireSelf(s, 'death', c);
    await this.fire(p, 'friendlyDeath', c); await this.fire(this.opp(p), 'enemyDeath', c);
    await this.fire(p, 'anyDeath', c); await this.fire(this.opp(p), 'anyDeath', c);
  }
  removePerm(e) { const p = e.owner; const i = p.econsL.indexOf(e); if (i >= 0) { p.econsL.splice(i, 1); p.martyrs.push(e.card); } }
  async sba() {
    let changed = true, guard = 0;
    while (changed && guard++ < 20) { changed = false; for (const q of this.players) for (const s of q.souls.slice()) if (await this.checkDeath(s)) changed = true; }
  }
  async token(p, might, wage, name, vanish = false) {
    const card = { id: 'TOKEN', name, type: 'Martial', deploy: 0, wage, might, keywords: [], text: '' };
    const s = this.mkPerm(p, card, 'soul'); s.token = true; s.vanish = vanish;
    p.souls.push(s); await this.fire(p, 'friendlyEnter', { soul: s });
    return s;
  }
  async splitDamage(p, n) {
    const t = this.opp(p).souls.slice().sort((a, b) => (b.deploy + this.might(b)) - (a.deploy + this.might(a)));
    for (const s of t) { const need = this.might(s) - s.dmg; if (need <= n && need > 0) { s.dmg += need; n -= need; } }
    if (n > 0 && t.length) t[0].dmg += n;
    for (const s of t) await this.checkDeath(s, p);
  }
  async fight(p) {
    const a = p.souls.slice().sort((x, y) => this.might(y) - this.might(x))[0];
    const b = this.opp(p).souls.slice().sort((x, y) => this.might(y) - this.might(x))[0];
    if (!a || !b) return;
    const ma = this.might(a), mb = this.might(b);
    a.dmg += mb; b.dmg += ma;
    await this.checkDeath(a, null); const bd = await this.checkDeath(b, p);
    if (bd && a.alive) await this.steal(p, 2, null);
  }
  fightValue(p) {
    const ma = Math.max(-1, ...p.souls.map(x => this.might(x))), mb = Math.max(-1, ...this.opp(p).souls.map(x => this.might(x)));
    if (ma < 0 || mb < 0) return -5;
    return ma > mb ? 3.5 : ma === mb ? 1 : -3;
  }
  burnValue(p, n) { return this.opp(p).life <= n ? 100 : n * 0.9; }
  taxValue(p, n) {
    const o = this.opp(p); const bill = this.wageBill(o) + o.wageTax; const avail = o.specie + this.projIncome(o);
    return (avail >= bill && avail < bill + n) ? 3 : 0.2;
  }
  canAttackNow(s) {
    const p = s.owner;
    if (s.tapped || !s.alive || this.might(s) <= 0) return false;
    if (s.enteredTurn === this.turn) {
      if (this.permFlag(s, 'noAttackOnEnter')) return false;
      const horn = !p.high && p.souls.some(x => this.permFlag(x, 'hornLow')) && s.deploy === this.freshDeploy(p);
      const haste = p.high || this.permFlag(s, 'hasteLow') || horn || (this.permFlag(s, 'uprisingAttack') && this.uprising(p)) || (this.permFlag(s, 'hasteIfStole') && p.stoleThisTurn);
      if (!haste) return false;
    }
    return true;
  }
  freshDeploy(p) { const c = {}; for (const x of p.souls) if (x.enteredTurn === this.turn) c[x.deploy] = (c[x.deploy] || 0) + 1; let b = null, n = 0; for (const k in c) if (c[k] > n) { n = c[k]; b = +k; } return b; }
  attackersPlanned(p) { return p.souls.filter(s => this.canAttackNow(s)).sort((a, b) => this.might(b) - this.might(a)); }
  precombatPumpValue(p, n, all, filter) {
    const a = this.attackersPlanned(p).filter(x => !filter || filter(x));
    if (!a.length) return -2;
    return (all ? a.length : 1) * n * 0.7;
  }
  bestDeployGroup(p) {
    const c = {}; for (const s of p.souls) c[s.deploy] = (c[s.deploy] || 0) + 1;
    let best = null, bn = 0; for (const k in c) if (c[k] > bn) { bn = c[k]; best = +k; } return best;
  }
  handMartials(p) { return p.hand.filter(c => c.type === 'Martial').length; }

  // ---------- hooks ----------
  async runFx(perm, e, idx, p, ctx) {
    if (e.once) { const k = 'o' + idx; if (perm.once[k] === this.turn) return; perm.once[k] = this.turn; }
    const o = this.opp(p);
    const kws = (perm.card && perm.card.keywords) || [];
    const trig = e.hook && e.hook !== 'tithe' && !['friendlyEnter', 'friendlyEconEnter'].includes(e.hook);
    if (trig && kws.includes('Raid') && perm.kind === 'soul' && ['attack', 'hitLife', 'enter', 'afterCombat', 'stole'].includes(e.hook)) {
      if (p.raidOffUntil >= this.turn) return;                         // COL-MAR-091
      const tax = o.souls.filter(x => this.permFlag(x, 'raidTax')).length; // COL-MAR-100
      if (tax) { if (p.specie >= tax) p.specie -= tax; else return; }
    }
    if (e.hook && kws.includes('Annex') && this.hasFlag(o, 'annexWard') && o.flagsUsed.annexWard !== this.turn) { o.flagsUsed.annexWard = this.turn; return; } // ANN-ECO-020
    if (e.hook === 'tithe' && this.hasFlag(o, 'titheBlock') && o.flagsUsed.titheBlock !== this.turn) { o.flagsUsed.titheBlock = this.turn; return; } // ANN-ECO-025
    if (e.hook === 'tithe') p.stats.titheFx = (p.stats.titheFx || 0) + 1;
    e.fn(this, p, perm, ctx || {});
  }
  async fire(p, hook, ctx) {
    for (const perm of this.perms(p)) {
      if (!this.active(perm)) continue;
      if (perm.kind === 'soul' && (hook === 'enter' || hook === 'death' || hook === 'attack' || hook === 'hitLife' || hook === 'resolve')) continue; // self-only hooks
      if (perm.kind === 'soul' && hook === 'afterCombat' && !perm.attackedThisTurn) continue;
      for (let i = 0; i < perm.fx.length; i++) { const e = perm.fx[i]; if (e.hook === hook) await this.runFx(perm, e, i, p, ctx); }
    }
  }
  async fireSelf(perm, hook, ctx, always = false) {
    for (let i = 0; i < perm.fx.length; i++) { const e = perm.fx[i]; if (e.hook === hook && (always ? e.always : true)) await this.runFx(perm, e, i, perm.owner, ctx); }
  }
  mkPerm(p, card, kind) {
    return { uid: ++this.uid, card, name: card.name, owner: p, kind, deploy: card.deploy, wage: card.wage || 0, baseMight: card.might || 0,
      mods: 0, age: 0, temp: 0, dmg: 0, tapped: false, enteredTurn: this.turn, blankTurn: -1, token: false, fx: card.id === 'TOKEN' ? [] : fxOf(card),
      flags: {}, extraKw: [], alive: true, attacking: false, attackedThisTurn: false, once: {}, combatDebuff: 0 };
  }

  // Variant (c)/(d): Ishtar's Drazah Lash + Sand-Herald get their once-per-turn Dune Age only when their side attacks
  // (Leaders can't attack in v1, so: once per turn, when you declare your first attacker).
  applyLeaderNerf(perm) {
    if (!this.opts.leaderNerf || !['ANN-LED-005', 'ANN-LED-002'].includes(perm.card.id)) return;
    perm.fx = perm.fx.map(e => (e.hook === 'activated' ? { ...e, hook: 'attack', once: true } : e));
  }

  // ---------- playing cards ----------
  async play(p, card) {
    const c = this.cost(p, card);
    p.specie -= c;
    if (this.log) this.log(`  P${p.idx} plays ${card.id} ${card.name} (${card.type} cost ${c}${card.type==='Martial'?' M'+card.might+' W'+card.wage:''})${p.high?'':' [LOW: blank]'} specie left ${p.specie}`);
    p.hand.splice(p.hand.indexOf(card), 1);
    p.stats.played[card.id] = (p.stats.played[card.id] || 0) + 1;
    if (hasKw({ card }, 'Canopy')) p.canopyUsedOrHad = true;
    if (card.type === 'Rite') {
      if (card.deploy <= p.freeRite && p.freeRite) p.freeRite = 0;
      p.martyrs.push(card);
      if (!p.high && !this.hasFlag(p, 'ritesWorkLow')) { p.stats.fizzledRites++; return; }
      const fx = fxOf(card);
      const fake = { card, owner: p, kind: 'rite', fx, once: {}, flags: {}, extraKw: [] };
      for (let i = 0; i < fx.length; i++) { const e = fx[i]; if (e.hook === 'resolve') await this.runFx(fake, e, i, p, {}); }
      p.ritesThisTurn++;
      await this.fire(p, 'riteCast', { card });
      await this.sba();
      return;
    }
    const kind = card.type === 'Martial' ? 'soul' : 'econ';
    if (kind === 'econ') p.econPlayedTurn = this.turn;
    if (kind === 'soul') { p.martialPlayedTurn = this.turn; p.bdDiscount = 0; if (p.freeMartials > 0) p.freeMartials--; }
    const perm = this.mkPerm(p, card, kind);
    const worksLow = perm.fx.some(e => e.flag === 'worksLow');
    if (!p.high && !worksLow) { perm.blankTurn = this.turn; p.stats.blankedPerms++; }
    if (kind === 'soul') { p.souls.push(perm); perm.mods += p.nextMartialBonus; p.nextMartialBonus = 0; }
    else p.econsL.push(perm);
    if (this.active(perm)) await this.fireSelf(perm, 'enter', {});
    else await this.fireSelf(perm, 'enter', {}, true); // drawbacks like "Enters Aged" still apply
    if (kind === 'soul') await this.fire(p, 'friendlyEnter', { soul: perm });
    else await this.fire(p, 'friendlyEconEnter', { perm });
    await this.sba();
  }

  // ---------- turn structure (Ian lock 2026-11-14) ----------
  async takeTurn(p, isFirstTurnOfGame) {
    this.turn++; p.turnCount++; p.stats.turns++;
    const o = this.opp(p);
    // start: untap, per-turn resets
    for (const s of p.souls) { s.tapped = false; }
    p.ritesThisTurn = 0; p.stoleThisTurn = false; p.duneAgedThisTurn = false; p.paidThisTurn = false; p.prevented = 0;
    p.raidDebuffUntilNext = 0; p.ageImmuneTurn = false; this.soulDiedThisTurn = false;
    o.prevented = 0;
    await this.fire(p, 'startTurn', {});
    // 1. draw
    if (!isFirstTurnOfGame) this.draw(p, 1);
    // 2. gain Specie
    const base = this.opts.income === 'ramp' ? Math.min(p.turnCount, 6) : (this.opts.baseIncome || 1);
    const inc = (p.skipBase ? 0 : base) + this.econIncome(p) + p.nextIncomeBonus;
    p.skipBase = false; p.nextIncomeBonus = 0;
    this.gain(p, inc);
    // 3. pay wages / set Cohesion
    const bill = this.wageBill(p) + p.wageTax; p.wageTax = 0; p.lastBill = bill;
    const short = this.hasFlag(p, 'oneShort') ? 1 : 0;
    let missed = false;
    if (bill > 0) p.stats.wageTurns++;
    if (p.specie >= bill) { p.specie -= bill; p.high = true; if (bill > 0) { p.paidThisTurn = true; p.stats.paid++; p.stats.tithes++; this.inTithe = p; await this.fire(p, 'tithe', { bill }); this.inTithe = null; await this.fire(p, 'paidFull', { bill }); } }
    else if (p.specie >= bill - short) { p.specie = 0; p.high = true; }
    else if (this.hasFlag(p, 'abbadon') && !p.flagsUsed.abbadon) {
      let use = true;
      if (p.isHuman && this.chooser && this.chooser.confirmYes) use = await this.chooser.confirmYes(this, p, "Abbadon: lose 1 Life instead of low Cohesion?");
      if (use) { p.flagsUsed.abbadon = 1; p.high = true; this.loseLife(p, 1); this.log((p.isHuman?'You':'AI') + ' used Abbadon: 1 Life instead of low Cohesion'); }
      else { missed = true; p.high = false; p.lastMissedAmount = bill - p.specie; if (this.opts.missDrain) p.specie = 0; }
    }
    else { missed = true; p.high = false; p.lastMissedAmount = bill - p.specie; if (this.opts.missDrain) p.specie = 0; }
    p.missedLast = missed; p.highLast = p.high;
    if (missed) {
      p.missedEver = true; p.stats.missed++; p.stats.lowTurns++;
      await this.fire(o, 'enemyMissed', {});
      if (p.missPunish) this.loseLife(p, p.missPunish);
      if (this.opts.missLife) { p.stats.missLifeLost = (p.stats.missLifeLost || 0) + this.opts.missLife; this.loseLife(p, this.opts.missLife); }
      if (this.opts.missAge) {
        const cands = p.souls.filter(x => this.wageOf(x) > 0).sort((a, b) => this.wageOf(b) - this.wageOf(a) || (a.deploy + a.baseMight) - (b.deploy + b.baseMight));
        let t = cands[0];
        if (t && p.isHuman && this.chooser && this.chooser.pickMissAge) t = await this.chooser.pickMissAge(this, p, cands);
        if (t) { p.stats.missAged = (p.stats.missAged || 0) + 1; this.log((p.isHuman?'You':'AI') + ' missed wages: ' + t.name + ' is Aged'); if (t.age > 0) await this.destroy(t); else await this.age(t, 1, null, 'self'); }
      }
    }
    p.missPunish = 0;
    if (this.log) this.log(`T${this.turn} P${p.idx} ${p.faction} life ${p.life}/${o.life} income ${inc} bill ${bill} ${missed?'MISSED':'paid'} specie ${p.specie} hand ${p.hand.length} board ${p.souls.map(s=>s.name.split(' ')[0]+':'+this.might(s)+(s.tapped?'t':'')).join(',')} | opp ${o.souls.map(s=>s.name.split(' ')[0]+':'+this.might(s)+(s.tapped?'t':'')).join(',')}`);
    // 4. main
    if (p.turnCount === 1) { p.leader = this.mkPerm(p, p.leaderCard, 'leader'); this.applyLeaderNerf(p.leader); await this.fireSelf(p.leader, 'enter', {}); this.log((p.isHuman?'Your':'AI') + ' Leader entered: ' + p.leaderCard.name); }
    if (p.isHuman && this.chooser && this.chooser.pickMainPlay) {
      for (let guard = 0; guard < 20; guard++) {
        const card = await this.chooser.pickMainPlay(this, p);
        if (!card) break;
        await this.play(p, card);
      }
    } else {
      await AI.mainPhase(this, p);
    }
    await this._doActivations(p);
    await this.sba();
    // 5. combat
    await this.combat(p);
    // 6. end
    await this.fire(p, 'endTurn', {});
    for (const s of p.souls.slice()) if (s.vanish) await this.removeSoul(s, false);
    if (p.turnCount % 3 === 0) await this.pulse(p);
    for (const q of this.players) for (const s of q.souls) { s.temp = 0; s.dmg = 0; s.combatDebuff = 0; s.attacking = false; s.attackedThisTurn = false; }
    p.riteDiscountTurn = 0; p.freeRite = 0; p.allAttack = false; p.warCry = false;
    await this.sba();
  }

  async pulse(p) {
    p.stats.pulses++;
    const o = this.opp(p);
    if (p.isHuman && this.chooser && this.chooser.pickPulse) {
      const opts = { samuel: !!(this.hasFlag(p, 'samuelCanopy') && p.paidThisTurn),
        payPulse: !!(this.hasFlag(p, 'payPulse') && !p.flagsUsed.payPulse && p.specie >= 2),
        ageSkip: p.souls.filter(x => this.permFlag(x, 'ageSkipPulse') && this.might(x) >= 2),
        canopy: p.canopy > 0 && !(this.hasFlag(o, 'antiCanopy') && o.flagsUsed.antiCanopy !== this.turn),
        custodes: this.hasFlag(p, 'michaelPulseAge') ? p.souls.filter(x => x.alive && /custodes/i.test(x.name)).sort((a, b) => this.might(a) - this.might(b) || b.age - a.age) : [],
        souls: p.souls.filter(x => x.alive).slice() };
      const pick = await this.chooser.pickPulse(this, p, opts);
      await this._applyPulsePick(p, pick, o);
      return;
    }
    if (this.hasFlag(p, 'samuelCanopy') && p.paidThisTurn) { p.stats.pulseSkip++; return; }
    if (this.hasFlag(p, 'payPulse') && !p.flagsUsed.payPulse && p.specie >= 2) { p.flagsUsed.payPulse = 1; p.specie -= 2; p.stats.pulseSkip++; return; }
    const ager = p.souls.find(x => this.permFlag(x, 'ageSkipPulse') && this.might(x) >= 2);
    if (ager) { p.stats.pulseSkip++; await this.age(ager, 1, p, 'self'); return; }
    if (p.canopy > 0) {
      if (this.hasFlag(o, 'antiCanopy') && o.flagsUsed.antiCanopy !== this.turn) { o.flagsUsed.antiCanopy = this.turn; p.stats.canopyDenied = (p.stats.canopyDenied || 0) + 1; }
      else { p.canopy--; p.canopyUsedOrHad = true; p.canopySkippedEver = true; p.stats.pulseSkip++; await this.fire(p, 'canopyUsed', {}); return; }
    }
    if (this.hasFlag(p, 'glowToll') && !p.flagsUsed.glow) {
      p.flagsUsed.glow = 1; p.stats.pulseSkip++;
      if (await this.ageEnemyBest(p, 1)) { if (this.hasFlag(p, 'glowTollSandfall')) this.loseSpecie(this.opp(p), 1); } else this.dmgLife(p, 1);
      return;
    }
    if (this.hasFlag(p, 'michaelPulseAge')) {
      const cs = p.souls.filter(x => x.alive && /custodes/i.test(x.name)).sort((a, b) => this.might(a) - this.might(b) || b.age - a.age);
      if (cs.length) { p.stats.pulseAge++; await this.age(cs[0], 1, p, 'pulse'); return; }
    }
    const choice = AI.pulseChoice(this, p);
    if (choice) { p.stats.pulseAge++; await this.age(choice, 1, p, 'pulse'); }
    else { p.stats.pulseLife++; this.loseLife(p, 1); }
  }

  async combat(p) {
    const o = this.opp(p);
    const elig = this.attackersPlanned(p);
    const attackers = (p.isHuman && this.chooser && this.chooser.pickAttackers)
      ? (await this.chooser.pickAttackers(this, p, elig)) || []
      : AI.chooseAttackers(this, p);
    if (!attackers.length) return;
    await this.fire(p, 'preCombat', {});
    this.inCombat = true;
    for (const a of attackers) { a.tapped = true; a.attacking = true; a.attackedThisTurn = true; p.stats.attacks = (p.stats.attacks || 0) + 1; }
    for (const a of attackers) {
      if (!a.alive) continue;
      this.curAger = a;
      if (this.active(a)) await this.fireSelf(a, 'attack', { attacker: a });
      this.curAger = null;
      await this.fire(p, 'attack', { attacker: a });
      if (p.warCry) await this.steal(p, 1, a);
    }
    await this.sba();
    const live = attackers.filter(a => a.alive);
    const blocks = (o.isHuman && this.chooser && this.chooser.pickBlocks)
      ? (await this.chooser.pickBlocks(this, o, live)) || new Map()
      : AI.chooseBlocks(this, o, live);
    if (this.log) this.log(`  attack: ${live.map(a=>a.name.split(' ')[0]+':'+this.might(a)+((blocks.get(a)||[]).length?' blocked by '+blocks.get(a).map(b=>b.name.split(' ')[0]+':'+this.might(b)).join('+'):'')).join('; ')}`);
    // snapshot Might simultaneously
    for (const [a, bs] of blocks) if (a.flags.debuffBlockers) for (const b of bs) b.combatDebuff += 1;
    const M = new Map(); for (const s of [...live, ...[].concat(...blocks.values())]) M.set(s, this.might(s));
    let reduce = 0;
    for (const bs of blocks.values()) for (const b of bs) if (this.permFlag(b, 'blockReduce')) reduce++;
    for (const s of o.souls) if (this.permFlag(s, 'econReduce') && o.econsL.length) reduce++;
    const involvedAll = [];
    for (const a of live) {
      const bs = blocks.get(a) || [];
      if (!bs.length) {
        let n = M.get(a);
        if (n >= 4 && this.hasFlag(p, 'bigHitter')) n += 1;
        const r = Math.min(reduce, n); reduce -= r; n -= r;
        if (n > 0) {
          this.dmgLife(p, n, true);
          if (this.active(a)) await this.fireSelf(a, 'hitLife', { attacker: a, amount: n });
          await this.fire(p, 'hitLife', { attacker: a, amount: n });
          if (a.flags.hornSteal === this.turn) await this.steal(p, 1, a);
        }
        continue;
      }
      if (bs.body) { // COL-MAR-053 Phalanx: one body, combined Might, all-or-nothing
        const sum = bs.reduce((t, b) => t + M.get(b), 0);
        if (M.get(a) >= sum) bs.forEach(b => { b.dmg += M.get(b) + 99; });
        a.dmg += sum;
        if (sum > 0) await this.fireSelf(a, 'dmgSoul', { target: bs[0] });
        for (const b of bs) { if (M.get(b) > 0) await this.fireSelf(b, 'dmgSoul', { target: a }); }
        involvedAll.push([a, ...bs]);
        continue;
      }
      if (this.permFlag(a, 'pierce') && a.flags.pierceTurn !== this.turn && !bs.some(b => M.get(a) >= M.get(b))) { // ANN-MAR-078
        a.flags.pierceTurn = this.turn;
        this.dmgLife(p, M.get(a), true);
        for (const b of bs) { this.applyCombatDmg(a, M.get(b)); if (M.get(b) > 0) await this.fireSelf(b, 'dmgSoul', { target: a }); }
        involvedAll.push([a, ...bs]);
        continue;
      }
      // attacker assigns damage (human may pick order when several blockers gang up)
      let dmg = M.get(a);
      let order = bs.slice().sort((x, y) => (y.deploy + M.get(y)) - (x.deploy + M.get(x)));
      if (p.isHuman && this.chooser && this.chooser.pickDamage && bs.length > 1) {
        const picked = await this.chooser.pickDamage(this, p, a, bs.slice(), dmg);
        if (picked && picked.length) {
          const seen = new Set();
          order = [];
          for (const s of picked) if (bs.includes(s) && !seen.has(s)) { seen.add(s); order.push(s); }
          for (const s of bs) if (!seen.has(s)) order.push(s);
        }
      }
      for (const b of order) {
        let need = M.get(b) + (this.permFlag(b, 'dr1') ? 1 : 0);
        if (dmg >= need) { this.applyCombatDmg(b, need); dmg -= need; }
      }
      if (dmg > 0) this.applyCombatDmg(order[0], dmg);
      if (M.get(a) > 0) await this.fireSelf(a, 'dmgSoul', { target: order[0] });
      for (const b of bs) { this.applyCombatDmg(a, M.get(b)); if (M.get(b) > 0) await this.fireSelf(b, 'dmgSoul', { target: a }); }
      involvedAll.push([a, ...bs]);
    }
    for (const grp of involvedAll) for (const s of grp) if (s.alive) await this.checkDeath(s, null, { combat: true, involved: grp });
    await this.sba();
    this.inCombat = false;
    await this.fire(p, 'afterCombat', {});
    await this.sba();
  }
  applyCombatDmg(s, n) {
    if (n <= 0) return;
    if (this.permFlag(s, 'dr1') && s.flags.drTurn !== this.turn) { s.flags.drTurn = this.turn; n -= 1; }
    s.dmg += Math.max(0, n);
  }

  async run() {
    const first = this.rng.int(2); this.first = first;
    let cur = this.players[first];
    let firstTurn = true;
    try {
      while (this.turn < this.maxTurns) {
        await this.takeTurn(cur, firstTurn);
        firstTurn = false;
        cur = this.opp(cur);
      }
      return { winner: -1, turns: this.turn, first };
    } catch (e) {
      if (e instanceof GameOver) return { winner: e.winner, turns: this.turn, first };
      throw e;
    }
  }
}


Game.prototype._applyPulsePick = async function(p, pick, o) {
    const kind = (pick && pick.type) || 'life';
    if (kind === 'payPulse') { p.flagsUsed.payPulse = 1; p.specie -= 2; p.stats.pulseSkip++; this.log((p.isHuman?'You':'AI') + ' paid 2 Specie to skip Timefall'); return; }
    if (kind === 'ageSkip' && pick.soul) { p.stats.pulseSkip++; await this.age(pick.soul, 1, p, 'self'); this.log((p.isHuman?'You':'AI') + ' Aged ' + pick.soul.name + ' to skip Timefall'); return; }
    if (kind === 'canopy' || kind === 'samuel') {
      if (kind === 'canopy' && this.hasFlag(o, 'antiCanopy') && o.flagsUsed.antiCanopy !== this.turn) { o.flagsUsed.antiCanopy = this.turn; p.stats.canopyDenied = (p.stats.canopyDenied || 0) + 1; this.log('Canopy skip was denied'); }
      else { if (kind === 'canopy') p.canopy--; p.canopyUsedOrHad = true; p.canopySkippedEver = true; p.stats.pulseSkip++; await this.fire(p, 'canopyUsed', {}); this.log((p.isHuman?'You':'AI') + ' skipped Timefall with Canopy'); return; }
    }
    if (kind === 'custodes' && pick.soul) { p.stats.pulseAge++; await this.age(pick.soul, 1, p, 'pulse'); this.log((p.isHuman?'You':'AI') + ' Aged ' + pick.soul.name + ' instead of Timefall (Michael)'); return; }
    if (kind === 'age' && pick.soul) { p.stats.pulseAge++; await this.age(pick.soul, 1, p, 'pulse'); this.log((p.isHuman?'You':'AI') + ' Aged ' + pick.soul.name + ' for Timefall'); return; }
    p.stats.pulseLife++; this.loseLife(p, 1); this.log((p.isHuman?'You':'AI') + ' lost 1 Life to Timefall');
};
Game.prototype._doActivations = async function(p) {
    const acts = [];
    for (const perm of this.perms(p)) {
      if (!this.active(perm)) continue;
      perm.fx.forEach((e, i) => { if (e.hook === 'activated') acts.push({ perm, e, i }); });
    }
    if (!acts.length) return;
    if (p.isHuman && this.chooser && this.chooser.pickActivations) {
      const picked = await this.chooser.pickActivations(this, p, acts);
      for (const a of (picked || [])) await this.runFx(a.perm, a.e, a.i, p, {});
      return;
    }
    await this.fire(p, 'activated', {});
};

module.exports = { Game, fxOf, PARSE, GameOver };

})(modules["./engine"], modules["./engine"].exports, req);

const engine = req('./engine');
const deck = req('./deck');
const rng = req('./rng');
const ai = req('./ai');
const effects = req('./effects');
const api = {
  Game: engine.Game,
  GameOver: engine.GameOver,
  fxOf: engine.fxOf,
  buildDeck: deck.buildDeck,
  makeRng: rng.makeRng,
  parseCard: effects.parseCard,
  AI: ai,
  GAME_OPTS: { baseIncome: 2, missAge: true }
};
root.RUIN_PLAY = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
