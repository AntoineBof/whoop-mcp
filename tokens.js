// Gestion du cycle de vie des jetons OAuth Whoop.
//
// Rappel important : les refresh tokens Whoop sont tournants et a usage
// unique. Chaque rafraichissement renvoie un nouveau refresh token et
// invalide l'ancien. Le jeton courant doit donc etre ecrit dans un
// stockage durable (Upstash) et jamais seulement en memoire : sur Render
// gratuit le process est tue a chaque mise en veille.

import { getJson, setJson, del } from './store.js';

const TOKEN_KEY = 'whoop:tokens';
const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';

export const SCOPES = [
  'offline',
  'read:profile',
  'read:body_measurement',
  'read:recovery',
  'read:sleep',
  'read:cycles',
  'read:workout',
];

// Marge de securite : on rafraichit avant l'expiration reelle.
const EXPIRY_MARGIN_MS = 120_000;

function clientId() {
  const value = process.env.WHOOP_CLIENT_ID;
  if (!value) throw new Error('WHOOP_CLIENT_ID absent de l\'environnement.');
  return value;
}

function clientSecret() {
  const value = process.env.WHOOP_CLIENT_SECRET;
  if (!value) throw new Error('WHOOP_CLIENT_SECRET absent de l\'environnement.');
  return value;
}

export function baseUrl() {
  const value = process.env.PUBLIC_BASE_URL;
  if (!value) throw new Error('PUBLIC_BASE_URL absent de l\'environnement.');
  return value.replace(/\/+$/, '');
}

export function redirectUri() {
  return `${baseUrl()}/oauth/callback`;
}

export function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function postToken(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Whoop a refuse la demande de jeton (${res.status}) : ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

function normalize(payload, previous) {
  if (!payload.access_token) {
    throw new Error('Reponse Whoop sans access_token.');
  }
  return {
    access_token: payload.access_token,
    // Whoop renvoie un nouveau refresh token a chaque rotation. On garde
    // l'ancien seulement si la reponse n'en contient pas.
    refresh_token: payload.refresh_token || previous?.refresh_token || null,
    expires_at: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    scope: payload.scope || previous?.scope || SCOPES.join(' '),
    obtained_at: Date.now(),
  };
}

export async function exchangeCode(code) {
  const payload = await postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
  });
  const tokens = normalize(payload);
  if (!tokens.refresh_token) {
    throw new Error(
      'Whoop n\'a pas renvoye de refresh token. Verifie que le scope "offline" est bien demande et autorise sur l\'app.',
    );
  }
  await setJson(TOKEN_KEY, tokens);
  return tokens;
}

async function readTokens() {
  const stored = await getJson(TOKEN_KEY);
  if (stored?.refresh_token) return stored;
  // Amorce facultative : un refresh token colle a la main en variable
  // d'environnement. Utilise une seule fois, puis remplace dans le store.
  const seed = process.env.WHOOP_REFRESH_TOKEN;
  if (seed) {
    return { access_token: null, refresh_token: seed, expires_at: 0, scope: SCOPES.join(' ') };
  }
  return null;
}

async function refresh(previous) {
  const payload = await postToken({
    grant_type: 'refresh_token',
    refresh_token: previous.refresh_token,
    client_id: clientId(),
    client_secret: clientSecret(),
    scope: 'offline',
  });
  const tokens = normalize(payload, previous);
  // Ecriture immediate : si le process meurt juste apres, le jeton
  // tournant ne doit pas etre perdu.
  await setJson(TOKEN_KEY, tokens);
  return tokens;
}

export class NeedsAuthorization extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeedsAuthorization';
  }
}

let inFlight = null;

export async function getAccessToken({ force = false } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const tokens = await readTokens();
    if (!tokens) {
      throw new NeedsAuthorization(
        'Aucun jeton Whoop enregistre. Ouvre /oauth/start?k=TON_SECRET pour autoriser l\'acces une premiere fois.',
      );
    }
    const stillValid =
      tokens.access_token && tokens.expires_at - EXPIRY_MARGIN_MS > Date.now();
    if (stillValid && !force) return tokens.access_token;

    try {
      const next = await refresh(tokens);
      return next.access_token;
    } catch (error) {
      // Refresh token perime ou revoque : il faut repasser par l'autorisation.
      if (/40[013]/.test(String(error.message))) {
        await del(TOKEN_KEY);
        throw new NeedsAuthorization(
          `Le refresh token Whoop n'est plus valide (${error.message}). Reouvre /oauth/start?k=TON_SECRET pour reautoriser.`,
        );
      }
      throw error;
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function status() {
  const tokens = await getJson(TOKEN_KEY);
  if (!tokens) return { authorized: false };
  return {
    authorized: Boolean(tokens.refresh_token),
    scope: tokens.scope,
    access_token_expires_at: new Date(tokens.expires_at).toISOString(),
    access_token_valid: tokens.expires_at > Date.now(),
    last_refresh: tokens.obtained_at ? new Date(tokens.obtained_at).toISOString() : null,
  };
}
