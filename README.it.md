<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.md">English</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

Un'unica scansione raccoglie lo stato del CI di ogni repository, le issue aperte e le richieste di pull, le release, i tag di versione, i file di workflow, la protezione dei branch, gli avvisi di sicurezza, i file di blocco e i dati di fatturazione di Actions in SQLite, quindi esegue un controllo completo rispetto alle regole definite.

Fornisce risposte, per l'intera organizzazione contemporaneamente:

- Quali branch predefiniti sono contrassegnati come problematici e si tratta di una branch principale interrotta o di una cronologia obsoleta?
- Quali richieste di pull non possono mai essere unite, perché un controllo richiesto che non produce alcun risultato le sta bloccando?
- Quali distribuzioni vengono rifiutate dalle impostazioni del repository?
- Dove `package.json`, i tag Git e il registro npm si sono discostati?
- Quali workflow violano le regole sui costi di Actions, quanto sono costati e quali job hanno consumato tali costi?
- Quali repository contengono avvisi che il sistema di avvisi di GitHub non rileva?

È uno strumento di audit, non uno strumento di correzione. Legge i dati di GitHub e non apporta alcuna modifica.

## Un agente per ogni repository

Un'organizzazione con dozzine di repository non dispone di un unico punto in cui sono memorizzati i suoi dati. housekeeping è questo punto, e il suo server MCP, `hk-mcp`, li fornisce a un agente AI. Grazie a questo, un singolo agente può fungere da coordinatore per l'intera organizzazione:

1. **Scansione.** `hk refresh` esegue una singola scansione di ogni repository.
2. **Smistamento.** L'agente chiede quali elementi sono contrassegnati come problematici, quali sono bloccati e quali sono peggiorati, e riceve risposte che già distinguono una branch principale interrotta da una cronologia obsoleta e una richiesta di pull bloccata da una in conflitto.
3. **Pianificazione di un'azione.** Una singola query `hk_sql` individua tutti i repository con la stessa struttura, in modo che la correzione diventi una singola richiesta di pull per repository anziché una ricerca.
4. **Esecuzione del lavoro.** housekeeping non scrive mai. L'agente apre le richieste di pull con i propri strumenti, con le proprie autorizzazioni e previa approvazione.
5. **Verifica.** Esegue una nuova scansione. L'errore è stato risolto o meno, e la differenza tra due scansioni è una query.

Domande a cui un agente risponde in una o due chiamate:

- Quali branch predefiniti sono contrassegnati come problematici e quale job e quale passaggio hanno causato il problema?
- Quali richieste di pull non possono mai essere unite e il problema è dovuto al trigger o a un conflitto?
- Quali repository contengono un avviso di produzione per il quale GitHub non mostra alcun avviso?
- Quali workflow pianificati violano le regole per le pianificazioni e in che modo?
- Quanto sono costati Actions e quale job ha consumato tali costi?
- Cosa è cambiato dall'ultima scansione?

| Strumento | A cosa risponde |
|---|---|
| `hk_summary` | Totali per la scansione più recente: repository, issue, richieste di pull, workflow, risultati. |
| `hk_findings` | Risultati per codice, gravità, categoria o repository; conteggi per codice quando non filtrati. Il risultato di una branch principale contrassegnata come problematica indica il job e il passaggio che hanno causato il problema. |
| `hk_ci` | Repository la cui branch predefinita è contrassegnata come problematica e i workflow che hanno fallito; anche le pianificazioni non riuscite, le branch delle richieste di pull non riuscite e i repository senza CI. |
| `hk_repo` | Un singolo repository nel dettaglio: risultati, workflow, richieste di pull e issue aperte. |
| `hk_backlog` | Richieste di pull o issue aperte in tutta l'organizzazione, ordinate dalla più vecchia alla più recente. |
| `hk_health` | Un punteggio di salute per repository, ordinato dal peggiore al migliore. |
| `hk_cost` | Spese di Actions per repository, workflow o job, separate in costi lordi e netti. |
| `hk_sql` | Una singola istruzione `SELECT` o `WITH` in sola lettura rispetto al data warehouse. |
| `hk_schema` | Le tabelle e le colonne, per scrivere query `hk_sql`. |

Ogni risposta proviene dalla scansione più recente, aperta in sola lettura. Una chiamata non riuscita restituisce un errore strutturato, mai una traccia dello stack.

### Come connetterlo

```json
{
  "mcpServers": {
    "housekeeping": { "command": "hk-mcp", "env": { "HK_HOME": "/path/to/warehouse" } },
    "atlas": { "command": "atlas", "args": ["mcp"] }
  }
}
```

`HK_HOME` è la directory da cui si esegue la scansione. Da una copia clonata, utilizzare `"command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"]`. Il secondo server è [Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas), che risponde allo stesso agente su un singolo repository alla volta (vedere di seguito). Su Windows, avviare un comando installato a livello globale tramite `cmd /c`.

## housekeeping e Atlas

[Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas) (`@dogfood-lab/atlas`) mappa un singolo repository: le sue parti e le sue "porte", ovvero ogni workflow con ciò che esegue, pubblica e distribuisce. La mappa viene salvata come `atlas/` e verificata nel CI. housekeeping è la vista dell'organizzazione. I due strumenti sono progettati per funzionare insieme.

- **Ogni mappa, sottoposta a scansione.** Una scansione legge la mappa salvata di ciascun repository insieme a tutti gli altri dati e segnala quali repository non ne hanno, quali non eseguono mai `atlas check` e quali contengono un motore diverso da quello utilizzato dal resto dell'organizzazione.
- **Dove un'esecuzione contrassegnata come problematica ha causato un errore.** Quando una branch predefinita è contrassegnata come problematica, il risultato indica il job e il passaggio che hanno causato l'errore e, tramite la mappa, il comando che quel passaggio esegue, in modo che la correzione inizi nel file corretto.
- **Informazioni sulla distribuzione dalla mappa.** L'ambiente in cui un job distribuisce è tratto dalla mappa in cui è registrato, in modo che entrambi gli strumenti leggano un workflow nello stesso modo.
- **Avvisi in tutta l'organizzazione.** Atlas segnala un passaggio del workflow che causerà un errore prima che venga eseguito, ad esempio uno strumento che richiede una versione di runtime più recente di quella installata dal job. Il report elenca questi elementi per tutti i repository contemporaneamente.

Un agente che utilizza entrambi i server passa da "questi dodici repository sono bloccati" (housekeeping) a "questo è il workflow, il job e i file che una modifica raggiungerà" (Atlas), senza dover aprire ogni repository manualmente.

## Perché ha questa struttura

| Livello | Scelta | Motivo |
|---|---|---|
| Trasporto | L'interfaccia a riga di comando `gh` | Già contiene il token. Lo strumento non memorizza né richiede mai una credenziale. |
| Raccolta | GitHub GraphQL, a pagine | Una singola query restituisce metadati, issue aperte, richieste di pull aperte, release e alberi di file per una pagina di repository. Una pagina che continua a superare il timeout viene dimezzata e richiesta nuovamente dallo stesso cursore. |
| Esecuzioni di Actions | REST | GraphQL non dispone di un'interfaccia per Actions. |
| Le azioni comportano un costo. | API di fatturazione più durata per ogni attività. | Nella fattura è indicato il repository; solo nelle attività è indicato il workflow. Gli endpoint `/timing` di GitHub restituiscono zeri, quindi il totale per ogni attività viene ricostruito e quindi riconciliato con la fattura. |
| Tariffe per i runner. | Letto dalla fattura. | Una tariffa fatturata può differire dal prezzo di listino e una costante nel codice sorgente falsificherebbe ogni numero. |
| Archiviazione. | SQLite tramite il `node:sqlite` integrato. | Nessuna fase di compilazione nativa. |
| Fonte di verità. | `data/snapshots/*.json` | Dati grezzi, modificabili e con possibilità di aggiungere solo dati. Il database viene derivato: `npm run rebuild` lo ricostruisce offline. |
| Registro delle scansioni. | `data/sweeps.jsonl` | Una riga per ogni scansione, comprese le scansioni non riuscite e le scansioni che non hanno trovato nulla di nuovo. |

Gli snapshot sono immutabili e additivi, quindi la differenza tra due date è un `JOIN`.

## Requisiti

- Node.js 22.5 o successivo.
- [GitHub CLI](https://cli.github.com/), con accesso effettuato (`gh auth status`) con un
account che può leggere l'organizzazione. Per leggere le fatture e gli avvisi di sicurezza
sono necessari i permessi corrispondenti; in caso contrario, la scansione registra "non misurato" e
prosegue. Non registra mai un permesso mancante come risultato valido.
- Windows o Linux. È sviluppato su Windows e i suoi test vengono eseguiti su Linux in
CI. macOS dovrebbe funzionare e non è testato.

## Utilizzo

```bash
npm install -g @mcptoolshop/housekeeping   # puts `hk` and `hk-mcp` on your path
mkdir warehouse && cd warehouse            # housekeeping keeps its data here
hk refresh your-org                        # collect, load, analyze, write reports/AUDIT-<date>.md
```

Per mantenere le impostazioni tra le scansioni, inserire un `housekeeping.config.json` in quella
directory (vedere Configurazione); quindi `hk refresh` non richiede alcun argomento.

Oppure eseguirlo da una copia, che mantiene i suoi dati nella copia:

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh
```

Quindi, eseguite una query:

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

In una copia senza `npm link`, ogni `hk <command>` è `node src/cli.mjs <command>`.

`npm run rebuild` deriva nuovamente il database e il report dagli snapshot già
presenti sul disco, senza accesso alla rete.

Una scansione completa effettua alcune centinaia di chiamate API. Non eseguire `refresh` in un ciclo.

I risultati vengono inviati all'output standard; i progressi e gli errori vengono inviati all'output degli errori standard. Ogni
errore stampa un codice e un suggerimento. Codici di uscita: 0 ok, 1 errore utente, 2 errore di runtime, 3 parziale (la scansione è terminata, con delle lacune).

## Configurazione

`housekeeping.config.json`, nella directory in cui opera housekeeping (vedere di seguito):

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` è l'organizzazione da scansionare. `hk refresh <org>` lo sovrascrive. In caso contrario, una scansione si rifiuta di avviarsi.
- `metaRepos` sono i repository che contengono le impostazioni predefinite dell'organizzazione, le risorse o
gli strumenti, non un prodotto distribuito. Sono esenti dai risultati che hanno senso solo per un prodotto: mancanza di README, LICENSE e file simili, assenza di workflow e assenza di release.

Un file non valido è un errore, mai un valore predefinito silenzioso: una chiave sconosciuta, un tipo errato o un JSON non valido interrompono l'esecuzione.

Eseguito da una copia, housekeeping mantiene `data/`, `reports/` e il file di configurazione
nella copia. Eseguito come pacchetto installato, li mantiene nella directory da cui
lo si esegue o in `HK_HOME` quando è impostato.

Ambiente: `HK_HOME` (dove risiedono i dati, i report e la configurazione),
`HK_CONFIG` (percorso della configurazione), `HK_DB` (percorso del database), `HK_LOG`
(`silent`, `normal`, `verbose` o `debug`), `HK_COST_REPOS` e
`HK_COST_BUDGET` (limiti per il costo per ogni attività), `GH_PATH` (percorso di `gh`).

## Mantenere i dati privati

**Ciò che una scansione scrive è sensibile. Non inserire `data/` o `reports/` in un
repository pubblico.**

Uno snapshot registra i nomi e le descrizioni dei repository privati, ogni
avviso di sicurezza aperto con il pacchetto a cui si riferisce, i file di workflow e la fatturazione di Actions. GitHub nasconde deliberatamente gli avvisi di sicurezza di un repository pubblico a tutti tranne che ai suoi manutentori; uno snapshot pubblicato fornirebbe tale elenco.

Il `.gitignore` di questo repository esclude `data/`, `reports/` e
`housekeeping.config.json`. Per mantenere la cronologia, che è lo scopo degli snapshot,
eseguire lo strumento da un **repository privato** di proprietà e inserirli lì.

## Risultati

Le regole sono contenute in `src/analyze.mjs`. Ognuna di esse cita la regola scritta che applica,
quindi un risultato può essere contestato rispetto a uno standard e non al gusto personale. Le regole
che questo repository distribuisce sono in [`rules/`](rules/):

- [`rules/github-actions.md`](rules/github-actions.md): filtri dei percorsi, runner, dimensione della matrice, limite del file di workflow, concorrenza.
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md): il CI deve essere superato, i gate di rilascio, le versioni.
- [`rules/repo-first.md`](rules/repo-first.md): la branch predefinita.
- [`rules/atlas-map.md`](rules/atlas-map.md): una mappa impegnata di ogni repository, controllata nel CI.

Sono gli standard di un'organizzazione. Se i vostri sono diversi, modificate il file della regola
e la regola insieme.

Le regole si prendono cura di separare le cose che sembrano simili, perché combinarle produce rumore:

- **Un ramo predefinito rosso non è un ramo di richiesta di pull rosso.** Un ramo di Dependabot che non funziona rappresenta un elemento in sospeso; un'esecuzione `push` non riuscita sul ramo predefinito rappresenta un problema. L'evento dell'esecuzione determina quale sia il caso.
- **La cronologia non è un problema.** Un flusso di lavoro spostato in una modalità di esecuzione solo per le release mantiene il suo ultimo errore sul ramo predefinito per sempre. Un flusso di lavoro eliminato mantiene le sue esecuzioni. Nessuno dei due rappresenta un difetto attivo.
- **Un controllo obbligatorio che non può generare alcun risultato non è un controllo che non è stato eseguito qui.** Uno suggerisce di eliminare il requisito; l'altro suggerisce di correggere il trigger. Le correzioni si contraddicono a vicenda.
- **Una richiesta di pull che il trigger ha saltato non è una richiesta in conflitto.** GitHub non esegue alcun flusso di lavoro per le richieste di pull su una richiesta di pull con conflitti, quindi la sua mancanza di controllo non dice nulla sul trigger. Quest'ultima richiede un rebase.
- **Un'esecuzione non riuscita non è un'esecuzione annullata.** `cancel-in-progress` esiste per interrompere le esecuzioni obsolete, quindi i minuti annullati rappresentano solitamente la regola di concorrenza in funzione.
- **Il costo lordo non è il costo netto.** GitHub calcola il costo dei repository pubblici al prezzo pieno e li riduce a zero. Il costo lordo è la potenza di calcolo reale; il costo netto è il denaro reale. Non vengono mai sommati.
- **Se non viene misurato, non è corretto.** Un repository che GitHub non sta analizzando segnala zero avvisi. Un repository per il quale il controllo dei costi non è stato raggiunto non ha una riga di costo. Entrambi vengono segnalati come sconosciuti.

La gravità determina un punteggio di salute: critico 40, alto 15, medio 6, basso 2, informativo 0, dedotto da 100. Il punteggio classifica l'attenzione, non la qualità.

Il [manuale](https://mcp-tool-shop-org.github.io/housekeeping/handbook/) elenca ogni riscontro, comando, codice di errore e tabella.

## Sicurezza

- **Solo lettura.** Il raccoglitore invia query GraphQL e richieste REST `GET`. Non esegue mai operazioni di merge, push, release, pubblicazione o modifica di un'impostazione.
- **Nessuna credenziale.** L'autenticazione è quella che `gh` già possiede. Nulla viene scritto su disco al riguardo.
- **Nessuna telemetria.** Gli unici host contattati sono l'API di GitHub, tramite `gh`, e il registro npm, per la ricerca di versioni e avvisi.
- **Ciò che memorizza** è la parte sensibile: vedere "Mantenere i dati privati".

Segnala una vulnerabilità come descritto in [SECURITY.md](SECURITY.md).

## Test

```bash
npm test
```

Ogni regola viene testata in entrambe le direzioni: la forma che deve essere attivata e la forma adiacente che non deve esserlo. Un verificatore separato deriva nuovamente un campione di risultati da GitHub in tempo reale tramite il proprio canale di comunicazione e, in caso di assenza di database o di rete, lo segnala in modo evidente.

## Licenza

MIT. Vedere [LICENSE](LICENSE).

---

Creato da <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
