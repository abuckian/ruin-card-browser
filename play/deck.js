/* RUIN deck helper — validate, auto-fill, export/import, localStorage, starters.
   Works in the browser (window.RUIN_DECK) and in Node (module.exports). */
(function (root) {
  const STORAGE_KEY = 'ruin-play-decks-v1';
  const CODE_PREFIX = 'RUIN1';
  const DECK_SIZE = 60;

  function byId(cards, id) { return cards.find((c) => c.id === id) || null; }
  function maxCopies(card) {
    if (!card) return 3;
    if (card.maxCopies != null && card.maxCopies >= 0) return card.maxCopies;
    return 3;
  }
  function playable(cards) { return cards.filter((c) => c && c.type && c.type !== 'Leader'); }
  function leaders(cards) { return cards.filter((c) => c.type === 'Leader'); }
  function totalCounts(counts) {
    let n = 0;
    for (const k in counts) n += (+counts[k] || 0);
    return n;
  }
  function normalizeCounts(counts) {
    const out = {};
    if (!counts) return out;
    if (Array.isArray(counts)) {
      for (const item of counts) {
        if (!item) continue;
        if (typeof item === 'string') { out[item] = (out[item] || 0) + 1; continue; }
        const id = item.id || item.cardId;
        const n = item.count != null ? +item.count : 1;
        if (id) out[id] = (out[id] || 0) + n;
      }
      return out;
    }
    if (typeof counts === 'object') {
      for (const id of Object.keys(counts)) {
        const n = +counts[id] || 0;
        if (n > 0) out[id] = n;
      }
    }
    return out;
  }

  function summarize(counts, cards) {
    const types = { Martial: 0, Economic: 0, Rite: 0, Other: 0 };
    const sets = { Colovian: 0, Anu: 0 };
    const curve = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, '5+': 0 };
    let total = 0;
    for (const id of Object.keys(counts)) {
      const n = +counts[id] || 0; if (!n) continue;
      const c = byId(cards, id); if (!c) continue;
      total += n;
      const t = types[c.type] != null ? c.type : 'Other';
      types[t] += n;
      if (sets[c.set] != null) sets[c.set] += n;
      const d = c.deploy || 0;
      if (d >= 5) curve['5+'] += n; else curve[d] = (curve[d] || 0) + n;
    }
    return { total, types, sets, curve, mixed: sets.Colovian > 0 && sets.Anu > 0 };
  }

  function validate(spec, cards) {
    const errors = [];
    if (!spec) { errors.push('No deck.'); return errors; }
    const leader = typeof spec.leader === 'object' && spec.leader
      ? spec.leader
      : byId(cards, spec.leaderId || (spec.leader && spec.leader.id));
    if (!leader || leader.type !== 'Leader') errors.push('Pick a Leader.');
    const counts = normalizeCounts(spec.counts || spec.cards);
    const total = totalCounts(counts);
    if (total !== DECK_SIZE) errors.push('Deck must be exactly ' + DECK_SIZE + ' cards (now ' + total + '). The Leader sits outside the 60.');
    for (const id of Object.keys(counts)) {
      const n = +counts[id] || 0; if (!n) continue;
      const c = byId(cards, id);
      if (!c) { errors.push('Unknown card ' + id + '.'); continue; }
      if (c.type === 'Leader') errors.push(c.name + ' is a Leader — Leaders do not go in the 60.');
      const cap = maxCopies(c);
      if (n > cap) errors.push((c.name || id) + ': ' + n + ' copies (max ' + cap + ').');
    }
    return errors;
  }

  function toGameDeck(spec, cards, rng) {
    const counts = normalizeCounts(spec.counts || spec.cards);
    const leader = typeof spec.leader === 'object' && spec.leader && spec.leader.type === 'Leader'
      ? spec.leader
      : byId(cards, spec.leaderId || (spec.leader && spec.leader.id));
    const list = [];
    for (const id of Object.keys(counts)) {
      const c = byId(cards, id); if (!c || c.type === 'Leader') continue;
      const n = +counts[id] || 0;
      for (let i = 0; i < n; i++) list.push(c);
    }
    if (rng && rng.shuffle) rng.shuffle(list);
    const sum = summarize(counts, cards);
    return {
      faction: (leader && leader.set) || spec.faction || 'Colovian',
      leader,
      cards: list,
      mixed: sum.mixed,
      name: spec.name || '',
      counts
    };
  }

  function fromBuilt(built) {
    const counts = {};
    for (const c of built.cards || []) counts[c.id] = (counts[c.id] || 0) + 1;
    return {
      name: built.name || '',
      leaderId: built.leader && built.leader.id,
      counts,
      faction: built.faction
    };
  }

  function incomeHint(card) {
    const m = (card.text || '').match(/gain (\d+)\s*specie/i);
    return m ? +m[1] : 0;
  }

  function autoFill(spec, cards, rng) {
    const rand = () => (rng && typeof rng === 'function' ? rng() : (rng && rng.next ? rng.next() : Math.random()));
    const leader = typeof spec.leader === 'object' && spec.leader
      ? spec.leader
      : byId(cards, spec.leaderId);
    const counts = normalizeCounts(spec.counts);
    const pool = playable(cards);
    const typeOf = (t) => {
      let n = 0;
      for (const c of pool) if (c.type === t) n += counts[c.id] || 0;
      return n;
    };
    const cheap = () => {
      let n = 0;
      for (const c of pool) if ((c.deploy || 0) <= 2) n += counts[c.id] || 0;
      return n;
    };
    const high = () => {
      let n = 0;
      for (const c of pool) if ((c.deploy || 0) >= 5) n += counts[c.id] || 0;
      return n;
    };

    function score(c) {
      const have = counts[c.id] || 0;
      if (have >= maxCopies(c)) return -Infinity;
      const deploy = c.deploy || 0;
      const wage = c.wage || 0;
      let s = 0;
      if (c.type === 'Martial') s = (c.might || 0) + (deploy <= 2 ? 2.2 : deploy <= 3 ? 0.9 : 0.2) - wage * 0.35;
      else if (c.type === 'Economic') {
        const inc = incomeHint(c);
        const tithe = /tithe/i.test(c.text || '') || (c.keywords || []).includes('Tithe');
        s = (inc - wage) * 2.2 + (tithe ? 1.1 : 0) + 0.9;
      } else if (c.type === 'Rite') s = 1.5 - deploy * 0.15 + ((c.text || '').length > 40 ? 0.25 : 0);
      else s = 0;
      if (leader && c.set === leader.set) s += 1.5;
      const tot = totalCounts(counts);
      const remain = Math.max(1, DECK_SIZE - tot);
      const needM = Math.max(0, 30 - typeOf('Martial'));
      const needE = Math.max(0, 15 - typeOf('Economic'));
      const needR = Math.max(0, 15 - typeOf('Rite'));
      if (c.type === 'Martial') s += 2.4 * (needM / remain);
      if (c.type === 'Economic') s += 2.4 * (needE / remain);
      if (c.type === 'Rite') s += 2.4 * (needR / remain);
      if (deploy <= 2 && cheap() < 18) s += 1.8;
      if (deploy >= 5 && high() >= 8) s -= 2.2;
      if (have === 1) s += 0.45;
      if (have === 2) s += 0.2;
      s += rand() * 0.2;
      return s;
    }

    let guard = 0;
    while (totalCounts(counts) < DECK_SIZE && guard++ < 200) {
      let best = null, bs = -1e9;
      for (const c of pool) {
        const s = score(c);
        if (s > bs) { bs = s; best = c; }
      }
      if (!best || bs === -Infinity) break;
      counts[best.id] = (counts[best.id] || 0) + 1;
    }
    return { leaderId: leader ? leader.id : spec.leaderId, leader, counts, name: spec.name || '' };
  }

  function buildAiDeck(cards, leaderOrFaction, rng) {
    let leader = null;
    if (leaderOrFaction && typeof leaderOrFaction === 'object' && leaderOrFaction.type === 'Leader') leader = leaderOrFaction;
    else if (typeof leaderOrFaction === 'string' && leaderOrFaction.indexOf('-LED-') >= 0) leader = byId(cards, leaderOrFaction);
    else {
      const fac = (typeof leaderOrFaction === 'string' && leaderOrFaction) ? leaderOrFaction : null;
      const pool = leaders(cards).filter((l) => !fac || l.set === fac);
      const list = pool.length ? pool : leaders(cards);
      if (rng && rng.pick) leader = rng.pick(list);
      else leader = list[Math.floor((rng && rng.next ? rng.next() : Math.random()) * list.length)];
    }
    return autoFill({ leaderId: leader && leader.id, leader, counts: {}, name: 'AI built' }, cards, rng);
  }

  function exportCode(spec) {
    const leaderId = spec.leaderId || (spec.leader && spec.leader.id) || '';
    const counts = normalizeCounts(spec.counts || spec.cards);
    const parts = Object.keys(counts).sort().map((id) => id + '*' + counts[id]);
    return CODE_PREFIX + ':' + leaderId + ':' + parts.join(',');
  }

  function importCode(text, cards) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('Empty code.');
    let body = raw.replace(/^\s*RUIN1\s*[:\s]/i, '').trim();
    // multiline: Leader: ID \n IDxN
    if (/^Leader\s*:/i.test(body) || /\n/.test(body)) {
      const lines = raw.split(/\s*[\r\n]+\s*/).map((l) => l.trim()).filter(Boolean);
      let leaderId = '';
      const counts = {};
      for (const line of lines) {
        if (/^RUIN1/i.test(line) && line.indexOf(':') >= 0) return importCode(line, cards);
        const lm = line.match(/^Leader\s*:\s*([A-Z]{3}-LED-\d+)/i);
        if (lm) { leaderId = lm[1].toUpperCase(); continue; }
        const cm = line.match(/^([A-Z]{3}-[A-Z]{3}-\d+)\s*[x*]\s*(\d+)\s*$/i) || line.match(/^([A-Z]{3}-[A-Z]{3}-\d+)\s*$/i);
        if (cm) { const id = cm[1].toUpperCase(); counts[id] = (counts[id] || 0) + (cm[2] ? +cm[2] : 1); continue; }
      }
      if (!leaderId) throw new Error('Code is missing a Leader.');
      return { leaderId, counts, name: '' };
    }
    const m = raw.match(/^RUIN1:(.+)$/i);
    const payload = m ? m[1] : body;
    const segs = payload.split(':');
    const leaderId = (segs[0] || '').trim().toUpperCase();
    const rest = segs.slice(1).join(':');
    if (!leaderId) throw new Error('Code is missing a Leader.');
    const counts = {};
    if (rest) {
      for (const part of rest.split(',')) {
        const p = part.trim(); if (!p) continue;
        const cm = p.match(/^([A-Z]{3}-[A-Z]{3}-\d+)\s*[x*]\s*(\d+)$/i) || p.match(/^([A-Z]{3}-[A-Z]{3}-\d+)$/i);
        if (!cm) throw new Error('Cannot read card entry: ' + p);
        const id = cm[1].toUpperCase();
        counts[id] = (counts[id] || 0) + (cm[2] ? +cm[2] : 1);
      }
    }
    if (cards && !byId(cards, leaderId)) throw new Error('Unknown Leader ' + leaderId + '.');
    return { leaderId, counts, name: '' };
  }

  function loadSaved() {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : (data && data.decks) || [];
      return list.map(normalizeSaved).filter(Boolean);
    } catch (e) { return []; }
  }
  function normalizeSaved(d) {
    if (!d || !d.leaderId) return null;
    return {
      id: d.id || ('d' + Date.now()),
      name: d.name || 'Untitled deck',
      leaderId: d.leaderId,
      counts: normalizeCounts(d.counts || d.cards),
      updated: d.updated || Date.now()
    };
  }
  function persistSaved(list) {
    if (typeof localStorage === 'undefined') return list;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, decks: list }));
    return list;
  }
  function saveDeck(spec) {
    const list = loadSaved();
    const row = {
      id: spec.id || ('d' + Date.now() + Math.floor(Math.random() * 1000)),
      name: (spec.name || 'Untitled deck').trim() || 'Untitled deck',
      leaderId: spec.leaderId || (spec.leader && spec.leader.id),
      counts: normalizeCounts(spec.counts),
      updated: Date.now()
    };
    const i = list.findIndex((x) => x.id === row.id);
    if (i >= 0) list[i] = row; else list.push(row);
    persistSaved(list);
    return row;
  }
  function deleteDeck(id) {
    persistSaved(loadSaved().filter((x) => x.id !== id));
  }
  function duplicateDeck(id) {
    const src = loadSaved().find((x) => x.id === id);
    if (!src) return null;
    return saveDeck({ name: src.name + ' (copy)', leaderId: src.leaderId, counts: Object.assign({}, src.counts) });
  }

  function normalizeStarter(d) {
    if (!d) return null;
    const leaderId = d.leaderId || d.leader || (d.leader && d.leader.id);
    if (!leaderId) return null;
    return {
      id: d.id || ('starter-' + leaderId),
      name: d.name || 'Starter',
      leaderId,
      counts: normalizeCounts(d.cards || d.counts),
      plan: d.plan || d.oneLiner || '',
      starter: true
    };
  }
  function startersFromPayload(payload) {
    if (!payload) return [];
    const list = Array.isArray(payload) ? payload : (payload.decks || payload.starters || []);
    return list.map(normalizeStarter).filter(Boolean);
  }

  function readStartersSync() {
    if (root.RUIN_STARTER_DECKS) return startersFromPayload(root.RUIN_STARTER_DECKS);
    if (typeof require === 'function' && typeof process !== 'undefined' && process.versions && process.versions.node) {
      const fs = require('fs');
      const path = require('path');
      const candidates = [
        path.join(__dirname, 'starter_decks.json'),
        '/workspace/ruin-card-browser/play/starter_decks.json',
        '/workspace/ruin-card-game/STARTER_DECKS.json',
        '/workspace/ruin-card-game/STARTER_DECKS_2026-11-14.json'
      ];
      try {
        const dir = '/workspace/ruin-card-game';
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            if (/^STARTER_DECKS.*\.(json|md)$/i.test(f)) candidates.push(path.join(dir, f));
          }
        }
      } catch (e) { /* ignore */ }
      for (const p of candidates) {
        try {
          if (!fs.existsSync(p)) continue;
          const raw = fs.readFileSync(p, 'utf8');
          if (/\.md$/i.test(p)) {
            const m = raw.match(/```json\s*([\s\S]*?)```/);
            if (m) return startersFromPayload(JSON.parse(m[1]));
            continue;
          }
          return startersFromPayload(JSON.parse(raw));
        } catch (e) { /* try next */ }
      }
    }
    return [];
  }

  function loadStarters() {
    const sync = readStartersSync();
    if (sync.length || typeof fetch === 'undefined' || (typeof process !== 'undefined' && process.versions && process.versions.node)) {
      return Promise.resolve(sync);
    }
    const url = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src)
      ? null
      : 'play/starter_decks.json';
    return fetch(url || 'play/starter_decks.json', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : { decks: [] })
      .then((j) => startersFromPayload(j))
      .catch(() => []);
  }

  const api = {
    STORAGE_KEY, DECK_SIZE, maxCopies, playable, leaders, byId, totalCounts, normalizeCounts,
    summarize, validate, toGameDeck, fromBuilt, autoFill, buildAiDeck,
    exportCode, importCode, loadSaved, saveDeck, deleteDeck, duplicateDeck,
    loadStarters, readStartersSync, startersFromPayload
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RUIN_DECK = api;
})(typeof window !== 'undefined' ? window : globalThis);
