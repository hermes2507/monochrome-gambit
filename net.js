'use strict';
/* =====================================================================
   Online play: peer-to-peer over WebRTC (PeerJS), one player hosts.

   - The HOST's browser runs the real game engine (game.js) and is the only
     place the full state exists. After every render it sends the guest a
     filtered view (viewFor) containing only what the guest may see.
   - The GUEST's browser only renders that view and sends intentions back:
     move, play card, answer a prompt. The host validates everything.
   - Matchmaking uses the free PeerJS cloud server; a room "code" is simply
     part of the host's peer id. Game data then flows browser-to-browser.
   ===================================================================== */

const PROTO = 1;
const PEER_PREFIX = 'monochrome-gambit-v1-';
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const CODE_LEN = 5;
const PEER_OPTS = { debug: 1 };
const LOG_CLS = new Set(['', 'good', 'bad', 'hot', 'warn', 'cool', 'dim']);
const FX_CLS = new Set(['', 'good', 'bad', 'warn', 'cool', 'gold', 'purple']);
const BTN_CLS = new Set(['', 'grey', 'blue', 'green', 'gold', 'purple']);
const PHASES = new Set(['start', 'move', 'resolving', 'skip', 'over']);

const NET = {
  role: null,         // null | 'host' | 'guest'
  peer: null, conn: null, code: null,
  session: 0,         // bumps on every leave, to ignore stale callbacks
  myName: '', started: false, joined: false,
  syncQueued: false, anim: null,
  askId: 0, asks: new Map(), pendingAsk: null,
  resolveRemoteMove: null, cardBusy: false, timer: null,

  connected() { return !!(this.conn && this.conn.open); },
  send(msg) { if (this.connected()) { try { this.conn.send(msg); } catch (e) { console.warn(e); } } },
  // Host: send an effect right away, after flushing any pending state so they arrive in order.
  sendNow(msg) { if (this.role !== 'host') return; this.flush(); this.send(msg); },
  queueSync() {
    if (S.anim) this.anim = { ...S.anim };
    if (this.syncQueued) return;
    this.syncQueued = true;
    queueMicrotask(() => this.flush());
  },
  flush(force = false) {
    if (!this.syncQueued && !force) return;
    this.syncQueued = false;
    if (this.role === 'host' && S && S.mode === 'online') this.send({ t: 'state', s: viewFor(1) });
    this.anim = null;
  },
  ask(html, buttons) {
    const id = ++this.askId;
    this.flush();
    this.pendingAsk = { t: 'ask', id, html, buttons };
    this.send(this.pendingAsk);
    return new Promise(res => this.asks.set(id, res));
  },
  resetGame() {
    this.resolveRemoteMove = null; this.pendingAsk = null; this.asks.clear(); this.cardBusy = false;
  },
  leave() {
    this.session++;
    clearTimeout(this.timer);
    if (this.connected()) { try { this.conn.send({ t: 'bye' }); } catch (e) { /* ignore */ } }
    const peer = this.peer;
    setTimeout(() => { try { peer && peer.destroy(); } catch (e) { /* ignore */ } }, 150);
    Object.assign(this, { role: null, peer: null, conn: null, code: null, started: false, joined: false, syncQueued: false, anim: null });
    this.resetGame();
  },
};

/* ------------------------------ Helpers -------------------------------- */
const cleanName = s => String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 16);
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
function genCode() {
  const a = new Uint32Array(CODE_LEN);
  crypto.getRandomValues(a);
  return [...a].map(x => CODE_ALPHA[x % CODE_ALPHA.length]).join('');
}
const inviteLink = code => location.href.split('#')[0] + '#join=' + code;
function loadName() { try { return cleanName(localStorage.getItem('mg-name')); } catch (e) { return ''; } }
function saveName(n) { try { localStorage.setItem('mg-name', n); } catch (e) { /* ignore */ } }

// Allow only a few harmless tags (no attributes but class) in HTML that came from the other browser.
const SAFE_TAGS = new Set(['B', 'I', 'EM', 'STRONG', 'SPAN', 'DIV', 'P', 'BR', 'H2', 'H4', 'UL', 'LI']);
function cleanHTML(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html ?? '');
  const walk = node => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 1) {
        if (!SAFE_TAGS.has(ch.tagName)) { ch.replaceWith(document.createTextNode(ch.textContent)); continue; }
        for (const a of [...ch.attributes]) if (a.name !== 'class') ch.removeAttribute(a.name);
        walk(ch);
      } else if (ch.nodeType !== 3) ch.remove();
    }
  };
  walk(t.content);
  return t.innerHTML;
}

/* ------------------------- Host: filtered view -------------------------- */
// Everything player v is allowed to know — and nothing more.
function viewFor(v) {
  const hide = pc => ({
    id: pc.id, type: pc.type, glaze: pc.glaze, dir: pc.dir, revealed: pc.revealed,
    owner: (pc.revealed || S.showAll) ? pc.owner : null,
    belief: v === 0 ? [pc.belief[0], null] : [null, pc.belief[1]],
  });
  return {
    gid: S.gid, variant: S.variant, back: S.back, names: S.names,
    board: S.board.map(row => row.map(pc => pc ? hide(pc) : null)),
    captured: S.captured.map(hide),
    deckN: S.deck.length, discard: S.discard,
    hands: [0, 1].map(p => p === v ? S.hands[p] : S.hands[p].map(c => ({ key: null, uid: c.uid }))),
    skips: S.skips, frost: S.frost, turn: S.turn, turnCount: S.turnCount,
    log: S.log.slice(0, 60), lastMove: S.lastMove,
    usedAction: S.usedAction, alibi: S.alibi, extraMove: S.extraMove,
    phase: S.phase, winner: S.winner, showAll: S.showAll, awaiting: S.awaiting,
    pmView: pMine(v), anim: NET.anim,
    flash: [...S.flash].filter(([, w]) => w === 'all' || w === v).map(([id]) => id),
  };
}

/* ------------------------------- Hosting -------------------------------- */
function openPeer(id) {
  return new Promise((res, rej) => {
    const peer = id ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
    const onErr = err => { peer.off('open', onOpen); try { peer.destroy(); } catch (e) { /* ignore */ } rej(err); };
    const onOpen = () => { peer.off('error', onErr); res(peer); };
    peer.once('open', onOpen);
    peer.once('error', onErr);
  });
}

async function hostFlow() {
  if (!window.Peer) return netError('Online play needs the PeerJS library, which failed to load. Check your internet connection and reload.');
  NET.leave();
  NET.role = 'host';
  const session = NET.session;
  modal('<h2>Creating a room…</h2><p>Contacting the matchmaking server.</p>', [{ label: 'Cancel', value: 'cancel', cls: 'grey' }])
    .then(v => { if (v === 'cancel') { NET.leave(); startScreen(); } });

  let peer = null, code = null;
  for (let i = 0; i < 4 && !peer; i++) {
    code = genCode();
    try { peer = await openPeer(PEER_PREFIX + code); } catch (err) {
      if (session !== NET.session) return;
      if (err.type !== 'unavailable-id') return netError(`Could not create a room (${err.type || err.message}).`);
    }
  }
  if (session !== NET.session) { if (peer) peer.destroy(); return; }
  if (!peer) return netError('Could not create a room. Please try again.');

  NET.peer = peer; NET.code = code;
  peer.on('connection', conn => hostOnConnection(conn));
  peer.on('disconnected', () => { if (NET.peer === peer && !peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (e) { /* ignore */ } }, 1500); });
  peer.on('error', err => console.warn('peer error', err.type));

  const link = inviteLink(code);
  modal(`<h2>Your game code</h2>
    <div class="code-big">${code}</div>
    <p>Ask your friend to choose <b>Join with code</b> and type it in, or send them this link:</p>
    <div class="link-row"><input readonly id="invLink" value="${esc(link)}"><button class="btn small" id="copyLink">Copy link</button></div>
    <p class="note" id="hostStatus"><span class="dots">Waiting for your friend to join</span></p>`,
  [{ label: 'Cancel', value: 'cancel', cls: 'grey' }])
    .then(v => { if (v === 'cancel') { NET.leave(); startScreen(); } });
  $('#copyLink').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Invite link copied!'); }
    catch (e) { $('#invLink').select(); toast('Press Ctrl/Cmd+C to copy'); }
  };
}

function hostOnConnection(conn) {
  conn.on('data', d => { try { hostOnData(conn, d); } catch (e) { console.error(e); } });
  conn.on('close', () => {
    if (NET.conn !== conn) return;
    NET.conn = null;
    if (S && S.mode === 'online') { toast(`${nm(1)} disconnected — they can rejoin with code ${NET.code}`); render(); }
  });
  conn.on('error', err => console.warn('conn error', err));
}

function hostOnData(conn, d) {
  if (!d || typeof d !== 'object') return;
  const reject = msg => conn.send({ t: 'reject', msg });

  if (d.t === 'hello') {
    if (d.v !== PROTO) { conn.send({ t: 'error', msg: 'Version mismatch — both players should reload the page.' }); return; }
    // The seat belongs to whoever holds the code; a newer connection replaces an older one (rejoin).
    if (NET.conn && NET.conn !== conn) { try { NET.conn.close(); } catch (e) { /* ignore */ } }
    NET.conn = conn;
    conn.send({ t: 'welcome', code: NET.code });
    if (!NET.started) {
      NET.started = true;
      const guest = cleanName(d.name) || PL[1].name;
      toast(`${guest} joined!`);
      newGame('online', prefVariant, [NET.myName || PL[0].name, guest]);
    } else {
      toast(`${nm(1)} is back!`);
      NET.flush(true);
      if (NET.pendingAsk) conn.send(NET.pendingAsk);
      render();
    }
    return;
  }
  if (conn !== NET.conn || !S || S.mode !== 'online') return;

  switch (d.t) {
    case 'move': {
      if (S.awaiting !== 1 || !NET.resolveRemoteMove || NET.cardBusy) return reject('It isn’t your move right now.');
      const m = d.m || {};
      const ok = allLegalMoves(1).some(x => x.fr === m.fr && x.fc === m.fc && x.tr === m.tr && x.tc === m.tc);
      if (!ok) return reject('That move isn’t allowed.');
      NET.resolveRemoteMove({ fr: m.fr, fc: m.fc, tr: m.tr, tc: m.tc });
      return;
    }
    case 'pass': {
      if (S.awaiting !== 1 || !NET.resolveRemoteMove || NET.cardBusy) return reject('It isn’t your move right now.');
      if (allLegalMoves(1).length) return reject('You still have legal moves.');
      NET.resolveRemoteMove(null);
      return;
    }
    case 'card': hostHandleCard(d, reject).catch(swallowAbort); return;
    case 'answer': {
      const pa = NET.pendingAsk;
      if (!pa || pa.id !== d.id || !pa.buttons.some(b => b.value === d.value)) return;
      const res = NET.asks.get(d.id);
      NET.asks.delete(d.id); NET.pendingAsk = null;
      if (res) res(d.value);
      return;
    }
    case 'bye': toast(`${nm(1)} left the game.`); return;
  }
}

async function hostHandleCard(d, reject) {
  if (S.awaiting !== 1 || !NET.resolveRemoteMove || NET.cardBusy || S.usedAction) return reject('You can’t play a card right now.');
  const card = S.hands[1].find(c => c.uid === d.uid);
  if (!card || CARDS[card.key].kind !== 'action') return reject('That card isn’t available.');
  const opts = {};
  if (card.key === 'spyglass' || card.key === 'brush') {
    const t = onBoard().find(pc => pc.id === d.target);
    if (!t) return reject('Pick a piece on the board.');
    if (card.key === 'spyglass' && t.revealed) return reject('That piece’s owner is already known.');
    if (card.key === 'brush') {
      if (t.type === 'K') return reject('Kings can’t be repainted.');
      if (!GLAZES.includes(d.colour)) return reject('Unknown colour.');
      opts.colour = d.colour;
    }
    opts.target = t;
  }
  const gid = S.gid;
  NET.cardBusy = true;
  S.awaiting = null;
  try { await playCard(1, card.uid, opts); }
  finally { NET.cardBusy = false; }
  if (S.gid === gid && NET.resolveRemoteMove && S.phase === 'move') { S.awaiting = 1; render(); }
}

/* -------------------------------- Joining ------------------------------- */
async function joinFlow(prefill = '') {
  let code = normCode(prefill), name = NET.myName || loadName();
  const pending = modal(`<h2>Join a game</h2>
    <p>Type the code shown on your friend’s screen.</p>
    <input id="joinCode" class="code-input" maxlength="${CODE_LEN}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE" value="${esc(code)}">
    <label class="field">Your name <input id="joinName" maxlength="16" placeholder="Luna" value="${esc(name)}"></label>`,
  [{ label: 'Back', value: 'back', cls: 'grey' }, { label: 'Join', value: 'join', cls: 'green' }]);
  const ci = $('#joinCode'), niEl = $('#joinName');
  ci.oninput = () => { ci.value = normCode(ci.value); code = ci.value; };
  niEl.oninput = () => { name = cleanName(niEl.value); };
  const joinBtn = [...document.querySelectorAll('#overlay .m-btns .btn')].pop();
  ci.onkeydown = niEl.onkeydown = e => { if (e.key === 'Enter') joinBtn.click(); };
  setTimeout(() => (code ? niEl : ci).focus(), 50);
  const v = await pending;
  if (v !== 'join') return startScreen();
  if (code.length !== CODE_LEN) { toast(`Codes have ${CODE_LEN} characters.`); return joinFlow(code); }
  NET.myName = name; saveName(name);
  connectAsGuest(code);
}

function connectAsGuest(code) {
  if (!window.Peer) return netError('Online play needs the PeerJS library, which failed to load. Check your internet connection and reload.');
  NET.leave();
  NET.role = 'guest'; NET.code = code;
  const session = NET.session;
  modal(`<h2>Connecting…</h2><p>Looking for game <b>${code}</b>.</p>`, [{ label: 'Cancel', value: 'cancel', cls: 'grey' }])
    .then(v => { if (v === 'cancel') { NET.leave(); startScreen(); } });
  const fail = msg => { if (session !== NET.session) return; NET.leave(); netError(msg, code); };
  NET.timer = setTimeout(() => { if (!NET.joined) fail('Could not reach that game. Check the code and make sure your friend is still on the hosting screen.'); }, 20000);

  openPeer(null).then(peer => {
    if (session !== NET.session) { peer.destroy(); return; }
    NET.peer = peer;
    peer.on('error', err => {
      if (err.type === 'peer-unavailable') fail(`No game found with code ${code}.`);
      else if (!NET.joined) fail(`Connection failed (${err.type || err.message}).`);
      else console.warn('peer error', err.type);
    });
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
    NET.conn = conn;
    conn.on('open', () => conn.send({ t: 'hello', v: PROTO, name: NET.myName }));
    conn.on('data', d => { if (session === NET.session) { try { guestOnData(d); } catch (e) { console.error(e); } } });
    conn.on('close', () => { if (session === NET.session && NET.conn === conn) guestLost(); });
  }).catch(err => fail(`Could not reach the matchmaking server (${err.type || err.message}).`));
}

function guestOnData(d) {
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    case 'welcome':
      if (!NET.joined) { NET.joined = true; clearTimeout(NET.timer); closeModal(); }
      return;
    case 'state': {
      if (!NET.joined) { NET.joined = true; clearTimeout(NET.timer); closeModal(); }
      applyView(d.s);
      return;
    }
    case 'fx': return guestFx(d);
    case 'ask': return guestAsk(d);
    case 'reject':
      ui.sentMove = false;
      toast(String(d.msg || 'Not allowed.').slice(0, 140));
      render();
      return;
    case 'error': {
      const msg = String(d.msg || 'The host refused the connection.').slice(0, 200);
      const code = NET.code; NET.leave(); netError(msg, code);
      return;
    }
    case 'bye': {
      NET.leave();
      modal('<h2>The host left</h2><p>The online game has ended.</p>', [{ label: 'Menu', value: 'menu', cls: 'green' }]).then(startScreen);
      return;
    }
  }
}

function applyView(raw) {
  const v = cleanView(raw);
  if (!v) return;
  if (!S || !S.isView || S.gid !== v.gid) {
    TOKEN++;
    ui.sel = null; ui.targets = []; ui.targeting = null; ui.busy = false; ui.sentMove = false;
    closeModal();
  }
  if (v.awaiting !== v.viewer) { ui.sentMove = false; ui.sel = null; ui.targets = []; }
  v.gen = TOKEN;
  S = v;
  render();
}

function guestFx(d) {
  const a = Array.isArray(d.a) ? d.a : [];
  if (d.k === 'banner') banner(cleanHTML(a[0]), cleanHTML(a[1]), FX_CLS.has(a[2]) ? a[2] : '');
  else if (d.k === 'card' && (a[0] === 0 || a[0] === 1) && CARDS[a[1]]) showCard(a[0], a[1]);
  else if (d.k === 'gameover') modal(cleanHTML(a[0]), [{ label: 'Close', value: 'ok', cls: 'green' }]);
}

function guestAsk(d) {
  const buttons = (Array.isArray(d.buttons) ? d.buttons : []).slice(0, 4).map(b => ({
    label: String(b && b.label || '?').slice(0, 40),
    value: ['boolean', 'string', 'number'].includes(typeof (b && b.value)) ? b.value : null,
    cls: BTN_CLS.has(b && b.cls) ? b.cls : '',
  }));
  if (!buttons.length) return;
  modal(cleanHTML(d.html), buttons).then(value => NET.send({ t: 'answer', id: d.id, value }));
}

function guestLost() {
  const code = NET.code;
  const over = S && S.phase === 'over';
  NET.leave();
  if (over) { toast('Disconnected from the host.'); return; }
  modal(`<h2>Connection lost</h2><p>The link to the host dropped. If they still have the game open, you can rejoin with code <b>${esc(code)}</b>.</p>`,
    [{ label: 'Menu', value: 'menu', cls: 'grey' }, { label: 'Reconnect', value: 'retry', cls: 'green' }])
    .then(v => v === 'retry' ? connectAsGuest(code) : startScreen());
}

// Rebuild the received view field by field, so a misbehaving host can only send plain data.
function cleanView(s) {
  if (!s || typeof s !== 'object') return null;
  const P = x => (x === 0 || x === 1) ? x : null;
  const int = (x, d = 0) => (typeof x === 'number' && Number.isFinite(x)) ? Math.trunc(x) : d;
  const sq = x => { const n = int(x, -1); return n >= 0 && n < 8 ? n : null; };
  const piece = p => (!p || typeof p !== 'object') ? null : {
    id: int(p.id), type: TYPES[p.type] ? p.type : 'P',
    glaze: (p.glaze === 'red' || p.glaze === 'white') ? p.glaze : null,
    dir: p.dir > 0 ? 1 : p.dir < 0 ? -1 : 0, revealed: !!p.revealed, owner: P(p.owner),
    belief: [P(p.belief && p.belief[0]), P(p.belief && p.belief[1])],
  };
  const move = m => {
    if (!m || typeof m !== 'object') return null;
    const o = { fr: sq(m.fr), fc: sq(m.fc), tr: sq(m.tr), tc: sq(m.tc), id: int(m.id) };
    return [o.fr, o.fc, o.tr, o.tc].includes(null) ? null : o;
  };
  const card = c => ({ key: (c && CARDS[c.key]) ? c.key : null, uid: int(c && c.uid) });
  const arr = (x, n) => Array.isArray(x) ? x.slice(0, n) : [];
  const pm = typeof s.pmView === 'number' && s.pmView >= 0 && s.pmView <= 1 ? s.pmView : 0.5;
  return {
    isView: true, mode: 'online', viewer: 1, uid: 0,
    gid: String(s.gid || '').slice(0, 24),
    variant: s.variant === '960' ? '960' : 'standard',
    back: /^[KQRBN]{8}$/.test(s.back) ? s.back : STANDARD_BACK,
    names: [0, 1].map(p => cleanName(s.names && s.names[p]) || PL[p].name),
    board: Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => piece(s.board && s.board[r] && s.board[r][c]))),
    captured: arr(s.captured, 40).map(piece).filter(Boolean),
    deck: Array(Math.min(100, Math.max(0, int(s.deckN)))).fill(null),
    discard: arr(s.discard, 100).filter(k => CARDS[k]),
    hands: [0, 1].map(p => arr(s.hands && s.hands[p], 12).map(card)),
    skips: [Math.max(0, int(s.skips && s.skips[0])), Math.max(0, int(s.skips && s.skips[1]))],
    frost: { red: int(s.frost && s.frost.red), white: int(s.frost && s.frost.white) },
    turn: P(s.turn) ?? 0, turnCount: Math.max(1, int(s.turnCount, 1)),
    log: arr(s.log, 120).map(l => ({ text: cleanHTML(l && l.text), cls: LOG_CLS.has(l && l.cls) ? l.cls : '' })),
    lastMove: move(s.lastMove), anim: move(s.anim),
    usedAction: !!s.usedAction, alibi: !!s.alibi, extraMove: !!s.extraMove,
    phase: PHASES.has(s.phase) ? s.phase : 'resolving',
    winner: s.winner && P(s.winner.p) !== null ? { p: s.winner.p, kingOwner: P(s.winner.kingOwner) ?? 1 - s.winner.p } : null,
    showAll: !!s.showAll, awaiting: P(s.awaiting), pmView: pm,
    flash: new Map(arr(s.flash, 40).map(id => [int(id), 'all'])),
  };
}

/* ------------------------------ Menus ---------------------------------- */
function netError(msg, retryCode = null) {
  const btns = [{ label: 'Menu', value: 'menu', cls: 'grey' }];
  if (retryCode) btns.push({ label: 'Try again', value: 'retry', cls: 'green' });
  modal(`<h2>Couldn’t connect</h2><p>${esc(msg)}</p>`, btns)
    .then(v => v === 'retry' ? connectAsGuest(retryCode) : startScreen());
}

async function startScreen() {
  const t = TOKEN;
  if (!NET.myName) NET.myName = loadName();
  const pending = modal(`<h2>MONOCHROME <span class="gold-t">GAMBIT</span></h2>
    <p>Chess where every piece looks the same and secretly belongs to someone. Move anything, bluff boldly, and dispute your rival’s lies.</p>
    <label class="field">Your name <input id="optName" maxlength="16" placeholder="Sol" value="${esc(NET.myName)}"></label>
    <label class="opt"><input type="checkbox" id="opt960" ${prefVariant === '960' ? 'checked' : ''}>
      <span><b>Chess960</b> — shuffle the back rank every game</span></label>
    <p class="note setup-note">Unticked, every game uses the <b>Monochrome setup</b>: R B Q N K N B R. The classic order isn’t safe here: since any piece can capture any piece, the queen beside the king could capture it on move one.</p>
    <div class="menu-sec">On this device</div>
    <div class="menu-row">
      <button class="btn gold" data-val="ai">Play vs AI</button>
      <button class="btn blue" data-val="hotseat">Hotseat (2P)</button>
    </div>
    <div class="menu-sec">Online with a friend</div>
    <div class="menu-row">
      <button class="btn green" data-val="host">Host a game</button>
      <button class="btn purple" data-val="join">Join with code</button>
    </div>`,
  [{ label: 'About', value: 'about', cls: 'grey' }, { label: 'Rules', value: 'rules', cls: 'grey' }]);
  $('#opt960').onchange = e => {
    prefVariant = e.target.checked ? '960' : 'standard';
    try { localStorage.setItem('mg-variant', prefVariant); } catch (err) { /* storage unavailable */ }
  };
  $('#optName').oninput = e => { NET.myName = cleanName(e.target.value); saveName(NET.myName); };
  const choice = await pending;
  if (t !== TOKEN) return;
  switch (choice) {
    case 'rules': showRules(); return startScreen();
    case 'about': showAbout(); return startScreen();
    case 'ai': case 'hotseat': NET.leave(); return newGame(choice, prefVariant);
    case 'host': return hostFlow();
    case 'join': return joinFlow();
  }
}

function goMenu() {
  if (NET.role && S && S.mode === 'online' && S.phase !== 'over' &&
      !confirm('Leave the online game? Your friend will be disconnected.')) return;
  NET.leave();
  TOKEN++;
  closeModal(); hideHandoff();
  startScreen();
}

function showAbout() {
  const ov = $('#rulesOv');
  ov.innerHTML = `<div class="modal wide about">
    <h2>About</h2>
    <p><b>Monochrome Gambit</b> is a bluffing variant of chess: every piece looks the same, each one secretly belongs to one of the two players, and anyone may move anything — at the risk of being disputed.</p>
    <h4>Credits</h4>
    <ul>
      <li>Game concept and design direction: <b>Santiago Rentería</b> (<a href="https://github.com/hermes2507" target="_blank" rel="noopener">@hermes2507</a>).</li>
      <li>Code written with <b>Claude Code</b> (Anthropic).</li>
    </ul>
    <h4>Inspirations</h4>
    <ul>
      <li><b>Chess</b>, and <b>Chess960 / Fischer Random Chess</b>, devised by Bobby Fischer.</li>
      <li>The card presentation is inspired by <b>Balatro</b> by LocalThunk. This project is not affiliated with or endorsed by Balatro’s creators and uses none of its assets.</li>
    </ul>
    <h4>Open-source software, fonts & services</h4>
    <ul>
      <li><a href="https://peerjs.com" target="_blank" rel="noopener">PeerJS</a> 1.5.5 (MIT License) for browser-to-browser connections, loaded from the unpkg CDN.</li>
      <li>The free <b>PeerJS cloud server</b> for matchmaking, and PeerJS’s public relay (TURN) servers as a fallback on strict networks; Google’s public STUN server helps browsers find each other.</li>
      <li>Fonts from Google Fonts under the SIL Open Font License 1.1: <b>Silkscreen</b> by Jason Kottke and <b>Pixelify Sans</b> by Stefie Justprince.</li>
      <li>Chess pieces are standard Unicode chess symbols drawn by your device’s fonts.</li>
    </ul>
    <h4>Privacy</h4>
    <p>No accounts, no tracking, and no game server. Online games travel directly between the two browsers; the matchmaking server only sees connection IDs. Your name and settings are kept in your own browser.</p>
    <h4>License</h4>
    <p>Released under the MIT License. Source code: <a href="https://github.com/hermes2507/monochrome-gambit" target="_blank" rel="noopener">github.com/hermes2507/monochrome-gambit</a></p>
    <div class="m-btns"><button class="btn green" id="aboutClose">Close</button></div></div>`;
  ov.classList.add('show');
  $('#aboutClose').onclick = () => { ov.classList.remove('show'); ov.innerHTML = ''; };
}

/* -------------------------------- Wiring -------------------------------- */
$('#board').addEventListener('click', e => {
  const sq = e.target.closest('.sq');
  if (!sq || !S) return;
  onSquareClick(+sq.dataset.r, +sq.dataset.c).catch(swallowAbort);
});
$('#btnRules').onclick = showRules;
$('#btnAbout').onclick = showAbout;
$('#btnNew').onclick = goMenu;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && ui.targeting) { const res = ui.targeting.resolve; ui.targeting = null; res(null); }
});
window.addEventListener('beforeunload', () => { if (NET.connected()) NET.send({ t: 'bye' }); });

// Boot: an idle demo board behind the menu, or straight to "join" from an invite link.
newGame('ai');
TOKEN++; // freeze that demo game
const inviteCode = (location.hash.match(/join=([A-Za-z0-9]+)/) || [])[1];
if (inviteCode) joinFlow(inviteCode); else startScreen();
