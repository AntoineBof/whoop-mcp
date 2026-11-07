# Politique de confidentialité

Ce logiciel est un serveur personnel, utilisé par une seule personne :
son propriétaire, qui en est aussi l'unique utilisateur Whoop connecté.

## Données traitées

Le serveur lit, à la demande, les données du compte Whoop du propriétaire :
récupération, sommeil, cycles et strain, entraînements, profil de base et
mesures corporelles. L'accès est en lecture seule, aucune donnée n'est
écrite vers Whoop.

## Conservation

Aucune donnée Whoop n'est stockée. Les réponses de l'API sont relayées à la
demande et ne sont pas conservées après la requête. Seul le jeton OAuth est
conservé, dans un stockage clé-valeur privé, afin d'éviter une
réauthentification à chaque usage.

## Partage

Aucune donnée n'est vendue, partagée, ni transmise à un tiers. Le serveur
n'est accessible qu'à travers une URL contenant un secret, connue du seul
propriétaire, et répond 404 à toute autre requête.

## Révocation

L'accès peut être révoqué à tout moment depuis les réglages du compte
Whoop, ou en supprimant l'app dans le portail développeur Whoop. Le
service cesse alors immédiatement de pouvoir lire la moindre donnée.

## Contact

antoine.h.beaufils@gmail.com
