<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.md">English</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/housekeeping/readme.png" alt="housekeeping" width="400" />
</p>

<h1 align="center">housekeeping</h1>

<p align="center">
  An operational-health warehouse for a GitHub organization.<br>
  One sweep, one SQLite database, findings you can argue with.
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/housekeeping/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/housekeeping/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://mcp-tool-shop-org.github.io/housekeeping/"><img src="https://img.shields.io/badge/Landing_Page-live-blue" alt="Landing Page" /></a>
  <a href="https://mcp-tool-shop-org.github.io/housekeeping/handbook/"><img src="https://img.shields.io/badge/Handbook-read-blue" alt="Handbook" /></a>
</p>

Une seule analyse collecte l’état des CI de chaque dépôt, les problèmes ouverts et les demandes de fusion,
les versions, les étiquettes de version, les fichiers de flux de travail, la protection des branches, les alertes de sécurité,
les fichiers de verrouillage et la facturation d’Actions dans SQLite, puis effectue un audit complet en fonction des règles définies.

Il répond, pour l’ensemble de l’organisation :

- Quelles sont les branches par défaut qui présentent des problèmes, et s’agit-il d’une branche principale défectueuse ou d’un historique obsolète ?
- Quelles demandes de fusion ne peuvent jamais être fusionnées, car une vérification requise qui ne renvoie aucune donnée les bloque-t-elle ?
- Quels déploiements les paramètres propres au dépôt refusent-ils ?
- Où `package.json`, les étiquettes Git et le registre npm divergent-ils ?
- Quels flux de travail enfreignent les règles de coût d’Actions, quel a été leur coût et quelles tâches ont consommé ces coûts ?
- Quels dépôts contiennent des avis que le propre système d’alerte de GitHub ne détecte pas ?

Il s’agit d’un outil d’audit, et non d’un correcteur. Il lit les données de GitHub et ne modifie rien.

## Pourquoi il a cette structure

| Couche | Choix | Raison |
|---|---|---|
| Transport | l’interface de ligne de commande `gh` | Il contient déjà votre jeton. L’outil ne stocke ni ne demande jamais d’informations d’identification. |
| Collecte | GitHub GraphQL, avec pagination | Une seule requête renvoie les métadonnées, les problèmes ouverts, les demandes de fusion ouvertes, les versions et les arborescences de fichiers pour une page de dépôts. Une page dont le temps d’attente est constamment dépassé est divisée par deux et la requête est renvoyée à partir du même curseur. |
| Exécutions d’Actions | REST | GraphQL ne dispose pas d’interface Actions. |
| Coût d’Actions | API de facturation plus durées par tâche | La facture indique quel dépôt ; seules les tâches indiquent quel flux de travail. Les points de terminaison `/timing` de GitHub renvoient des zéros, de sorte que la somme par tâche est reconstruite, puis rapprochée de la facture. |
| Tarifs des exécuteurs | lu dans la facture | Un tarif facturé peut différer du prix catalogue, et une constante dans la source fausserait tous les chiffres. |
| Stockage | SQLite via l’outil `node:sqlite` intégré | Aucune étape de compilation native. |
| Source de vérité | `data/snapshots/*.json` | Brut, diffusable et en ajout uniquement. La base de données est dérivée : `npm run rebuild` la reconstruit hors ligne. |
| Journal d’analyse | `data/sweeps.jsonl` | Une ligne par analyse, y compris les analyses ayant échoué et les analyses n’ayant rien trouvé de nouveau. |

Les instantanés sont immuables et additifs, de sorte que la dérive entre deux dates est un `JOIN`.

## Exigences

- Node.js 22.5 ou version ultérieure.
- L’[interface de ligne de commande GitHub](https://cli.github.com/), connectée (`gh auth status`) avec un
compte qui peut lire l’organisation. La lecture de la facturation et des alertes de sécurité
nécessite les autorisations correspondantes ; une analyse sans ces autorisations enregistre « non mesuré » et
continue. Elle n’enregistre jamais une autorisation manquante comme un résultat valide.
- Windows ou Linux. Il est développé sous Windows et ses tests sont exécutés sous Linux en
CI. macOS devrait fonctionner et n’est pas testé.

## Utilisation

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh               # collect, load, analyze, write reports/AUDIT-<date>.md
```

Puis interrogez-la :

```bash
hk summary               # portfolio totals
hk ci                    # repositories whose default branch is red
hk findings              # findings grouped by severity and code
hk health                # per-repository health score, worst first
hk repo <name>           # one repository in full
hk prs                   # every open pull request by age
hk versions              # package.json against git tag against npm
hk actions               # every workflow and its rule flags
hk cost                  # Actions cost, gross and net side by side
hk sql "SELECT ..."      # one read-only statement
hk help                  # every command and flag
```

Sans `npm link`, chaque `hk <command>` est `node src/cli.mjs <command>`.

`npm run rebuild` redérive la base de données et le rapport à partir des instantanés déjà
présents sur le disque, sans accès au réseau.

Une analyse complète effectue quelques centaines d’appels d’API. N’exécutez pas `refresh` en boucle.

Les résultats sont envoyés vers la sortie standard ; les progrès et les erreurs sont envoyés vers la sortie d’erreur standard. Chaque
erreur affiche un code et un indice. Codes de sortie : 0 (OK), 1 (erreur utilisateur), 2 (erreur d’exécution), 3 (partiel, l’analyse est terminée, mais avec des lacunes).

## Configuration

`housekeeping.config.json`, en plus de `package.json` :

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` est l’organisation à analyser. `hk refresh <org>` le remplace. Sans
aucun des deux, une analyse refuse de démarrer.
- `metaRepos` sont les dépôts qui contiennent les paramètres, les ressources ou
les outils de l’organisation, et non un produit commercialisé. Ils sont exemptés des résultats qui ne sont pertinents que pour un produit : absence de fichier README, de fichier LICENSE et de fichiers similaires, absence de flux de travail et absence de versions.

Un fichier malformé est une erreur, et non une valeur par défaut silencieuse : une clé inconnue, un type incorrect ou un JSON incorrect interrompent l’exécution.

Environnement : `HK_CONFIG` (chemin du fichier de configuration), `HK_DB` (chemin de la base de données), `HK_LOG`
(`silent`, `normal`, `verbose` ou `debug`), `HK_COST_REPOS` et
`HK_COST_BUDGET` (limites de la plage de coûts par tâche), `GH_PATH` (chemin vers `gh`).

## Conservez les données privées

**Ce qu’une analyse écrit est sensible. N’ajoutez pas `data/` ou `reports/` à un
dépôt public.**

Un instantané enregistre les noms et les descriptions des dépôts privés, toutes
les alertes de sécurité ouvertes avec le package qu’il nomme, les fichiers de flux de travail et la facturation d’Actions. GitHub masque délibérément les alertes de sécurité d’un dépôt public à tous, sauf à ses mainteneurs ; un instantané publié divulguerait cette liste.

Le `.gitignore` de ce dépôt exclut `data/`, `reports/` et
`housekeeping.config.json`. Pour conserver l’historique, ce qui est l’objectif des instantanés,
exécutez l’outil à partir d’un **dépôt privé** et ajoutez-les.

## Serveur MCP

`npm run mcp` sert le référentiel via stdio, de sorte qu’un assistant puisse poser
des questions sans lire un instantané de plusieurs mégaoctets :

`hk_summary` · `hk_findings` · `hk_ci` · `hk_repo` · `hk_backlog` ·
`hk_health` · `hk_cost` · `hk_sql` · `hk_schema`

```json
{
  "mcpServers": {
    "housekeeping": { "command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"] }
  }
}
```

`hk_sql` accepte une seule instruction `SELECT` ou `WITH` et ouvre la base de données
en lecture seule. Un appel ayant échoué renvoie une erreur structurée, et non une trace de pile.

## Résultats

Les règles sont stockées dans `src/analyze.mjs`. Chacune d’entre elles fait référence à la règle écrite qu’elle applique,
de sorte qu’un résultat peut être contesté par rapport à une norme et non par rapport au goût. Les règles
fournies avec ce dépôt sont disponibles dans [`rules/`](rules/) :

- [`rules/github-actions.md`](rules/github-actions.md) : filtres de chemins, exécuteurs, taille de la matrice, limite du fichier de flux de travail, concurrence.
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md) : les CI doivent réussir, les portes de publication, les versions.
- [`rules/repo-first.md`](rules/repo-first.md) : la branche par défaut.
- [`rules/atlas-map.md`](rules/atlas-map.md) : une carte validée de chaque dépôt, vérifiée dans les CI.

Il s’agit des normes d’une organisation. Si les vôtres sont différentes, modifiez le fichier de règles et la règle elle-même.

Les règles veillent à ce que les éléments qui se ressemblent soient séparés, car les regrouper entraînerait du bruit :

- **Une branche par défaut rouge n’est pas une branche de demande de fusion rouge.** Une branche Dependabot défaillante est un élément en attente ; une exécution `push` défaillante sur la branche par défaut est une erreur. L’événement de l’exécution détermine lequel.
- **L’historique n’est pas une erreur.** Un flux de travail déplacé vers un déclencheur de publication uniquement conserve son dernier échec sur la branche par défaut pour toujours. Un flux de travail supprimé conserve ses exécutions. Aucun n’est un défaut actif.
- **Une vérification obligatoire qui ne peut rien produire n’est pas une vérification qui n’a pas été exécutée ici.** L’une indique qu’il faut supprimer l’exigence ; l’autre indique qu’il faut corriger le déclencheur. Les corrections se contredisent.
- **Une exécution ayant échoué n’est pas une exécution annulée.** `cancel-in-progress` sert à arrêter les exécutions obsolètes, de sorte que les minutes annulées correspondent généralement au fonctionnement de la règle de concurrence.
- **Le coût brut n’est pas le coût net.** GitHub facture les dépôts publics au prix fort et les réduit à zéro. Le coût brut est la puissance de calcul réelle ; le coût net est l’argent réel. Ils ne sont jamais additionnés.
- **Ce qui n’est pas mesuré n’est pas propre.** Un dépôt GitHub qui n’effectue pas d’analyse signale zéro alerte. Un dépôt pour lequel le processus de calcul des coûts n’a pas abouti n’a pas de ligne de coûts. Les deux sont signalés comme inconnus.

La gravité détermine un score de santé : critique 40, élevé 15, moyen 6, faible 2, information 0, déduit de 100. Le score classe l’importance, et non la qualité.

Le [manuel](https://mcp-tool-shop-org.github.io/housekeeping/handbook/) répertorie chaque résultat, commande, code d’erreur et tableau.

## Sécurité

- **Lecture seule.** Le collecteur effectue des requêtes GraphQL et des requêtes REST `GET`. Il ne fusionne, ne pousse, ne publie, ne modifie jamais un paramètre.
- **Aucun identifiant.** L’authentification est celle que `gh` contient déjà. Rien n’est écrit sur le disque à ce sujet.
- **Aucune télémétrie.** Les seuls hôtes contactés sont l’API GitHub, via `gh`, et le registre npm, pour les recherches de version et de conseils.
- **Ce qu’il stocke** est la partie sensible : voir « Conserver les données en privé ».

Signalez une vulnérabilité comme décrit dans [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test
```

Chaque règle est testée dans les deux sens : la forme qui doit être déclenchée et la forme voisine qui ne doit pas l’être. Un vérificateur distinct redérive un échantillon de résultats à partir de GitHub en direct via son propre transport, et saute, bruyamment, lorsqu’il n’y a pas de base de données ou de réseau.

## Licence

MIT. Voir [LICENSE](LICENSE).

---

Créé par <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
