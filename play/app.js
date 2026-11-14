/* RUIN play UI — Ian vs the sim AI, variant (t). */
(function () {
  const { Game, GameOver, buildDeck, makeRng, fxOf, AI, GAME_OPTS } = window.RUIN_PLAY;
  const CARDS = window.RUIN_PLAY_CARDS;
  const RULES_MD = window.RUIN_PLAY_RULES;
  const TIPS = window.RUIN_PLAY_TOOLTIPS || {};

  const $ = (id) => document.getElementById(id);
  const shortName = (n) => (n || '').split(',')[0];
  const artUrl = (card) => (!card || !card.id || card.id === 'TOKEN') ? '' : ('thumbs/' + card.id + '.jpg');

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

  let faction = 'Colovian';
  let st = { game: null, me: null, ai: null, busy: false };

  function leadersFor(fac) {
    return CARDS.filter((c) => c.type === 'Leader' && c.set === fac);
  }
  function fillLeaders() {
    const sel = $('leaderSel');
    const list = leadersFor(faction);
    sel.innerHTML = '<option value="">Random</option>' + list.map((c) =>
      '<option value="' + c.id + '">' + escapeHtml(shortName(c.name)) + '</option>').join('');
  }

  document.getElementById('factionRow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fac]'); if (!b) return;
    faction = b.getAttribute('data-fac');
    document.querySelectorAll('#factionRow .btn').forEach((x) => x.classList.toggle('picked', x === b));
    fillLeaders();
  });
  $('btnStart').addEventListener('click', () => startGame());
  $('btnRulesSetup').addEventListener('click', openRules);
  $('btnRules').addEventListener('click', openRules);
  $('btnNew').addEventListener('click', () => { $('endModal').classList.remove('on'); showSetup(); });

  function showSetup() {
    $('game').classList.remove('on'); $('setup').classList.add('on');
  }
  function showGame() {
    $('setup').classList.remove('on'); $('game').classList.add('on');
  }

  function openRules() {
    $('rulesSheet').innerHTML = mdToHtml(RULES_MD) +
      '<button class="btn primary wide" type="button" id="rulesClose">Close</button>';
    $('rulesModal').classList.add('on');
    $('rulesClose').onclick = () => $('rulesModal').classList.remove('on');
  }
  $('rulesModal').addEventListener('click', (e) => { if (e.target === $('rulesModal')) $('rulesModal').classList.remove('on'); });
  $('cardModal').addEventListener('click', (e) => { if (e.target === $('cardModal')) $('cardModal').classList.remove('on'); });

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
      (art ? '<img class="art" alt="" src="' + art + '" onerror="this.style.display=\'none\'">' : '') +
      '<h2>' + escapeHtml(card.name) + '</h2>' +
      '<div class="sub" style="margin-top:0">' + escapeHtml(typ + (stats ? ' · ' + stats : '')) + '</div>' +
      '<div class="txt">' + linkKeywords(card.text || '') + '</div>' +
      (card.flavor ? '<p class="sub">' + escapeHtml(card.flavor) + '</p>' : '') +
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
        const blocks = new Map();
        let chosenBlocker = null;
        st.pickSet = { type: 'block', attackers, blocks, get chosenBlocker() { return chosenBlocker; }, set chosenBlocker(v) { chosenBlocker = v; } };
        prompt('Assign blockers like Magic: tap one of your Souls, then the attacker it blocks. Several can gang up on one attacker. Tap a blocker again to unassign it.', [
          { label: 'Confirm blocks', primary: true, fn: () => { st.pickSet = null; resolve(blocks); } }
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
          const snippet = (a.perm.card && a.perm.card.text) ? a.perm.card.text.replace(/Enter by end of turn 1\.\s*/i, '') : 'Use ability';
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

  function startGame() {
    const rng = makeRng((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
    const myFac = faction;
    const aiFac = myFac === 'Colovian' ? 'Anu' : 'Colovian';
    const lid = $('leaderSel').value || undefined;
    const mine = buildDeck(CARDS, myFac, rng, lid);
    const theirs = buildDeck(CARDS, aiFac, rng);
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
    g.log((cur.isHuman ? 'You' : 'The AI') + ' go first.');
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

  function pills(p) {
    const G = st.game;
    const bill = G.wageBill(p);
    const inc = G.projIncome(p);
    const coh = p.high ? 'High Cohesion' : 'Low Cohesion';
    return '<span class="pill">Life ' + p.life + '</span>' +
      '<span class="pill">Specie ' + p.specie + '</span>' +
      '<span class="pill ' + (p.high ? 'hi' : 'lo') + '">' + coh + '</span>' +
      '<span class="pill">Wages ' + bill + '</span>' +
      '<span class="pill">Income ' + inc + '</span>' +
      (p.turnCount ? '<span class="pill">Turn ' + p.turnCount + '</span>' : '');
  }

  function chip(s, cls) {
    const G = st.game;
    const m = G.might(s);
    const w = G.wageOf(s);
    const aged = s.age ? ' Aged ' + s.age : '';
    const dmg = s.dmg ? ' dmg ' + s.dmg : '';
    const tok = s.token ? ' token' : '';
    return '<button type="button" class="chip ' + (cls || '') + (s.tapped ? ' tapped' : '') + '" data-uid="' + s.uid + '">' +
      '<span class="t">' + escapeHtml(shortName(s.name)) + '</span>' +
      '<span class="m">Might ' + m + (w ? ' · Wage ' + w : '') + aged + dmg + tok + '</span></button>';
  }

  function lane(p, prefix) {
    const econs = (p.econsL || []).map((e) =>
      '<button type="button" class="chip" data-card="' + escapeAttr(e.card.id) + '"><span class="t">' + escapeHtml(shortName(e.name)) + '</span><span class="m">Econ</span></button>').join('');
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
      return chip(s, cls);
    }).join('');
    const el = prefix === 'ai' ? $('aiBoard') : $('myBoard');
    el.innerHTML = '<div class="lane">' + econs + souls + (econs || souls ? '' : '<span class="sub">Empty board</span>') + '</div>';
  }

  function renderHand() {
    const p = st.me, G = st.game;
    if (!p) return;
    $('hand').innerHTML = p.hand.map((c, i) => {
      const cost = costOf(p, c);
      const can = st.handMode && st.handMode.type === 'play' && canPlay(p, c);
      const stats = c.type === 'Rite' ? ('Rite · ' + cost) : (c.type === 'Economic' ? ('Econ · ' + cost + (c.wage ? ' W' + c.wage : '')) : (cost + ' · M' + (c.might || 0) + ' W' + (c.wage || 0)));
      return '<button type="button" class="card' + (can ? ' can' : '') + '" data-hand="' + i + '"><div class="cn">' + escapeHtml(shortName(c.name)) + '</div><div class="cm">' + escapeHtml(stats) + '</div></button>';
    }).join('') || '<span class="sub">No cards in hand</span>';
  }

  function render() {
    const g = st.game; if (!g) return;
    const me = st.me, ai = st.ai;
    $('aiName').textContent = 'AI · ' + ai.faction;
    $('aiName').className = 'name ' + (ai.faction === 'Anu' ? 'anu' : 'col');
    $('meName').textContent = 'You · ' + me.faction;
    $('meName').className = 'name ' + (me.faction === 'Anu' ? 'anu' : 'col');
    $('aiLeader').textContent = ai.leaderCard ? shortName(ai.leaderCard.name) : '';
    $('meLeader').textContent = me.leaderCard ? shortName(me.leaderCard.name) : '';
    $('aiPills').innerHTML = pills(ai);
    $('mePills').innerHTML = pills(me);
    lane(ai, 'ai');
    lane(me, 'my');
    renderHand();
    const notes = (g.notes || []).slice(-8);
    $('log').innerHTML = notes.map(escapeHtml).join('<br>');
    $('log').scrollTop = $('log').scrollHeight;
  }

  function soulByUid(uid) {
    uid = +uid;
    for (const p of st.game.players) {
      const s = p.souls.find((x) => x.uid === uid);
      if (s) return s;
    }
    return null;
  }

  document.addEventListener('click', (e) => {
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
    const chip = e.target.closest('.chip[data-uid], .chip[data-card]');
    if (chip) {
      const ps = st.pickSet;
      if (chip.getAttribute('data-card') && !chip.getAttribute('data-uid')) {
        const c = CARDS.find((x) => x.id === chip.getAttribute('data-card'));
        openCard(c); return;
      }
      const s = soulByUid(chip.getAttribute('data-uid'));
      if (!s) return;
      if (ps && ps.type === 'attack' && ps.elig.includes(s)) {
        if (ps.picked.has(s)) ps.picked.delete(s); else ps.picked.add(s);
        render(); return;
      }
      if (ps && ps.type === 'block') {
        if (s.owner === st.me) {
          // unassign if already blocking
          for (const [a, arr] of ps.blocks) {
            const i = arr.indexOf(s);
            if (i >= 0) { arr.splice(i, 1); if (!arr.length) ps.blocks.delete(a); ps.chosenBlocker = null; render(); return; }
          }
          if (!AI.canBlock || true) {
            // can they block? checked when assigning to an attacker
            ps.chosenBlocker = s; render(); return;
          }
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
      if (ps && ps.type === 'ageTarget' && ps.cands.includes(s)) {
        const res = ps.resolve; st.pickSet = null; res(s); return;
      }
      if (ps && ps.type === 'missAge' && ps.cands.includes(s)) {
        const res = ps.resolve; st.pickSet = null; res(s); return;
      }
      openCard(s.card); return;
    }
    if (e.target.closest('#aiLeader')) openCard(st.ai && st.ai.leaderCard);
    if (e.target.closest('#meLeader')) openCard(st.me && st.me.leaderCard);
  });

  $('endModal').addEventListener('click', (e) => { if (e.target === $('endModal')) $('endModal').classList.remove('on'); });

  fillLeaders();
})();
