<p align="center">
  <a href="README.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/housekeeping/readme.png" alt="housekeeping" width="400" />
</p>

<h1 align="center">housekeeping</h1>

<p align="center">
  An operational-health warehouse for a GitHub organization.<br>
  One sweep, one SQLite database, findings you can argue with,<br>
  and the whole-organization view an AI agent needs to coordinate every repository.
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/housekeeping/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/housekeeping/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://mcp-tool-shop-org.github.io/housekeeping/"><img src="https://img.shields.io/badge/Landing_Page-live-blue" alt="Landing Page" /></a>
  <a href="https://mcp-tool-shop-org.github.io/housekeeping/handbook/"><img src="https://img.shields.io/badge/Handbook-read-blue" alt="Handbook" /></a>
</p>

Une seule analyse collecte l’état des CI de chaque dépôt, les problèmes ouverts et les demandes de fusion,
les versions, les étiquettes de version, les fichiers de workflow, la protection des branches, les alertes de sécurité,
les fichiers de verrouillage et la facturation d’Actions dans SQLite, puis effectue une vérification de l’ensemble en fonction des règles définies.

Il répond, pour l’ensemble de l’organisation, aux questions suivantes :

- Quelles sont les branches par défaut qui présentent des problèmes, et s’agit-il d’une branche principale défectueuse ou d’un historique obsolète ?
- Quelles sont les demandes de fusion qui ne peuvent jamais être fusionnées, car une vérification requise qui ne renvoie aucune donnée les bloque-t-elle ?
- Quels sont les déploiements que les paramètres du dépôt refusent ?
- Où `package.json`, les étiquettes Git et le registre npm divergent-ils ?
- Quels sont les workflows qui enfreignent les règles de coût d’Actions, quel a été leur coût et quelles tâches ont consommé ces ressources ?
- Quels sont les dépôts qui contiennent des avis que le nombre d’alertes de GitHub ne prend pas en compte ?

Il s’agit d’un outil d’audit, et non d’un outil de correction. Il lit GitHub et ne modifie rien.

## Un agent pour chaque dépôt

Une organisation comptant des dizaines de dépôts n’a pas d’emplacement unique où sont stockées ses données. housekeeping est cet emplacement, et son serveur MCP, `hk-mcp`, les transmet à un agent d’IA. Grâce à lui, un seul agent peut agir en tant que coordinateur pour l’ensemble de l’organisation :

1. **Analyse.** `hk refresh` effectue une capture instantanée de chaque dépôt.
2. **Tri.** L’agent demande ce qui présente des problèmes, ce qui est bloqué et ce qui s’est aggravé, et obtient des réponses qui permettent déjà de distinguer une branche principale défectueuse d’un historique obsolète, et une demande de fusion bloquée d’une demande en conflit.
3. **Planification d’une vague.** Une requête `hk_sql` trouve tous les dépôts qui ont la même structure, de sorte qu’une correction devient une demande de fusion par dépôt au lieu d’une recherche.
4. **Réalisation des tâches.** housekeeping n’écrit jamais. L’agent ouvre des demandes de fusion avec ses propres outils, sous ses propres autorisations et sous votre contrôle.
5. **Vérification.** Nouvelle analyse. Le problème est résolu ou non, et la différence entre deux captures instantanées est une requête.

Questions auxquelles un agent répond en un ou deux échanges :

- Quelles sont les branches par défaut qui présentent des problèmes, et quelle tâche et quelle étape sont à l’origine du problème ?
- Quelles sont les demandes de fusion qui ne peuvent jamais être fusionnées, et est-ce le déclencheur ou un conflit qui en est la cause ?
- Quels sont les dépôts qui contiennent un avis de production pour lequel GitHub n’affiche aucune alerte ?
- Quels sont les workflows planifiés qui enfreignent les règles relatives aux plannings, et comment ?
- Quel a été le coût d’Actions, et quelle tâche a consommé ces ressources ?
- Qu’est-ce qui a changé depuis la dernière analyse ?

| Outil | Ce à quoi il répond |
|---|---|
| `hk_summary` | Totaux pour la dernière analyse : dépôts, problèmes, demandes de fusion, workflows, résultats. |
| `hk_findings` | Résultats par code, gravité, catégorie ou dépôt ; nombre par code lorsque les résultats ne sont pas filtrés. Le résultat d’une branche principale rouge indique la tâche et l’étape qui ont causé le problème. |
| `hk_ci` | Dépôts dont la branche par défaut présente des problèmes et workflows ayant échoué ; également, plannings ayant échoué, branches de demandes de fusion ayant échoué et dépôts sans CI. |
| `hk_repo` | Un dépôt en entier : résultats, workflows, demandes de fusion et problèmes ouverts. |
| `hk_backlog` | Demandes de fusion ou problèmes ouverts dans l’ensemble de l’organisation, du plus ancien au plus récent. |
| `hk_health` | Un score de santé par dépôt, du plus mauvais au meilleur. |
| `hk_cost` | Dépenses d’Actions par dépôt, workflow ou tâche, en brut et en net. |
| `hk_sql` | Une seule instruction `SELECT` ou `WITH` en lecture seule par rapport à l’entrepôt. |
| `hk_schema` | Les tables et les colonnes, pour écrire des requêtes `hk_sql`. |

Chaque réponse provient de la dernière capture instantanée, ouverte en lecture seule. Un appel ayant échoué renvoie une erreur structurée, et non une trace de pile.

### Connectez-le

```json
{
  "mcpServers": {
    "housekeeping": { "command": "hk-mcp", "env": { "HK_HOME": "/path/to/warehouse" } },
    "atlas": { "command": "atlas", "args": ["mcp"] }
  }
}
```

`HK_HOME` est le répertoire à partir duquel vous effectuez l’analyse. À partir d’un clone, utilisez `"command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"]`. Le deuxième serveur est [Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas), qui répond aux mêmes questions concernant un seul dépôt (voir ci-dessous). Sous Windows, démarrez une commande installée globalement via `cmd /c`.

## housekeeping et Atlas

[Atlas] https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas
`@dogfood-lab/atlas` mappe un seul dépôt : ses composants et ses points d’accès, ce qui signifie
chaque flux de travail, y compris ce qu’il exécute, publie et déploie. La carte est enregistrée
sous la forme `atlas/` et vérifiée dans le cadre de l’intégration continue. La gestion est la vue d’ensemble de l’organisation. Les deux
sont conçus pour fonctionner ensemble.

- **Chaque carte, analysée.** Une analyse lit la carte enregistrée de chaque dépôt, ainsi que tous les autres éléments, et signale quels sont les dépôts qui n’en ont pas, lesquels n’exécutent jamais `atlas check` et lesquels utilisent une version différente de celle que le reste de l’organisation utilise.
- **Où une exécution rouge a échoué.** Lorsqu’une branche par défaut présente des problèmes, le résultat indique la tâche et l’étape qui ont échoué et, via la carte, la commande que cette étape exécute, de sorte que la correction commence dans le bon fichier.
- **Faits de déploiement à partir de la carte.** L’environnement vers lequel une tâche se déploie est extrait de la carte où il est enregistré, de sorte que les deux outils lisent un workflow de la même manière.
- **Avertissements dans l’ensemble du parc.** Atlas signale une étape de workflow qui échouera avant son exécution, comme un outil qui nécessite une version d’exécution plus récente que celle installée par la tâche. Le rapport les répertorie pour tous les dépôts en même temps.

Un agent disposant des deux serveurs passe de « ces douze dépôts sont bloqués » (housekeeping) à « il s’agit du workflow, de la tâche et des fichiers qu’une modification affectera » (Atlas), sans avoir à ouvrir chaque dépôt manuellement.

## Pourquoi il est structuré de cette manière

| Couche | Choix | Raison |
|---|---|---|
| Transport | L’interface de ligne de commande `gh` | Elle contient déjà votre jeton. L’outil ne stocke ni ne demande jamais d’informations d’identification. |
| Collecte | GitHub GraphQL, par pages | Une requête renvoie les métadonnées, les problèmes ouverts, les demandes de fusion ouvertes, les versions et les arborescences de fichiers pour une page de dépôts. Une page qui continue de dépasser le délai d’attente est divisée par deux et la requête est répétée à partir du même curseur. |
| Exécutions d’Actions | REST | GraphQL n’a pas d’interface Actions. |
| Coût d’Actions | API de facturation plus durées par tâche | La facture indique le dépôt ; seules les tâches indiquent le flux de travail. Les points de terminaison GitHub de `/timing` renvoient des zéros, de sorte que la somme par tâche est recalculée, puis comparée à la facture. |
| Tarifs des exécuteurs | lu dans la facture | Un tarif facturé peut différer du prix catalogue, et une constante dans la source fausserait tous les chiffres. |
| Stockage | SQLite via le `node:sqlite` intégré | Aucune étape de compilation native. |
| Source de vérité | `data/snapshots/*.json` | Brut, diffusable et en ajout uniquement. La base de données est dérivée : `npm run rebuild` la reconstruit hors ligne. |
| Journal de balayage | `data/sweeps.jsonl` | Une ligne par balayage, y compris les balayages ayant échoué et les balayages n’ayant rien trouvé de nouveau. |

Les instantanés sont immuables et additifs, de sorte que la dérive entre deux dates est un `JOIN`.

## Exigences

- Node.js 22.5 ou version ultérieure.
- L’[CLI GitHub](https://cli.github.com/), connecté (`gh auth status`) en tant que
compte pouvant lire l’organisation. La lecture des factures et des alertes de sécurité
nécessite les autorisations correspondantes ; un balayage sans celles-ci enregistre « non mesuré » et
continue. Il n’enregistre jamais une autorisation manquante comme un résultat valide.
- Windows ou Linux. Il est développé sur Windows et ses tests sont exécutés sur Linux en
CI. macOS devrait fonctionner et n’est pas testé.

## Utilisation

```bash
npm install -g @mcptoolshop/housekeeping   # puts `hk` and `hk-mcp` on your path
mkdir warehouse && cd warehouse            # housekeeping keeps its data here
hk refresh your-org                        # collect, load, analyze, write reports/AUDIT-<date>.md
```

Pour conserver les paramètres entre les balayages, placez un `housekeeping.config.json` dans ce
répertoire (voir Configuration) ; ensuite, `hk refresh` n’a besoin d’aucun argument.

Ou exécutez-le à partir d’un clone, ce qui conserve ses données dans le clone :

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh
```

Ensuite, interrogez-le :

```bash
hk summary               # portfolio totals
hk ci                    # repositories whose default branch is red
hk findings              # findings grouped by severity and code
hk health                # per-repository health score, worst first
hk repo <name>           # one repository in full
hk prs                   # every open pull request by age
hk branches              # branches by state: merged, moved after merge, no PR
hk watch                 # open PRs, alerts and branches for a short watch list
hk versions              # package.json against git tag against npm
hk actions               # every workflow and its rule flags
hk cost                  # Actions cost, gross and net side by side
hk sql "SELECT ..."      # one read-only statement
hk help                  # every command and flag
```

Dans un clone sans `npm link`, chaque `hk <command>` est `node src/cli.mjs <command>`.

`npm run rebuild` redérive la base de données et le rapport à partir des instantanés déjà
présents sur le disque, sans accès au réseau.

Un balayage complet effectue quelques centaines d’appels d’API. N’exécutez pas `refresh` en boucle.

Les résultats sont envoyés vers la sortie standard ; les progrès et les erreurs sont envoyés vers la sortie d’erreur standard. Chaque
erreur affiche un code et un indice. Codes de sortie : 0 ok, 1 erreur utilisateur, 2 erreur d’exécution, 3 partiel (le balayage est terminé, avec des lacunes).

## Configuration

`housekeeping.config.json`, dans le répertoire dans lequel le programme de maintenance fonctionne (voir ci-dessous) :

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` est l’organisation à analyser. `hk refresh <org>` le remplace. Sans
aucun des deux, un balayage refuse de démarrer.
- `metaRepos` sont les dépôts qui contiennent les paramètres, les actifs ou les
outils de l’organisation, et non un produit commercialisé. Ils sont exemptés des résultats qui ne
sont pertinents que pour un produit : fichier README, fichier LICENSE et fichiers similaires manquants,
absence de flux de travail et absence de versions.

Un fichier malformé est une erreur, jamais une valeur par défaut silencieuse : une clé inconnue, un type incorrect ou un JSON corrompu interrompent l’exécution.

Exécution à partir d’un clone, le programme de maintenance conserve `data/`, `reports/` et le fichier de configuration
dans le clone. Exécution en tant que package installé, il les conserve dans le répertoire à partir duquel vous
l’exécutez, ou dans `HK_HOME` lorsque cela est défini.

Environnement : `HK_HOME` (où les données, les rapports et la configuration sont stockés),
`HK_CONFIG` (chemin de configuration), `HK_DB` (chemin de la base de données), `HK_LOG`
(`silent`, `normal`, `verbose` ou `debug`), `HK_COST_REPOS` et
`HK_COST_BUDGET` (limites du coût par tâche), `GH_PATH` (chemin vers `gh`).

## Conserver les données privées

**Ce qu’un balayage écrit est sensible. Ne committez pas `data/` ou `reports/` dans un
dépôt public.**

Un instantané enregistre les noms et les descriptions des dépôts privés, chaque
alerte de sécurité ouverte avec le package qu’elle mentionne, les fichiers de flux de travail et la facturation d’Actions. GitHub masque délibérément les alertes de sécurité d’un dépôt public à tous, sauf à ses mainteneurs ; un instantané publié diffuserait cette liste.

Le `.gitignore` de ce dépôt exclut `data/`, `reports/` et
`housekeeping.config.json`. Pour conserver l’historique, qui est l’objectif des instantanés,
exécutez l’outil à partir d’un **dépôt privé** et committez-les là.

## Résultats

Les règles sont stockées dans `src/analyze.mjs`. Chacune d’entre elles cite la règle écrite qu’elle applique,
de sorte qu’un résultat peut être contesté par rapport à une norme et non par rapport au goût. Les règles
fournies avec ce dépôt sont disponibles dans [`rules/`](rules/) :

- [`rules/github-actions.md`](rules/github-actions.md) : filtres de chemins, exécuteurs, taille de la matrice, limite du fichier de flux de travail, concurrence.
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md) : la CI doit réussir, les étapes de publication, les versions.
- [`rules/repo-first.md`](rules/repo-first.md) : la branche par défaut.
- [`rules/atlas-map.md`](rules/atlas-map.md) : une carte validée de chaque dépôt, vérifiée en CI.

Ce sont les normes d’une organisation. Si les vôtres sont différentes, modifiez le fichier de règles
et la règle en même temps.

Les règles veillent à distinguer les éléments qui se ressemblent, car leur regroupement produit du bruit :

- **Une branche par défaut rouge n’est pas une branche de demande de tirage rouge.** Une branche Dependabot défaillante est en attente ; une exécution `push` défaillante sur la branche par défaut est une
erreur. L’événement de l’exécution détermine lequel.
- **L’historique n’est pas une erreur.** Un flux de travail déplacé vers une exécution uniquement en production conserve
sa dernière erreur de branche par défaut pour toujours. Un flux de travail supprimé conserve ses exécutions.
Aucun des deux n’est un défaut actif.
- **Une vérification requise qui ne peut rien émettre n’est pas une vérification qui n’a pas été exécutée ici.**
L’une dit de supprimer l’exigence ; l’autre dit de corriger le déclencheur. Les corrections
se contredisent.
- **Une demande de tirage que le déclencheur a ignorée n’est pas une demande de tirage en conflit.** GitHub n’exécute
aucun flux de travail de demande de tirage sur une demande de tirage avec des conflits, de sorte que sa vérification manquante ne dit rien sur le déclencheur. Celle-ci nécessite une rebasification.
- **Une exécution ayant échoué n’est pas une exécution annulée.** `cancel-in-progress` sert à arrêter
les exécutions obsolètes, de sorte que les minutes annulées correspondent généralement au fonctionnement de la règle de concurrence.
- **Le coût brut n’est pas le coût net.** GitHub mesure les dépôts publics à plein
tarif et les réduit à zéro. Le coût brut est la puissance de calcul réelle ; le coût net est l’argent réel.
Ils ne sont jamais additionnés.
- **Non mesuré n’est pas propre.** Un dépôt GitHub qui n’analyse pas les rapports
n’affiche aucune alerte. Un dépôt pour lequel le passage des coûts n’a pas été atteint n’a pas de ligne de coût. Les deux
sont signalés comme inconnus.

La gravité détermine un score de santé : critique 40, élevé 15, moyen 6, faible 2, info 0,
déduit de 100. Le score classe l’attention, et non la qualité.

Le [manuel](https://mcp-tool-shop-org.github.io/housekeeping/handbook/)
énumère tous les résultats, toutes les commandes, tous les codes d’erreur et tous les tableaux.

## Sécurité

- **Lecture seule.** Le collecteur effectue GraphQL requêtes et des appels REST `GET`. Il ne fusionne, ne pousse, ne publie, ne modifie ni ne met à jour jamais un paramètre.
- **Aucun identifiant.** L’authentification se fait en utilisant les informations déjà disponibles dans `gh`. Rien n’est écrit sur le disque à ce sujet.
- **Aucune télémétrie.** Les seuls hôtes contactés sont l’API GitHub, via `gh`, et le registre npm, pour vérifier les versions et les avis de sécurité.
- **Ce qu’il stocke** est la partie sensible : voir « Conserver les données en privé ».

Signalez une vulnérabilité comme décrit dans [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test
```

Chaque règle est testée dans les deux sens : la forme qui doit être déclenchée et la forme voisine qui ne doit pas l’être. Un vérificateur distinct recalcule un échantillon de résultats à partir des données GitHub en temps réel, en utilisant son propre canal de communication, et signale clairement lorsqu’il n’y a pas de base de données ou de réseau.

## Licence

MIT. Voir [LICENSE](LICENSE).

---

Créé par <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
