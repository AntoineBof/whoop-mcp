// Serveur HTTP : endpoint MCP (transport Streamable HTTP), flux OAuth
// Whoop et sonde de sante legere pour le reveil matinal.

import crypto from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { authorizeUrl, exchangeCode, redirectUri, status, SCOPES } from './tokens.js';
import { getJson, setJson, del, isDurable, ping, backend } from './store.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

const PORT = process.env.PORT || 10000;
const MCP_SECRET = process.env.MCP_SECRET || '';

function secretMatches(candidate) {
  if (!MCP_SECRET || !candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(MCP_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- Sonde de sante -------------------------------------------------------
// Volontairement minimale : aucun appel reseau, aucune lecture du store.
// C'est elle que le reveil matinal appelle pour sortir le service de veille.
app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

// --- Page d'accueil -------------------------------------------------------
app.get('/', (_req, res) => {
  res.type('text/plain').send(
    [
      'Serveur MCP Whoop.',
      '',
      'Endpoints :',
      '  GET  /healthz              sonde de sante',
      '  GET  /oauth/start?k=SECRET lance l\'autorisation Whoop',
      '  GET  /oauth/callback       retour OAuth (a declarer dans l\'app Whoop)',
      '  POST /mcp/SECRET           endpoint MCP a coller dans Claude',
      '',
      'Aucune donnee personnelle n\'est exposee sans le secret.',
    ].join('\n'),
  );
});

// --- Diagnostic protege ---------------------------------------------------
app.get('/debug', async (req, res) => {
  if (!secretMatches(req.query.k)) return res.status(404).end();
  let storeState = 'inconnu';
  try {
    storeState = await ping();
  } catch (error) {
    storeState = `erreur : ${error.message}`;
  }
  res.json({
    store: storeState,
    store_durable: isDurable,
    backend,
    redirect_uri: safe(() => redirectUri()),
    scopes: SCOPES,
    whoop_client_id_present: Boolean(process.env.WHOOP_CLIENT_ID),
    whoop_client_secret_present: Boolean(process.env.WHOOP_CLIENT_SECRET),
    tokens: await status(),
  });
});

function safe(fn) {
  try {
    return fn();
  } catch (error) {
    return `erreur : ${error.message}`;
  }
}

// --- OAuth ----------------------------------------------------------------
app.get('/oauth/start', async (req, res) => {
  if (!secretMatches(req.query.k)) return res.status(404).end();
  try {
    // Whoop exige un state d'au moins 8 caracteres.
    const state = crypto.randomBytes(12).toString('hex');
    await setJson(`whoop:state:${state}`, { created_at: Date.now() }, { ttlSeconds: 600 });
    res.redirect(authorizeUrl(state));
  } catch (error) {
    res.status(500).type('text/plain').send(`Impossible de lancer l'autorisation : ${error.message}`);
  }
});

app.get('/oauth/callback', async (req, res) => {
  const { code, state, error: oauthError, error_description: description } = req.query;
  if (oauthError) {
    return res
      .status(400)
      .type('text/plain')
      .send(`Whoop a refuse l'autorisation : ${oauthError} ${description || ''}`);
  }
  if (!code || !state) {
    return res.status(400).type('text/plain').send('Parametres code ou state manquants.');
  }
  try {
    const key = `whoop:state:${state}`;
    const pending = await getJson(key);
    if (!pending) {
      return res
        .status(400)
        .type('text/plain')
        .send('State inconnu ou expire. Relance /oauth/start?k=TON_SECRET.');
    }
    await del(key);
    const tokens = await exchangeCode(String(code));
    res.type('text/html').send(
      `<!doctype html><meta charset="utf-8"><title>Whoop connecte</title>
       <body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.6">
       <h1>C'est bon.</h1>
       <p>Le refresh token Whoop est enregistre dans le stockage durable.
       Scopes accordes : <code>${tokens.scope}</code>.</p>
       <p>${isDurable ? 'Stockage durable actif. Tu n\'auras normalement plus a repasser par cette page.' : '<strong>Attention :</strong> aucun stockage durable configure, le jeton est garde en memoire et sera perdu a la prochaine mise en veille.'}</p>
       <p>Tu peux fermer cet onglet et interroger Whoop depuis Claude.</p></body>`,
    );
  } catch (error) {
    res.status(500).type('text/plain').send(`Echange du code impossible : ${error.message}`);
  }
});

// --- Endpoint MCP ---------------------------------------------------------
// Mode sans session : un serveur et un transport par requete. C'est le plus
// robuste sur Render gratuit, ou le process peut etre tue entre deux appels.
async function handleMcp(req, res) {
  if (!secretMatches(req.params.secret)) return res.status(404).end();
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Erreur MCP :', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Erreur interne du serveur MCP.' },
        id: null,
      });
    }
  }
}

app.post('/mcp/:secret', handleMcp);
app.get('/mcp/:secret', handleMcp);
app.delete('/mcp/:secret', handleMcp);

// --- Demarrage ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Serveur MCP Whoop en ecoute sur le port ${PORT}`);
  if (!MCP_SECRET) {
    console.warn('MCP_SECRET absent : l\'endpoint MCP et le flux OAuth repondront 404.');
  }
  if (!isDurable) {
    console.warn(
      'Aucun stockage durable configure (ni REDIS_URL ni UPSTASH_*) : memoire seulement, ' +
        'le refresh token sera perdu a chaque redemarrage.',
    );
  }
});
