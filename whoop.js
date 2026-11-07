// Client minimal de l'API Whoop Developer v2.
// Base : https://api.prod.whoop.com/developer

import { getAccessToken } from './tokens.js';

const API_BASE = 'https://api.prod.whoop.com/developer';

// Plafond de securite : les resultats d'outils MCP sont limites cote
// Claude (environ 150 000 caracteres), inutile de ramener des annees.
const MAX_RECORDS = 200;

async function request(path, params, { retried = false } = {}) {
  const token = await getAccessToken({ force: retried });
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401 && !retried) {
    // Jeton rejete : on force un rafraichissement et on retente une fois.
    return request(path, params, { retried: true });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Whoop ${res.status} sur ${path} : ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

export function toIso(value, { endOfDay = false } = {}) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Date illisible : ${value}. Utilise AAAA-MM-JJ ou un ISO 8601 complet.`);
  }
  return date.toISOString();
}

export function daysAgoIso(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function collection(path, { start, end, limit = 25 } = {}) {
  const wanted = Math.min(Math.max(Number(limit) || 25, 1), MAX_RECORDS);
  const records = [];
  let nextToken;
  do {
    const pageSize = Math.min(25, wanted - records.length);
    const page = await request(path, {
      start,
      end,
      limit: pageSize,
      nextToken,
    });
    records.push(...(page?.records || []));
    nextToken = page?.next_token;
  } while (nextToken && records.length < wanted);
  return records.slice(0, wanted);
}

export const whoop = {
  profile: () => request('/v2/user/profile/basic'),
  bodyMeasurement: () => request('/v2/user/measurement/body'),
  recovery: (opts) => collection('/v2/recovery', opts),
  sleep: (opts) => collection('/v2/activity/sleep', opts),
  cycles: (opts) => collection('/v2/cycle', opts),
  workouts: (opts) => collection('/v2/activity/workout', opts),
};
