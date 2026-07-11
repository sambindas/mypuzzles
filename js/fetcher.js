/**
 * fetcher.js — pulls games for a user from Lichess or Chess.com, with pagination.
 *
 * Both APIs are CORS-enabled so this runs entirely in the browser.
 * Games are normalized to:
 *   { id, pgn, url, date, white, black, userColor, opponent, platform }
 */

const PAGE_SIZE = 10;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Creates a paginated game source. Call next() repeatedly;
 * it returns { games, done }. `done: true` means history is exhausted.
 */
export function createGameSource(platform, username) {
  if (platform === 'lichess') return lichessSource(username);
  if (platform === 'chesscom') return chesscomSource(username);
  throw new Error('Unknown platform: ' + platform);
}

/* ── Lichess ─────────────────────────────────────────────────────────────
 * GET /api/games/user/{u}?max=N&until=timestamp  (Accept: x-chess-pgn)
 * We page backwards using the `until` param with the createdAt of the
 * oldest game seen so far (from the PGN's UTCDate/UTCTime headers).
 *
 * To vary the puzzles between visits, paging starts at a random point in
 * the last ~3 years (phase 1: backwards from there to the beginning of
 * history, phase 2: the newer slice from that point up to today).
 */
function lichessSource(username) {
  const startAt = Date.now() - Math.floor(Math.random() * 3 * 365 * 864e5);
  let until = startAt;
  let phase = 1;      // 1: backwards from the random start, 2: the newer slice
  let done = false;

  return {
    platform: 'lichess',
    async next() {
      if (done) return { games: [], done: true };

      let url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}`
        + `?max=${PAGE_SIZE}&rated=true&perfType=blitz,rapid,classical`;
      if (phase === 2) url += `&since=${startAt}`;
      if (until) url += `&until=${until}`;

      const res = await fetch(url, { headers: { Accept: 'application/x-chess-pgn' } });
      if (res.status === 404) throw new Error(`User "${username}" not found on Lichess`);
      if (!res.ok) throw new Error(`Lichess API error (${res.status})`);

      const text = await res.text();
      const games = parseLichessPgns(text, username);

      if (games.length) {
        // page backwards: oldest game's timestamp minus 1ms
        const oldest = games[games.length - 1];
        until = oldest.timestamp - 1;
      }
      if (games.length < PAGE_SIZE) {
        if (phase === 1) { phase = 2; until = null; }  // now fetch the newer slice
        else done = true;
      }
      return { games, done };
    },
  };
}

function parseLichessPgns(text, username) {
  const blocks = text.split(/\n\n(?=\[Event)/).map(b => b.trim()).filter(Boolean);
  const games = [];

  for (const pgn of blocks) {
    const tag = name => (pgn.match(new RegExp(`\\[${name}\\s+"([^"]*)"`)) || [])[1] || '';
    const site = tag('Site');
    const id = tag('GameId') || site.split('/').pop();
    const white = tag('White');
    const black = tag('Black');
    const date = (tag('UTCDate') || tag('Date')).replace(/\./g, '-');
    const time = tag('UTCTime');
    const timestamp = Date.parse(`${date}T${time || '00:00:00'}Z`) || Date.now();

    const userIsWhite = white.toLowerCase() === username.toLowerCase();
    const userIsBlack = black.toLowerCase() === username.toLowerCase();
    if (!userIsWhite && !userIsBlack) continue;

    games.push({
      id,
      pgn,
      url: site || `https://lichess.org/${id}`,
      date,
      timestamp,
      white,
      black,
      userColor: userIsWhite ? 'w' : 'b',
      opponent: userIsWhite ? black : white,
      platform: 'lichess',
    });
  }
  return games;
}

/* ── Chess.com ───────────────────────────────────────────────────────────
 * GET /pub/player/{u}/games/archives  → list of month URLs (oldest→newest)
 * We walk the archive list backwards (newest month first), buffering games.
 */
function chesscomSource(username) {
  let archives = null;   // month URLs, newest first
  let archiveIdx = 0;
  let buffer = [];       // normalized games waiting to be served, newest first
  let done = false;

  async function loadArchiveList() {
    const res = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`);
    if (res.status === 404) throw new Error(`User "${username}" not found on Chess.com`);
    if (!res.ok) throw new Error(`Chess.com API error (${res.status})`);
    const data = await res.json();
    archives = shuffle(data.archives || []);  // random month order between visits
  }

  async function fillBuffer() {
    while (buffer.length < PAGE_SIZE && archiveIdx < archives.length) {
      const res = await fetch(archives[archiveIdx]);
      archiveIdx++;
      if (!res.ok) continue;
      const data = await res.json();
      const monthGames = (data.games || [])
        .filter(g => g.rules === 'chess' && g.pgn) // standard chess only
        .reverse();                                // newest first within month
      for (const g of monthGames) buffer.push(normalizeChesscom(g, username));
    }
    if (archiveIdx >= archives.length && buffer.length === 0) done = true;
  }

  return {
    platform: 'chesscom',
    async next() {
      if (done) return { games: [], done: true };
      if (!archives) await loadArchiveList();
      await fillBuffer();
      const games = buffer.splice(0, PAGE_SIZE).filter(Boolean);
      if (archiveIdx >= archives.length && buffer.length === 0) done = true;
      return { games, done };
    },
  };
}

function normalizeChesscom(g, username) {
  const white = g.white?.username || '';
  const black = g.black?.username || '';
  const userIsWhite = white.toLowerCase() === username.toLowerCase();
  const userIsBlack = black.toLowerCase() === username.toLowerCase();
  if (!userIsWhite && !userIsBlack) return null;

  const date = new Date((g.end_time || 0) * 1000).toISOString().slice(0, 10);

  return {
    id: g.uuid || g.url,
    pgn: g.pgn,
    url: g.url,
    date,
    timestamp: (g.end_time || 0) * 1000,
    white,
    black,
    userColor: userIsWhite ? 'w' : 'b',
    opponent: userIsWhite ? black : white,
    platform: 'chesscom',
  };
}
