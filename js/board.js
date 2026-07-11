/**
 * board.js — dependency-free chess board renderer with click-to-move.
 *
 * Usage:
 *   const board = new Board(containerEl, {
 *     onMove: (uci) => boolean|'pending'   // return false to reject/snap back
 *   });
 *   board.setPosition(fen, { orientation: 'w'|'b', legalMoves: [uci...] });
 *   board.playMove(uci)          // animate/apply a move (opponent replies)
 *   board.flash(from, to, cls)   // highlight squares ('correct'|'wrong'|'last')
 */

// cburnett SVG piece set (pieces/wK.svg \u2026 bP.svg)
const pieceSrc = p => `pieces/${p === p.toUpperCase() ? 'w' : 'b'}${p.toUpperCase()}.svg`;
const FILES = 'abcdefgh';

/* Tiny WebAudio move/capture sounds \u2014 no asset files needed. */
let audioCtx = null;
function moveSound(capture) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(capture ? 190 : 300, t);
    o.frequency.exponentialRampToValueAtTime(capture ? 90 : 150, t + 0.08);
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.14);
  } catch { /* audio unavailable \u2014 stay silent */ }
}

export class Board {
  constructor(el, { onMove } = {}) {
    this.el = el;
    this.onMove = onMove || (() => false);
    this.pos = {};            // square -> piece char (FEN style: 'K' white, 'k' black)
    this.orientation = 'w';
    this.legalMoves = [];
    this.selected = null;
    this.interactive = true;
    this.lastMove = null;     // [from, to]
    this.drag = null;         // active piece-drag state
    this.arrows = [];         // user-drawn arrows [{from, to}]
    this.arrowDrag = null;    // active arrow-drag state
    this.el.classList.add('board');
    this.el.addEventListener('pointerdown',   e => this._pointerDown(e));
    this.el.addEventListener('pointermove',   e => this._pointerMove(e));
    this.el.addEventListener('pointerup',     e => this._pointerUp(e));
    this.el.addEventListener('pointercancel', () => this._cancelDrag());
    this.el.addEventListener('contextmenu',   e => e.preventDefault());
  }

  setPosition(fen, { orientation = 'w', legalMoves = [], lastMove = null } = {}) {
    this.pos = parseFen(fen);
    this.turn = fen.split(' ')[1];
    this.orientation = orientation;
    this.legalMoves = legalMoves;
    this.selected = null;
    this.lastMove = lastMove;
    this.arrows = [];
    this.render();
  }

  /** Apply a UCI move to the current position (visual only). */
  playMove(uci) {
    const from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci[4];
    let piece = this.pos[from];
    if (!piece) return;
    const isCapture = !!this.pos[to] || (piece.toUpperCase() === 'P' && from[0] !== to[0]);
    delete this.pos[from];

    // promotion
    if (promo) piece = piece === piece.toUpperCase() ? promo.toUpperCase() : promo.toLowerCase();

    // en passant capture (pawn moves diagonally onto empty square)
    if (piece.toUpperCase() === 'P' && from[0] !== to[0] && !this.pos[to]) {
      delete this.pos[to[0] + from[1]];
    }

    // castling: move the rook too
    if (piece.toUpperCase() === 'K' && Math.abs(FILES.indexOf(from[0]) - FILES.indexOf(to[0])) === 2) {
      const rank = from[1];
      if (to[0] === 'g') { this.pos['f' + rank] = this.pos['h' + rank]; delete this.pos['h' + rank]; }
      else               { this.pos['d' + rank] = this.pos['a' + rank]; delete this.pos['a' + rank]; }
    }

    this.pos[to] = piece;
    this.turn = this.turn === 'w' ? 'b' : 'w';
    this.lastMove = [from, to];
    this.selected = null;
    this.render();
    moveSound(isCapture);
  }

  setLegalMoves(list) { this.legalMoves = list; }
  setInteractive(v)   { this.interactive = v; if (!v) { this.selected = null; } this.render(); }

  flash(from, to, cls) {
    this.render();
    for (const sq of [from, to]) {
      const el = this.el.querySelector(`[data-sq="${sq}"]`);
      if (el) el.classList.add(cls);
    }
  }

  render() {
    this.el.innerHTML = '';
    const ranks = this.orientation === 'w' ? [8,7,6,5,4,3,2,1] : [1,2,3,4,5,6,7,8];
    const files = this.orientation === 'w' ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];

    for (const r of ranks) {
      for (const f of files) {
        const sq = FILES[f] + r;
        const cell = document.createElement('div');
        cell.className = 'sq ' + ((f + r) % 2 === 0 ? 'light' : 'dark');
        cell.dataset.sq = sq;

        const piece = this.pos[sq];
        if (piece) {
          const img = document.createElement('img');
          img.className = 'piece';
          img.src = pieceSrc(piece);
          img.alt = piece;
          img.draggable = false;
          cell.appendChild(img);
        }

        if (this.lastMove && (sq === this.lastMove[0] || sq === this.lastMove[1]))
          cell.classList.add('last');

        if (sq === this.selected) cell.classList.add('selected');

        if (this.selected && this.interactive) {
          const target = this.legalMoves.some(m => m.startsWith(this.selected) && m.slice(2, 4) === sq);
          if (target) cell.classList.add(piece ? 'hint-ring' : 'hint-dot');
        }

        // coordinates on edge squares
        const isLastFile = f === files[7];
        const isLastRank = r === ranks[7];
        if (isLastFile || isLastRank) {
          if (isLastFile) cell.appendChild(coord(r, 'coord-rank'));
          if (isLastRank) cell.appendChild(coord(FILES[f], 'coord-file'));
        }

        this.el.appendChild(cell);
      }
    }
    this._renderArrows();
  }

  /* ── arrows ──────────────────────────────────────────────────────────── */

  _sqCenter(sq) {
    const f = FILES.indexOf(sq[0]);
    const r = +sq[1];
    const col = this.orientation === 'w' ? f : 7 - f;
    const row = this.orientation === 'w' ? 8 - r : r - 1;
    return [(col + 0.5) * 12.5, (row + 0.5) * 12.5];
  }

  _renderArrows(preview = null) {
    let svg = this.el.querySelector('.arrow-layer');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'arrow-layer');
      svg.setAttribute('viewBox', '0 0 100 100');
      this.el.appendChild(svg);
    }
    const all = preview ? [...this.arrows, preview] : this.arrows;
    svg.innerHTML = all.map(a => this._arrowSvg(a)).join('');
  }

  _arrowSvg(a) {
    const [x1, y1] = this._sqCenter(a.from);
    const [x2, y2] = this._sqCenter(a.to);

    /* knight-shaped moves get an L: long leg first, then the short leg */
    const fdx = Math.abs(FILES.indexOf(a.to[0]) - FILES.indexOf(a.from[0]));
    const rdy = Math.abs(+a.to[1] - +a.from[1]);
    let cx = null, cy = null;
    if ((fdx === 1 && rdy === 2) || (fdx === 2 && rdy === 1)) {
      if (fdx === 2) { cx = x2; cy = y1; }   // horizontal long leg
      else           { cx = x1; cy = y2; }   // vertical long leg
    }

    const sx = cx === null ? x1 : cx, sy = cy === null ? y1 : cy;
    const len = Math.hypot(x2 - sx, y2 - sy);
    if (!len) return '';
    const ux = (x2 - sx) / len, uy = (y2 - sy) / len;
    const ex = x2 - ux * 4.5, ey = y2 - uy * 4.5;                 // line stops before the head
    const h1x = x2 - ux * 6 - uy * 3, h1y = y2 - uy * 6 + ux * 3; // arrowhead wings
    const h2x = x2 - ux * 6 + uy * 3, h2y = y2 - uy * 6 - ux * 3;

    let out = '';
    if (cx !== null)
      out += `<line x1="${x1}" y1="${y1}" x2="${cx}" y2="${cy}" stroke-width="2.4" stroke-linecap="round"/>`;
    out += `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke-width="2.4" stroke-linecap="round"/>`
         + `<polygon points="${x2},${y2} ${h1x},${h1y} ${h2x},${h2y}"/>`;
    return out;
  }

  /* ── pointer handling: click-to-move + drag-to-move ─────────────────── */

  _squareFromEvent(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest ? el.closest('.sq') : null;
    return cell && this.el.contains(cell) ? cell.dataset.sq : null;
  }

  /** Resolve a from/to pair: a plain uci move, 'promo' (needs a picker), or null. */
  _resolveMove(from, to) {
    const uci = from + to;
    if (this.legalMoves.includes(uci)) return uci;
    if (this.legalMoves.some(m => m.startsWith(uci) && m.length === 5)) return 'promo';
    return null;
  }

  /** Try to play from→to: opens the promotion picker when needed. */
  _tryMove(from, to) {
    const res = this._resolveMove(from, to);
    if (!res) { this.render(); return; }
    if (res === 'promo') { this._showPromoPicker(from, to); return; }
    this.onMove(res);
  }

  _showPromoPicker(from, to) {
    this.render();
    const overlay = document.createElement('div');
    overlay.className = 'promo-overlay';
    overlay.addEventListener('pointerdown', ev => ev.stopPropagation());
    overlay.addEventListener('click', ev => {
      if (ev.target === overlay) { overlay.remove(); this.render(); }
    });

    const box = document.createElement('div');
    box.className = 'promo-box';
    for (const p of ['q', 'r', 'b', 'n']) {
      const btn = document.createElement('button');
      btn.className = 'promo-btn';
      btn.type = 'button';
      const img = document.createElement('img');
      img.src = `pieces/${this.turn}${p.toUpperCase()}.svg`;
      img.alt = p;
      img.draggable = false;
      btn.appendChild(img);
      btn.addEventListener('click', () => {
        overlay.remove();
        this.onMove(from + to + p);
      });
      box.appendChild(btn);
    }
    overlay.appendChild(box);
    this.el.appendChild(overlay);
  }

  _pointerDown(e) {
    const cell = e.target.closest ? e.target.closest('.sq') : null;
    if (!cell) return;
    const sq = cell.dataset.sq;

    /* right button always starts an arrow drag (works even when locked) */
    if (e.pointerType === 'mouse' && e.button === 2) {
      e.preventDefault();
      this.arrowDrag = { from: sq, right: true, moved: false, x: e.clientX, y: e.clientY };
      this.el.setPointerCapture(e.pointerId);
      return;
    }

    if (!this.interactive) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const piece = this.pos[sq];
    const mine = piece && (piece === piece.toUpperCase() ? 'w' : 'b') === this.turn;

    /* left press on an empty/enemy square: click-move resolves on pointerup,
       dragging instead draws an arrow */
    if (!mine) {
      this.arrowDrag = { from: sq, right: false, moved: false, x: e.clientX, y: e.clientY };
      this.el.setPointerCapture(e.pointerId);
      return;
    }

    e.preventDefault();
    this.arrows = [];                     // touching a piece wipes drawn arrows
    const wasSelected = this.selected === sq;
    this.selected = sq;                   // shows legal-move hints immediately
    this.render();
    this.drag = { from: sq, piece, wasSelected, active: false, ghost: null, over: null, x: e.clientX, y: e.clientY };
    this.el.setPointerCapture(e.pointerId);
  }

  _pointerMove(e) {
    const a = this.arrowDrag;
    if (a) {
      if (!a.moved && Math.hypot(e.clientX - a.x, e.clientY - a.y) < 5) return;
      a.moved = true;
      const over = this._squareFromEvent(e);
      this._renderArrows(over && over !== a.from ? { from: a.from, to: over } : null);
      return;
    }

    const d = this.drag;
    if (!d) return;

    if (!d.active) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.active = true;
      const src = this.el.querySelector(`[data-sq="${d.from}"]`);
      if (src) src.classList.add('drag-src');
      const ghost = document.createElement('img');
      ghost.className = 'piece drag-ghost';
      ghost.src = pieceSrc(d.piece);
      ghost.draggable = false;
      this.el.appendChild(ghost);
      d.ghost = ghost;
    }

    const rect = this.el.getBoundingClientRect();
    d.ghost.style.left = (e.clientX - rect.left) + 'px';
    d.ghost.style.top  = (e.clientY - rect.top) + 'px';

    const over = this._squareFromEvent(e);
    if (over !== d.over) {
      if (d.over) this.el.querySelector(`[data-sq="${d.over}"]`)?.classList.remove('drag-over');
      d.over = over;
      if (over && over !== d.from) this.el.querySelector(`[data-sq="${over}"]`)?.classList.add('drag-over');
    }
  }

  _pointerUp(e) {
    const a = this.arrowDrag;
    if (a) {
      this.arrowDrag = null;
      const to = this._squareFromEvent(e);
      if (a.moved && to && to !== a.from) {
        const i = this.arrows.findIndex(x => x.from === a.from && x.to === to);
        if (i >= 0) this.arrows.splice(i, 1);       // redraw toggles it off
        else this.arrows.push({ from: a.from, to });
        this._renderArrows();
        return;
      }
      this._renderArrows();                          // drop any preview
      if (a.right) {
        if (!a.moved) { this.arrows = []; this._renderArrows(); } // right-click clears
        return;
      }
      // clicking a piece (not an empty square) wipes drawn arrows
      if (to && this.pos[to] && this.arrows.length) {
        this.arrows = [];
        this._renderArrows();
      }
      // plain left click on an empty/enemy square → click-move
      if (!this.interactive || !this.selected || !to) return;
      const from = this.selected;
      this.selected = null;
      this._tryMove(from, to);
      return;
    }

    const d = this.drag;
    if (d) {
      this.drag = null;
      if (d.active) {
        this._clearDragMarks(d);
        const to = this._squareFromEvent(e);
        if (to && to !== d.from) {
          this.selected = null;
          this._tryMove(d.from, to);
          return;
        }
        this.render();                    // snap back (origin drop keeps selection)
        return;
      }
      // plain click on own piece: toggle selection off if it was already selected
      if (d.wasSelected) { this.selected = null; this.render(); }
    }
  }

  _cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this._clearDragMarks(d);
    this.render();
  }

  _clearDragMarks(d) {
    if (d.ghost) d.ghost.remove();
    this.el.querySelector('.drag-src')?.classList.remove('drag-src');
    this.el.querySelector('.drag-over')?.classList.remove('drag-over');
  }
}

function coord(text, cls) {
  const s = document.createElement('span');
  s.className = 'coord ' + cls;
  s.textContent = text;
  return s;
}

function parseFen(fen) {
  const pos = {};
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (isNaN(ch)) { pos[FILES[f] + (8 - r)] = ch; f++; }
      else f += +ch;
    }
  }
  return pos;
}
