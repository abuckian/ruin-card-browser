/* RUIN play UI — Ian vs the sim AI, with deck builder. */
(function () {
  const { Game, GameOver, buildDeck, makeRng, AI, GAME_OPTS } = window.RUIN_PLAY;
  const DECK = window.RUIN_DECK;
  const CARDS = window.RUIN_PLAY_CARDS;
  const RULES_MD = window.RUIN_PLAY_RULES;
  const TIPS = window.RUIN_PLAY_TOOLTIPS || {};

  const $ = (id) => document.getElementById(id);
  const shortName = (n) => (n || '').split(',')[0];
  const artUrl = (card) => (!card || !card.id || card.id === 'TOKEN') ? '' : ('thumbs/' + card.id + '.jpg');

  const DEV_NOTE_RE = /\s*\((?:text says so|name check|reminder|text allows|see (?:code|engine|notes)|dev(?:eloper)? note|todo|fixme)\)/gi;
  function displayText(text) {
    return String(text || '')
      .replace(DEV_NOTE_RE, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([.,;:])/g, '$1')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }
  function shownText(card) { return displayText((card && card.text) || ''); }

  const KW = Object.keys(TIPS).sort((a, b) => b.length - a.length);
  const KW_RE = KW.length ? new RegExp('(' + KW.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi') : null;

  function linkKeywords(text) {
    const s = String(text || '');
    if (!KW_RE) return escapeHtml(s);
    let out = '', last = 0;
    s.replace(KW_RE, function (m, _g, i) {
      out += escapeHtml(s.slice(last, i));
      const key = KW.find((k) => k.toLowerCase() === m.toLowerCase()) || m;
      out += '<span class="kw" data-kw="' + escapeAttr(key) + '">' + escapeHtml(m) + '</span>';
      last = i + m.length;
      return m;
    });
    return out + escapeHtml(s.slice(last));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

  function mdToHtml(md) {
    const lines = String(md).split(/\n/);
    let html = '', inOl = false, inUl = false;
    const close = () => { if (inOl) { html += '</ol>'; inOl = false; } if (inUl) { html += '</ul>'; inUl = false; } };
    const inline = (t) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) { close(); continue; }
      if (/^#\s/.test(t)) { close(); html += '<h2>' + inline(t.replace(/^#\s+/, '')) + '</h2>'; continue; }
      if (/^##\s/.test(t)) { close(); html += '<h2>' + inline(t.replace(/^##\s+/, '')) + '</h2>'; continue; }
      const olm = t.match(/^\d+\.\s+(.*)/);
      if (olm) { if (inUl) { html += '</ul>'; inUl = false; } if (!inOl) { html += '<ol>'; inOl = true; } html += '<li>' + inline(olm[1]) + '</li>'; continue; }
      if (/^[-*]\s/.test(t)) { if (inOl) { html += '</ol>'; inOl = false; } if (!inUl) { html += '<ul>'; inUl = true; } html += '<li>' + inline(t.replace(/^[-*]\s+/, '')) + '</li>'; continue; }
      close(); html += '<p>' + inline(t) + '</p>';
    }
    close();
    return html;
  }

  let st = { game: null, me: null, ai: null, busy: false };
  let starters = [];
  const draft = {
    id: null, name: '', leaderId: '', counts: {},
    facFilt: 'Leader', typeFilt: '', costFilt: '', q: ''
  };

  function cardById(id) { return CARDS.find((c) => c.id === id) || null; }
  function allLeaders() { return CARDS.filter((c) => c.type === 'Leader'); }
  function leaderOptions(includeRandom) {
    const groups = { Colovian: [], Anu: [] };
    for (const c of allLeaders()) (groups[c.set] || (groups[c.set] = [])).push(c);
    let html = includeRandom ? '<option value="">Random</option>' : '';
    for (const fac of ['Colovian', 'Anu']) {
      html += '<optgroup label="' + fac + '">';
      for (const c of groups[fac] || []) html += '<option value="' + c.id + '">' + escapeHtml(shortName(c.name)) + '</option>';
      html += '</optgroup>';
    }
    return html;
  }
  function fillLeaders() {
    $('leaderSel').innerHTML = leaderOptions(true);
    $('builderLeader').innerHTML = leaderOptions(false);
    if (!draft.leaderId) draft.leaderId = $('builderLeader').value;
    else $('builderLeader').value = draft.leaderId;
  }

  function deckLabel(d) {
    const L = cardById(d.leaderId);
    const n = DECK.totalCounts(d.counts);
    const mix = DECK.summarize(d.counts, CARDS).mixed ? ' · mixed' : '';
    return (d.name || 'Untitled') + ' — ' + shortName(L ? L.name : d.leaderId) + ' (' + n + '/60' + mix + ')';
  }

  function fillDeckSelects(keep) {
    const myVal = keep ? $('myDeckSel').value : 'random';
    const aiVal = keep ? $('aiDeckSel').value : ($('aiDeckSel').value || 'random');
    let my = '<option value="random">Random deck</option>';
    const saved = DECK.loadSaved();
    if (saved.length) {
      my += '<optgroup label="Your decks">';
      for (const d of saved) my += '<option value="saved:' + d.id + '">' + escapeHtml(deckLabel(d)) + '</option>';
      my += '</optgroup>';
    }
    if (starters.length) {
      my += '<optgroup label="Starter decks">';
      for (const d of starters) my += '<option value="starter:' + d.id + '">' + escapeHtml(deckLabel(d)) + '</option>';
      my += '</optgroup>';
    }
    $('myDeckSel').innerHTML = my;
    if ([].some.call($('myDeckSel').options, (o) => o.value === myVal)) $('myDeckSel').value = myVal;

    let ai = '<option value="random">Random deck</option>';
    ai += '<option value="ai">AI-built deck</option>';
    if (starters.length) {
      ai += '<optgroup label="Starter decks">';
      ai += '<option value="starter">Random starter (other Leader faction)</option>';
      for (const d of starters) ai += '<option value="starter:' + d.id + '">' + escapeHtml(deckLabel(d)) + '</option>';
      ai += '</optgroup>';
    }
    $('aiDeckSel').innerHTML = ai;
    if ([].some.call($('aiDeckSel').options, (o) => o.value === aiVal)) $('aiDeckSel').value = aiVal;
    refreshSetupErr();
  }

  function selectedMySpec() {
    const v = $('myDeckSel').value;
    if (v === 'random' || !v) return null;
    const kind = v.split(':')[0], id = v.slice(v.indexOf(':') + 1);
    if (kind === 'saved') return DECK.loadSaved().find((d) => d.id === id) || null;
    if (kind === 'starter') return starters.find((d) => d.id === id) || null;
    return null;
  }

  function deckPlanText(spec) {
    if (!spec) return '';
    return spec.plan || '';
  }
  function starterByValue(val) {
    if (!val) return null;
    if (val === 'starter') return { name: 'Random starter', plan: "A random starter whose Leader is the other faction." };
    if (val.indexOf('starter:') === 0) return starters.find((d) => d.id === val.slice(8)) || null;
    if (val.indexOf('saved:') === 0) return DECK.loadSaved().find((d) => d.id === val.slice(6)) || null;
    return null;
  }
  function refreshPlans() {
    const mine = starterByValue($('myDeckSel').value);
    const theirs = starterByValue($('aiDeckSel').value);
    $('myDeckPlan').textContent = ($('myDeckSel').value === 'random')
      ? 'A random legal 60 from your Leader\'s faction (10 Martialus / 5 Economic / 5 Rite).'
      : (deckPlanText(mine) || '');
    if ($('aiDeckSel').value === 'random') $('aiDeckPlan').textContent = 'A random legal 60 from the other Leader faction.';
    else if ($('aiDeckSel').value === 'ai') $('aiDeckPlan').textContent = 'The same auto-fill logic, for a Leader of the other faction.';
    else $('aiDeckPlan').textContent = deckPlanText(theirs) || '';
  }
  function refreshSetupErr() {
    const el = $('setupErr');
    const spec = selectedMySpec();
    refreshPlans();
    if (!spec) { el.textContent = ''; $('btnStart').disabled = false; return; }
    const errs = DECK.validate(spec, CARDS);
    if (errs.length) {
      el.textContent = 'This deck cannot be used: ' + errs.join(' ');
      $('btnStart').disabled = true;
    } else { el.textContent = ''; $('btnStart').disabled = false; }
  }

  function hideAllScreens() {
    ['setup', 'game', 'builder'].forEach((id) => $(id).classList.remove('on'));
  }
  function showSetup() {
    hideAllScreens(); $('setup').classList.add('on');
    fillDeckSelects(true); refreshSetupErr();
  }
  function showGame() { hideAllScreens(); $('game').classList.add('on'); }
  function showBuilder() { hideAllScreens(); $('builder').classList.add('on'); renderBuilder(); }

  $('btnStart').addEventListener('click', () => startGame());
  $('btnRulesSetup').addEventListener('click', openRules);
  $('btnRules').addEventListener('click', openRules);
  $('btnNew').addEventListener('click', () => { $('endModal').classList.remove('on'); showSetup(); });
  $('btnBuilder').addEventListener('click', () => openBuilder(null));
  $('btnBuilderBack').addEventListener('click', () => showSetup());
  $('myDeckSel').addEventListener('change', () => {
    const spec = selectedMySpec();
    if (spec && spec.leaderId) $('leaderSel').value = spec.leaderId;
    refreshSetupErr();
  });
  $('aiDeckSel').addEventListener('change', refreshSetupErr);

  function openRules() {
    $('rulesSheet').innerHTML = mdToHtml(RULES_MD) +
      '<button class="btn primary wide" type="button" id="rulesClose">Close</button>';
    $('rulesModal').classList.add('on');
    $('rulesClose').onclick = () => $('rulesModal').classList.remove('on');
  }
  $('rulesModal').addEventListener('click', (e) => { if (e.target === $('rulesModal')) $('rulesModal').classList.remove('on'); });
  $('cardModal').addEventListener('click', (e) => { if (e.target === $('cardModal')) $('cardModal').classList.remove('on'); });
  $('codeModal').addEventListener('click', (e) => { if (e.target === $('codeModal')) $('codeModal').classList.remove('on'); });
  $('endModal').addEventListener('click', (e) => { if (e.target === $('endModal')) $('endModal').classList.remove('on'); });

  function openCard(card, extraHtml) {
    if (!card) return;
    const art = artUrl(card);
    const typ = [card.type, card.set].filter(Boolean).join(' · ');
    const stats = [
      card.type !== 'Leader' ? 'Deploy ' + (card.deploy ?? 0) : null,
      (card.wage || card.wage === 0) && card.type !== 'Rite' && card.type !== 'Leader' ? 'Wage ' + card.wage : null,
      card.might != null ? 'Might ' + card.might : null
    ].filter(Boolean).join(' · ');
    $('cardSheet').innerHTML =
      (art ? '<img class="art" alt="" src="' + art + '" onerror="this.style.opacity=0">' : '') +
      '<h2>' + escapeHtml(card.name) + '</h2>' +
      '<div class="sub" style="margin-top:0">' + escapeHtml(typ + (stats ? ' · ' + stats : '')) + '</div>' +
      '<div class="txt">' + linkKeywords(shownText(card)) + '</div>' +
      (card.flavor ? '<p class="sub">' + escapeHtml(displayText(card.flavor)) + '</p>' : '') +
      (extraHtml || '') +
      '<button class="btn wide" type="button" id="cardClose">Close</button>';
    $('cardModal').classList.add('on');
    $('cardClose').onclick = () => $('cardModal').classList.remove('on');
    bindKeywords($('cardSheet'));
  }

  function bindKeywords(root) {
    root.querySelectorAll('.kw').forEach((el) => {
      const show = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const key = el.getAttribute('data-kw');
        const tip = $('tip');
        tip.textContent = (TIPS[key] || key);
        tip.style.display = 'block';
        const r = el.getBoundingClientRect();
        let left = Math.min(window.innerWidth - 272, Math.max(8, r.left));
        let top = r.bottom + 8;
        if (top + 80 > window.innerHeight) top = Math.max(8, r.top - 80);
        tip.style.left = left + 'px'; tip.style.top = top + 'px';
        const hide = () => { tip.style.display = 'none'; document.removeEventListener('click', hide, true); };
        setTimeout(() => document.addEventListener('click', hide, true), 0);
      };
      el.addEventListener('click', show);
      el.addEventListener('contextmenu', show);
      let t = 0;
      el.addEventListener('touchstart', () => { t = Date.now(); }, { passive: true });
      el.addEventListener('touchend', (ev) => { if (Date.now() - t > 400) show(ev); });
    });
  }

  function costOf(p, card) { return st.game.cost(p, card); }
  function canPlay(p, card) { return costOf(p, card) <= p.specie; }

  function chooser() {
    return {
      pickMainPlay: (G, p) => new Promise((resolve) => {
        prompt('Your main phase. Tap a card in your hand to look at it, then Play if you can afford it.', [
          { label: 'Done', primary: true, fn: () => resolve(null) }
        ]);
        st.handMode = { type: 'play', resolve, p };
        render();
      }),
      pickAttackers: (G, p, elig) => new Promise((resolve) => {
        const picked = new Set();
        const finish = () => resolve([...picked]);
        st.pickSet = { type: 'attack', elig, picked, finish };
        prompt('Tap your Souls to attack, then Confirm. You can also confirm with none.', [
          { label: 'Confirm attackers', primary: true, fn: finish }
        ]);
        render();
      }),
      pickBlocks: (G, d, attackers) => new Promise((resolve) => {
        const live = (attackers || []).filter((a) => a && a.alive);
        const can = live.some((a) => (d.souls || []).some((b) => !AI.canBlock || AI.canBlock(G, b, a)));
        if (!live.length || !can) { resolve(new Map()); return; }
        const blocks = new Map();
        let chosenBlocker = null;
        st.pickSet = { type: 'block', attackers: live, blocks, get chosenBlocker() { return chosenBlocker; }, set chosenBlocker(v) { chosenBlocker = v; } };
        prompt('Tap a Soul, then the attacker it blocks. Several can gang up. Confirm when done.', [
          { label: 'Confirm blocks', primary: true, fn: () => { st.pickSet = null; resolve(blocks); } }
        ]);
        render();
      }),
      pickDamage: (G, p, attacker, blockers, dmg) => new Promise((resolve) => {
        const order = [];
        const finish = (list) => { st.pickSet = null; resolve(list); };
        st.pickSet = { type: 'damage', attacker, blockers, order };
        prompt('Assign ' + dmg + ' damage from ' + shortName(attacker.name) + '. Tap blockers in the order they should take damage (first is assigned lethal if you can), then Confirm.', [
          { label: 'Confirm order', primary: true, fn: () => {
            const rest = blockers.filter((b) => !order.includes(b));
            finish(order.concat(rest));
          } },
          { label: 'Default (biggest first)', fn: () => finish(null) }
        ]);
        render();
      }),
      pickPulse: (G, p, opts) => new Promise((resolve) => {
        const acts = [];
        if (opts.samuel) acts.push({ label: 'Skip Timefall (Samuel, wages paid)', fn: () => resolve({ type: 'samuel' }) });
        if (opts.canopy) acts.push({ label: 'Skip Timefall with Canopy', fn: () => resolve({ type: 'canopy' }) });
        if (opts.payPulse) acts.push({ label: 'Pay 2 Specie to skip Timefall', fn: () => resolve({ type: 'payPulse' }) });
        (opts.ageSkip || []).forEach((s) => acts.push({ label: 'Age ' + shortName(s.name) + ' to skip Timefall', fn: () => resolve({ type: 'ageSkip', soul: s }) }));
        (opts.custodes || []).forEach((s) => acts.push({ label: 'Age ' + shortName(s.name) + ' instead (Michael)', fn: () => resolve({ type: 'custodes', soul: s }) }));
        (opts.souls || []).forEach((s) => acts.push({ label: 'Age ' + shortName(s.name) + ' (Might ' + G.might(s) + ')', fn: () => resolve({ type: 'age', soul: s }) }));
        acts.push({ label: 'Lose 1 Life', primary: true, fn: () => resolve({ type: 'life' }) });
        prompt('Timefall. Choose one:', acts);
        render();
      }),
      pickAgeTarget: (G, p, cands, reason) => new Promise((resolve) => {
        st.pickSet = { type: 'ageTarget', cands, resolve };
        prompt((reason || 'Choose an enemy Martialus to Age') + '. Tap one.', [
          { label: 'Skip (no target)', fn: () => { st.pickSet = null; resolve(null); } }
        ]);
        render();
      }),
      pickMissAge: (G, p, cands) => new Promise((resolve) => {
        st.pickSet = { type: 'missAge', cands, resolve };
        const def = cands[0];
        prompt('You missed wages. Choose a Soul with Wage to Age (dies if already Aged). Highest Wage is marked.', [
          def ? { label: 'Age ' + shortName(def.name) + ' (highest Wage)', primary: true, fn: () => { st.pickSet = null; resolve(def); } } : null
        ].filter(Boolean));
        render();
      }),
      pickScry: (G, p, cards) => new Promise((resolve) => {
        const flags = cards.map(() => 'keep');
        const redraw = () => {
          const acts = cards.map((c, i) => ({
            label: (flags[i] === 'keep' ? 'Keep: ' : 'Bottom: ') + shortName(c.name),
            fn: () => { flags[i] = flags[i] === 'keep' ? 'bottom' : 'keep'; redraw(); }
          }));
          acts.push({ label: 'Confirm order', primary: true, fn: () => {
            resolve({ keep: cards.filter((_, i) => flags[i] === 'keep'), bottom: cards.filter((_, i) => flags[i] === 'bottom') });
          }});
          prompt('Look at the top of your deck. Tap a card to send it to the bottom or keep it on top.', acts);
        };
        redraw();
        render();
      }),
      pickActivations: (G, p, acts) => new Promise(async (resolve) => {
        const used = [];
        for (const a of acts) {
          const name = a.perm.name || (a.perm.card && a.perm.card.name) || 'Leader';
          const snippet = (a.perm.card && a.perm.card.text) ? displayText(a.perm.card.text).replace(/Enter by end of turn 1\.\s*/i, '') : 'Use ability';
          const ok = await yesNo('Use ' + shortName(name) + '?\n' + snippet);
          if (ok) used.push(a);
        }
        resolve(used);
      }),
      confirmYes: (G, p, q) => yesNo(q)
    };
  }

  function yesNo(q) {
    return new Promise((resolve) => {
      prompt(q, [
        { label: 'Yes', primary: true, fn: () => resolve(true) },
        { label: 'No', fn: () => resolve(false) }
      ]);
      render();
    });
  }

  function prompt(q, acts) {
    $('promptQ').textContent = q;
    const box = $('promptActs');
    box.innerHTML = '';
    (acts || []).forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (a.primary ? ' primary' : '');
      b.textContent = a.label;
      b.addEventListener('click', () => { if (st.handMode && a.label === 'Done') st.handMode = null; a.fn(); });
      box.appendChild(b);
    });
  }

  function otherFaction(fac) { return fac === 'Anu' ? 'Colovian' : 'Anu'; }

  function makeRandomDeck(rng, faction, leaderId) {
    return buildDeck(CARDS, faction, rng, leaderId || undefined);
  }

  function startGame() {
    const rng = makeRng((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
    const mySpec = selectedMySpec();
    let lid = $('leaderSel').value || undefined;
    let mine;
    if (mySpec) {
      const errs = DECK.validate(mySpec, CARDS);
      if (errs.length) { $('setupErr').textContent = errs.join(' '); return; }
      mine = DECK.toGameDeck(mySpec, CARDS, rng);
    } else {
      const L = lid ? cardById(lid) : rng.pick(allLeaders());
      lid = L.id;
      mine = makeRandomDeck(rng, L.set, lid);
    }
    const myFac = (mine.leader && mine.leader.set) || mine.faction;
    const aiFac = otherFaction(myFac);
    const aiVal = $('aiDeckSel').value || 'random';
    let theirs;
    if (aiVal === 'ai') {
      const built = DECK.buildAiDeck(CARDS, aiFac, rng);
      theirs = DECK.toGameDeck(built, CARDS, rng);
    } else if (aiVal === 'starter' || aiVal.indexOf('starter:') === 0) {
      let d = null;
      if (aiVal.indexOf('starter:') === 0) d = starters.find((x) => x.id === aiVal.slice(8));
      if (!d) {
        const pool = starters.filter((x) => {
          const L = cardById(x.leaderId); return L && L.set === aiFac && !DECK.validate(x, CARDS).length;
        });
        const ok = pool.length ? pool : starters.filter((x) => !DECK.validate(x, CARDS).length);
        d = ok.length ? rng.pick(ok) : null;
      }
      if (d && !DECK.validate(d, CARDS).length) theirs = DECK.toGameDeck(d, CARDS, rng);
      else theirs = makeRandomDeck(rng, aiFac);
    } else {
      theirs = makeRandomDeck(rng, aiFac);
    }
    const g = new Game(mine, theirs, rng, Object.assign({}, GAME_OPTS, { chooser: chooser(), log: true }));
    g.players[0].isHuman = true;
    g.players[1].isHuman = false;
    st.game = g; st.me = g.players[0]; st.ai = g.players[1]; st.handMode = null; st.pickSet = null;
    showGame();
    $('btnNew').style.display = 'none';
    playLoop(g);
  }

  async function playLoop(g) {
    const first = g.rng.int(2); g.first = first;
    let cur = g.players[first];
    let firstTurn = true;
    g.log((cur.isHuman ? 'You go first.' : 'The AI goes first.'));
    try {
      while (g.turn < g.maxTurns) {
        st.handMode = null; st.pickSet = null;
        prompt(cur.isHuman ? 'Your turn…' : 'AI is taking its turn…', []);
        render();
        await g.takeTurn(cur, firstTurn);
        firstTurn = false;
        cur = g.opp(cur);
        render();
      }
      endGame(-1);
    } catch (e) {
      if (e && (e instanceof GameOver || typeof e.winner === 'number')) endGame(e.winner);
      else { console.error(e); prompt('Something went wrong: ' + (e && e.message ? e.message : e), []); }
    }
  }

  function endGame(winner) {
    render();
    const youWin = winner === 0;
    const draw = winner < 0;
    const title = draw ? 'Draw' : (youWin ? 'You win' : 'You lose');
    const msg = draw ? 'The game hit the turn cap.' : (youWin ? 'Enemy Life hit 0.' : 'Your Life hit 0.');
    $('endbox').innerHTML = '<p class="big">' + title + '</p><p class="sub">' + msg + '</p><button class="btn primary wide" type="button" id="endNew">New game</button>';
    $('endModal').classList.add('on');
    $('btnNew').style.display = '';
    $('endNew').onclick = () => { $('endModal').classList.remove('on'); showSetup(); };
    prompt(title + '. ' + msg, []);
  }

  function gem(kind, value, dmg, label) {
    const hurt = (kind === 'might' && dmg) ? ' hurt' : '';
    const mark = (kind === 'might' && dmg) ? '<span class="dmg">' + dmg + '</span>' : '';
    const title = kind === 'cost' ? 'Deploy' : (kind === 'might' ? 'Might' : (kind === 'life' ? 'Life' : 'Wage'));
    const lab = (label === '') ? '' : (label != null ? label : ({ might: 'M', wage: 'W', cost: 'D' }[kind] || ''));
    return '<span class="gem ' + kind + hurt + '" title="' + title + '"><span class="gv">' + value + '</span>' +
      (lab ? '<span class="gl">' + lab + '</span>' : '') + mark + '</span>';
  }
  function artTag(card, cls) {
    const u = artUrl(card);
    if (!u) return '';
    return '<img class="' + (cls || 'art') + '" alt="" src="' + u + '" onerror="this.style.opacity=0">';
  }
  function leaderText(card) {
    return displayText((card && card.text) || '').replace(/Enter by end of turn 1\.\s*/i, '');
  }

  function pills(p, compact) {
    const G = st.game;
    const bill = G.wageBill(p);
    const inc = G.projIncome(p);
    const pulse = p.turnCount && p.turnCount % 3 === 0;
    const incTurn = compact
      ? '<span class="pill">In ' + inc + (p.turnCount ? ' · T' + p.turnCount : '') + (pulse ? ' · Timefall' : '') + '</span>'
      : ('<span class="pill">Income ' + inc + '</span>' +
        (p.turnCount ? '<span class="pill">Turn ' + p.turnCount + (pulse ? ' · Timefall' : '') + '</span>' : ''));
    return '<span class="crystals">' +
      '<span class="crystal" title="Specie">' + gem('cost', p.specie, 0, '') + ' Specie</span>' +
      '<span class="crystal wage-bill" title="Total wages this turn">' + gem('wage', bill) + ' Wages</span>' +
      '</span>' + incTurn;
  }

  function tokenSoul(s, cls) {
    const G = st.game;
    const m = G.might(s);
    const w = G.wageOf(s);
    const card = s.card || s;
    const aged = s.age ? '<div class="meta">Aged ' + s.age + (s.token ? ' · token' : '') + '</div>' : (s.token ? '<div class="meta">token</div>' : '');
    const ps = st.pickSet;
    let extra = '';
    if (ps && ps.type === 'damage' && ps.order) {
      const i = ps.order.indexOf(s);
      if (i >= 0) extra = '<div class="meta">Assign #' + (i + 1) + '</div>';
    }
    return '<button type="button" class="token ' + (cls || '') + (s.tapped ? ' tapped' : '') + '" data-uid="' + s.uid + '">' +
      artTag(card) +
      '<span class="tn">' + escapeHtml(shortName(s.name)) + '</span>' +
      '<div class="gems">' + gem('might', m, s.dmg || 0) + gem('wage', w || 0) + '</div>' +
      aged + extra +
      '</button>';
  }
  function tokenEcon(e) {
    const w = (e.card && e.card.wage) || e.wage || 0;
    return '<button type="button" class="token" data-card="' + escapeAttr(e.card.id) + '">' +
      artTag(e.card) +
      '<span class="tn">' + escapeHtml(shortName(e.name)) + '</span>' +
      '<div class="gems">' + gem('wage', w) + '</div>' +
      '<div class="meta">Economic</div></button>';
  }

  function lane(p, prefix) {
    const econs = (p.econsL || []).map(tokenEcon).join('');
    const souls = (p.souls || []).map((s) => {
      let cls = '';
      const ps = st.pickSet;
      if (ps && ps.type === 'attack' && ps.elig.includes(s) && ps.picked.has(s)) cls = 'atk sel';
      else if (ps && ps.type === 'attack' && ps.elig.includes(s)) cls = 'atk';
      if (ps && ps.type === 'block') {
        const assigned = [...ps.blocks.values()].some((arr) => arr.includes(s));
        if (ps.chosenBlocker === s) cls = 'sel';
        else if (assigned) cls = 'blk';
      }
      if (ps && ps.type === 'missAge' && ps.cands.includes(s)) cls = (ps.cands[0] === s ? 'sel' : '');
      if (ps && ps.type === 'ageTarget' && ps.cands.includes(s)) cls = 'atk';
      if (ps && ps.type === 'damage' && ps.blockers.includes(s)) cls = (ps.order.includes(s) ? 'sel' : 'blk');
      return tokenSoul(s, cls);
    }).join('');
    const el = prefix === 'ai' ? $('aiBoard') : $('myBoard');
    const empty = !(econs || souls);
    el.classList.toggle('empty', empty);
    el.innerHTML = empty ? '' : '<div class="lane">' + econs + souls + '</div>';
  }

  function renderHand() {
    const p = st.me;
    if (!p) return;
    $('hand').innerHTML = p.hand.map((c, i) => {
      const cost = costOf(p, c);
      const can = st.handMode && st.handMode.type === 'play' && canPlay(p, c);
      const gems = [gem('cost', cost)];
      if (c.might != null) gems.push(gem('might', c.might));
      if (c.type !== 'Rite' && c.type !== 'Leader') gems.push(gem('wage', c.wage || 0));
      return '<button type="button" class="card' + (can ? ' can' : '') + '" data-hand="' + i + '">' +
        '<span class="cost-slot">' + gem('cost', cost) + '</span>' +
        artTag(c) +
        '<div class="body"><div class="cn">' + escapeHtml(shortName(c.name)) + '</div>' +
        '<div class="gems">' + gems.slice(1).join('') + '</div>' +
        '<div class="ct">' + linkKeywords(shownText(c)) + '</div></div></button>';
    }).join('') || '<span class="sub empty-hand">No cards in hand</span>';
    bindKeywords($('hand'));
    layoutHandFan();
  }

  function layoutHandFan() {
    const hand = $('hand');
    const wrap = $('handWrap');
    if (!hand || !wrap) return;
    const cards = [...hand.querySelectorAll('.card')];
    cards.forEach((el, i) => {
      el.style.left = '';
      el.style.bottom = '';
      el.style.width = '';
      el.style.transform = '';
      el.style.zIndex = String(i + 1);
    });
    hand.style.height = '';
    wrap.classList.toggle('fit', cards.length > 0 && hand.scrollWidth <= wrap.clientWidth + 1);
  }

  function renderLeader(slotId, p, who) {
    const el = $(slotId);
    if (!el || !p || !p.leaderCard) { if (el) el.innerHTML = ''; return; }
    const c = p.leaderCard;
    const coh = p.high ? 'high' : 'low';
    el.innerHTML = '<button type="button" class="lcard" data-leader="' + who + '">' +
      '<div class="portrait">' + artTag(c) +
      '<span class="life-wrap" title="Life">' + gem('life', p.life) + '</span>' +
      '<span class="rune ' + coh + '" title="Cohesion"><span class="rune-gem"></span><span class="rune-lab">' + (p.high ? 'High' : 'Low') + '</span></span>' +
      '</div>' +
      '<div class="body"><div class="cn">' + escapeHtml(shortName(c.name)) + '</div>' +
      '<div class="ct">' + linkKeywords(leaderText(c)) + '</div></div></button>';
    bindKeywords(el);
  }

  function formatLog(notes) {
    const out = [];
    for (const n of notes || []) {
      let s = String(n).trim();
      if (/^T\d+\s+P\d+/.test(s)) {
        const m = s.match(/bill (\d+) (MISSED|paid) specie (\d+)/i);
        if (!m) continue;
        const who = /P0 /.test(s) ? 'You' : 'The AI';
        s = m[2].toLowerCase() === 'paid'
          ? (who + ' paid ' + m[1] + ' Specie in wages, ' + m[3] + ' left.')
          : (who + ' missed wages (needed ' + m[1] + ' Specie, ' + m[3] + ' left).');
      }
      s = s.replace(/^P0 plays \S+\s+(.+?) \([^)]*cost (\d+)[^)]*\)(?:\s*\[LOW: blank\])?\s*specie left (\d+)/i,
        (_, name, cost, left) => 'You play ' + name + ' for ' + cost + ' Specie (' + left + ' left).');
      s = s.replace(/^P1 plays \S+\s+(.+?) \([^)]*cost (\d+)[^)]*\)(?:\s*\[LOW: blank\])?\s*specie left (\d+)/i,
        (_, name, cost, left) => 'The AI plays ' + name + ' for ' + cost + ' Specie (' + left + ' left).');
      s = s.replace(/specie left (\d+)/gi, (_, n) => n + ' Specie left');
      s = s.replace(/\s*\[LOW: blank\]/g, '');
      s = s.replace(/^\s*attack:\s*/, 'Attack: ');
      s = s.replace(/^AI Leader entered:/, "The AI's Leader entered:");
      s = s.replace(/^AI /g, 'The AI ');
      if (s) out.push(s);
    }
    return out.slice(-3);
  }

  function pulseTimefall(g) {
    const cur = g.players.find((p) => p.turnCount === g.turn) || st.me;
    const on = !!(cur && cur.turnCount && cur.turnCount % 3 === 0);
    const gameEl = $('game');
    if (!on) { gameEl.classList.remove('timefall'); st._pulseFor = 0; return; }
    const key = (cur.idx + ':' + cur.turnCount);
    if (st._pulseFor === key) return;
    st._pulseFor = key;
    gameEl.classList.remove('timefall');
    void gameEl.offsetWidth;
    gameEl.classList.add('timefall');
  }

  function facLabel(p) {
    const sets = new Set();
    if (p.leaderCard && p.leaderCard.set) sets.add(p.leaderCard.set);
    (p.deck || []).forEach((c) => { if (c && c.set) sets.add(c.set); });
    (p.hand || []).forEach((c) => { if (c && c.set) sets.add(c.set); });
    if (sets.size > 1) return (p.faction || 'Mixed') + ' (mixed)';
    return p.faction || '';
  }

  function render() {
    const g = st.game; if (!g) return;
    const me = st.me, ai = st.ai;
    $('aiName').textContent = 'AI · ' + facLabel(ai);
    $('aiName').className = 'name ' + (ai.faction === 'Anu' ? 'anu' : 'col');
    $('meName').textContent = 'You · ' + facLabel(me);
    $('meName').className = 'name ' + (me.faction === 'Anu' ? 'anu' : 'col');
    $('aiPills').innerHTML = pills(ai);
    $('mePills').innerHTML = pills(me, true);
    renderLeader('aiLeaderSlot', ai, 'ai');
    renderLeader('meLeaderSlot', me, 'me');
    lane(ai, 'ai');
    lane(me, 'my');
    renderHand();
    $('log').innerHTML = formatLog(g.notes).map(escapeHtml).join('<br>');
    $('log').scrollTop = $('log').scrollHeight;
    pulseTimefall(g);
  }

  window.addEventListener('resize', () => layoutHandFan());
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => layoutHandFan());

  function soulByUid(uid) {
    uid = +uid;
    for (const p of st.game.players) {
      const s = p.souls.find((x) => x.uid === uid);
      if (s) return s;
    }
    return null;
  }

  document.addEventListener('click', (e) => {
    const pm = e.target.closest('.pm[data-add], .pm[data-sub]');
    if (pm) {
      e.preventDefault(); e.stopPropagation();
      const id = pm.getAttribute('data-add') || pm.getAttribute('data-sub');
      bumpCard(id, pm.hasAttribute('data-add') ? 1 : -1);
      return;
    }
    const savedAct = e.target.closest('[data-sedit], [data-sdup], [data-sdel]');
    if (savedAct) {
      const id = savedAct.getAttribute('data-sedit') || savedAct.getAttribute('data-sdup') || savedAct.getAttribute('data-sdel');
      if (savedAct.hasAttribute('data-sedit')) openBuilder(id);
      else if (savedAct.hasAttribute('data-sdup')) { DECK.duplicateDeck(id); renderSaved(); fillDeckSelects(true); }
      else if (savedAct.hasAttribute('data-sdel')) {
        if (confirm('Delete this saved deck?')) { DECK.deleteDeck(id); if (draft.id === id) draft.id = null; renderSaved(); fillDeckSelects(true); }
      }
      return;
    }
    const handBtn = e.target.closest('[data-hand]');
    if (handBtn && st.me) {
      const card = st.me.hand[+handBtn.getAttribute('data-hand')];
      if (!card) return;
      const hm = st.handMode;
      const playable = hm && hm.type === 'play' && canPlay(st.me, card);
      const extra = playable
        ? '<button class="btn primary wide" type="button" id="cardPlay">Play for ' + costOf(st.me, card) + ' Specie</button>'
        : '';
      openCard(card, extra);
      const pb = document.getElementById('cardPlay');
      if (pb) pb.onclick = () => {
        $('cardModal').classList.remove('on');
        st.handMode = null;
        hm.resolve(card);
      };
      return;
    }
    const dinfo = e.target.closest('.dinfo[data-cid]');
    if (dinfo) { openCard(cardById(dinfo.getAttribute('data-cid'))); return; }
    const chipEl = e.target.closest('.chip[data-uid], .chip[data-card]');
    if (chipEl) {
      const ps = st.pickSet;
      if (chipEl.getAttribute('data-card') && !chipEl.getAttribute('data-uid')) {
        const c = cardById(chipEl.getAttribute('data-card'));
        openCard(c); return;
      }
      const s = soulByUid(chipEl.getAttribute('data-uid'));
      if (!s) return;
      if (ps && ps.type === 'attack' && ps.elig.includes(s)) {
        if (ps.picked.has(s)) ps.picked.delete(s); else ps.picked.add(s);
        render(); return;
      }
      if (ps && ps.type === 'block') {
        if (s.owner === st.me) {
          for (const [a, arr] of ps.blocks) {
            const i = arr.indexOf(s);
            if (i >= 0) { arr.splice(i, 1); if (!arr.length) ps.blocks.delete(a); ps.chosenBlocker = null; render(); return; }
          }
          ps.chosenBlocker = s; render(); return;
        }
        if (s.owner === st.ai && ps.attackers.includes(s) && ps.chosenBlocker) {
          const b = ps.chosenBlocker;
          if (AI.canBlock && !AI.canBlock(st.game, b, s)) { $('promptQ').textContent = 'That Soul cannot block this attacker. Pick another, or Confirm.'; return; }
          const arr = ps.blocks.get(s) || [];
          if (!arr.includes(b)) arr.push(b);
          ps.blocks.set(s, arr);
          ps.chosenBlocker = null;
          render(); return;
        }
      }
      if (ps && ps.type === 'damage' && ps.blockers.includes(s)) {
        const i = ps.order.indexOf(s);
        if (i >= 0) ps.order.splice(i, 1);
        else ps.order.push(s);
        render(); return;
      }
      if (ps && ps.type === 'ageTarget' && ps.cands.includes(s)) {
        const res = ps.resolve; st.pickSet = null; res(s); return;
      }
      if (ps && ps.type === 'missAge' && ps.cands.includes(s)) {
        const res = ps.resolve; st.pickSet = null; res(s); return;
      }
      openCard(s.card); return;
    }
    const lead = e.target.closest('[data-leader]');
    if (lead) { openCard(lead.getAttribute('data-leader') === 'ai' ? (st.ai && st.ai.leaderCard) : (st.me && st.me.leaderCard)); return; }
  });

  /* ---------- deck builder ---------- */
  function openBuilder(savedId) {
    if (savedId) {
      const d = DECK.loadSaved().find((x) => x.id === savedId);
      if (d) {
        draft.id = d.id; draft.name = d.name; draft.leaderId = d.leaderId;
        draft.counts = Object.assign({}, d.counts);
      }
    } else {
      draft.id = null;
      draft.name = '';
      draft.leaderId = $('leaderSel').value || (allLeaders().find((l) => l.set === 'Colovian') || allLeaders()[0]).id;
      draft.counts = {};
    }
    draft.facFilt = 'Leader'; draft.typeFilt = ''; draft.costFilt = ''; draft.q = '';
    $('deckName').value = draft.name;
    $('builderLeader').value = draft.leaderId;
    $('cardSearch').value = '';
    showBuilder();
  }

  function bumpCard(id, delta) {
    const c = cardById(id); if (!c) return;
    const cap = DECK.maxCopies(c);
    const have = draft.counts[id] || 0;
    const next = have + delta;
    if (next <= 0) delete draft.counts[id];
    else if (next > cap) draft.counts[id] = cap;
    else {
      const tot = DECK.totalCounts(draft.counts);
      if (delta > 0 && tot >= 60) return;
      draft.counts[id] = next;
    }
    renderBuilder();
  }

  function renderCurve(sum) {
    const keys = [0, 1, 2, 3, 4, '5+'];
    const max = Math.max(1, ...keys.map((k) => sum.curve[k] || 0));
    $('deckCurve').innerHTML = keys.map((k) => {
      const n = sum.curve[k] || 0;
      const h = Math.round((n / max) * 36);
      return '<div class="bar" title="Deploy ' + k + ': ' + n + '"><i style="height:' + h + 'px"></i><span>' + k + '</span></div>';
    }).join('');
  }

  function renderBuilder() {
    draft.name = $('deckName').value;
    draft.leaderId = $('builderLeader').value;
    const L = cardById(draft.leaderId);
    const sum = DECK.summarize(draft.counts, CARDS);
    $('deckCount').textContent = sum.total + '/60';
    $('deckTypes').textContent = 'M ' + sum.types.Martial + ' · E ' + sum.types.Economic + ' · R ' + sum.types.Rite;
    $('deckSets').textContent = 'Col ' + sum.sets.Colovian + ' · Anu ' + sum.sets.Anu + (sum.mixed ? ' · mixed' : '');
    renderCurve(sum);
    const errs = DECK.validate({ leaderId: draft.leaderId, counts: draft.counts }, CARDS);
    $('builderErr').textContent = (sum.total === 60 && !errs.length) ? '' : errs.join(' ');

    const facWant = draft.facFilt === 'Leader' ? (L ? L.set : 'Colovian') : draft.facFilt;
    const q = (draft.q || '').trim().toLowerCase();
    let list = DECK.playable(CARDS).filter((c) => {
      if (facWant && facWant !== 'All' && c.set !== facWant) return false;
      if (draft.typeFilt && c.type !== draft.typeFilt) return false;
      if (draft.costFilt !== '' && draft.costFilt != null) {
        const d = c.deploy || 0;
        if (draft.costFilt === '5') { if (d < 5) return false; }
        else if (d !== +draft.costFilt) return false;
      }
      if (q && !(c.name || '').toLowerCase().includes(q) && !(c.id || '').toLowerCase().includes(q)) return false;
      return true;
    });
    list.sort((a, b) => {
      const ca = draft.counts[a.id] || 0, cb = draft.counts[b.id] || 0;
      if (cb !== ca) return cb - ca;
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      if ((a.deploy || 0) !== (b.deploy || 0)) return (a.deploy || 0) - (b.deploy || 0);
      return a.name.localeCompare(b.name);
    });
    $('dlist').innerHTML = list.map((c) => {
      const n = draft.counts[c.id] || 0;
      const typ = c.type === 'Martial' ? 'Martialus' : c.type;
      const meta = typ + ' · ' + c.set + ' · Deploy ' + (c.deploy ?? 0) + (c.might != null ? ' · Might ' + c.might : '') + (c.wage || c.wage === 0 ? ' · Wage ' + c.wage : '');
      return '<div class="drow' + (n ? ' in' : '') + '">' +
        '<button type="button" class="dinfo ' + (c.set === 'Anu' ? 'anu' : 'col') + '" data-cid="' + c.id + '"><span class="dn">' + escapeHtml(shortName(c.name)) + '</span><span class="dm">' + escapeHtml(meta) + '</span></button>' +
        '<button type="button" class="pm" data-sub="' + c.id + '" ' + (n ? '' : 'disabled') + '>−</button>' +
        '<span class="dcount">' + n + '</span>' +
        '<button type="button" class="pm" data-add="' + c.id + '" ' + (n >= DECK.maxCopies(c) || sum.total >= 60 ? 'disabled' : '') + '>+</button>' +
        '</div>';
    }).join('') || '<p class="sub pad">No cards match those filters.</p>';

    document.querySelectorAll('#facFilt .btn').forEach((b) => b.classList.toggle('picked', b.getAttribute('data-fac') === draft.facFilt));
    document.querySelectorAll('#typeFilt .btn').forEach((b) => b.classList.toggle('picked', (b.getAttribute('data-type') || '') === (draft.typeFilt || '')));
    document.querySelectorAll('#costFilt .btn').forEach((b) => b.classList.toggle('picked', (b.getAttribute('data-cost') || '') === String(draft.costFilt || '')));
    renderSaved();
  }

  function renderSaved() {
    const list = DECK.loadSaved();
    $('savedList').innerHTML = list.length ? list.map((d) => {
      const ok = !DECK.validate(d, CARDS).length;
      return '<div class="savedrow"><div class="sn">' + escapeHtml(deckLabel(d)) + (ok ? '' : ' · illegal') + '</div>' +
        '<div class="row"><button class="btn small" type="button" data-sedit="' + d.id + '">Edit</button>' +
        '<button class="btn small" type="button" data-sdup="' + d.id + '">Duplicate</button>' +
        '<button class="btn small danger" type="button" data-sdel="' + d.id + '">Delete</button></div></div>';
    }).join('') : '<p class="sub">No saved decks yet.</p>';
  }

  $('deckName').addEventListener('input', () => { draft.name = $('deckName').value; });
  $('builderLeader').addEventListener('change', () => { draft.leaderId = $('builderLeader').value; renderBuilder(); });
  $('cardSearch').addEventListener('input', () => { draft.q = $('cardSearch').value; renderBuilder(); });
  $('facFilt').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fac]'); if (!b) return;
    draft.facFilt = b.getAttribute('data-fac'); renderBuilder();
  });
  $('typeFilt').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]'); if (!b) return;
    draft.typeFilt = b.getAttribute('data-type') || ''; renderBuilder();
  });
  $('costFilt').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cost]'); if (!b) return;
    draft.costFilt = b.getAttribute('data-cost') || ''; renderBuilder();
  });

  $('btnAuto').addEventListener('click', () => {
    const filled = DECK.autoFill({ leaderId: draft.leaderId, counts: draft.counts, name: draft.name }, CARDS, makeRng(Date.now() >>> 0));
    draft.counts = filled.counts;
    renderBuilder();
  });
  $('btnSaveDeck').addEventListener('click', () => {
    draft.name = $('deckName').value;
    const row = DECK.saveDeck({ id: draft.id, name: draft.name, leaderId: draft.leaderId, counts: draft.counts });
    draft.id = row.id;
    if (!$('deckName').value) $('deckName').value = row.name;
    renderSaved();
    fillDeckSelects(true);
    $('builderErr').textContent = 'Saved as “' + row.name + '”.' + (DECK.validate(row, CARDS).length ? ' (Not legal to play yet: ' + DECK.validate(row, CARDS).join(' ') + ')' : '');
  });

  function openCodeModal(mode) {
    const sheet = $('codeSheet');
    if (mode === 'export') {
      const code = DECK.exportCode({ leaderId: draft.leaderId, counts: draft.counts, name: draft.name });
      sheet.innerHTML = '<h2>Export deck</h2><p class="sub">Copy this code and paste it to share the deck.</p><textarea class="code" id="codeBox" readonly>' + escapeHtml(code) + '</textarea>' +
        '<button class="btn primary wide" type="button" id="codeCopy">Copy</button>' +
        '<button class="btn wide" type="button" id="codeClose">Close</button>';
      $('codeModal').classList.add('on');
      $('codeCopy').onclick = () => {
        const box = $('codeBox'); box.select();
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.value).catch(() => document.execCommand('copy'));
        else document.execCommand('copy');
        $('codeCopy').textContent = 'Copied';
      };
    } else {
      sheet.innerHTML = '<h2>Import deck</h2><p class="sub">Paste a RUIN1 code.</p><textarea class="code" id="codeBox" placeholder="RUIN1:COL-LED-003:COL-MAR-001*3,..."></textarea>' +
        '<p id="codeErr" class="sub" style="color:#e08880"></p>' +
        '<button class="btn primary wide" type="button" id="codeDo">Import</button>' +
        '<button class="btn wide" type="button" id="codeClose">Close</button>';
      $('codeModal').classList.add('on');
      $('codeDo').onclick = () => {
        try {
          const spec = DECK.importCode($('codeBox').value, CARDS);
          draft.counts = spec.counts;
          draft.leaderId = spec.leaderId;
          draft.id = null;
          if (spec.name) { draft.name = spec.name; $('deckName').value = spec.name; }
          $('builderLeader').value = draft.leaderId;
          $('codeModal').classList.remove('on');
          renderBuilder();
        } catch (err) { $('codeErr').textContent = err.message || String(err); }
      };
    }
    $('codeClose').onclick = () => $('codeModal').classList.remove('on');
  }
  $('btnExport').addEventListener('click', () => openCodeModal('export'));
  $('btnImport').addEventListener('click', () => openCodeModal('import'));

  try {
    fillLeaders();
    fillDeckSelects(false);
    DECK.loadStarters().then((list) => { starters = list || []; fillDeckSelects(true); }).catch(function (err) {
      if ($('setupErr')) $('setupErr').textContent = 'Could not load starter decks: ' + (err && err.message ? err.message : err);
    });
  } catch (err) {
    var el = document.getElementById('setupErr');
    if (el) el.textContent = 'Could not start the page: ' + (err && err.message ? err.message : err);
    console.error(err);
  }
})();
