/**
 * engine.js — wraps the Stockfish WASM worker with a promise-based job queue.
 *
 * Scores are normalized to the SIDE TO MOVE's perspective in centipawns.
 * Mate scores are mapped to ±(MATE_SCORE − pliesToMate) so that ordinary
 * numeric comparisons work and mates rank above any material advantage.
 */

export const MATE_SCORE = 100000;

export class Engine {
  constructor(workerPath = 'engine/stockfish.js') {
    this.worker = new Worker(workerPath);
    this.queue = Promise.resolve(); // serialize jobs
    this._listeners = [];
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : e.data?.data ?? '';
      for (const fn of this._listeners) fn(line);
    };
  }

  _send(cmd) { this.worker.postMessage(cmd); }

  _listen(fn) {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i !== -1) this._listeners.splice(i, 1);
    };
  }

  /** Wait for engine boot. */
  init() {
    return this._enqueue(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('Engine init timeout')); }, 20000);
      let sawUci = false;
      const off = this._listen((line) => {
        if (line === 'uciok' && !sawUci) { sawUci = true; this._send('isready'); }
        if (line === 'readyok') { clearTimeout(timer); off(); resolve(); }
      });
      this._send('uci');
    }));
  }

  /**
   * Analyze a FEN. Resolves { score, mateIn, pv }.
   *  - score:  cp from side-to-move POV (mate mapped near ±MATE_SCORE)
   *  - mateIn: plies to mate (positive = side to move mates) or null
   *  - pv:     array of UCI moves
   */
  analyze(fen, depth) {
    return this._enqueue(() => new Promise((resolve) => {
      let score = null, mateIn = null, pv = [];

      const finish = () => { off(); clearTimeout(timer); resolve({ score, mateIn, pv }); };
      const timer = setTimeout(finish, 30000);

      const off = this._listen((line) => {
        if (line.startsWith('info ')) {
          const cp = line.match(/score cp (-?\d+)/);
          const mate = line.match(/score mate (-?\d+)/);
          if (cp) { score = parseInt(cp[1]); mateIn = null; }
          else if (mate) {
            const m = parseInt(mate[1]);
            mateIn = m;
            score = m > 0 ? MATE_SCORE - m : -MATE_SCORE - m;
          }
          const pvM = line.match(/\spv\s(.+)$/);
          if (pvM) pv = pvM[1].trim().split(/\s+/);
        } else if (line.startsWith('bestmove')) {
          if (!pv.length) {
            const mv = line.split(/\s+/)[1];
            if (mv && mv !== '(none)') pv = [mv];
          }
          finish();
        }
      });

      this._send('position fen ' + fen);
      this._send('go depth ' + depth);
    }));
  }

  _enqueue(job) {
    const run = this.queue.then(job, job);
    // keep the chain alive even if a job rejects
    this.queue = run.catch(() => {});
    return run;
  }

  destroy() {
    try { this._send('quit'); } catch { /* noop */ }
    setTimeout(() => this.worker.terminate(), 300);
  }
}
