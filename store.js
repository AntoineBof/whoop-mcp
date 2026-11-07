// Petit magasin cle-valeur durable pour le refresh token Whoop.
//
// Trois implementations, choisies dans cet ordre :
//   1. REDIS_URL        -> Render Key Value (protocole Redis)
//   2. UPSTASH_*        -> Upstash Redis (API REST)
//   3. rien             -> memoire, pour le developpement local uniquement
//
// Aucune ne demande de disque persistant, ce que le palier gratuit de
// Render ne fournit pas.

import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const backend = REDIS_URL ? 'redis' : UPSTASH_URL && UPSTASH_TOKEN ? 'upstash' : 'memory';
export const isDurable = backend !== 'memory';

const memory = new Map();

// --- Render Key Value -----------------------------------------------------
let clientPromise = null;

async function redisClient() {
  if (!clientPromise) {
    const client = createClient({
      url: REDIS_URL,
      socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 2000) },
    });
    client.on('error', (error) => console.error('Erreur Redis :', error.message));
    clientPromise = client.connect().then(() => client);
  }
  try {
    return await clientPromise;
  } catch (error) {
    clientPromise = null;
    throw error;
  }
}

// --- Upstash REST ---------------------------------------------------------
async function upstash(args) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Upstash ${res.status} sur ${args[0]} : ${text.slice(0, 300)}`);
  const payload = JSON.parse(text);
  if (payload.error) throw new Error(`Upstash : ${payload.error}`);
  return payload.result;
}

// --- API commune ----------------------------------------------------------
export async function get(key) {
  if (backend === 'redis') return (await redisClient()).get(key);
  if (backend === 'upstash') return upstash(['GET', key]);
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

export async function set(key, value, { ttlSeconds } = {}) {
  if (backend === 'redis') {
    const client = await redisClient();
    await client.set(key, value, ttlSeconds ? { EX: ttlSeconds } : undefined);
    return;
  }
  if (backend === 'upstash') {
    const args = ['SET', key, value];
    if (ttlSeconds) args.push('EX', String(ttlSeconds));
    await upstash(args);
    return;
  }
  memory.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
}

export async function del(key) {
  if (backend === 'redis') {
    await (await redisClient()).del(key);
    return;
  }
  if (backend === 'upstash') {
    await upstash(['DEL', key]);
    return;
  }
  memory.delete(key);
}

export async function getJson(key) {
  const raw = await get(key);
  if (raw == null) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function setJson(key, value, options) {
  await set(key, JSON.stringify(value), options);
}

export async function ping() {
  if (backend === 'redis') {
    await (await redisClient()).ping();
    return 'redis';
  }
  if (backend === 'upstash') {
    await upstash(['PING']);
    return 'upstash';
  }
  return 'memory';
}
