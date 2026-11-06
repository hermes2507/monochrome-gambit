'use strict';
/* =====================================================================
   MONOCHROME GAMBIT — chess where every piece looks the same.
   Each piece secretly belongs to Sol or Luna. Anyone may move any piece;
   moving one that isn't yours is a bluff, and bluffs can be Disputed.

   This file holds the rules engine, the AI and the UI. Online play lives
   in net.js: the host's browser runs this engine and the guest receives
   only a filtered view of the state (see viewFor in net.js).
   ===================================================================== */

const $ = (s, el = document) => el.querySelector(s);
const rnd = n => Math.floor(Math.random() * n);
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const VS = '︎'; // force text (non-emoji) presentation for chess glyphs
const TYPES = {
  K: { v: 0, g: '♚', n: 'King' },
  Q: { v: 9, g: '♛', n: 'Queen' },
  R: { v: 5, g: '♜', n: 'Rook' },
  B: { v: 3, g: '♝', n: 'Bishop' },
  N: { v: 3, g: '♞', n: 'Knight' },
  P: { v: 1, g: '♟', n: 'Pawn' },
};
const glyph = t => `<span class="gl">${TYPES[t].g}${VS}</span>`;
const rawGlyph = t => TYPES[t].g + VS;
const PL = [
  { name: 'Sol', sym: '☀', cls: 'sol' },
  { name: 'Luna', sym: '☾', cls: 'luna' },
];
const RULES = { HAND_MAX: 6, START_HAND: 3, KNOWN_START: 8, SHUFFLE_N: 5 };
const GLAZES = ['red', 'white', null];
const gName = g => g === 'red' ? 'Red' : g === 'white' ? 'White' : 'Plain';

/* ---------------------------- Card catalogue ---------------------------- */
const CARDS = {
  dispute: { name: 'Dispute', kind: 'reaction', rarity: 'common', count: 12, icon: '⚖',
    text: "After your rival moves, claim the piece wasn't theirs. Right: move undone, they lose a turn. Wrong: you lose a turn." },
  counter: { name: 'Counter-dispute', kind: 'reaction', rarity: 'uncommon', count: 5, icon: '⛨',
    text: 'When your move is disputed: cancel the dispute. Nothing is revealed.' },
  shuffle: { name: 'Chromatic Shuffle', kind: 'action', rarity: 'common', count: 4, icon: '✺',
    text: '5 random pieces change colour at random. Kings are immune.' },
  brush: { name: 'Paintbrush', kind: 'action', rarity: 'common', count: 3, icon: '✎',
    text: 'Repaint one piece Red, White or Plain. Kings are immune.' },
  spyglass: { name: 'Spyglass', kind: 'action', rarity: 'common', count: 3, icon: '◉',
    text: 'Secretly learn who owns one piece.' },
  frostRed: { name: 'Red Frost', kind: 'action', rarity: 'uncommon', count: 2, icon: '❄',
    text: 'All red pieces cannot move this round (this turn and your rival’s next).' },
  frostWhite: { name: 'White Frost', kind: 'action', rarity: 'uncommon', count: 2, icon: '❄',
    text: 'All white pieces cannot move this round (this turn and your rival’s next).' },
  alibi: { name: 'Alibi', kind: 'action', rarity: 'uncommon', count: 3, icon: '✉',
    text: 'Your moves this turn cannot be disputed. Bluff in peace.' },
  turncoat: { name: 'Turncoat', kind: 'action', rarity: 'rare', count: 2, icon: '⇄',
    text: 'A random hidden rival pawn secretly defects to you. Its old owner is not told.' },
  doubletime: { name: 'Double Time', kind: 'action', rarity: 'rare', count: 1, icon: '⧗',
    text: 'Make a second move this turn.' },
  joker: { name: 'Wild Joker', kind: 'action', rarity: 'rare', count: 1, icon: '★',
    text: 'Draw 2 cards.' },
  purgeRed: { name: 'Red Purge', kind: 'action', rarity: 'legendary', count: 1, icon: '☠',
    text: 'All red pieces are removed from the game. Kings are immune.' },
  purgeWhite: { name: 'White Purge', kind: 'action', rarity: 'legendary', count: 1, icon: '☠',
    text: 'All white pieces are removed from the game. Kings are immune.' },
};

/* ------------------------------ Game state ------------------------------ */
// S is the full game state on the host / local device. On an online guest it
// is a filtered view received from the host (S.isView === true).
let S = null;
const ui = { sel: null, targets: [], resolveMove: null, targeting: null, busy: false, sentMove: false };

let TOKEN = 0;
class Abort extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Each game (or received online view) carries the TOKEN it was created under.
// Bumping TOKEN freezes it: any of its pending awaits throw Abort when they resume.
const gameKey = () => S ? S.gid + ':' + S.gen : '';
const stillLive = key => !!S && S.gen === TOKEN && gameKey() === key;
async function wait(ms) { const k = gameKey(); await sleep(ms); if (!stillLive(k)) throw new Abort(); }
async function W(p) { const k = gameKey(); const v = await p; if (!stillLive(k)) throw new Abort(); return v; }
const swallowAbort = err => { if (!(err instanceof Abort)) console.error(err); };

const isAI = p => S.mode === 'ai' && p === 1;
const isHuman = p => !isAI(p);
// In an online game the host's engine treats player 1 as remote.
const isRemote = p => S.mode === 'online' && !S.isView && p === 1;
const isYou = p => S.mode === 'ai' && p === 0;
const nm = p => (S && S.names && S.names[p]) || PL[p].name;
const pname = p => isYou(p) ? 'You' : nm(p);
const poss = p => isYou(p) ? 'Your' : nm(p) + '’s';
const vb = (p, base) => isYou(p) ? base : (/(s|sh)$/.test(base) ? base + 'es' : base + 's');
const sqName = (r, c) => 'abcdefgh'[c] + (8 - r);
const isMine = p => isYou(p) || (S.mode === 'online' && p === S.viewer);

// Default back rank: kings flanked by knights so no piece threatens a king at the start.
// (It is itself one of the 960 Fischer Random positions.)
const STANDARD_BACK = 'RBQNKNBR';

// Chess960: bishops on opposite colours, king somewhere between the rooks.
// Because any piece may capture any piece in this variant, a queen or rook standing
// right beside the king could capture it on move one, so those set-ups are re-dealt.
// 172 of the 960 positions pass that rule.
function backRank960() {
  for (;;) {
    const row = Array(8).fill(null);
    const free = () => row.map((x, i) => (x ? -1 : i)).filter(i => i >= 0);
    row[2 * rnd(4)] = 'B';
    row[2 * rnd(4) + 1] = 'B';
    let f = free(); row[f[rnd(f.length)]] = 'Q';
    f = free(); row[f.splice(rnd(f.length), 1)[0]] = 'N'; row[f[rnd(f.length)]] = 'N';
    f = free(); row[f[0]] = 'R'; row[f[1]] = 'K'; row[f[2]] = 'R';
    const k = row.indexOf('K');
    if (!'QR'.includes(row[k - 1]) && !'QR'.includes(row[k + 1])) return row.join('');
  }
}

let prefVariant = 'standard';
try { if (localStorage.getItem('mg-variant') === '960') prefVariant = '960'; } catch (e) { /* storage unavailable */ }
// 'random': ownership dealt at random (default). 'classic': Sol owns the bottom 16, Luna the top 16.
let prefOwnership = 'random';
try { if (localStorage.getItem('mg-ownership') === 'classic') prefOwnership = 'classic'; } catch (e) { /* storage unavailable */ }

// Classic ownership is a memory challenge: humans get no badges for unrevealed pieces.
// The AI starts with perfect knowledge, so it forgets a little each turn to stay bluffable.
const AI_FORGET = 0.03;

function newGame(mode, variant = prefVariant, names = null, ownership = prefOwnership) {
  TOKEN++;
  closeModal(); hideHandoff();
  ui.sel = null; ui.targets = []; ui.resolveMove = null; ui.targeting = null; ui.busy = false; ui.sentMove = false;
  NET.resetGame();

  let nid = 1;
  const mk = (type, dir = 0) => ({ id: nid++, type, owner: 0, glaze: null, dir, belief: [null, null], revealed: false });
  const B = Array.from({ length: 8 }, () => Array(8).fill(null));
  const back = variant === '960' ? backRank960() : STANDARD_BACK;
  for (let c = 0; c < 8; c++) {
    B[0][c] = mk(back[c]); B[1][c] = mk('P', 1);
    B[6][c] = mk('P', -1); B[7][c] = mk(back[c]);
  }
  const all = B.flat().filter(Boolean);
  if (ownership === 'classic') {
    // Regular chess sides: Sol owns rows 6–7 (bottom), Luna rows 0–1 (top).
    for (let c = 0; c < 8; c++) { B[0][c].owner = B[1][c].owner = 1; B[6][c].owner = B[7][c].owner = 0; }
  } else {
    // Random but fair ownership: each type is split evenly between the players.
    for (const t of 'KQRBNP') {
      const l = shuffle(all.filter(p => p.type === t));
      l.forEach((p, i) => { p.owner = i < l.length / 2 ? 0 : 1; });
    }
  }
  // Random colours: a third red, a third white, a third plain. Kings are never coloured.
  shuffle(all.filter(p => p.type !== 'K')).forEach((p, i) => { p.glaze = GLAZES[i % 3]; });
  // Both kings are public.
  for (const p of all) if (p.type === 'K') { p.revealed = true; p.belief = [p.owner, p.owner]; }
  if (ownership === 'classic') {
    // Memory challenge: humans track their pieces themselves (no badges); the AI starts knowing all.
    if (mode === 'ai') for (const p of all) p.belief[1] = p.owner;
  } else {
    // Each player secretly knows only some of their own pieces.
    for (const pl of [0, 1]) {
      shuffle(all.filter(p => p.owner === pl && p.type !== 'K'))
        .slice(0, RULES.KNOWN_START).forEach(p => { p.belief[pl] = pl; });
    }
  }

  const deck = [];
  for (const k in CARDS) for (let i = 0; i < CARDS[k].count; i++) deck.push(k);
  shuffle(deck);

  S = {
    mode, variant, back, names, ownership, gid: Math.random().toString(36).slice(2), gen: TOKEN,
    board: B, captured: [], deck, discard: [], hands: [[], []],
    skips: [0, 0], frost: { red: 0, white: 0 },
    turn: rnd(2), turnCount: 1,
    viewer: mode === 'hotseat' ? -1 : 0,
    log: [], lastMove: null, usedAction: false, alibi: false, extraMove: false,
    phase: 'start', winner: null, showAll: false, uid: 1, anim: null,
    flash: new Map(), // piece id -> 'all' | player who may see the flash
    awaiting: null,   // player whose move input the engine is waiting on (online)
  };
  for (const p of [0, 1]) {
    const i = S.deck.indexOf('dispute');
    S.hands[p].push({ key: S.deck.splice(i, 1)[0], uid: S.uid++ });
    drawCards(p, RULES.START_HAND - 1);
  }
  render();
  gameLoop();
}

/* -------------------------- Effects for players ------------------------- */
// Public effects are shown locally and mirrored to an online guest.
function bannerAll(big, small, cls) {
  if (S.mode === 'online') NET.sendNow({ t: 'fx', k: 'banner', a: [big, small, cls] });
  return banner(big, small, cls);
}
// Private effects are shown only to player p.
function bannerTo(p, big, small, cls) {
  if (isRemote(p)) { NET.sendNow({ t: 'fx', k: 'banner', a: [big, small, cls] }); return sleep(1500); }
  if (isHuman(p) && S.viewer === p) return banner(big, small, cls);
  return Promise.resolve();
}
function showCardAll(p, key) {
  if (S.mode === 'online') NET.sendNow({ t: 'fx', k: 'card', a: [p, key] });
  return showCard(p, key);
}
// Ask player p a question; answered locally or by the remote guest.
function promptPlayer(p, html, buttons) {
  if (isRemote(p)) return NET.ask(html, buttons);
  return modal(html, buttons);
}
function flash(ids, who = 'all') {
  for (const id of ids) S.flash.set(id, who);
  render();
  const t = TOKEN;
  setTimeout(() => { if (t === TOKEN) for (const id of ids) S.flash.delete(id); }, 1200);
}

/* ----------------------------- Card helpers ----------------------------- */
function drawCards(p, n) {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (S.hands[p].length >= RULES.HAND_MAX) break;
    if (!S.deck.length) {
      if (!S.discard.length) break;
      S.deck = shuffle(S.discard); S.discard = [];
      log('The discard pile is reshuffled into the deck.', 'dim');
    }
    S.hands[p].push({ key: S.deck.pop(), uid: S.uid++ });
    drawn++;
  }
  return drawn;
}
const hasCard = (p, key) => S.hands[p].some(c => c.key === key);

async function useCard(p, key) {
  const hand = S.hands[p];
  const i = hand.findIndex(c => c.key === key);
  if (i < 0) return;
  hand.splice(i, 1);
  S.discard.push(key);
  render();
  await W(showCardAll(p, key));
}

async function playCard(p, uid, opts = {}) {
  const hand = S.hands[p];
  const i = hand.findIndex(c => c.uid === uid);
  if (i < 0) return;
  const card = hand.splice(i, 1)[0];
  S.discard.push(card.key);
  if (CARDS[card.key].kind === 'action') S.usedAction = true;
  ui.sel = null; ui.targets = [];
  render();
  await W(showCardAll(p, card.key));
  await applyEffect(p, card.key, opts);
  render();
}

async function applyEffect(p, key, opts) {
  const o = 1 - p;
  switch (key) {
    case 'shuffle': {
      const chosen = shuffle(onBoard().filter(pc => pc.type !== 'K')).slice(0, RULES.SHUFFLE_N);
      for (const pc of chosen) { const opt = GLAZES.filter(g => g !== pc.glaze); pc.glaze = opt[rnd(opt.length)]; }
      log(`Chromatic Shuffle! ${chosen.map(pc => sqOf(pc)).join(', ')} change colour.`, 'hot');
      flash(chosen.map(pc => pc.id));
      break;
    }
    case 'frostRed': case 'frostWhite': {
      const g = key === 'frostRed' ? 'red' : 'white';
      S.frost[g] = S.turnCount + 1;
      log(`${gName(g)} pieces are frozen this round.`, 'cool');
      render(); await W(bannerAll(`${gName(g).toUpperCase()} FROST`, 'Those pieces cannot move this round', 'cool'));
      break;
    }
    case 'purgeRed': case 'purgeWhite': {
      const g = key === 'purgeRed' ? 'red' : 'white';
      const gone = [0, 0];
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const pc = S.board[r][c];
        if (pc && pc.type !== 'K' && pc.glaze === g) { reveal(pc); S.captured.push(pc); S.board[r][c] = null; gone[pc.owner]++; }
      }
      log(`${gName(g)} Purge! ${nm(0)} loses ${gone[0]}, ${nm(1)} loses ${gone[1]} piece(s).`, 'bad');
      render(); await W(bannerAll('PURGE!', `${gone[0] + gone[1]} ${g} pieces destroyed`, 'purple'));
      break;
    }
    case 'spyglass': {
      const t = opts.target; if (!t) break;
      log(`${pname(p)} ${vb(p, 'peek')} at the ${TYPES[t.type].n} on ${sqOf(t)}.`, 'dim');
      t.belief[p] = t.owner;
      flash([t.id], p);
      await W(bannerTo(p, t.owner === p ? 'YOURS!' : 'NOT YOURS', `That ${TYPES[t.type].n} belongs to ${nm(t.owner)}`, t.owner === p ? 'good' : 'bad'));
      break;
    }
    case 'brush': {
      const t = opts.target; if (!t) break;
      t.glaze = opts.colour;
      log(`${pname(p)} ${vb(p, 'repaint')} ${sqOf(t)} ${gName(opts.colour).toLowerCase()}.`, 'hot');
      flash([t.id]);
      break;
    }
    case 'alibi':
      S.alibi = true;
      log(`${pname(p)} ${isYou(p) ? 'have' : 'has'} an Alibi: no disputes this turn.`, 'hot');
      break;
    case 'turncoat': {
      const cand = onBoard().filter(pc => pc.type === 'P' && pc.owner === o && !pc.revealed);
      if (!cand.length) { log('Turncoat fizzles: no hidden rival pawn to recruit.', 'dim'); break; }
      const t = cand[rnd(cand.length)];
      t.owner = p; t.belief[p] = p; // the old owner's belief is now stale!
      log(`A pawn secretly defects to ${nm(p)}…`, 'hot');
      flash([t.id], p);
      await W(bannerTo(p, 'DEFECTOR', `The pawn on ${sqOf(t)} is now yours`, 'gold'));
      break;
    }
    case 'doubletime':
      S.extraMove = true;
      log(`${pname(p)} ${vb(p, 'gain')} an extra move this turn.`, 'hot');
      break;
    case 'joker': {
      const n = drawCards(p, 2);
      log(`${pname(p)} ${vb(p, 'draw')} ${n} card(s).`, 'hot');
      break;
    }
  }
}

/* ---------------------------- Board helpers ----------------------------- */
const inb = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const onBoard = () => S.board.flat().filter(Boolean);
function sqOf(pc) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (S.board[r][c] === pc) return sqName(r, c);
  return '?';
}
function findPiece(id) {
  for (const pc of onBoard()) if (pc.id === id) return pc;
  return S.captured.find(pc => pc.id === id) || null;
}
function reveal(pc) { pc.revealed = true; pc.belief = [pc.owner, pc.owner]; }
const cloneBoard = B => B.map(row => row.map(p => p ? { ...p } : null));
const isFrozen = pc => !!pc.glaze && S.frost[pc.glaze] >= S.turnCount;

const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];

// Any piece may capture any other piece — there are no "friendly" pieces on the board.
function genMoves(B, r, c) {
  const pc = B[r][c]; if (!pc) return [];
  const out = [];
  const slide = dirs => {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (inb(rr, cc)) { out.push([rr, cc]); if (B[rr][cc]) break; rr += dr; cc += dc; }
    }
  };
  const step = dirs => { for (const [dr, dc] of dirs) if (inb(r + dr, c + dc)) out.push([r + dr, c + dc]); };
  switch (pc.type) {
    case 'P': {
      const d = pc.dir, start = d > 0 ? 1 : 6, r1 = r + d;
      if (inb(r1, c) && !B[r1][c]) {
        out.push([r1, c]);
        const r2 = r + 2 * d;
        if (r === start && inb(r2, c) && !B[r2][c]) out.push([r2, c]);
      }
      for (const dc of [-1, 1]) if (inb(r1, c + dc) && B[r1][c + dc]) out.push([r1, c + dc]);
      break;
    }
    case 'N': step(KNIGHT); break;
    case 'B': slide(DIAG); break;
    case 'R': slide(ORTH); break;
    case 'Q': slide(ORTH); slide(DIAG); break;
    case 'K': step(ORTH); step(DIAG); break;
  }
  return out;
}
function attacked(B, r, c) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    if (!B[rr][cc] || (rr === r && cc === c)) continue;
    for (const [tr, tc] of genMoves(B, rr, cc)) if (tr === r && tc === c) return true;
  }
  return false;
}
function findKing(B, owner) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = B[r][c]; if (p && p.type === 'K' && p.owner === owner) return [r, c]; }
  return null;
}
// Kings are public, so only their owner may move them.
const canMove = (pc, p) => !isFrozen(pc) && !(pc.type === 'K' && pc.owner !== p);
function allLegalMoves(p) {
  const out = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const pc = S.board[r][c];
    if (!pc || !canMove(pc, p)) continue;
    for (const [tr, tc] of genMoves(S.board, r, c)) out.push({ fr: r, fc: c, tr, tc });
  }
  return out;
}
// Probability, from p's point of view, that a piece p hasn't identified belongs to p.
function pMine(p) {
  if (S.isView) return S.pmView;
  let unk = 0, mine = 0;
  for (const pc of onBoard()) if (pc.belief[p] === null) { unk++; if (pc.owner === p) mine++; }
  return unk ? mine / unk : 0.5;
}

/* ------------------------------- Game loop ------------------------------ */
async function gameLoop() {
  try {
    log(`New game! The pieces are dealt. ${pname(S.turn)} ${vb(S.turn, 'move')} first.`, 'hot');
    if (S.variant === '960') log(`Chess960 back rank: <b>${S.back.split('').join(' ')}</b>`, 'cool');
    else log(`Monochrome setup: <b>${S.back.split('').join(' ')}</b>. Knights guard the kings, because in the classic order the queen could capture the king on move one.`, 'cool');
    if (S.ownership === 'classic') log(`Classic ownership: ${nm(0)} owns the bottom 16 pieces, ${nm(1)} the top 16. No badges: remember which pieces are yours!`, 'cool');
    render();
    while (!S.winner) {
      await playTurn();
      if (S.winner) break;
      S.turnCount++;
      S.turn = 1 - S.turn;
    }
    await endGame();
  } catch (e) { swallowAbort(e); }
}

async function playTurn() {
  const p = S.turn;
  S.usedAction = false; S.alibi = false; S.extraMove = false;
  ui.sel = null; ui.targets = [];

  if (S.skips[p] > 0) {
    S.skips[p]--;
    S.phase = 'skip';
    log(`${pname(p)} ${vb(p, 'lose')} this turn.`, 'warn');
    render();
    await W(bannerAll('TURN LOST', `${pname(p)} ${vb(p, 'sit')} this one out`, 'warn'));
    return;
  }

  if (isAI(p) && S.ownership === 'classic') aiForget(p);
  await handoff(p);
  drawCards(p, 1);
  S.phase = 'move';
  render();

  let movesLeft = 1;
  while (movesLeft-- > 0) {
    S.phase = 'move'; render();
    const m = isAI(p) ? await aiMovePhase(p)
      : isRemote(p) ? await W(remoteMovePhase(p))
      : await W(humanMovePhase(p));
    if (!m) { log(`${pname(p)} cannot move and ${vb(p, 'pass')}.`, 'dim'); break; }
    const res = await executeMove(p, m);
    if (S.winner || res === 'caught') return;
    if (S.extraMove) { S.extraMove = false; movesLeft++; }
  }
}

function humanMovePhase() {
  S.phase = 'move';
  render();
  return new Promise(res => { ui.resolveMove = res; });
}

// Online: wait for the guest's move. net.js validates it and calls the resolver.
function remoteMovePhase(p) {
  S.phase = 'move';
  S.awaiting = p;
  render();
  return new Promise(res => {
    NET.resolveRemoteMove = m => { S.awaiting = null; NET.resolveRemoteMove = null; res(m); };
  });
}

async function executeMove(p, m) {
  S.phase = 'resolving';
  const snap = JSON.parse(JSON.stringify({ board: S.board, captured: S.captured }));
  const pc = S.board[m.fr][m.fc];
  const cap = S.board[m.tr][m.tc];
  const origType = pc.type;
  S.board[m.tr][m.tc] = pc; S.board[m.fr][m.fc] = null;
  let promo = false;
  if (pc.type === 'P' && ((pc.dir > 0 && m.tr === 7) || (pc.dir < 0 && m.tr === 0))) { pc.type = 'Q'; promo = true; }
  if (cap) { reveal(cap); S.captured.push(cap); }
  S.lastMove = { fr: m.fr, fc: m.fc, tr: m.tr, tc: m.tc, id: pc.id, p };
  S.anim = { id: pc.id, fr: m.fr, fc: m.fc, tr: m.tr, tc: m.tc };
  const capTxt = cap ? ` × ${glyph(cap.type)} (${nm(cap.owner)}’s)` : '';
  log(`${pname(p)}: ${glyph(origType)} ${sqName(m.fr, m.fc)}→${sqName(m.tr, m.tc)}${capTxt}${promo ? ' =' + glyph('Q') : ''}`);
  render();
  await wait(500);

  const res = await reactionWindow(p, pc, { cap, snap, m });
  checkWin();
  render();
  return res;
}

async function reactionWindow(p, pc, info) {
  const o = 1 - p;
  if (S.alibi) { log('Alibi: this move cannot be disputed.', 'dim'); return 'ok'; }
  if (!hasCard(o, 'dispute')) return 'ok';

  const kingCap = !!(info.cap && info.cap.type === 'K');
  let want;
  if (isAI(o)) { await wait(450); want = aiWantsDispute(o, pc, info, kingCap); }
  else { await handoff(o); want = await W(askDispute(o, pc, info)); }
  if (!want) return 'ok';

  await useCard(o, 'dispute');
  log(`${pname(o)} ${vb(o, 'dispute')} the move!`, 'hot');

  if (hasCard(p, 'counter')) {
    let c;
    if (isAI(p)) { await wait(450); c = aiWantsCounter(p, pc); }
    else { await handoff(p); c = await W(askCounter(p, pc)); }
    if (c) {
      await useCard(p, 'counter');
      log('Counter-dispute! The dispute is void and nothing is revealed.', 'cool');
      await W(bannerAll('COUNTERED', 'The dispute is void', 'cool'));
      return 'ok';
    }
  }

  const owner = pc.owner;
  if (owner === p) {
    reveal(pc);
    S.skips[o]++;
    log(`Honest move — that piece belongs to ${nm(owner)}. ${pname(o)} ${vb(o, 'lose')} a turn.`, 'good');
    render();
    await W(bannerAll('HONEST!', `${pname(o)} ${vb(o, 'lose')} a turn`, 'good'));
    return 'ok';
  }
  // Caught bluffing: undo the move, reveal the piece, mover loses a turn.
  const id = pc.id;
  S.board = info.snap.board; S.captured = info.snap.captured;
  const back = findPiece(id); if (back) reveal(back);
  if (info.cap) { const c2 = findPiece(info.cap.id); if (c2) reveal(c2); }
  S.skips[p]++;
  S.lastMove = null;
  log(`Caught! That piece belongs to ${nm(owner)}. The move is undone and ${pname(p)} ${vb(p, 'lose')} a turn.`, 'bad');
  render();
  await W(bannerAll('CAUGHT!', `Move undone — ${pname(p)} ${vb(p, 'lose')} a turn`, 'bad'));
  return 'caught';
}

function checkWin() {
  for (const c of S.captured) if (c.type === 'K') { S.winner = { p: 1 - c.owner, kingOwner: c.owner }; return; }
}

async function endGame() {
  S.phase = 'over';
  S.showAll = true;
  render();
  const w = S.winner.p;
  log(`${nm(S.winner.kingOwner)}’s king has fallen. ${nm(w)} wins!`, 'good');
  const big = isYou(w) ? 'VICTORY' : S.mode === 'ai' ? 'DEFEAT' : `${nm(w).toUpperCase()} WINS`;
  await W(bannerAll(big, 'The king has fallen', isYou(w) || S.mode !== 'ai' ? 'gold' : 'bad'));
  const html = `<h2><span class="who ${PL[w].cls}">${PL[w].sym} ${nm(w)}</span> wins!</h2>
     <p>${nm(S.winner.kingOwner)}’s king was captured. Every piece’s true owner is now shown on the board.</p>`;
  if (S.mode === 'online') {
    NET.sendNow({ t: 'fx', k: 'gameover', a: [html + '<p class="note">The host can start a rematch.</p>'] });
    const again = await W(modal(html, [{ label: 'Look at board', value: 'look', cls: 'grey' }, { label: 'Rematch', value: 'again', cls: 'green' }]));
    if (again === 'again') newGame('online', S.variant, S.names, S.ownership);
    return;
  }
  const again = await W(modal(html, [{ label: 'Look at board', value: 'look', cls: 'grey' }, { label: 'Play again', value: 'again', cls: 'green' }]));
  if (again === 'again') newGame(S.mode, S.variant, null, S.ownership);
}

/* ------------------------------- Hotseat -------------------------------- */
async function handoff(p) {
  if (S.mode !== 'hotseat' || S.viewer === p) return;
  const el = $('#handoff');
  el.innerHTML = `<div class="ho-sym who ${PL[p].cls}">${PL[p].sym}</div>
    <div class="ho-title">Pass to ${PL[p].name}</div>
    <div class="ho-sub">${PL[1 - p].name}, look away! Secret ownership will be shown.</div>
    <button class="btn ${p === 0 ? 'gold' : 'blue'}" id="hoGo">I am ${PL[p].name}</button>`;
  el.classList.add('show');
  await W(new Promise(res => { $('#hoGo').onclick = res; }));
  hideHandoff();
  S.viewer = p;
  render();
}
function hideHandoff() { const el = $('#handoff'); el.classList.remove('show'); el.innerHTML = ''; }

/* ---------------------------- Human prompts ----------------------------- */
function beliefVerdict(v, pc) {
  const b = pc.belief[v];
  if (b === v) return { cls: 'good', txt: 'You believe this piece is <b>yours</b>.' };
  if (b === 1 - v) return { cls: 'bad', txt: `You believe this piece is <b>${nm(1 - v)}’s</b>.` };
  if (S.ownership === 'classic') return { cls: 'unk', txt: 'Classic ownership: only your memory knows whose piece this is.' };
  return { cls: 'unk', txt: `You don’t know who owns this piece (≈${Math.round(pMine(v) * 100)}% of your unknowns are yours).` };
}

function askDispute(o, pc, info) {
  const p = 1 - o, m = info.m;
  const bv = beliefVerdict(o, pc);
  const hint = bv.cls === 'good' ? 'A dispute should catch them!' : bv.cls === 'bad' ? 'A dispute would backfire.' : 'Disputing is a gamble.';
  const n = S.hands[o].filter(c => c.key === 'dispute').length;
  return promptPlayer(o,
    `<h2>Dispute?</h2>
     <p><b class="who ${PL[p].cls}">${PL[p].sym} ${nm(p)}</b> moved the ${TYPES[pc.type].n} ${glyph(pc.type)} from <b>${sqName(m.fr, m.fc)}</b> to <b>${sqName(m.tr, m.tc)}</b>${info.cap ? `, capturing a ${TYPES[info.cap.type].n}` : ''}.</p>
     <div class="verdict ${bv.cls}">${bv.txt} ${hint}</div>
     <p class="note">If the piece isn’t ${nm(p)}’s, the move is undone and they lose a turn. If it is, <b>you</b> lose a turn. You hold ${n} Dispute card(s).</p>`,
    [{ label: 'Let it go', value: false, cls: 'grey' }, { label: '⚖ Dispute!', value: true }]);
}

function askCounter(p, pc) {
  const o = 1 - p;
  const bv = beliefVerdict(p, pc);
  const hint = bv.cls === 'good'
    ? `If you let it resolve and you’re right, ${nm(o)} loses a turn.`
    : 'If the dispute resolves, you will probably be caught.';
  return promptPlayer(p,
    `<h2>You’ve been disputed!</h2>
     <p><b class="who ${PL[o].cls}">${PL[o].sym} ${nm(o)}</b> claims the ${TYPES[pc.type].n} you moved isn’t yours.</p>
     <div class="verdict ${bv.cls}">${bv.txt} ${hint}</div>
     <p class="note">Counter-dispute cancels the dispute entirely and nothing is revealed.</p>`,
    [{ label: 'Let it resolve', value: false, cls: 'grey' }, { label: '⛨ Counter-dispute', value: true, cls: 'blue' }]);
}

function pickTarget(prompt, filter) {
  return new Promise(res => { ui.targeting = { prompt, filter, resolve: res }; render(); });
}

function pickColour(pc) {
  const opts = GLAZES.filter(g => g !== pc.glaze);
  return modal(`<h2>Paintbrush</h2><p>Repaint the ${TYPES[pc.type].n} on ${sqOf(pc)} (currently ${gName(pc.glaze).toLowerCase()}):</p>`,
    [{ label: 'Cancel', value: undefined, cls: 'grey' },
     ...opts.map(g => ({ label: gName(g), value: g, cls: g === 'red' ? '' : g === 'white' ? 'blue' : 'purple' }))]);
}

// True when the person at this screen may make a move right now.
function myMoveInput() {
  if (!S || S.phase !== 'move' || S.turn !== S.viewer || ui.sentMove) return false;
  if (S.isView) return S.awaiting === S.viewer;
  return isHuman(S.turn) && !isRemote(S.turn) && !!ui.resolveMove;
}

function submitMove(m) {
  ui.sel = null; ui.targets = [];
  if (S.isView) { ui.sentMove = true; NET.send({ t: 'move', m }); render(); return; }
  const res = ui.resolveMove; ui.resolveMove = null;
  res(m);
}

async function humanPlayCard(uid) {
  if (ui.busy || ui.targeting || !myMoveInput() || S.usedAction) return;
  const p = S.turn;
  const card = S.hands[p].find(c => c.uid === uid);
  if (!card || CARDS[card.key].kind !== 'action') return;
  ui.busy = true;
  ui.sel = null; ui.targets = [];
  try {
    const opts = {};
    if (card.key === 'spyglass') {
      const t = await W(pickTarget('Spyglass: click a piece whose owner is hidden', pc => !pc.revealed));
      if (!t) return;
      opts.target = t;
    } else if (card.key === 'brush') {
      const t = await W(pickTarget('Paintbrush: click a non-king piece to repaint', pc => pc.type !== 'K'));
      if (!t) return;
      const col = await W(pickColour(t));
      if (col === undefined) return;
      opts.target = t; opts.colour = col;
    }
    if (S.isView) {
      ui.sentMove = true;
      NET.send({ t: 'card', uid, target: opts.target ? opts.target.id : null, colour: opts.colour ?? null });
      return;
    }
    await playCard(p, uid, opts);
  } finally {
    ui.busy = false; ui.targeting = null;
    render();
  }
}

async function onSquareClick(r, c) {
  const pc = S.board[r][c];
  if (ui.targeting) {
    if (pc && ui.targeting.filter(pc)) { const res = ui.targeting.resolve; ui.targeting = null; res(pc); }
    return;
  }
  if (ui.busy || !myMoveInput()) return;
  const p = S.turn;

  if (ui.sel) {
    const hit = ui.targets.find(([tr, tc]) => tr === r && tc === c);
    if (hit) {
      if (pc && pc.belief[p] === p) {
        ui.busy = true;
        const ok = await W(modal(pc.type === 'K'
          ? '<h2>Capture your own king?</h2><p>That is your king. Capturing it loses the game instantly.</p>'
          : `<h2>Capture your own piece?</h2><p>You believe the ${TYPES[pc.type].n} on ${sqName(r, c)} is yours.</p>`,
          [{ label: 'Cancel', value: false, cls: 'grey' }, { label: 'Capture anyway', value: true }]));
        ui.busy = false;
        if (!ok || !myMoveInput()) { render(); return; }
      }
      submitMove({ fr: ui.sel[0], fc: ui.sel[1], tr: r, tc: c });
      return;
    }
    if (ui.sel[0] === r && ui.sel[1] === c) { ui.sel = null; ui.targets = []; render(); return; }
  }
  if (pc) {
    if (isFrozen(pc)) { toast(`That piece is ${pc.glaze} — frozen this round.`); return; }
    if (pc.type === 'K' && pc.owner !== p) { toast('Kings are public — only their owner may move them.'); return; }
    ui.sel = [r, c];
    ui.targets = genMoves(S.board, r, c);
  } else { ui.sel = null; ui.targets = []; }
  render();
}

/* ---------------------------------- AI ---------------------------------- */
function valueTo(p, pc, pm) {
  const v = TYPES[pc.type].v, b = pc.belief[p];
  if (b === p) return v;
  if (b === 1 - p) return -v;
  return (2 * pm - 1) * v;
}

async function aiMovePhase(p) {
  render();
  await wait(650 + rnd(400));
  if (!S.usedAction) {
    const a = aiChooseAction(p);
    if (a) { await playCard(p, a.uid, a.opts); await wait(300); }
  }
  const moves = allLegalMoves(p);
  if (!moves.length) return null;
  const best = aiBestMove(p, moves);
  if (!S.usedAction) {
    const pc = S.board[best.fr][best.fc];
    const alibi = S.hands[p].find(c => c.key === 'alibi');
    const dt = S.hands[p].find(c => c.key === 'doubletime');
    if (alibi && pc.belief[p] !== p && best.gain >= 1) await playCard(p, alibi.uid, {});
    else if (dt && best.gain >= 3) await playCard(p, dt.uid, {});
  }
  return { fr: best.fr, fc: best.fc, tr: best.tr, tc: best.tc };
}

function aiBestMove(p, moves) {
  const o = 1 - p, pm = pMine(p);
  const oppDisp = S.hands[o].length >= 2 ? 0.75 : 0.45;
  const alibi = S.alibi || (!S.usedAction && hasCard(p, 'alibi'));
  let best = null;
  for (const m of moves) {
    const pc = S.board[m.fr][m.fc], tgt = S.board[m.tr][m.tc];
    const b = pc.belief[p];
    const pTheirs = b === p ? 0 : b === o ? 1 : 1 - pm;
    let gain = 0;
    if (tgt) {
      if (tgt.type === 'K') gain = tgt.owner === p ? -10000 : 1000;
      else gain = -valueTo(p, tgt, pm);
    }
    const sim = cloneBoard(S.board);
    sim[m.tr][m.tc] = sim[m.fr][m.fc]; sim[m.fr][m.fc] = null;
    const moved = sim[m.tr][m.tc];
    if (moved.type === 'P' && (m.tr === 0 || m.tr === 7)) { moved.type = 'Q'; gain += pTheirs < 0.5 ? 6 : -3; }

    let s = gain;
    const myK = findKing(sim, p), thK = findKing(sim, o);
    if (myK && attacked(sim, myK[0], myK[1])) s -= 80;
    if (thK && attacked(sim, thK[0], thK[1])) s += 3;
    const mv = valueTo(p, moved, pm);
    if (moved.type !== 'K') {
      const hit = attacked(sim, m.tr, m.tc);
      if (hit && mv > 0) s -= mv * 0.7;
      if (mv > 0 && attacked(S.board, m.fr, m.fc) && !hit) s += mv * 0.5;
    }
    s -= pTheirs * oppDisp * (alibi ? 0.15 : 1) * (Math.max(gain, 0) + 3.5);
    s += ((3.5 - Math.abs(3.5 - m.tc)) + (3.5 - Math.abs(3.5 - m.tr))) * 0.05;
    s += Math.random() * 0.8;
    if (!best || s > best.s) best = { ...m, s, gain };
  }
  return best;
}

function aiChooseAction(p) {
  const pm = pMine(p), hand = S.hands[p];
  let best = null;
  const consider = (card, u, opts = {}) => { if (u > 0 && (!best || u > best.u)) best = { uid: card.uid, u, opts }; };
  for (const card of hand) {
    switch (card.key) {
      case 'purgeRed': case 'purgeWhite': {
        const g = card.key === 'purgeRed' ? 'red' : 'white';
        let d = 0; for (const pc of onBoard()) if (pc.glaze === g && pc.type !== 'K') d -= valueTo(p, pc, pm);
        consider(card, d > 2.5 ? d : 0); break;
      }
      case 'frostRed': case 'frostWhite': {
        const g = card.key === 'frostRed' ? 'red' : 'white';
        let d = 0; for (const pc of onBoard()) if (pc.glaze === g) d -= valueTo(p, pc, pm) * 0.35;
        consider(card, d > 1.5 ? d : 0); break;
      }
      case 'shuffle': consider(card, Math.random() < 0.15 ? 1.2 : 0); break;
      case 'spyglass': {
        const unk = shuffle(onBoard().filter(pc => !pc.revealed && pc.belief[p] === null))
          .sort((a, b) => TYPES[b.type].v - TYPES[a.type].v);
        if (unk.length && TYPES[unk[0].type].v >= 3) consider(card, 1 + Math.random() * 0.5, { target: unk[0] });
        break;
      }
      case 'brush': {
        const pg = hand.find(c => c.key === 'purgeRed' || c.key === 'purgeWhite');
        if (pg) {
          const g = pg.key === 'purgeRed' ? 'red' : 'white';
          const t = onBoard().filter(pc => pc.type !== 'K' && pc.glaze !== g && pc.belief[p] === 1 - p)
            .sort((a, b) => TYPES[b.type].v - TYPES[a.type].v)[0];
          if (t) consider(card, 2, { target: t, colour: g });
        } else {
          const t = onBoard().filter(pc => pc.type !== 'K' && pc.glaze && pc.belief[p] === p && TYPES[pc.type].v >= 5)
            .sort((a, b) => TYPES[b.type].v - TYPES[a.type].v)[0];
          if (t && Math.random() < 0.3) consider(card, 1, { target: t, colour: null });
        }
        break;
      }
      case 'turncoat': consider(card, 2.5); break;
      case 'joker': consider(card, hand.length <= 3 ? 2 : 0); break;
    }
  }
  return best && best.u >= 1 ? best : null;
}

function aiWantsDispute(o, pc, info, kingCap) {
  if (kingCap) return true; // nothing to lose
  const b = pc.belief[o];
  if (b === o) return true;
  if (b === 1 - o) return false;
  const pm = pMine(o) * 0.75; // humans usually move their own pieces
  const capVal = info.cap ? Math.max(0, valueTo(o, info.cap, pm)) : 0;
  const ev = pm * (3 + capVal) - (1 - pm) * 3;
  const nDisp = S.hands[o].filter(c => c.key === 'dispute').length;
  return ev > (nDisp > 1 ? 0.2 : 0.8) || (Math.random() < 0.08 && pm > 0.35);
}

// Memory challenge: the AI loses track of some unrevealed pieces each turn, as a person would.
function aiForget(p) {
  for (const pc of onBoard()) {
    if (pc.revealed || pc.type === 'K' || pc.belief[p] === null) continue;
    if (Math.random() < AI_FORGET) pc.belief[p] = null;
  }
}

function aiWantsCounter(p, pc) {
  return pc.belief[p] !== p; // only protect genuine bluffs
}

/* ------------------------------- Rendering ------------------------------ */
function render() {
  if (!S) return;
  if (NET.role === 'host' && S.mode === 'online') NET.queueSync();
  renderBoard(); renderHand(); renderPlayers(); renderEffects(); renderPhase(); renderLog();
}
const flashVisible = id => { const w = S.flash.get(id); return w !== undefined && (w === 'all' || w === S.viewer); };

function renderBoard() {
  const el = $('#board');
  const v = S.viewer;
  const lm = S.lastMove;
  const frag = document.createDocumentFragment();
  const tset = new Set(ui.targets.map(([r, c]) => r * 8 + c));
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const sq = document.createElement('div');
    const pc = S.board[r][c];
    sq.className = 'sq ' + ((r + c) % 2 ? 'd' : 'l');
    sq.dataset.r = r; sq.dataset.c = c;
    if (lm && ((lm.fr === r && lm.fc === c) || (lm.tr === r && lm.tc === c))) sq.classList.add('last');
    if (ui.sel && ui.sel[0] === r && ui.sel[1] === c) sq.classList.add('sel');
    if (tset.has(r * 8 + c)) { sq.classList.add('tgt'); if (pc) sq.classList.add('cap'); }
    if (ui.targeting && pc && ui.targeting.filter(pc)) sq.classList.add('pick');
    if (c === 7) sq.insertAdjacentHTML('beforeend', `<span class="coord r">${8 - r}</span>`);
    if (r === 7) sq.insertAdjacentHTML('beforeend', `<span class="coord f">${'abcdefgh'[c]}</span>`);
    if (pc) {
      if (pc.type === 'K' && attacked(S.board, r, c)) sq.classList.add('danger');
      const d = document.createElement('div');
      d.className = 'pc' + (isFrozen(pc) ? ' frozen' : '') + (flashVisible(pc.id) ? ' flash' : '');
      d.dataset.id = pc.id;
      let badge = '';
      if ((S.showAll || pc.revealed) && pc.owner !== null) badge = `<span class="badge rev ${PL[pc.owner].cls}">${PL[pc.owner].sym}</span>`;
      else if (v >= 0 && pc.belief[v] !== null) badge = `<span class="badge priv ${PL[pc.belief[v]].cls}">${PL[pc.belief[v]].sym}</span>`;
      d.innerHTML = `<div class="disc ${pc.glaze || 'none'}"></div><span class="g">${rawGlyph(pc.type)}</span>${badge}${isFrozen(pc) ? '<span class="ice">❄</span>' : ''}`;
      sq.appendChild(d);
    }
    frag.appendChild(sq);
  }
  el.replaceChildren(frag);

  if (S.anim) {
    const a = S.anim; S.anim = null;
    const pe = el.querySelector(`.pc[data-id="${a.id}"]`);
    if (pe) {
      const size = el.clientWidth / 8;
      pe.style.transition = 'none';
      pe.style.transform = `translate(${(a.fc - a.tc) * size}px, ${(a.fr - a.tr) * size}px)`;
      pe.style.zIndex = 10;
      void pe.offsetWidth;
      pe.style.transition = 'transform .28s cubic-bezier(.3,1.4,.5,1)';
      pe.style.transform = '';
    }
  }
}

function cardEl(key) {
  const d = CARDS[key];
  const el = document.createElement('div');
  el.className = `card r-${d.rarity} k-${d.kind}`;
  el.innerHTML = `<div class="c-name">${d.name}</div><div class="c-icon">${d.icon}</div>
    <div class="c-text">${d.text}</div><div class="c-foot">${d.kind} · ${d.rarity}</div>`;
  return el;
}

function renderHand() {
  const el = $('#hand');
  const v = S.viewer;
  el.replaceChildren();
  if (v < 0) return;
  const hand = S.hands[v];
  if (!hand.length) { el.innerHTML = '<div class="hand-empty">No cards in hand</div>'; return; }
  const canAct = myMoveInput() && !S.usedAction && !ui.busy && !ui.targeting;
  const n = hand.length;
  hand.forEach((card, i) => {
    if (!CARDS[card.key]) return;
    const w = document.createElement('div');
    w.className = 'cw';
    w.style.setProperty('--d', `${-i * 0.45}s`);
    w.style.setProperty('--rot', `${(i - (n - 1) / 2) * 3}deg`);
    const c = cardEl(card.key);
    const def = CARDS[card.key];
    if (def.kind === 'reaction') { c.classList.add('reactive'); c.title = 'Reaction: you will be asked when it can be played.'; }
    else if (canAct) { c.classList.add('playable'); c.onclick = () => humanPlayCard(card.uid).catch(swallowAbort); c.title = 'Click to play'; }
    else { c.classList.add('unplayable'); c.title = S.usedAction ? 'Only one action card per turn' : 'Play on your turn, before moving'; }
    w.appendChild(c);
    el.appendChild(w);
  });
}

function renderPlayers() {
  for (const p of [0, 1]) {
    const el = $('#pbox' + p);
    el.className = `pbox ${PL[p].cls}` + (S.turn === p && S.phase !== 'over' ? ' active' : '');
    const lost = S.captured.filter(c => c.owner === p).map(c => glyph(c.type)).join('');
    const tag = S.mode === 'ai' ? (p === 0 ? 'YOU' : 'AI')
      : S.mode === 'online' ? (p === S.viewer ? 'YOU' : 'FRIEND')
      : (S.viewer === p ? 'VIEWING' : 'P' + (p + 1));
    const backs = '<span class="mini-backs">' + '<span class="mini-back"></span>'.repeat(S.hands[p].length) + '</span>';
    let known = '';
    if (S.viewer === p) {
      const k = onBoard().filter(pc => pc.belief[p] === p).length;
      known = S.ownership === 'classic'
        ? `<div class="pb-row" style="display:block">Memory mode: you started with the ${p === 0 ? 'bottom' : 'top'} 16 pieces</div>`
        : `<div class="pb-row" style="display:block">You know <b>${k}</b> of your pieces on the board</div>`;
    }
    el.innerHTML = `<div class="pb-head"><span class="pb-sym">${PL[p].sym}</span>${nm(p)}<span class="pb-tag">${tag}</span></div>
      <div class="pb-row">Hand: <b>${S.hands[p].length}</b> ${backs}</div>
      ${S.skips[p] ? `<div class="pb-row skip-chip">⏳ Loses next turn${S.skips[p] > 1 ? ' ×' + S.skips[p] : ''}</div>` : ''}
      ${known}
      <div class="pb-row">Lost: <span class="lost">${lost || '—'}</span></div>`;
  }
}

function renderEffects() {
  const chips = [];
  if (NET.role && NET.code) chips.push(`<span class="chip gold">Room ${NET.code}${NET.role === 'host' && !NET.connected() ? ' · friend offline' : ''}</span>`);
  if (S.variant === '960') chips.push(`<span class="chip">Chess960 · ${S.back}</span>`);
  else chips.push(`<span class="chip" title="The classic R N B Q K B N R order would let a queen capture the king on move one, since any piece can capture any piece.">Monochrome setup · ${S.back}</span>`);
  if (S.ownership === 'classic') chips.push('<span class="chip" title="Sol owns the bottom 16 pieces, Luna the top 16. Remember which are yours.">Classic ownership · memory</span>');
  for (const g of ['red', 'white']) if (S.frost[g] >= S.turnCount) chips.push(`<span class="chip ${g}">❄ ${gName(g)} frozen</span>`);
  if (S.alibi) chips.push('<span class="chip gold">✉ Alibi active</span>');
  if (S.extraMove) chips.push('<span class="chip gold">⧗ Extra move</span>');
  const counts = { red: 0, white: 0, none: 0 };
  for (const pc of onBoard()) if (pc.type !== 'K') counts[pc.glaze || 'none']++;
  $('#effects').innerHTML = `<h3>Round ${Math.ceil(S.turnCount / 2)} · Turn ${S.turnCount}</h3>
    <div>${chips.join('') || '<span class="chip">No active effects</span>'}</div>
    <div class="deckline">On board: <b style="color:#ff8a92">${counts.red} red</b> · <b style="color:#fff">${counts.white} white</b> · ${counts.none} plain</div>
    <div class="deckline">Deck ${S.deck.length} · Discard ${S.discard.length}</div>`;
}

function renderPhase() {
  const el = $('#phaseBar');
  const p = S.turn;
  if (S.phase === 'over') {
    const host = S.mode === 'online' && !S.isView;
    el.innerHTML = `<span class="who ${PL[S.winner.p].cls}">${PL[S.winner.p].sym} ${nm(S.winner.p)} wins!</span>
      ${host ? '<button class="btn small" id="pbRematch">Rematch</button>' : ''}
      <button class="btn small" id="pbNew">${S.mode === 'online' ? 'Leave' : 'New game'}</button>`;
    $('#pbNew').onclick = goMenu;
    if (host) $('#pbRematch').onclick = () => newGame('online', S.variant, S.names, S.ownership);
    return;
  }
  if (ui.targeting) {
    el.innerHTML = `<b>${ui.targeting.prompt}</b> <button class="btn small" id="pbCancel">Cancel</button>`;
    $('#pbCancel').onclick = () => { const res = ui.targeting.resolve; ui.targeting = null; res(null); };
    return;
  }
  const who = `<span class="who ${PL[p].cls}">${PL[p].sym} ${isMine(p) ? 'Your' : poss(p)} turn</span>`;
  if (myMoveInput()) {
    let hint = 'Select any piece to move — yours, or a bluff.';
    if (ui.sel) {
      const pc = S.board[ui.sel[0]][ui.sel[1]];
      const b = pc.belief[p];
      if (b === p) hint = `<span class="hint-good">✔ ${TYPES[pc.type].n}: yours — safe to move</span>`;
      else if (b === 1 - p) hint = `<span class="hint-bad">⚠ ${TYPES[pc.type].n}: ${nm(1 - p)}’s — moving it is a bluff!</span>`;
      else if (S.ownership === 'classic') hint = `<span class="hint-unk">? ${TYPES[pc.type].n}: is it yours? Moving a rival piece is a bluff</span>`;
      else hint = `<span class="hint-unk">? ${TYPES[pc.type].n}: unknown owner (≈${Math.round(pMine(p) * 100)}% chance it’s yours)</span>`;
    }
    const act = S.usedAction ? '' : ' · <span style="color:var(--dim)">may play 1 action card first</span>';
    const noMoves = !allLegalMoves(p).length;
    el.innerHTML = `${who} · ${hint}${act}${noMoves ? ' <button class="btn small" id="pbPass">Pass</button>' : ''}`;
    if (noMoves) $('#pbPass').onclick = () => {
      if (S.isView) { ui.sentMove = true; NET.send({ t: 'pass' }); render(); return; }
      const res = ui.resolveMove; ui.resolveMove = null; res(null);
    };
    return;
  }
  if (S.phase === 'skip') { el.innerHTML = `${who} · lost!`; return; }
  if (isAI(p)) { el.innerHTML = `${who} · <span style="color:var(--dim)">Luna is plotting…</span>`; return; }
  if (S.mode === 'online' && p !== S.viewer && S.phase === 'move') {
    const off = !S.isView && !NET.connected();
    el.innerHTML = `${who} · <span style="color:var(--dim)">${off ? `⚠ ${nm(p)} disconnected — they can rejoin with code <b>${NET.code}</b>` : `waiting for ${nm(p)}…`}</span>`;
    return;
  }
  el.innerHTML = `${who} · <span style="color:var(--dim)">resolving…</span>`;
}

function log(text, cls = '') {
  if (!S) return;
  S.log.unshift({ text, cls });
  if (S.log.length > 120) S.log.pop();
}
function renderLog() {
  $('#log').innerHTML = S.log.map(l => `<div class="${l.cls}">${l.text}</div>`).join('');
}

/* ------------------------------ Overlays -------------------------------- */
// Buttons may be passed explicitly, or placed in the html with data-val="...".
function modal(html, buttons, opts = {}) {
  const ov = $('#overlay');
  ov.innerHTML = `<div class="modal ${opts.cls || ''}">${html}<div class="m-btns"></div></div>`;
  const bb = $('.m-btns', ov);
  return new Promise(res => {
    const done = v => { closeModal(); res(v); };
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (b.cls || '');
      btn.textContent = b.label;
      btn.onclick = () => done(b.value);
      bb.appendChild(btn);
    }
    ov.querySelectorAll('[data-val]').forEach(btn => { btn.onclick = () => done(btn.dataset.val); });
    ov.classList.add('show');
  });
}
function closeModal() { const ov = $('#overlay'); ov.classList.remove('show'); ov.innerHTML = ''; }

function banner(big, small, cls = '') {
  const el = $('#banner');
  el.className = '';
  el.innerHTML = `<div class="b-big">${big}</div><div class="b-small">${small || ''}</div>`;
  void el.offsetWidth;
  el.className = 'show ' + cls;
  return new Promise(res => { clearTimeout(banner.t); banner.t = setTimeout(() => { el.className = ''; res(); }, 1500); });
}

function showCard(p, key) {
  const el = $('#cardShow');
  el.className = '';
  el.replaceChildren();
  const lab = document.createElement('div');
  lab.className = `cs-lab who ${PL[p].cls}`;
  lab.textContent = `${PL[p].sym} ${isMine(p) && !isYou(p) ? 'You play' : pname(p) + ' ' + vb(p, 'play')}`;
  el.append(lab, cardEl(key));
  void el.offsetWidth;
  el.className = 'show';
  return new Promise(res => setTimeout(() => { el.className = ''; res(); }, 1300));
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

function rulesHTML() {
  const cards = Object.keys(CARDS).map(k => {
    const tmp = document.createElement('div');
    tmp.className = 'rc';
    tmp.innerHTML = `<span class="cnt">×${CARDS[k].count}</span>`;
    tmp.appendChild(cardEl(k));
    return tmp.outerHTML;
  }).join('');
  const total = Object.values(CARDS).reduce((a, c) => a + c.count, 0);
  return `<h2>How to play</h2>
  <p>Every piece is carved from the same bone. Secretly, each one belongs to <b class="who sol">☀ Sol</b> or <b class="who luna">☾ Luna</b> — by default ownership is dealt at random (each player gets one king and an even split of every piece type).</p>
  <h4>What you know</h4>
  <ul>
    <li>Both kings are public. You also secretly know <b>${RULES.KNOWN_START}</b> of your other 15 pieces (dashed badge). The rest of your army is hidden even from you.</li>
    <li>A piece’s owner is revealed to everyone when it is captured or disputed (solid badge).</li>
  </ul>
  <h4>Classic ownership (memory challenge)</h4>
  <p>Untick <b>Randomise ownership</b> in the menu and the sides work like regular chess: Sol owns the bottom 16 pieces and Luna the top 16. They still all look the same, and no badges are shown until a piece is revealed, so you have to <b>remember</b> which pieces are yours as they move. Luna, the AI, starts out knowing every piece but forgets a few each turn, so bluffing it can work.</p>
  <h4>Your turn</h4>
  <ul>
    <li><b>Draw</b> 1 card (hand limit ${RULES.HAND_MAX}).</li>
    <li>Optionally play <b>1 action card</b>.</li>
    <li><b>Move any piece</b> (except the rival’s king, which is public) using normal chess movement. The default back rank, the <b>Monochrome setup</b>, is <b>R B Q N K N B R</b>: in the classic order the queen beside the king could capture it on move one, so knights guard the kings instead. With <b>Chess960</b> on, the back rank is shuffled each game (mirrored for both sides, bishops on opposite colours, king between the rooks), and never deals a queen or rook right beside a king. Any piece may capture any other piece. Pawns move toward the far side from where they started and promote to queens. No castling, no en passant, no check: <b>capture the rival’s king to win</b>.</li>
    <li>Moving a piece that isn’t yours is a <b>bluff</b>. It’s perfectly legal… unless you get caught.</li>
  </ul>
  <h4>Disputes</h4>
  <ul>
    <li>After a move, the rival may play <b>Dispute</b>. The moved piece is revealed.</li>
    <li>If it wasn’t the mover’s piece: the move is <b>undone</b> and the mover <b>loses a turn</b>.</li>
    <li>If it was theirs: the disputer <b>loses a turn</b>.</li>
    <li>The mover may answer with <b>Counter-dispute</b> to cancel the dispute with nothing revealed.</li>
  </ul>
  <h4>Colours</h4>
  <p>Separately from ownership, each non-king piece wears a public colour on its base: <b style="color:#ff8a92">red</b>, <b>white</b> or plain. Colour has nothing to do with who owns a piece — it’s what Frost, Purge, Shuffle and Paintbrush act on, and it hits both players alike. Starting colours are random.</p>
  <h4>Playing online</h4>
  <p>One player hosts and gets a short code; the friend enters it (or opens the invite link). The two browsers connect directly. The host’s browser runs the game and sends the guest only what the guest is allowed to see.</p>
  <h4>The deck — ${total} cards, shared</h4>
  <div class="rules-cards">${cards}</div>`;
}
function showRules() {
  const ov = $('#rulesOv');
  ov.innerHTML = `<div class="modal wide">${rulesHTML()}<div class="m-btns"><button class="btn green" id="rulesClose">Got it</button></div></div>`;
  ov.classList.add('show');
  $('#rulesClose').onclick = () => { ov.classList.remove('show'); ov.innerHTML = ''; };
}
