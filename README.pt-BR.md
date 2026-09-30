<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.md">English</a>
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

Uma execução coleta o status de CI de todos os repositórios, problemas abertos e solicitações de pull,
lançamentos, tags de versão, arquivos de fluxo de trabalho, proteção de branch, alertas de segurança,
arquivos de bloqueio e faturamento do Actions em SQLite, e, em seguida, verifica tudo em relação às
regras definidas.

Ele responde, para toda a organização de uma só vez:

- Quais branches padrão estão marcadas em vermelho e isso indica uma branch principal com problemas ou um histórico desatualizado?
- Quais solicitações de pull nunca podem ser mescladas, porque uma verificação obrigatória que não emite nada está bloqueando-as?
- Quais implantações as configurações do próprio repositório rejeitam?
- Onde `package.json`, as tags Git e o registro npm divergiram?
- Quais fluxos de trabalho violam as regras de custo do Actions, quanto custaram e quais tarefas gastaram esse valor?
- Quais repositórios contêm avisos que o próprio contador de alertas do GitHub não detecta?

É um instrumento de auditoria, não um corretor. Ele lê o GitHub e não altera nada.

## Por que ele tem essa estrutura:

| Camada | Escolha | Razão |
|---|---|---|
| Transporte | a CLI `gh` | Ele já contém seu token. A ferramenta nunca armazena ou solicita uma credencial. |
| Coleta | GitHub GraphQL, paginado | Uma consulta retorna metadados, problemas abertos, solicitações de pull abertas, lançamentos e árvores de arquivos para uma página de repositórios. Uma página que continua excedendo o tempo limite é dividida ao meio e a solicitação é repetida a partir do mesmo cursor. |
| Execuções do Actions | REST | O GraphQL não tem uma interface para o Actions. |
| Custo do Actions | API de faturamento mais durações por tarefa | A fatura indica qual repositório; apenas as tarefas indicam qual fluxo de trabalho. Os endpoints `/timing` do GitHub retornam zeros, portanto, a soma por tarefa é reconstruída e, em seguida, reconciliada com a fatura. |
| Taxas do Runner | lidas da fatura | Uma taxa faturada pode diferir do preço de tabela, e uma constante na fonte distorceria todos os números. |
| Armazenamento | SQLite por meio do `node:sqlite` integrado | Sem etapa de construção nativa. |
| Fonte da verdade | `data/snapshots/*.json` | Bruta, comparável e apenas para anexar. O banco de dados é derivado: `npm run rebuild` o reconstrói offline. |
| Registro da execução | `data/sweeps.jsonl` | Uma linha por execução, incluindo execuções que falharam e execuções que não encontraram nada de novo. |

Os snapshots são imutáveis e aditivos, portanto, a diferença entre duas datas é um `JOIN`.

## Requisitos

- Node.js 22.5 ou posterior.
- O [GitHub CLI](https://cli.github.com/), conectado (`gh auth status`) como uma
conta que pode ler a organização. A leitura do faturamento e dos alertas de segurança
requer o acesso correspondente; uma execução sem ele registra "não medido" e
continua. Ele nunca registra uma permissão ausente como um resultado válido.
- Windows ou Linux. Ele é desenvolvido no Windows e seus testes são executados no Linux em
CI. O macOS deve funcionar e não é testado.

## Uso

```bash
npm install -g @mcptoolshop/housekeeping   # puts `hk` and `hk-mcp` on your path
mkdir warehouse && cd warehouse            # housekeeping keeps its data here
hk refresh your-org                        # collect, load, analyze, write reports/AUDIT-<date>.md
```

Para manter as configurações entre as execuções, coloque um `housekeeping.config.json` nesse diretório (veja a seção Configuração); então, `hk refresh` não precisa de nenhum argumento.

Ou execute-o a partir de uma cópia, que mantém os seus dados na cópia:

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh
```

Em seguida, consulte-o:

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

Em uma cópia sem `npm link`, cada `hk <command>` é `node src/cli.mjs <command>`.

`npm run rebuild` rederiva o banco de dados e o relatório a partir de snapshots já
armazenados no disco, sem acesso à rede.

Uma execução completa faz algumas centenas de chamadas de API. Não execute `refresh` em um loop.

Os resultados são enviados para a saída padrão; o progresso e os erros são enviados para a saída de erro padrão. Cada
erro imprime um código e uma dica. Códigos de saída: 0 ok, 1 erro do usuário, 2 erro de tempo de execução, 3 parcial (a execução foi concluída, com lacunas).

## Configuração

`housekeeping.config.json`, no diretório em que a ferramenta de organização funciona (veja abaixo):

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` é a organização a ser executada. `hk refresh <org>` o substitui. Sem
nenhum dos dois, uma execução se recusará a iniciar.
- `metaRepos` são os repositórios que contêm as configurações, ativos ou
ferramentas padrão da organização, e não um produto lançado. Eles são isentos das descobertas que só
fazem sentido para um produto: ausência de arquivos README, LICENSE e semelhantes, ausência de
fluxos de trabalho e ausência de lançamentos.

Um arquivo malformado é um erro, nunca um padrão silencioso: uma chave desconhecida, um tipo incorreto ou um JSON corrompido interrompe a execução.

Execute a partir de um clone, a ferramenta de organização mantém `data/`, `reports/` e o arquivo de configuração
no clone. Execute como um pacote instalado, ele os mantém no diretório de onde
você o executa ou em `HK_HOME` quando isso estiver definido.

Ambiente: `HK_HOME` (onde os dados, relatórios e a configuração estão localizados),
`HK_CONFIG` (caminho da configuração), `HK_DB` (caminho do banco de dados), `HK_LOG`
(`silent`, `normal`, `verbose` ou `debug`), `HK_COST_REPOS` e
`HK_COST_BUDGET` (limites para a passagem do custo por tarefa), `GH_PATH` (caminho para `gh`).

## Mantenha os dados privados

**O que uma execução grava é confidencial. Não inclua `data/` ou `reports/` em um
repositório público.**

Um snapshot registra os nomes e as descrições dos repositórios privados, todos os
alertas de segurança abertos com o pacote que ele nomeia, arquivos de fluxo de trabalho e faturamento do Actions. O GitHub oculta deliberadamente os alertas de segurança de um repositório público de
todos, exceto seus mantenedores; um snapshot publicado entregaria essa lista.

O `.gitignore` deste repositório exclui `data/`, `reports/` e
`housekeeping.config.json`. Para manter o histórico, que é o objetivo dos snapshots,
execute a ferramenta a partir de um repositório **privado** de sua propriedade e inclua-os lá.

## Servidor MCP

`hk-mcp` (ou `npm run mcp` em uma cópia) serve os dados ao programa através do stdio, para que um assistente possa fazer perguntas sem precisar ler um arquivo de vários megabytes:

`hk_summary` · `hk_findings` · `hk_ci` · `hk_repo` · `hk_backlog` ·
`hk_health` · `hk_cost` · `hk_sql` · `hk_schema`

```json
{
  "mcpServers": {
    "housekeeping": { "command": "hk-mcp", "env": { "HK_HOME": "/path/to/warehouse" } }
  }
}
```

`HK_HOME` é o diretório a partir do qual você executa o programa. Em uma cópia, use `"command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"]` em vez disso.

`hk_sql` aceita uma única instrução `SELECT` ou `WITH` e abre o banco de dados
em modo somente leitura. Uma chamada com falha retorna um erro estruturado, nunca um rastreamento de pilha.

## Descobertas

As regras estão em `src/analyze.mjs`. Cada uma cita a regra escrita que ela aplica,
para que uma descoberta possa ser contestada em relação a um padrão e não em relação ao gosto pessoal. As regras
que este repositório envia estão em [`rules/`](rules/):

- [`rules/github-actions.md`](rules/github-actions.md): filtros de caminhos, executores, tamanho da matriz, limite do arquivo de fluxo de trabalho, concorrência.
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md): o CI deve ser aprovado, os critérios de lançamento, versões.
- [`rules/repo-first.md`](rules/repo-first.md): o ramo padrão.
- [`rules/atlas-map.md`](rules/atlas-map.md): um mapa registrado de cada repositório, verificado no CI.

São os padrões de uma organização. Se os seus forem diferentes, altere o arquivo de regra e a regra em conjunto.

As regras têm o cuidado de manter separados os elementos que parecem semelhantes, porque agrupá-los gera ruído:

- **Um ramo padrão vermelho não é um ramo de solicitação de pull vermelho.** Um ramo do Dependabot com falha é um acúmulo; uma execução `push` com falha no ramo padrão é uma falha. O evento da execução decide qual é.
- **O histórico não é uma falha.** Um fluxo de trabalho movido para gatilhos apenas de lançamento mantém sua última falha no ramo padrão para sempre. Um fluxo de trabalho excluído mantém suas execuções. Nenhum dos dois é um defeito ativo.
- **Uma verificação obrigatória que nada pode emitir não é uma verificação que não foi executada aqui.** Uma diz para remover o requisito; a outra diz para corrigir o gatilho. As correções contradizem-se.
- **Uma execução com falha não é uma execução cancelada.** `cancel-in-progress` existe para encerrar execuções substituídas, portanto, os minutos cancelados geralmente são a regra de concorrência em funcionamento.
- **O custo bruto não é o custo líquido.** O GitHub mede os repositórios públicos com o preço total e os reduz a zero. O bruto é o poder de computação real; o líquido é o dinheiro real. Eles nunca são somados.
- **O que não é medido não é limpo.** Um repositório do GitHub que não está sendo verificado relata zero alertas. Um repositório cujo limite de custo não foi atingido não tem linha de custo. Ambos são relatados como desconhecidos.

A gravidade impulsiona uma pontuação de saúde: crítica 40, alta 15, média 6, baixa 2, informativa 0, deduzida de 100. A pontuação classifica a atenção, não a qualidade.

O [manual](https://mcp-tool-shop-org.github.io/housekeeping/handbook/) lista cada descoberta, comando, código de erro e tabela.

## Segurança

- **Somente leitura.** O coletor emite consultas GraphQL e solicitações REST `GET`. Ele nunca mescla, envia, lança, publica ou edita uma configuração.
- **Sem credenciais.** A autenticação é o que `gh` já possui. Nada é gravado em disco sobre isso.
- **Sem telemetria.** Os únicos hosts contatados são a API do GitHub, por meio de `gh`, e o registro npm, para pesquisas de versão e avisos.
- **O que ele armazena** é a parte sensível: veja "Mantenha os dados privados".

Relate uma vulnerabilidade conforme descrito em [SECURITY.md](SECURITY.md).

## Testes

```bash
npm test
```

Cada regra é testada em ambas as direções: a forma que deve ser ativada e a forma vizinha que não deve ser. Um verificador separado deriva novamente uma amostra de descobertas do GitHub em tempo real por meio de seu próprio transporte e ignora, em voz alta, quando não há banco de dados ou rede.

## Licença

MIT. Veja [LICENSE](LICENSE).

---

Criado por <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
