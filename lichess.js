// Client minimal de l'API publique Lichess (aucune authentification requise).
// Documentation : https://lichess.org/api

const API_BASE = 'https://lichess.org';
const USERNAME = process.env.LICHESS_USERNAME || 'AntoineBof';
const TIMEZONE = process.env.LICHESS_TIMEZONE || 'Europe/Paris';
const USER_AGENT = 'whoop-mcp (serveur MCP personnel)';

// Lichess diffuse environ 20 parties par seconde sans authentification.
// On s'arrete avant le delai d'attente du client MCP et on signale la reprise.
const STREAM_BUDGET_MS = 35_000;

export function lichessUsername() {
  return USERNAME;
}

function toMs(value, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Date.parse(endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Date illisible : ${value}. Utilise AAAA-MM-JJ ou un ISO 8601 complet.`);
  }
  return ms;
}

async function getJson(path, params) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Lichess ${res.status} sur ${path} : ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function localParts(ms) {
  const parts = {};
  for (const part of partsFormatter.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    hour: Number(parts.hour),
  };
}

// Transforme une partie brute en ligne compacte vue du cote du joueur.
function compact(game, cutoffHour) {
  const me = USERNAME.toLowerCase();
  const isWhite = game.players?.white?.user?.id === me;
  const color = isWhite ? 'white' : 'black';
  const mine = game.players?.[color] || {};
  const theirs = game.players?.[isWhite ? 'black' : 'white'] || {};
  const result = !game.winner ? 'N' : game.winner === color ? 'G' : 'P';
  const local = localParts(game.createdAt);
  // Une partie jouee apres minuit appartient a la journee de la veille.
  const day = localParts(game.createdAt - cutoffHour * 3_600_000).date;
  const plies = game.moves ? game.moves.split(' ').length : 0;
  let myClock = null;
  let theirClock = null;
  if (Array.isArray(game.clocks) && game.clocks.length) {
    const offset = isWhite ? 0 : 1;
    for (let i = game.clocks.length - 1; i >= 0; i -= 1) {
      if (myClock === null && i % 2 === offset) myClock = Math.round(game.clocks[i] / 100);
      if (theirClock === null && i % 2 !== offset) theirClock = Math.round(game.clocks[i] / 100);
      if (myClock !== null && theirClock !== null) break;
    }
  }
  return {
    id: game.id,
    date: local.date,
    heure: local.time,
    heure_num: local.hour,
    jour: day,
    cadence: game.speed,
    variante: game.variant,
    temps: game.clock ? `${game.clock.initial / 60}+${game.clock.increment}` : '',
    classee: game.rated ? 1 : 0,
    couleur: isWhite ? 'B' : 'N',
    resultat: result,
    elo: mine.rating ?? null,
    elo_adv: theirs.rating ?? null,
    diff: mine.ratingDiff ?? null,
    fin: game.status,
    coups: Math.ceil(plies / 2),
    eco: game.opening?.eco || '',
    ouverture: game.opening?.name || '',
    pendule: myClock,
    pendule_adv: theirClock,
    precision: mine.analysis?.accuracy ?? null,
    gaffes: mine.analysis?.blunder ?? null,
  };
}

// Lit le flux NDJSON des parties, dans l'ordre chronologique.
async function streamGames({ start, end, max, perfType, rated, cutoffHour = 5 }) {
  const url = new URL(`${API_BASE}/api/games/user/${encodeURIComponent(USERNAME)}`);
  const params = {
    since: toMs(start),
    until: toMs(end, { endOfDay: true }),
    max,
    perfType,
    rated: rated === undefined ? undefined : String(rated),
    sort: 'dateAsc',
    clocks: 'true',
    opening: 'true',
    accuracy: 'true',
    moves: 'true',
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { Accept: 'application/x-ndjson', 'User-Agent': USER_AGENT },
    signal: controller.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lichess ${res.status} sur les parties : ${text.slice(0, 300)}`);
  }
  const deadline = Date.now() + STREAM_BUDGET_MS;
  const decoder = new TextDecoder();
  const games = [];
  let buffer = '';
  let truncated = false;
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) games.push(compact(JSON.parse(line), cutoffHour));
      }
      if (Date.now() > deadline) {
        truncated = true;
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (!truncated) throw error;
  }
  if (!truncated && buffer.trim()) games.push(compact(JSON.parse(buffer), cutoffHour));
  if (max && games.length >= max) truncated = true;
  const last = games[games.length - 1];
  return {
    games,
    truncated,
    // Pour reprendre : relancer avec start egal a cette valeur.
    resume: truncated && last ? `${last.date}T${last.heure}:00` : null,
    lastId: last?.id ?? null,
  };
}

const COLUMNS = [
  'id', 'jour', 'date', 'heure', 'cadence', 'temps', 'classee', 'couleur', 'resultat',
  'elo', 'elo_adv', 'diff', 'fin', 'coups', 'eco', 'ouverture', 'pendule', 'pendule_adv',
  'precision', 'gaffes',
];

function toTsv(games) {
  const lines = [COLUMNS.join('\t')];
  for (const game of games) {
    lines.push(COLUMNS.map((key) => (game[key] === null || game[key] === undefined ? '' : game[key])).join('\t'));
  }
  return lines.join('\n');
}

function aggregateByDay(games) {
  const days = new Map();
  for (const game of games) {
    if (game.variante !== 'standard') continue;
    let day = days.get(game.jour);
    if (!day) {
      day = { jour: game.jour, parties: 0, G: 0, N: 0, P: 0, diff: 0, classees: 0, cadences: {}, heures: [], precisions: [] };
      days.set(game.jour, day);
    }
    day.parties += 1;
    day[game.resultat] += 1;
    if (game.classee) {
      day.classees += 1;
      day.diff += game.diff || 0;
    }
    const speed = (day.cadences[game.cadence] ||= { parties: 0, G: 0, N: 0, P: 0, diff: 0, elo_fin: null });
    speed.parties += 1;
    speed[game.resultat] += 1;
    if (game.classee) {
      speed.diff += game.diff || 0;
      if (game.elo !== null) speed.elo_fin = game.elo + (game.diff || 0);
    }
    day.heures.push(game.heure_num);
    if (game.precision !== null) day.precisions.push(game.precision);
  }
  return [...days.values()].map((day) => {
    const { heures, precisions, ...rest } = day;
    return {
      ...rest,
      score_pct: Math.round((100 * (day.G + day.N / 2)) / day.parties),
      premiere_heure: Math.min(...heures),
      derniere_heure: Math.max(...heures),
      precision_moy: precisions.length
        ? Math.round(precisions.reduce((a, b) => a + b, 0) / precisions.length)
        : null,
    };
  });
}

export const lichess = {
  profile: () => getJson(`/api/user/${encodeURIComponent(USERNAME)}`),
  ratingHistory: () => getJson(`/api/user/${encodeURIComponent(USERNAME)}/rating-history`),
  perf: (perf) => getJson(`/api/user/${encodeURIComponent(USERNAME)}/perf/${encodeURIComponent(perf)}`),
  game: (id) =>
    getJson(`/game/export/${encodeURIComponent(id)}`, {
      clocks: 'true',
      evals: 'true',
      opening: 'true',
      accuracy: 'true',
      pgnInJson: 'true',
      literate: 'true',
    }),
  async games(options) {
    const { games, truncated, resume, lastId } = await streamGames(options);
    return { total: games.length, tronque: truncated, reprendre_a_partir_de: resume, derniere_id: lastId, tsv: toTsv(games) };
  },
  async daily(options) {
    const { games, truncated, resume } = await streamGames(options);
    return { parties_lues: games.length, tronque: truncated, reprendre_a_partir_de: resume, jours: aggregateByDay(games) };
  },
};
