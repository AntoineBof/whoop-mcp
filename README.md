# whoop-mcp

Serveur MCP distant qui expose mes données Whoop (API Developer v2) à Claude
en tant que connecteur personnalisé. Un seul utilisateur, hébergement Render
palier gratuit, aucun disque persistant.

## Outils exposés

| Outil | Contenu |
| --- | --- |
| `whoop_today` | Dernière récupération, dernier sommeil, cycle en cours |
| `whoop_recovery` | Récupération, VFC (HRV), FC de repos, SpO2, température cutanée |
| `whoop_sleep` | Sessions de sommeil, stages, performance, efficacité, régularité |
| `whoop_cycles` | Cycles physiologiques, strain, calories, FC moyenne et max |
| `whoop_workouts` | Séances, type d'activité, strain, zones de FC, distance |
| `whoop_profile` | Profil de base |
| `whoop_body_measurement` | Taille, poids, FC max |
| `whoop_auth_status` | Diagnostic de l'autorisation OAuth, sans appel à Whoop |

Les périodes acceptent `AAAA-MM-JJ` ou un ISO 8601 complet. Tout est en
lecture seule, aucune écriture vers Whoop.

## Choix techniques

**Transport Streamable HTTP, sans session.** Un serveur MCP et un transport
sont créés par requête. Sur le palier gratuit Render le process est tué
après 15 minutes d'inactivité, donc aucun état en mémoire ne peut être
supposé entre deux appels.

**Stockage du refresh token dans un Key Value Render, pas en variable
d'environnement.** Les refresh tokens Whoop sont tournants et à usage
unique : chaque rafraîchissement en renvoie un nouveau et invalide
l'ancien. Une variable d'environnement serait donc périmée dès le premier
rafraîchissement, et comme la mise en veille efface la mémoire, il faudrait
se réauthentifier à chaque réveil. Le Key Value du blueprint est joignable
sur le réseau privé Render, ne demande aucun disque et vit dans le même
compte. Limite assumée du palier gratuit : il n'a pas de persistance sur
disque, donc un redémarrage de l'instance Redis efface la clé et il faut
réautoriser une fois, en ouvrant `/oauth/start`. Upstash Redis reste
supporté via `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` si tu
veux une persistance réelle plus tard. `WHOOP_REFRESH_TOKEN` est accepté
comme amorce manuelle facultative.

**Protection par URL secrète.** L'endpoint MCP vit sur `/mcp/<MCP_SECRET>`.
Tout chemin dont le secret ne correspond pas répond 404, sans fuite
d'information. Implémenter un OAuth complet côté serveur MCP serait plus
conforme à la spécification, mais représente beaucoup de code pour un
utilisateur unique.

**Réveil par GitHub Actions, pas par un cron Render.** Les cron jobs Render
sont facturés (minimum d'environ 1 $ par mois et par job) et planifiés en
UTC uniquement. `.github/workflows/wake.yml` appelle `/healthz` à 7h50 heure
de Paris, avec deux créneaux UTC et une garde pour couvrir le changement
d'heure. La sonde est volontairement minimale : aucun appel réseau, aucune
lecture du store.

**Aucun secret dans le dépôt.** Les identifiants Whoop vivent uniquement
dans les variables d'environnement Render, marquées `sync: false` dans le
blueprint.

## Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `WHOOP_CLIENT_ID` | Client ID de l'app Whoop |
| `WHOOP_CLIENT_SECRET` | Client secret de l'app Whoop |
| `PUBLIC_BASE_URL` | URL publique du service, sans slash final |
| `MCP_SECRET` | Secret de l'URL MCP et du flux OAuth |
| `REDIS_URL` | Key Value Render, injecté par le blueprint |
| `UPSTASH_REDIS_REST_URL` | Alternative Upstash, optionnel |
| `UPSTASH_REDIS_REST_TOKEN` | Alternative Upstash, optionnel |
| `WHOOP_REFRESH_TOKEN` | Optionnel, amorce manuelle |

## Scopes demandés

`offline` (indispensable pour obtenir un refresh token), `read:profile`,
`read:body_measurement`, `read:recovery`, `read:sleep`, `read:cycles`,
`read:workout`.

## Endpoints

```
GET  /healthz              sonde de santé
GET  /oauth/start?k=SECRET lance l'autorisation Whoop
GET  /oauth/callback       redirect URI à déclarer dans l'app Whoop
GET  /debug?k=SECRET       diagnostic (store, scopes, état des jetons)
POST /mcp/SECRET           endpoint MCP à coller dans Claude
```

## Dépannage

- **Claude dit que l'outil n'est pas autorisé** : ouvrir `/oauth/start?k=SECRET`
  pour réautoriser. Le refresh token a été révoqué ou perdu.
- **`whoop_auth_status` renvoie `authorized: false`** : même remède.
- **`/debug` affiche `store: memory`** : aucun stockage durable n'est lu, le
  jeton ne survivra pas à la mise en veille.
- **Première question de la journée lente** : le service dort, comptez une
  minute. Le workflow de réveil limite le cas au reste de la journée.

## Développement local

```bash
npm install
cp .env.example .env   # puis remplir
node --env-file=.env src/index.js
```
