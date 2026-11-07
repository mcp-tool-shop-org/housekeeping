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

Un'unica scansione raccoglie lo stato CI di ogni repository, le issue aperte e le richieste di pull,
le release, i tag di versione, i file di workflow, la protezione dei branch, gli avvisi di sicurezza,
i file di lock e la fatturazione di Actions in SQLite, quindi esegue un controllo su tutto questo rispetto alle
regole definite.

Fornisce risposte, per l'intera organizzazione contemporaneamente:

- Quali sono i branch predefiniti contrassegnati come problematici e si tratta di una branch principale interrotta o di una cronologia obsoleta?
- Quali richieste di pull non possono mai essere unite, perché un controllo richiesto che non produce alcun risultato le sta bloccando?
- Quali deployment vengono rifiutati dalle impostazioni del repository?
- Dove `package.json`, i tag Git e il registro npm si sono discostati?
- Quali workflow violano le regole sui costi di Actions, quanto sono costati e quali job hanno consumato tali costi?
- Quali repository contengono avvisi che il conteggio degli avvisi di GitHub non rileva?

È uno strumento di audit, non uno strumento di correzione. Legge GitHub e non modifica nulla.

## Un agente per ogni repository

Un'organizzazione con dozzine di repository non ha un unico punto in cui risiedono i suoi
dati. housekeeping è questo punto, e il suo server MCP, `hk-mcp`, li fornisce
a un agente AI. Con esso, un singolo agente può agire come coordinatore per l'intera
organizzazione:

1. **Scansione.** `hk refresh` acquisisce un'istantanea di ogni repository.
2. **Smistamento.** L'agente chiede quali elementi sono problematici, quali sono bloccati e quali sono peggiorati,
e riceve risposte che già distinguono una branch principale interrotta da una cronologia obsoleta e
una richiesta di pull bloccata da una in conflitto.
3. **Pianificazione di un'ondata.** Una singola query `hk_sql` individua tutti i repository con la stessa
configurazione, in modo che una correzione diventi una singola richiesta di pull per repository invece di una ricerca.
4. **Esecuzione del lavoro.** housekeeping non scrive mai. L'agente apre le richieste di pull
con i propri strumenti, con le proprie autorizzazioni e con la tua approvazione.
5. **Verifica.** Esegui di nuovo la scansione. L'anomalia è stata risolta o meno, e la differenza
tra due istantanee è una query.

Domande a cui un agente risponde in una o due chiamate:

- Quali sono i branch predefiniti contrassegnati come problematici e quale job e quale passaggio hanno causato il problema?
- Quali richieste di pull non possono mai essere unite e la causa è il trigger o un conflitto?
- Quali repository contengono un avviso di produzione per il quale GitHub non mostra alcun avviso?
- Quali workflow pianificati violano le regole per le pianificazioni e come?
- Quanto sono costati Actions e quale job ha consumato tali costi?
- Cosa è cambiato dall'ultima scansione?

| Strumento | A cosa risponde |
|---|---|
| `hk_summary` | Totali per la scansione più recente: repository, issue, richieste di pull, workflow, anomalie. |
| `hk_findings` | Anomalie per codice, gravità, categoria o repository; conteggi per codice quando non filtrati. L'anomalia di una branch principale problematica indica il job e il passaggio che hanno causato il problema. |
| `hk_ci` | Repository il cui branch predefinito è problematico e i workflow che non sono riusciti; anche le pianificazioni non riuscite, i branch delle richieste di pull non riuscite e i repository senza CI. |
| `hk_repo` | Un singolo repository nel dettaglio: anomalie, workflow, richieste di pull e issue aperte. |
| `hk_backlog` | Richieste di pull o issue aperte in tutta l'organizzazione, ordinate dalla più vecchia alla più recente. |
| `hk_health` | Un punteggio di salute per repository, ordinato dal peggiore al migliore. |
| `hk_cost` | Spese di Actions per repository, workflow o job, separate tra costi lordi e netti. |
| `hk_sql` | Una singola istruzione `SELECT` o `WITH` in sola lettura rispetto al data warehouse. |
| `hk_schema` | Le tabelle e le colonne, per scrivere query `hk_sql`. |

Ogni risposta proviene dall'istantanea più recente, aperta in sola lettura. Una chiamata non riuscita
restituisce un errore strutturato, mai una traccia dello stack.

### Come connetterlo

```json
{
  "mcpServers": {
    "housekeeping": { "command": "hk-mcp", "env": { "HK_HOME": "/path/to/warehouse" } },
    "atlas": { "command": "atlas", "args": ["mcp"] }
  }
}
```

`HK_HOME` è la directory da cui si esegue la scansione. Da un clone, utilizzare
`"command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"]`. Il secondo
server è [Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas),
che risponde allo stesso agente su un singolo repository alla volta (vedi sotto). Su
Windows, avvia un comando installato a livello globale tramite `cmd /c`.

## housekeeping e Atlas

[Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas)
(`@dogfood-lab/atlas`) mappa un singolo repository: le sue parti e le sue porte, ovvero
ogni workflow con ciò che esegue, pubblica e distribuisce. La mappa viene salvata
come `atlas/` e controllata in CI. housekeeping è la vista dell'organizzazione. I due
sono progettati per funzionare insieme.

- **Ogni mappa, acquisita.** Una scansione legge la mappa salvata di ciascun repository insieme
a tutto il resto e segnala quali repository non ne hanno, quali non eseguono mai `atlas check` e quali
contengono un motore diverso da quello a cui il resto dell'
organizzazione fa riferimento.
- **Dove un'esecuzione problematica si è verificata.** Quando un branch predefinito è problematico, l'anomalia indica
il job e il passaggio che non sono riusciti e, tramite la mappa, il comando che quel passaggio
esegue, in modo che la correzione inizi nel file corretto.
- **Fatti sul deployment dalla mappa.** L'ambiente in cui un job esegue il deployment viene preso dalla
mappa in cui lo registra, in modo che entrambi gli strumenti leggano un workflow nello stesso modo.
- **Avvisi in tutta la flotta.** Atlas segnala un passaggio del workflow che fallirà
prima di essere eseguito, come uno strumento che richiede una versione runtime più recente di quella installata dal job.
Il report elenca questi elementi per tutti i repository contemporaneamente.

Un agente con entrambi i server passa da "questi dodici repository sono bloccati"
(housekeeping) a "questo è il workflow, il job e i file che una modifica raggiungerà" (Atlas), senza aprire ogni repository manualmente.

## Perché ha questa forma

| Livello | Scelta | Motivo |
|---|---|---|
| Trasporto | la CLI `gh` | Già contiene il tuo token. Lo strumento non memorizza né richiede mai una credenziale. |
| Raccolta | GitHub GraphQL, a pagine | Una singola query restituisce metadati, issue aperte, richieste di pull aperte, release e alberi di file per una pagina di repository. Una pagina che continua a superare il tempo limite viene dimezzata e richiesta di nuovo dallo stesso cursore. |
| Esecuzioni di Actions | REST | GraphQL non ha un'interfaccia Actions. |
| Costi di Actions | API di fatturazione più durate per job | La fattura indica il repository; solo i job indicano quale flusso di lavoro. Gli endpoint GitHub di `/timing` restituiscono zeri, quindi la somma per ogni job viene ricostruita e quindi confrontata con la fattura. |
| Tariffe per l'esecuzione | lettura dalla fattura | Una tariffa fatturata può differire dal prezzo di listino e una costante nel codice sorgente falsificherebbe ogni numero. |
| Archiviazione | SQLite tramite il `node:sqlite` integrato | Nessuna fase di compilazione nativa. |
| Fonte di verità | `data/snapshots/*.json` | Dati grezzi, modificabili e con possibilità di aggiungere solo dati. Il database viene derivato: `npm run rebuild` lo ricostruisce offline. |
| Registro delle scansioni | `data/sweeps.jsonl` | Una riga per ogni scansione, comprese le scansioni che hanno avuto esito negativo e le scansioni che non hanno trovato nulla di nuovo. |

Gli snapshot sono immutabili e additivi, quindi la differenza tra due date è un `JOIN`.

## Requisiti

- Node.js 22.5 o successivo.
- La [CLI GitHub](https://cli.github.com/), con accesso (`gh auth status`) come
account in grado di leggere l'organizzazione. Per leggere le fatture e gli avvisi di sicurezza
sono necessari i permessi corrispondenti; in caso contrario, la scansione registra "non misurato" e
prosegue. Non registra mai un permesso mancante come risultato valido.
- Windows o Linux. È sviluppato su Windows e i suoi test vengono eseguiti su Linux in
CI. macOS dovrebbe funzionare, ma non è stato testato.

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
hk branches              # branches by state: merged, moved after merge, no PR
hk watch                 # open PRs, alerts and branches for a short watch list
hk versions              # package.json against git tag against npm
hk actions               # every workflow and its rule flags
hk cost                  # Actions cost, gross and net side by side
hk sql "SELECT ..."      # one read-only statement
hk help                  # every command and flag
```

In una copia senza `npm link`, ogni `hk <command>` è `node src/cli.mjs <command>`.

`npm run rebuild` deriva nuovamente il database e il report dagli snapshot già
sul disco, senza accesso alla rete.

Una scansione completa effettua alcune centinaia di chiamate API. Non eseguire `refresh` in un ciclo.

I risultati vengono inviati all'output standard; i progressi e gli errori vengono inviati all'errore standard. Ogni
errore stampa un codice e un suggerimento. Codici di uscita: 0 ok, 1 errore utente, 2 errore di runtime, 3 parziale (la scansione è terminata, con delle lacune).

## Configurazione

`housekeeping.config.json`, nella directory in cui opera housekeeping (vedere di seguito):

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` è l'organizzazione da scansionare. `hk refresh <org>` lo sovrascrive. In
caso contrario, la scansione si rifiuta di avviarsi.
- `metaRepos` sono i repository che contengono le impostazioni predefinite dell'organizzazione, le risorse o
gli strumenti, non un prodotto distribuito. Sono esenti dai risultati che hanno senso solo per un prodotto: mancanza di file README, LICENSE e simili, assenza di flussi di lavoro e assenza di versioni.

Un file non valido è un errore, mai un valore predefinito silenzioso: una chiave sconosciuta, un tipo errato o un JSON non valido interrompono l'esecuzione.

Eseguire da una copia, housekeeping mantiene `data/`, `reports/` e il file di configurazione
nella copia. Eseguire come pacchetto installato, li mantiene nella directory da cui
lo si esegue o in `HK_HOME` quando è impostato.

Ambiente: `HK_HOME` (dove risiedono i dati, i report e la configurazione),
`HK_CONFIG` (percorso della configurazione), `HK_DB` (percorso del database), `HK_LOG`
(`silent`, `normal`, `verbose` o `debug`), `HK_COST_REPOS` e
`HK_COST_BUDGET` (limiti per il costo per job), `GH_PATH` (percorso di `gh`).

## Mantenere i dati privati

**Ciò che una scansione scrive è sensibile. Non inserire `data/` o `reports/` in un
repository pubblico.**

Uno snapshot registra i nomi e le descrizioni dei repository privati, ogni
avviso di sicurezza aperto con il pacchetto a cui si riferisce, i file del flusso di lavoro e la fatturazione di Actions. GitHub nasconde deliberatamente gli avvisi di sicurezza di un repository pubblico a tutti tranne che ai suoi manutentori; uno snapshot pubblicato fornirebbe tale elenco.

Il `.gitignore` di questo repository esclude `data/`, `reports/` e
`housekeeping.config.json`. Per mantenere la cronologia, che è lo scopo degli snapshot,
eseguire lo strumento da un **repository privato** di proprietà e inserirli lì.

## Risultati

Le regole sono contenute in `src/analyze.mjs`. Ognuna di esse cita la regola scritta che applica,
quindi un risultato può essere contestato rispetto a uno standard e non al gusto personale. Le regole
che questo repository distribuisce sono in [`rules/`](rules/):

- [`rules/github-actions.md`](rules/github-actions.md): filtri dei percorsi, esecutori, dimensione della matrice, limite del file del flusso di lavoro, concorrenza.
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md): il CI deve essere superato, i gate di rilascio, le versioni.
- [`rules/repo-first.md`](rules/repo-first.md): la branch predefinita.
- [`rules/atlas-map.md`](rules/atlas-map.md): una mappa impegnata di ciascun repository, controllata nel CI.

Sono gli standard di un'organizzazione. Se i vostri sono diversi, modificate il file delle regole
e la regola insieme.

Le regole si assicurano di mantenere separate le cose che sembrano simili, perché combinarle produce rumore:

- **Una branch predefinita rossa non è una branch di richiesta di pull rossa.** Una branch Dependabot non riuscita è un backlog; un'esecuzione `push` non riuscita sulla branch predefinita è un errore. L'evento dell'esecuzione decide quale.
- **La cronologia non è un errore.** Un flusso di lavoro spostato in release-only mantiene
il suo ultimo errore sulla branch predefinita per sempre. Un flusso di lavoro eliminato mantiene le sue esecuzioni.
Nessuno dei due è un difetto attivo.
- **Un controllo richiesto che nulla può emettere non è un controllo che non è stato eseguito qui.**
Uno dice di eliminare il requisito; l'altro dice di correggere il trigger. Le correzioni
si contraddicono a vicenda.
- **Una richiesta di pull saltata dal trigger non è una richiesta di pull in conflitto.** GitHub non esegue
nessun flusso di lavoro di richiesta di pull su una richiesta di pull con conflitti, quindi il suo controllo mancante non dice nulla sul trigger. Quello richiede un rebase.
- **Un'esecuzione non riuscita non è un'esecuzione annullata.** `cancel-in-progress` esiste per interrompere
le esecuzioni obsolete, quindi i minuti annullati sono in genere la regola di concorrenza in funzione.
- **Il costo lordo non è il costo netto.** GitHub misura i repository pubblici a prezzo pieno e li sconta a zero. Il costo lordo è la potenza di calcolo reale; il costo netto è il denaro reale.
Non vengono mai sommati.
- **Non misurato non è pulito.** Un repository GitHub che non esegue la scansione dei report
non segnala alcun avviso. Un repository a cui il passaggio dei costi non è arrivato non ha una riga dei costi. Entrambi
vengono segnalati come sconosciuti.

La gravità determina un punteggio di integrità: critico 40, alto 15, medio 6, basso 2, informativo 0,
dedotto da 100. Il punteggio classifica l'attenzione, non la qualità.

Il [manuale](https://mcp-tool-shop-org.github.io/housekeeping/handbook/) elenca tutti i risultati, i comandi, i codici di errore e le tabelle.

## Sicurezza

- **Solo lettura.** Il raccoglitore esegue GraphQL query e richieste REST `GET`. Non esegue mai operazioni di unione, invio, rilascio, pubblicazione o modifica delle impostazioni.
- **Nessuna credenziale.** L'autenticazione utilizza le credenziali già presenti in `gh`. Nessun dato viene scritto su disco al riguardo.
- **Nessuna telemetria.** Gli unici host contattati sono l'API GitHub, tramite `gh`, e il registro npm, per la verifica della versione e degli avvisi.
- **Cosa memorizza** è la parte sensibile: vedere "Mantenere i dati privati".

Segnalare una vulnerabilità come descritto in [SECURITY.md](SECURITY.md).

## Test

```bash
npm test
```

Ogni regola viene testata in entrambe le direzioni: la configurazione che deve attivarsi e la configurazione adiacente che non deve attivarsi. Un verificatore separato ricava un campione di risultati dai dati GitHub in tempo reale tramite il proprio canale di comunicazione e, in caso di assenza del database o della rete, segnala l'errore in modo evidente.

## Licenza

MIT. Vedere [LICENSE](LICENSE).

---

Realizzato da <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
