// Definition du serveur MCP et des outils de lecture Whoop et Lichess.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { whoop, toIso, daysAgoIso } from './whoop.js';
import { status as tokenStatus, NeedsAuthorization } from './tokens.js';
import { lichess, lichessUsername } from './lichess.js';

const rangeSchema = {
  start: z
    .string()
    .optional()
    .describe('Debut de periode, AAAA-MM-JJ ou ISO 8601. Par defaut : il y a 7 jours.'),
  end: z
    .string()
    .optional()
    .describe('Fin de periode, AAAA-MM-JJ ou ISO 8601. Par defaut : maintenant.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Nombre maximum d\'enregistrements a renvoyer (defaut 25, plafond 200).'),
};

function parseRange(args, defaultDays = 7) {
  return {
    start: args?.start ? toIso(args.start) : daysAgoIso(defaultDays),
    end: args?.end ? toIso(args.end, { endOfDay: true }) : undefined,
    limit: args?.limit,
  };
}

function ok(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(error) {
  const hint =
    error instanceof NeedsAuthorization
      ? error.message
      : `Erreur lors de l'appel : ${error.message}`;
  return { isError: true, content: [{ type: 'text', text: hint }] };
}

function guard(handler) {
  return async (args) => {
    try {
      return await handler(args || {});
    } catch (error) {
      return fail(error);
    }
  };
}

export function createServer() {
  const server = new McpServer(
    { name: 'whoop', version: '1.0.0' },
    {
      instructions:
        'Donnees Whoop personnelles en lecture seule : recuperation, sommeil, cycles et strain, ' +
        'entrainements, profil et mesures corporelles. Les dates acceptent AAAA-MM-JJ. ' +
        'Un cycle Whoop est une journee physiologique, qui ne commence pas a minuit. ' +
        'Le serveur expose aussi les parties d\'echecs Lichess du meme joueur (outils lichess_*), ' +
        'avec un champ "jour" aligne sur la journee Whoop (une partie jouee apres minuit compte pour la veille).',
    },
  );

  const readOnly = { readOnlyHint: true, openWorldHint: true };

  server.registerTool(
    'whoop_today',
    {
      title: 'Point du jour',
      description:
        'Synthese du jour : derniere recuperation, dernier sommeil et cycle en cours (strain). ' +
        'A utiliser pour une question generale du type "comment je vais aujourd\'hui".',
      inputSchema: {},
      annotations: readOnly,
    },
    guard(async () => {
      const [recovery, sleep, cycles] = await Promise.all([
        whoop.recovery({ limit: 1 }),
        whoop.sleep({ limit: 1 }),
        whoop.cycles({ limit: 1 }),
      ]);
      return ok({
        derniere_recuperation: recovery[0] ?? null,
        dernier_sommeil: sleep[0] ?? null,
        cycle_courant: cycles[0] ?? null,
      });
    }),
  );

  server.registerTool(
    'whoop_recovery',
    {
      title: 'Recuperation',
      description:
        'Scores de recuperation sur une periode : pourcentage de recuperation, VFC (HRV rmssd), ' +
        'frequence cardiaque de repos, SpO2, temperature cutanee.',
      inputSchema: rangeSchema,
      annotations: readOnly,
    },
    guard(async (args) => ok(await whoop.recovery(parseRange(args)))),
  );

  server.registerTool(
    'whoop_sleep',
    {
      title: 'Sommeil',
      description:
        'Sessions de sommeil sur une periode : duree des stages (leger, profond, REM), ' +
        'performance, efficacite, regularite, besoin de sommeil, frequence respiratoire.',
      inputSchema: rangeSchema,
      annotations: readOnly,
    },
    guard(async (args) => ok(await whoop.sleep(parseRange(args)))),
  );

  server.registerTool(
    'whoop_cycles',
    {
      title: 'Cycles et strain',
      description:
        'Cycles physiologiques Whoop sur une periode, avec le strain, les calories (kilojoules) ' +
        'et les frequences cardiaques moyenne et maximale.',
      inputSchema: rangeSchema,
      annotations: readOnly,
    },
    guard(async (args) => ok(await whoop.cycles(parseRange(args)))),
  );

  server.registerTool(
    'whoop_workouts',
    {
      title: 'Entrainements',
      description:
        'Seances enregistrees sur une periode : type d\'activite, strain, zones de frequence ' +
        'cardiaque, distance, denivele, energie depensee.',
      inputSchema: rangeSchema,
      annotations: readOnly,
    },
    guard(async (args) => ok(await whoop.workouts(parseRange(args, 30)))),
  );

  server.registerTool(
    'whoop_profile',
    {
      title: 'Profil',
      description: 'Profil Whoop de base : identifiant utilisateur, prenom, nom, adresse e-mail.',
      inputSchema: {},
      annotations: readOnly,
    },
    guard(async () => ok(await whoop.profile())),
  );

  server.registerTool(
    'whoop_body_measurement',
    {
      title: 'Mesures corporelles',
      description: 'Taille, poids et frequence cardiaque maximale enregistres dans Whoop.',
      inputSchema: {},
      annotations: readOnly,
    },
    guard(async () => ok(await whoop.bodyMeasurement())),
  );

  server.registerTool(
    'whoop_auth_status',
    {
      title: 'Etat de l\'autorisation',
      description:
        'Diagnostic : indique si un jeton Whoop valide est enregistre, ses scopes et sa date ' +
        'd\'expiration. N\'appelle pas l\'API Whoop.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async () => ok(await tokenStatus())),
  );

  // ---------------------------------------------------------------- Lichess

  const gamesSchema = {
    start: z.string().optional().describe('Debut de periode, AAAA-MM-JJ ou ISO 8601. Par defaut : il y a 7 jours.'),
    end: z.string().optional().describe('Fin de periode, AAAA-MM-JJ ou ISO 8601. Par defaut : maintenant.'),
    max: z.number().int().min(1).max(700).optional().describe('Nombre maximum de parties (defaut 300, plafond 700).'),
    cadence: z
      .string()
      .optional()
      .describe('Filtre de cadence, valeurs separees par des virgules : ultraBullet, bullet, blitz, rapid, classical, correspondence.'),
    classees: z.boolean().optional().describe('true pour les parties classees seulement, false pour les amicales seulement.'),
  };

  function gamesArgs(args, defaultMax) {
    return {
      start: args.start || daysAgoIso(7),
      end: args.end,
      max: args.max || defaultMax,
      perfType: args.cadence,
      rated: args.classees,
    };
  }

  server.registerTool(
    'lichess_profile',
    {
      title: 'Profil Lichess',
      description:
        `Profil Lichess de ${lichessUsername()} : classement et nombre de parties par cadence, ` +
        'totaux de victoires, nulles et defaites, temps de jeu.',
      inputSchema: {},
      annotations: readOnly,
    },
    guard(async () => ok(await lichess.profile())),
  );

  server.registerTool(
    'lichess_games',
    {
      title: 'Parties Lichess',
      description:
        'Liste compacte des parties sur une periode, dans l\'ordre chronologique, au format TSV : ' +
        'identifiant, jour (aligne sur la journee Whoop), date et heure de Paris, cadence, temps, couleur (B ou N), ' +
        'resultat (G gagnee, N nulle, P perdue), classements, variation de classement, type de fin, nombre de coups, ' +
        'ouverture, temps restant aux deux pendules en secondes, precision si la partie a ete analysee. ' +
        'Si "tronque" vaut true, relancer avec start egal a "reprendre_a_partir_de".',
      inputSchema: gamesSchema,
      annotations: readOnly,
    },
    guard(async (args) => ok(await lichess.games(gamesArgs(args, 300)))),
  );

  server.registerTool(
    'lichess_daily',
    {
      title: 'Resultats Lichess par jour',
      description:
        'Resultats agreges par journee (parties standard) : nombre de parties, victoires, nulles, defaites, ' +
        'score en pourcentage, variation de classement, detail par cadence, premiere et derniere heure de jeu. ' +
        'Le jour est aligne sur la journee Whoop, ce qui permet de croiser avec la recuperation et le sommeil. ' +
        'Si "tronque" vaut true, relancer avec start egal a "reprendre_a_partir_de".',
      inputSchema: gamesSchema,
      annotations: readOnly,
    },
    guard(async (args) => ok(await lichess.daily(gamesArgs(args, 700)))),
  );

  server.registerTool(
    'lichess_game',
    {
      title: 'Detail d\'une partie',
      description:
        'Une partie complete : PGN, coups, temps a la pendule coup par coup, ouverture et, si la partie ' +
        'a ete analysee sur Lichess, evaluations et erreurs. A utiliser pour commenter une partie precise.',
      inputSchema: { id: z.string().min(8).max(12).describe('Identifiant Lichess de la partie (8 caracteres).') },
      annotations: readOnly,
    },
    guard(async (args) => ok(await lichess.game(args.id.slice(0, 8)))),
  );

  server.registerTool(
    'lichess_rating_history',
    {
      title: 'Historique de classement',
      description:
        'Evolution du classement Lichess par cadence. Chaque point vaut [annee, mois (0 = janvier), jour, classement].',
      inputSchema: {
        cadence: z.string().optional().describe('Nom de cadence a garder, par exemple Blitz, Bullet ou Rapid. Par defaut : Bullet, Blitz et Rapid.'),
        depuis: z.string().optional().describe('Ne garder que les points a partir de cette date, AAAA-MM-JJ.'),
      },
      annotations: readOnly,
    },
    guard(async (args) => {
      const wanted = args.cadence ? [args.cadence.toLowerCase()] : ['bullet', 'blitz', 'rapid'];
      const since = args.depuis ? Date.parse(`${args.depuis}T00:00:00Z`) : 0;
      const history = await lichess.ratingHistory();
      return ok(
        history
          .filter((entry) => wanted.includes(entry.name.toLowerCase()))
          .map((entry) => ({
            cadence: entry.name,
            points: entry.points.filter(([y, m, d]) => Date.UTC(y, m, d) >= since),
          })),
      );
    }),
  );

  return server;
}
