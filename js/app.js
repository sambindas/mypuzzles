/**
 * app.js — orchestration: fetch games → analyze in background → serve puzzles.
 *
 * Cascade when content runs out:
 *   Phase 1: strict thresholds over paginated game history
 *   Phase 2: softer thresholds re-pass over the same games
 *   Phase 3: retry puzzles the user failed
 *   Phase 4: end screen with session stats
 */

import { Chess } from './vendor/chess.js';
import { Engine } from './engine.js';
import { createGameSource } from './fetcher.js';
import { analyzeGame, safeMove } from './analyzer.js';
import { Board } from './board.js';

/* ── constants ─────────────────────────────────────────────────────────── */

const SOFT_THRESHOLDS = { winScore: 150, jumpScore: 150, maxMateLen: 7, crushScore: 1200 };
const FIRST_BATCH = 5;   // buffer this many puzzles before serving the first one
const THEME_LABEL = {
  mate:    { text: 'Checkmate',         cls: 'chip-mate' },
  punish:  { text: 'Punish the blunder', cls: 'chip-punish' },
  convert: { text: 'Convert the win',    cls: 'chip-convert' },
  tactic:  { text: 'Winning tactic',     cls: 'chip-tactic' },
};

/* ── state ─────────────────────────────────────────────────────────────── */

let engine = null;
let session = null;   // everything for the current username

/* ── cross-visit memory: fens of puzzles already shown, per user ───────── */

const seenKey = (platform, username) => `mypuzzles-seen:${platform}:${username.toLowerCase()}`;

function loadSeenFens(platform, username) {
  try { return new Set(JSON.parse(localStorage.getItem(seenKey(platform, username)) || '[]')); }
  catch { return new Set(); }
}

function rememberSeen(platform, username, fen) {
  try {
    const key = seenKey(platform, username);
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    if (!arr.includes(fen)) {
      arr.push(fen);
      while (arr.length > 800) arr.shift();
      localStorage.setItem(key, JSON.stringify(arr));
    }
  } catch { /* storage unavailable */ }
}

function newSession(platform, username) {
  return {
    platform, username,
    source: createGameSource(platform, username),
    games: [],            // all fetched games (kept for phase 2)
    seenFens: loadSeenFens(platform, username),  // skip puzzles from past visits
    queue: [],            // unplayed puzzles
    failed: [],           // failed puzzles (for phase 3)
    phase: 1,
    pumping: false,
    servedAny: false,     // first puzzle waits for a small varied batch
    exhausted: false,     // no more content will ever arrive
    cancelled: false,
    waiting: null,        // resolver when player is waiting for a puzzle
    stats: { solved: 0, failed: 0, byTheme: {} },
    current: null,        // current puzzle
    play: null,           // current play state
    replaySnapshots: null,
    replayIdx: 0,
  };
}

/* ── DOM ───────────────────────────────────────────────────────────────── */

const $ = id => document.getElementById(id);
const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');

const board = new Board($('board'), { onMove: onUserMove });

$('generate-btn').addEventListener('click', start);
$('username').addEventListener('keydown', e => e.key === 'Enter' && start());
$('next-btn').addEventListener('click', nextPuzzle);
$('giveup-btn').addEventListener('click', giveUp);
$('back-btn').addEventListener('click', undoWrongMove);
$('replay-back').addEventListener('click', () => stepReplay(-1));
$('replay-fwd').addEventListener('click', () => stepReplay(1));
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.key === 'ArrowLeft' || e.key === 'Left')) {
    if (!$('back-btn').classList.contains('hidden')) {
      e.preventDefault();
      return undoWrongMove();
    }
    if (!$('replay-controls').classList.contains('hidden') && !$('replay-back').disabled) {
      e.preventDefault();
      return stepReplay(-1);
    }
  }
  if ((e.key === 'ArrowRight' || e.key === 'Right')) {
    if (!$('replay-controls').classList.contains('hidden') && !$('replay-fwd').disabled) {
      e.preventDefault();
      return stepReplay(1);
    }
  }
});
$('restart-btn').addEventListener('click', () => { location.reload(); });

/* ── start ─────────────────────────────────────────────────────────────── */

async function start() {
  const platform = $('platform').value;
  const username = $('username').value.trim();
  if (!username) return showError('Please enter a username.');

  if (session) session.cancelled = true;
  hide($('error-card')); hide($('puzzle-view')); hide($('end-screen'));
  show($('loading'));
  $('generate-btn').disabled = true;

  try {
    if (!engine) {
      setLoading('Loading Stockfish engine…');
      engine = new Engine();
      await engine.init();
    }

    session = newSession(platform, username);
    setLoading(`Fetching ${username}'s games…`);

    pump(session); // background analysis loop (don't await)

    setLoading('Analyzing your games…', 'Your first puzzle will appear as soon as one is found');
    const puzzle = await takePuzzle(session);

    if (!puzzle) {
      hide($('loading'));
      /* if past-visit history blocked everything, clear it so a retry works */
      let hadHistory = false;
      try {
        hadHistory = JSON.parse(localStorage.getItem(seenKey(platform, username)) || '[]').length > 0;
        if (hadHistory) localStorage.removeItem(seenKey(platform, username));
      } catch { /* storage unavailable */ }
      return showError(hadHistory
        ? 'No new puzzles found — you\'ve seen everything from these games. Your puzzle history was reset, so try again to replay them.'
        : 'No puzzles could be generated — not enough games, or no clear tactics found. Play more games and try again!');
    }

    hide($('loading'));
    show($('puzzle-view'));
    loadPuzzle(puzzle);

  } catch (err) {
    hide($('loading'));
    showError(err.message);
  } finally {
    $('generate-btn').disabled = false;
  }
}

/* ── background analysis pump ──────────────────────────────────────────── */

async function pump(s) {
  if (s.pumping) return;
  s.pumping = true;

  try {
    /* Phase 1 — strict pass, paging through history */
    while (!s.cancelled) {
      const { games, done } = await s.source.next();
      for (const game of games) {
        if (s.cancelled) return;
        s.games.push(game);
        await analyzeGame(engine, game, {}, s.seenFens, p => enqueue(s, p), () => s.cancelled);
      }
      if (done) break;
    }
    if (s.cancelled) return;

    /* Phase 2 — softer thresholds over the same games */
    s.phase = 2;
    for (const game of s.games) {
      if (s.cancelled) return;
      await analyzeGame(engine, game, SOFT_THRESHOLDS, s.seenFens, p => enqueue(s, p), () => s.cancelled);
    }
    if (s.cancelled) return;

    /* Phase 3 — recycled failed puzzles are added lazily in takePuzzle() */
    s.phase = 3;
    s.exhausted = true;
    if (s.waiting) checkWaiter(s);

  } catch (err) {
    console.error('pump error:', err);
    s.exhausted = true;
    if (s.waiting) checkWaiter(s);
    if (!s.queue.length && !s.current) showError(err.message);
  } finally {
    s.pumping = false;
  }
}

function enqueue(s, puzzle) {
  s.queue.push(puzzle);
  if (s.waiting) checkWaiter(s);
}

/* Pull a random puzzle from the queue so consecutive puzzles come from
   different games instead of following analysis order. */
function popRandom(s) {
  const i = Math.floor(Math.random() * s.queue.length);
  return s.queue.splice(i, 1)[0];
}

/* The first puzzle is only served once a small batch has accumulated (or
   analysis finished), so the random pick has real variety to choose from. */
function canServe(s) {
  if (!s.queue.length) return false;
  return s.servedAny || s.exhausted || s.queue.length >= FIRST_BATCH;
}

/* takePuzzle resolves with the next puzzle, waiting for analysis if needed.
   Returns null only when every source (incl. retries) is exhausted. */
function takePuzzle(s) {
  if (canServe(s)) {
    s.servedAny = true;
    return Promise.resolve(popRandom(s));
  }

  if (s.exhausted) {
    if (s.failed.length) {           // Phase 3: recycle failures
      const retry = s.failed.splice(0, s.failed.length);
      shuffle(retry);
      s.queue.push(...retry.map(p => ({ ...p, isRetry: true })));
      return Promise.resolve(popRandom(s));
    }
    return Promise.resolve(null);    // Phase 4
  }

  return new Promise(resolve => { s.waiting = resolve; });
}

function checkWaiter(s) {
  if (!s.waiting) return;
  if (canServe(s) || s.exhausted) {
    const r = s.waiting; s.waiting = null;
    takePuzzle(s).then(r);
  }
}

/* ── puzzle player ─────────────────────────────────────────────────────── */

function loadPuzzle(puzzle) {
  const s = session;
  s.current = puzzle;
  if (!puzzle.isRetry) rememberSeen(s.platform, s.username, puzzle.fen);
  s.play = {
    chess: new Chess(puzzle.fen),
    step: 0,                 // index into puzzle.line
    hadMistake: false,
    done: false,
  };

  /* meta bar */
  const t = THEME_LABEL[puzzle.theme] || THEME_LABEL.tactic;
  const chip = $('theme-chip');
  chip.textContent = puzzle.theme === 'mate' && puzzle.mateIn
    ? `Mate in ${puzzle.mateIn}` : t.text;
  chip.className = 'chip ' + t.cls;

  $('retry-chip').classList.toggle('hidden', !puzzle.isRetry);
  $('found-chip').classList.toggle('hidden', !puzzle.foundInGame);

  $('game-date').textContent = fmtDate(puzzle.game.date);
  $('game-opp').textContent = `vs ${puzzle.game.opponent}`;
  $('game-color').textContent = puzzle.userColor === 'w' ? '(you were White)' : '(you were Black)';
  $('game-link').href = puzzle.game.url;

  hide($('solution-box'));
  hide($('replay-controls'));
  hide($('back-btn'));
  $('next-btn').disabled = true;
  s.replaySnapshots = null;
  s.replayIdx = 0;

  /* board: replay the opponent's last move first, so you see what just happened */
  const toPlay = puzzle.userColor === 'w' ? 'White to play' : 'Black to play';
  if (puzzle.preFen && puzzle.lastMove) {
    $('giveup-btn').disabled = true;
    board.setPosition(puzzle.preFen, { orientation: puzzle.userColor });
    board.setInteractive(false);
    setStatus('wait', 'Opponent plays…', '');
    setTimeout(() => {
      if (s.current !== puzzle || s.play.done) return;
      board.playMove(puzzle.lastMove);
      board.setLegalMoves(legalUci(s.play.chess));
      board.setInteractive(true);
      $('giveup-btn').disabled = false;
      setStatus('play', 'Your move', `Opponent played ${sanOf(puzzle.preFen, puzzle.lastMove) || 'their move'} — ${toPlay.toLowerCase()}`);
    }, 800);
  } else {
    board.setPosition(puzzle.fen, {
      orientation: puzzle.userColor,
      legalMoves: legalUci(s.play.chess),
    });
    board.setInteractive(true);
    $('giveup-btn').disabled = false;
    setStatus('play', 'Your move', toPlay);
  }

  updateStatsBar();
}

async function onUserMove(uci) {
  const s = session;
  if (!s || !s.play || s.play.done) return false;
  const { play, current } = s;
  const expected = current.line[play.step];

  if (uci === expected) return acceptMove(uci);

  /* not the PV move — check if it's an equally decisive alternative */
  const probe = new Chess(play.chess.fen());
  safeMove(probe, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

  if (probe.isCheckmate()) return acceptMove(uci, true);   // any mate is a win

  /* engine check: verifies strong alternatives and explains failures */
  setStatus('wait', 'Checking your move…', '');
  board.setInteractive(false);
  const r = await engine.analyze(probe.fen(), 12);
  const userEval = r.score === null ? -Infinity : -r.score;  // flip: opponent POV → user POV

  if (current.theme !== 'mate' && userEval >= Math.max(200, (current.score ?? 0) - 120)) {
    board.setInteractive(true);
    return acceptMove(uci, true);
  }

  /* wrong — keep the move on the board and explain why it fails */
  if (!play.hadMistake) {
    play.hadMistake = true;
    s.stats.failed++;
    bumpTheme(s, current.theme, false);
    s.failed.push(current);
  }
  board.playMove(uci);
  board.setInteractive(false);
  board.flash(uci.slice(0, 2), uci.slice(2, 4), 'wrong');
  setStatus('bad', 'Not quite', wrongReason(current, probe, r, userEval));
  $('giveup-btn').disabled = true;
  show($('back-btn'));

  /* let the computer demonstrate the refutation */
  if (r.pv && r.pv.length) {
    play.refuteTimer = setTimeout(() => {
      play.refuteTimer = null;
      if (!play.done && s.current === current) board.playMove(r.pv[0]);
    }, 700);
  }
  return false;
}

/** Human-readable reason a move fails, from the engine reply analysis. */
function wrongReason(puzzle, probe, r, userEval) {
  let refute = '';
  if (r.pv && r.pv.length) {
    const m = safeMove(new Chess(probe.fen()),
      { from: r.pv[0].slice(0, 2), to: r.pv[0].slice(2, 4), promotion: r.pv[0][4] });
    if (m) refute = `After ${m.san}, `;
  }
  if (r.mateIn !== null && r.mateIn > 0)
    return `${refute}your opponent has mate in ${r.mateIn}. Press Back to try again.`;
  if (puzzle.theme === 'mate' && userEval >= 200)
    return `${refute}the forced mate slips away. Press Back to try again.`;
  const ev = userEval === -Infinity ? '' : ` (${(userEval / 100).toFixed(1)})`;
  if (userEval <= -150) return `${refute}you're losing${ev}. Press Back to try again.`;
  if (userEval < 150)   return `${refute}your advantage is gone${ev}. Press Back to try again.`;
  return `${refute}a stronger continuation was available${ev}. Press Back to try again.`;
}

/** Undo the displayed wrong move and let the player retry. */
function undoWrongMove() {
  const s = session;
  if (!s || !s.play || s.play.done) return;
  if (s.play.refuteTimer) { clearTimeout(s.play.refuteTimer); s.play.refuteTimer = null; }
  hide($('back-btn'));
  $('giveup-btn').disabled = false;
  board.setPosition(s.play.chess.fen(), {
    orientation: s.current.userColor,
    legalMoves: legalUci(s.play.chess),
  });
  board.setInteractive(true);
  setStatus('play', 'Your move', 'Find the strongest continuation');
}

function acceptMove(uci, isAlternate = false) {
  const s = session;
  const { play, current } = s;

  safeMove(play.chess, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  board.playMove(uci);
  board.flash(uci.slice(0, 2), uci.slice(2, 4), 'correct');

  /* alternates end the puzzle immediately (we can't follow the PV anymore) */
  const solvedNow = isAlternate || play.step + 1 >= current.line.length;

  if (solvedNow) return finishPuzzle(true);

  /* auto-play opponent reply, then hand back to user */
  play.step++;
  const reply = current.line[play.step];
  board.setInteractive(false);
  setStatus('wait', 'Opponent replies…', '');

  setTimeout(() => {
    safeMove(play.chess, { from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] });
    board.playMove(reply);
    play.step++;
    board.setLegalMoves(legalUci(play.chess));
    board.setInteractive(true);
    setStatus('play', 'Keep going…', `Move ${Math.floor(play.step / 2) + 1} of ${Math.ceil(current.line.length / 2)}`);
  }, 550);

  return true;
}

function finishPuzzle(solved) {
  const s = session;
  s.play.done = true;
  board.setInteractive(false);
  hide($('back-btn'));

  if (solved && !s.play.hadMistake) {
    s.stats.solved++;
    bumpTheme(s, s.current.theme, true);
    setStatus('good', 'Solved!', s.current.foundInGame
      ? 'You also found this in the game — well done'
      : 'You missed this one in the actual game');
  } else if (solved) {
    setStatus('good', 'Solved (with a slip)', 'This one will come back later for a retry');
  } else {
    setStatus('bad', 'Solution shown', 'This one will come back later for a retry');
  }

  showSolutionLine(s.current);
  $('giveup-btn').disabled = true;
  $('next-btn').disabled = false;
  $('next-btn').focus();
  updateStatsBar();
  return true;
}

function giveUp() {
  const s = session;
  if (!s || !s.play || s.play.done) return;
  if (!s.play.hadMistake) {
    s.stats.failed++;
    bumpTheme(s, s.current.theme, false);
    s.failed.push(s.current);
    s.play.hadMistake = true;
  }
  /* play out the full line on the board */
  const remaining = s.current.line.slice(s.play.step);
  playOutLine(remaining, () => finishPuzzle(false));
}

function playOutLine(moves, then) {
  board.setInteractive(false);
  let i = 0;
  const tick = () => {
    if (i >= moves.length) return then();
    board.playMove(moves[i]);
    i++;
    setTimeout(tick, 500);
  };
  tick();
}

async function nextPuzzle() {
  const s = session;
  $('next-btn').disabled = true;

  const immediate = s.queue.length > 0 || s.exhausted;
  if (!immediate) {
    setStatus('wait', 'Finding more puzzles…', 'Analyzing more of your games');
    board.setInteractive(false);
  }

  const puzzle = await takePuzzle(s);
  if (puzzle) return loadPuzzle(puzzle);

  /* Phase 4 — the end */
  showEndScreen(s);
}

/* ── end screen ────────────────────────────────────────────────────────── */

function showEndScreen(s) {
  hide($('puzzle-view'));
  show($('end-screen'));

  const total = s.stats.solved + s.stats.failed;
  const acc = total ? Math.round((s.stats.solved / total) * 100) : 0;
  $('end-summary').textContent =
    `You went through every puzzle we could find in ${s.games.length} games. ` +
    `Solved ${s.stats.solved} of ${total} (${acc}% accuracy).`;

  const byTheme = $('end-themes');
  byTheme.innerHTML = '';
  for (const [theme, v] of Object.entries(s.stats.byTheme)) {
    const row = document.createElement('div');
    row.className = 'theme-row';
    const label = THEME_LABEL[theme]?.text || theme;
    row.innerHTML = `<span>${label}</span><span>${v.ok} / ${v.ok + v.bad}</span>`;
    byTheme.appendChild(row);
  }
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function legalUci(chess) {
  return chess.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
}

function sanOf(fen, uci) {
  const m = safeMove(new Chess(fen), { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return m ? m.san : null;
}

function showSolutionLine(puzzle) {
  show($('solution-box'));
  const el = $('solution-moves');
  el.innerHTML = '';

  /* replay the line once to get the position after each half-move */
  const chess = new Chess(puzzle.fen);
  const snapshots = [{ fen: puzzle.fen, lastMove: null }];
  puzzle.line.forEach(uci => {
    safeMove(chess, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    snapshots.push({ fen: chess.fen(), lastMove: [uci.slice(0, 2), uci.slice(2, 4)] });
  });

  const s = session;
  s.replaySnapshots = snapshots;
  s.replayIdx = snapshots.length - 1;

  const startSide = puzzle.fen.split(' ')[1];
  let moveNo = parseInt(puzzle.fen.split(' ')[5], 10) || 1;

  puzzle.lineSan.forEach((san, i) => {
    const side = i % 2 === 0 ? startSide : (startSide === 'w' ? 'b' : 'w');
    let label;
    if (side === 'w') label = `${moveNo}. ${san}`;
    else { label = i === 0 ? `${moveNo}… ${san}` : san; moveNo++; }

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mv-badge ' + (side === 'w' ? 'mv-white' : 'mv-black');
    b.textContent = label;
    b.title = 'Show this position on the board';
    b.dataset.idx = i + 1;
    b.addEventListener('click', () => {
      s.replayIdx = parseInt(b.dataset.idx);
      renderReplay(s);
    });
    el.appendChild(b);
  });

  show($('replay-controls'));
  renderReplay(s);
}

function renderReplay(s) {
  const shots = s.replaySnapshots;
  const idx = s.replayIdx;
  const shot = shots[idx];
  if (!shot) return;

  board.setPosition(shot.fen, {
    orientation: s.current.userColor,
    lastMove: shot.lastMove,
  });

  const total = shots.length - 1;
  $('replay-pos').textContent = `${idx} / ${total}`;
  $('replay-label').textContent = idx === 0
    ? 'Puzzle start'
    : (idx % 2 === 1 ? 'Your move' : 'Opponent reply');
  $('replay-back').disabled = idx <= 0;
  $('replay-fwd').disabled  = idx >= total;

  const badges = $('solution-moves').querySelectorAll('.mv-badge');
  badges.forEach((b, i) => b.classList.toggle('active', i + 1 === idx));
}

function stepReplay(dir) {
  const s = session;
  if (!s || !s.replaySnapshots) return;
  const next = s.replayIdx + dir;
  if (next < 0 || next >= s.replaySnapshots.length) return;
  s.replayIdx = next;
  renderReplay(s);
}

function setStatus(kind, title, sub) {
  const icons = { play: '\u25B6', good: '\u2713', bad: '\u2717', wait: '\u23F3' };
  const colors = { play: '', good: 'var(--green)', bad: 'var(--red)', wait: 'var(--muted)' };
  $('status-icon').textContent = icons[kind] || '';
  $('status-title').textContent = title;
  $('status-title').style.color = colors[kind] || '';
  $('status-sub').textContent = sub || '';
}

function setLoading(title, sub) {
  $('loading-title').textContent = title;
  $('loading-sub').textContent = sub || '';
}

function updateStatsBar() {
  const s = session;
  $('stat-solved').textContent = s.stats.solved;
  $('stat-failed').textContent = s.stats.failed;
}

function bumpTheme(s, theme, ok) {
  const v = s.stats.byTheme[theme] || (s.stats.byTheme[theme] = { ok: 0, bad: 0 });
  ok ? v.ok++ : v.bad++;
}

function showError(msg) {
  show($('error-card'));
  $('error-msg').textContent = msg;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
