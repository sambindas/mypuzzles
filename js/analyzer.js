/**
 * analyzer.js — extracts personalized puzzles from a user's games.
 *
 * Themes:
 *   'mate'    — you had a forced checkmate sequence
 *   'punish'  — your opponent just blundered; find the punishment
 *   'convert' — you were winning; find the move that seals it (or the win you threw away)
 *   'tactic'  — a winning tactical shot appeared
 *
 * Strategy: we only evaluate positions where it's the USER to move
 * (half the engine work). Scores from Engine are side-to-move POV,
 * which at those positions equals the user's POV.
 */

import { Chess } from './vendor/chess.js';
import { MATE_SCORE } from './engine.js';

export const DEFAULT_THRESHOLDS = {
  scanDepth: 11,      // quick pass on every user move
  confirmDepth: 16,   // deep pass on puzzle candidates
  winScore: 250,      // cp advantage considered "winning"
  jumpScore: 250,     // eval jump that signals a blunder/tactic appeared
  maxMateLen: 5,      // only mate-in-5 or shorter become mate puzzles
  minPly: 10,         // skip the first 5 full moves (opening)
  crushScore: 900,    // skip positions where user is already totally crushing
};

const isMate = (r) => r.mateIn !== null && r.mateIn > 0;

/** chess.js v1 throws on illegal moves — normalize to null. */
export function safeMove(chess, arg) {
  try { return chess.move(arg); } catch { return null; }
}

/**
 * Analyze one game. Streams puzzles via onPuzzle(puzzle).
 * `seenFens` is a Set used to dedupe across passes/games.
 */
export async function analyzeGame(engine, game, opts, seenFens, onPuzzle, shouldStop) {
  const cfg = { ...DEFAULT_THRESHOLDS, ...opts };
  const chess = new Chess();

  try {
    chess.loadPgn(game.pgn);
  } catch {
    return 0;
  }

  const moves = chess.history({ verbose: true });
  if (moves.length < 12) return 0;

  chess.reset();

  let prev = null;          // last user-to-move analysis { score, mateIn, pv }
  let pending = null;       // { fen, result, playedUci, ply } — awaiting retro check
  let found = 0;
  let lastFen = null;       // position before the previous (opponent) move
  let lastUci = null;       // the previous move itself

  for (let ply = 0; ply < moves.length; ply++) {
    if (shouldStop && shouldStop()) break;

    const mv = moves[ply];
    const userToMove = chess.turn() === game.userColor;
    const fenNow = chess.fen();
    const uciNow = mv.from + mv.to + (mv.promotion || '');

    if (!userToMove || ply < cfg.minPly) {
      chess.move(mv.san);
      lastFen = fenNow; lastUci = uciNow;
      continue;
    }

    const fen = fenNow;
    const playedUci = uciNow;
    const r = await engine.analyze(fen, cfg.scanDepth);

    if (r.score === null) { chess.move(mv.san); lastFen = fenNow; lastUci = uciNow; continue; }

    /* ── retro check: did the previous user move throw away a win? ── */
    if (pending && prev) {
      const threwAway = prev.score >= cfg.winScore + 150 && r.score <= 100;
      if (threwAway && !seenFens.has(pending.fen)) {
        const p = await confirmPuzzle(engine, game, pending.fen, 'convert', pending.ply, cfg, prev,
          null, { preFen: pending.preFen, lastUci: pending.lastUci });
        if (p) { seenFens.add(pending.fen); found++; onPuzzle(p); }
      }
    }

    /* ── immediate candidates at this position ── */
    let theme = null;

    if (isMate(r) && r.mateIn <= cfg.maxMateLen) {
      // first appearance of a mate (avoid one puzzle per ply of the same mating attack)
      if (!prev || !isMate(prev)) theme = 'mate';
    } else if (r.score >= cfg.winScore && prev && prev.score < cfg.winScore) {
      // a win just appeared
      theme = (r.score - prev.score >= cfg.jumpScore) ? 'punish' : 'tactic';
    } else if (
      r.score >= cfg.winScore + cfg.jumpScore &&
      prev && prev.score >= cfg.winScore &&
      r.score - prev.score >= cfg.jumpScore &&
      r.score < cfg.crushScore
    ) {
      // already winning, but a much stronger continuation appeared
      theme = 'convert';
    }

    if (theme && !seenFens.has(fen)) {
      const p = await confirmPuzzle(engine, game, fen, theme, ply, cfg, r, playedUci,
        { preFen: lastFen, lastUci });
      if (p) { seenFens.add(fen); found++; onPuzzle(p); }
    }

    pending = { fen, playedUci, ply, preFen: lastFen, lastUci };
    prev = r;
    chess.move(mv.san);
    lastFen = fenNow; lastUci = uciNow;
  }

  return found;
}

/**
 * Deep-analyze a candidate and build the final puzzle object (or null if it
 * doesn't hold up at higher depth).
 */
async function confirmPuzzle(engine, game, fen, theme, ply, cfg, scanResult, playedUci, ctx = {}) {
  const deep = await engine.analyze(fen, cfg.confirmDepth);
  if (!deep.pv.length || deep.score === null) return null;

  let mateIn = null;
  if (isMate(deep)) {
    mateIn = deep.mateIn;
    if (mateIn > cfg.maxMateLen) {
      if (deep.score < cfg.winScore) return null;
      mateIn = null; // too long — treat as a normal winning line
    }
    if (mateIn !== null) theme = 'mate';
  } else {
    if (theme === 'mate') theme = 'tactic';       // mate didn't survive depth
    if (deep.score < 200) return null;            // not clearly winning — discard
  }

  /* build the solution line */
  let line;
  if (mateIn !== null) {
    line = deep.pv.slice(0, mateIn * 2 - 1);      // full mating sequence
  } else {
    line = deep.pv.length >= 3 ? deep.pv.slice(0, 3) : deep.pv.slice(0, 1);
  }

  /* UCI → SAN, and validate the line is legal */
  const tmp = new Chess(fen);
  const lineSan = [];
  for (const uci of line) {
    const m = safeMove(tmp, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    if (!m) break;
    lineSan.push(m.san);
  }
  if (!lineSan.length) return null;
  const finalLine = line.slice(0, lineSan.length);
  if (finalLine.length % 2 === 0) {               // line must end on a user move
    finalLine.pop(); lineSan.pop();
    if (!finalLine.length) return null;
  }

  const moveNumber = parseInt(fen.split(' ')[5], 10);

  return {
    id: `${game.id}-${ply}`,
    fen,
    line: finalLine,
    lineSan,
    theme,
    mateIn,
    score: deep.score,
    foundInGame: playedUci ? playedUci === finalLine[0] : false,
    userColor: game.userColor,
    moveNumber,
    preFen: ctx.preFen || null,     // position before the opponent's last move
    lastMove: ctx.lastUci || null,  // the opponent move that led to the puzzle
    game: {
      url: game.url,
      date: game.date,
      opponent: game.opponent,
      white: game.white,
      black: game.black,
      platform: game.platform,
    },
  };
}
