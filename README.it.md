<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.md">English</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

Un singolo ciclo di analisi raccoglie lo stato CI di ogni repository, le issue aperte e le richieste di pull, le release, i tag di versione, i file di workflow, le protezioni dei branch, gli avvisi di sicurezza, i file di blocco e i dati di fatturazione di Actions in SQLite, quindi esegue un controllo completo rispetto alle regole definite.

Fornisce risposte, per l'intera organizzazione:

- Quali sono i branch predefiniti contrassegnati come problematici e si tratta di una branch principale interrotta o di una cronologia obsoleta?
- Quali richieste di pull non possono essere unite perché un controllo obbligatorio non produce alcun risultato e le blocca?
- Quali distribuzioni vengono rifiutate dalle impostazioni del repository?
- Dove sono divergenti `package.json`, i tag Git e il registro npm?
- Quali workflow violano le regole sui costi di Actions, quanto sono costati e quali job hanno utilizzato tali risorse?
- Quali repository contengono avvisi che il sistema di avvisi di GitHub non rileva?

È uno strumento di audit, non uno strumento di correzione. Legge i dati da GitHub e non apporta alcuna modifica.

## Motivazione della sua struttura

| Livello | Scelta | Ragione |
|---|---|---|
| Trasporto | L'interfaccia a riga di comando `gh` | Contiene già il token. Lo strumento non memorizza né richiede credenziali. |
| Raccolta | GitHub GraphQL, con paginazione | Una singola query restituisce i metadati, le issue aperte, le richieste di pull aperte, le release e le strutture di file per una pagina di repository. Una pagina che continua a superare il tempo limite viene dimezzata e la richiesta viene ripetuta utilizzando lo stesso cursore. |
| Esecuzioni di Actions | REST | GraphQL non dispone di un'interfaccia per Actions. |
| Costi di Actions | API di fatturazione più durate per job | La fattura indica il repository; solo i job indicano il workflow. Gli endpoint `/timing` di GitHub restituiscono zeri, quindi la somma per job viene ricostruita e quindi riconciliata con la fattura. |
| Tariffe dei runner | Letto dalla fattura | Una tariffa fatturata può differire dal prezzo di listino e una costante nel codice sorgente falsificherebbe tutti i numeri. |
| Archiviazione | SQLite tramite l'implementazione `node:sqlite` integrata | Nessun passaggio di compilazione nativo. |
| Fonte di verità | `data/snapshots/*.json` | Dati grezzi, modificabili e aggiungibili. Il database viene derivato: `npm run rebuild` lo ricostruisce offline. |
| Log dell'analisi | `data/sweeps.jsonl` | Una riga per ogni analisi, comprese le analisi che hanno avuto esito negativo e le analisi che non hanno trovato nuovi dati. |

Gli snapshot sono immutabili e additivi, quindi la differenza tra due date è un `JOIN`.

## Requisiti

- Node.js 22.5 o successivo.
- L'interfaccia a riga di comando [GitHub CLI](https://cli.github.com/), con accesso (`gh auth status`) come account in grado di leggere l'organizzazione. La lettura dei dati di fatturazione e degli avvisi di sicurezza richiede i permessi corrispondenti; un'analisi senza tali permessi registra "non misurato" e continua. Non registra mai un permesso mancante come risultato valido.
- Windows o Linux. È sviluppato su Windows e i test vengono eseguiti su Linux in CI. macOS dovrebbe funzionare e non è testato.

## Utilizzo

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh               # collect, load, analyze, write reports/AUDIT-<date>.md
```

Quindi, eseguire una query:

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

Senza `npm link`, ogni `hk <command>` è `node src/cli.mjs <command>`.

`npm run rebuild` ricostruisce il database e il report dagli snapshot già presenti sul disco, senza accesso alla rete.

Un'analisi completa esegue alcune centinaia di chiamate API. Non eseguire `refresh` in un ciclo.

I risultati vengono inviati all'output standard; i progressi e gli errori vengono inviati all'errore standard. Ogni errore stampa un codice e un suggerimento. Codici di uscita: 0 (tutto ok), 1 (errore utente), 2 (errore di runtime), 3 (parziale, l'analisi è terminata, ma con delle lacune).

## Configurazione

`housekeeping.config.json`, oltre a `package.json`:

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` è l'organizzazione da analizzare. `hk refresh <org>` lo sovrascrive. Se nessuno dei due è specificato, l'analisi non viene avviata.
- `metaRepos` sono i repository che contengono le impostazioni predefinite dell'organizzazione, le risorse o gli strumenti, e non un prodotto distribuito. Sono esenti dai risultati che hanno senso solo per un prodotto: mancanza di file README, LICENSE e simili, assenza di workflow e assenza di release.

Un file non valido è un errore, mai un valore predefinito silenzioso: una chiave sconosciuta, un tipo errato o un JSON non valido interrompono l'esecuzione.

Ambiente: `HK_CONFIG` (percorso del file di configurazione), `HK_DB` (percorso del database), `HK_LOG` (`silent`, `normal`, `verbose` o `debug`), `HK_COST_REPOS` e `HK_COST_BUDGET` (limiti per il passaggio dei costi per job), `GH_PATH` (percorso di `gh`).

## Mantenere i dati privati

**I dati scritti da un'analisi sono sensibili. Non inserire `data/` o `reports/` in un repository pubblico.**

Uno snapshot registra i nomi e le descrizioni dei repository privati, ogni avviso di sicurezza aperto con il pacchetto a cui si riferisce, i file di workflow e i dati di fatturazione di Actions. GitHub nasconde deliberatamente gli avvisi di sicurezza di un repository pubblico a tutti tranne che ai suoi manutentori; uno snapshot pubblicato fornirebbe tale elenco.

Il `.gitignore` di questo repository esclude `data/`, `reports/` e `housekeeping.config.json`. Per mantenere la cronologia, che è lo scopo degli snapshot, eseguire lo strumento da un repository **privato** di tua proprietà e inserirli lì.

## Server MCP

`npm run mcp` fornisce il data warehouse tramite stdio, in modo che un assistente possa porre domande senza leggere uno snapshot di diversi megabyte:

`hk_summary` · `hk_findings` · `hk_ci` · `hk_repo` · `hk_backlog` · `hk_health` · `hk_cost` · `hk_sql` · `hk_schema`

```json
{
  "mcpServers": {
    "housekeeping": { "command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"] }
  }
}
```

`hk_sql` accetta una singola istruzione `SELECT` o `WITH` e apre il database in sola lettura. Una chiamata non riuscita restituisce un errore strutturato, mai una traccia dello stack.

## Risultati

Le regole sono contenute in `src/analyze.mjs`. Ognuna di esse fa riferimento alla regola scritta che applica, in modo che un risultato possa essere contestato rispetto a uno standard e non al gusto personale. Le regole contenute in questo repository sono in [`rules/`](rules/):

- [`rules/github-actions.md`](rules/github-actions.md): filtri dei percorsi, runner, dimensione della matrice, limite del file di workflow, concorrenza.
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md): il CI deve essere superato, i controlli di rilascio, le versioni.
- [`rules/repo-first.md`](rules/repo-first.md): il branch predefinito.
- [`rules/atlas-map.md`](rules/atlas-map.md): una mappa impegnata di ogni repository, controllata in CI.

Si tratta degli standard di un’organizzazione. Se i suoi sono diversi, modifichi il file delle regole e la regola stessa.

Le regole si assicurano di mantenere separate le cose che sembrano simili, perché raggrupparle genera rumore:

- **Un ramo predefinito rosso non è un ramo di richiesta di pull rosso.** Un ramo di Dependabot non funzionante rappresenta un elemento in sospeso; un’esecuzione `push` non riuscita sul ramo predefinito rappresenta un problema. L’evento dell’esecuzione determina quale sia.
- **La cronologia non è un problema.** Un flusso di lavoro spostato in una versione che attiva solo le release mantiene per sempre il suo ultimo errore sul ramo predefinito. Un flusso di lavoro eliminato mantiene le sue esecuzioni. Nessuno dei due rappresenta un difetto attivo.
- **Un controllo obbligatorio che non può emettere nulla non è un controllo che non è stato eseguito qui.** Uno suggerisce di eliminare il requisito; l’altro suggerisce di correggere l’attivatore. Le correzioni si contraddicono a vicenda.
- **Un’esecuzione non riuscita non è un’esecuzione annullata.** `cancel-in-progress` esiste per interrompere le esecuzioni obsolete, quindi i minuti annullati rappresentano in genere la regola di concorrenza in funzione.
- **Il costo lordo non è il costo netto.** GitHub calcola i costi dei repository pubblici al prezzo pieno e li riduce a zero. Il costo lordo è la potenza di calcolo reale; il costo netto è il denaro reale. Non vengono mai sommati.
- **Se non viene misurato, non è corretto.** Un repository GitHub che non viene sottoposto a scansione segnala zero avvisi. Un repository per il quale il controllo dei costi non è stato raggiunto non ha una riga di costo. Entrambi vengono segnalati come sconosciuti.

La gravità determina un punteggio di salute: critico 40, alto 15, medio 6, basso 2, informativo 0, dedotto da 100. Il punteggio classifica l’attenzione, non la qualità.

Il [manuale](https://mcp-tool-shop-org.github.io/housekeeping/handbook/) elenca ogni riscontro, comando, codice di errore e tabella.

## Sicurezza

- **Solo lettura.** Il raccoglitore invia query GraphQL e richieste REST `GET`. Non esegue mai operazioni di merge, push, release, pubblicazione o modifica di un’impostazione.
- **Nessuna credenziale.** L’autenticazione è quella già presente in `gh`. Nulla viene scritto su disco al riguardo.
- **Nessuna telemetria.** Gli unici host contattati sono l’API di GitHub, tramite `gh`, e il registro npm, per la ricerca di versioni e avvisi.
- **Ciò che memorizza** è la parte sensibile: vedere “Mantenere i dati privati”.

Segnalare una vulnerabilità come descritto in [SECURITY.md](SECURITY.md).

## Test

```bash
npm test
```

Ogni regola viene testata in entrambe le direzioni: la forma che deve essere attivata e la forma adiacente che non deve esserlo. Un verificatore separato deriva nuovamente un campione di riscontri da GitHub in tempo reale tramite il proprio canale e lo ignora, in modo evidente, quando non è presente un database o una rete.

## Licenza

MIT. Vedere [LICENSE](LICENSE).

---

Creato da <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
