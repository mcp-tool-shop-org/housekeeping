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

Uma única execução coleta o status de CI de cada repositório, problemas abertos e solicitações de pull,
lançamentos, tags de versão, arquivos de fluxo de trabalho, proteção de ramificação, alertas de segurança,
arquivos de bloqueio e faturamento do Actions em SQLite, e, em seguida, verifica tudo em relação às regras definidas.

Ele responde, para toda a organização de uma só vez:

- Quais são os ramos padrão que estão com problemas e isso indica uma linha principal com defeito ou um histórico desatualizado?
- Quais solicitações de pull nunca podem ser mescladas, porque uma verificação obrigatória não está sendo executada e está bloqueando-as?
- Quais implantações são rejeitadas pelas próprias configurações do repositório?
- Onde `package.json`, as tags Git e o registro npm divergiram?
- Quais fluxos de trabalho violam as regras de custo do Actions, quanto custaram e quais tarefas consumiram esses recursos?
- Quais repositórios contêm avisos que o número de alertas do GitHub não detecta?

É um instrumento de auditoria, não um corretor. Ele lê GitHub e não altera nada.

## Um agente em cada repositório

Uma organização com dezenas de repositórios não tem um único local onde seu
estado é armazenado. housekeeping é esse local, e seu servidor MCP, `hk-mcp`, o fornece
a um agente de IA. Com ele, um único agente pode atuar como o coordenador para toda
a organização:

1. **Execução.** `hk refresh` captura um instantâneo de cada repositório.
2. **Triagem.** O agente pergunta o que está com problemas, o que está bloqueado e o que piorou,
e obtém respostas que já distinguem uma linha principal com defeito de um histórico desatualizado e
uma solicitação de pull travada de uma com conflitos.
3. **Planejar uma onda.** Uma consulta `hk_sql` encontra todos os repositórios com a mesma
estrutura, para que uma correção se torne uma única solicitação de pull por repositório, em vez de uma busca.
4. **Realizar o trabalho.** housekeeping nunca grava. O agente abre solicitações de pull
com suas próprias ferramentas, sob suas próprias permissões e com sua revisão.
5. **Verificar.** Executar novamente. A descoberta desapareceu ou não, e a mudança
entre dois instantâneos é uma consulta.

Perguntas que um agente responde em uma ou duas interações:

- Quais são os ramos padrão que estão com problemas e qual tarefa e etapa causaram o problema?
- Quais solicitações de pull nunca podem ser mescladas e o gatilho ou um conflito são os culpados?
- Quais repositórios contêm um aviso de produção para o qual GitHub não mostra nenhum alerta?
- Quais fluxos de trabalho agendados violam as regras para agendamentos e como?
- Quanto o Actions custou e qual tarefa consumiu esses recursos?
- O que mudou desde a última execução?

| Ferramenta | O que ela responde |
|---|---|
| `hk_summary` | Totais da execução mais recente: repositórios, problemas, solicitações de pull, fluxos de trabalho, descobertas. |
| `hk_findings` | Descobertas por código, gravidade, categoria ou repositório; contagens por código quando não filtrado. A descoberta de uma linha principal com problemas indica a tarefa e a etapa que causaram o problema. |
| `hk_ci` | Repositórios cujo ramo padrão está com problemas e os fluxos de trabalho que falharam; também, agendamentos com falha, ramos de solicitação de pull com falha e repositórios sem CI. |
| `hk_repo` | Um repositório completo: descobertas, fluxos de trabalho, solicitações de pull e problemas abertos. |
| `hk_backlog` | Solicitações de pull ou problemas abertos em toda a organização, da mais antiga para a mais recente. |
| `hk_health` | Uma pontuação de saúde por repositório, da pior para a melhor. |
| `hk_cost` | Gastos do Actions por repositório, fluxo de trabalho ou tarefa, separados em valores brutos e líquidos. |
| `hk_sql` | Uma única instrução `SELECT` ou `WITH` somente leitura contra o armazém. |
| `hk_schema` | As tabelas e colunas para gravar consultas `hk_sql`. |

Cada resposta vem do instantâneo mais recente, aberto em modo somente leitura. Uma interação com falha
retorna um erro estruturado, nunca um rastreamento de pilha.

### Conecte-o

```json
{
  "mcpServers": {
    "housekeeping": { "command": "hk-mcp", "env": { "HK_HOME": "/path/to/warehouse" } },
    "atlas": { "command": "atlas", "args": ["mcp"] }
  }
}
```

`HK_HOME` é o diretório do qual você executa. De um clone, use
`"command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"]`. O segundo
servidor é [Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas),
que responde ao mesmo agente sobre um repositório por vez (veja abaixo). No
Windows, inicie um comando instalado globalmente por meio de `cmd /c`.

## housekeeping e Atlas

[Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas)
(`@dogfood-lab/atlas`) mapeia um repositório: suas partes e suas portas, o que significa
cada fluxo de trabalho com o que ele executa, publica e implanta. O mapa é confirmado
como `atlas/` e verificado no CI. housekeeping é a visão da organização. Os dois
são construídos para funcionar juntos.

- **Cada mapa, executado.** Uma execução lê o mapa confirmado de cada repositório, juntamente
com tudo o mais, e relata quais repositórios não têm um, quais nunca
executam `atlas check` e quais contêm um mecanismo diferente do que o restante da
organização usa.
- **Onde uma execução com problemas falhou.** Quando um ramo padrão está com problemas, a descoberta indica
a tarefa e a etapa que falharam e, por meio do mapa, o comando que essa etapa
executa, para que a correção comece no arquivo correto.
- **Fatos de implantação do mapa.** O ambiente para o qual uma tarefa é implantada é obtido
do mapa, onde ele registra um, para que ambas as ferramentas leiam um fluxo de trabalho da mesma forma.
- **Avisos em toda a frota.** Atlas sinaliza uma etapa do fluxo de trabalho que falhará
antes de ser executada, como uma ferramenta que precisa de uma versão mais recente do tempo de execução do que a tarefa
instala. O relatório lista esses avisos para cada repositório de uma só vez.

Um agente com ambos os servidores passa de "esses doze repositórios estão bloqueados"
(housekeeping) para "este é o fluxo de trabalho, a tarefa e os arquivos que uma alteração alcançará" (Atlas), sem abrir cada repositório manualmente.

## Por que ele tem essa estrutura

| Camada | Escolha | Razão |
|---|---|---|
| Transporte | a CLI `gh` | Ela já contém seu token. A ferramenta nunca armazena ou solicita uma credencial. |
| Coleta | GitHub GraphQL, paginado | Uma consulta retorna metadados, problemas abertos, solicitações de pull abertas, lançamentos e árvores de arquivos para uma página de repositórios. Uma página que continua a atingir o tempo limite é dividida ao meio e solicitada novamente a partir do mesmo cursor. |
| Execuções do Actions | REST | GraphQL não tem uma superfície do Actions. |
| Custo do Actions | API de faturamento mais durações por tarefa | A fatura indica qual repositório; apenas os trabalhos indicam qual fluxo de trabalho. Os pontos finais de GitHub's `/timing` retornam zeros, portanto, a soma por trabalho é reconstruída e, em seguida, reconciliada com a fatura. |
| Taxas de execução | lidas da fatura | Uma taxa cobrada pode diferir do preço de tabela, e uma constante na fonte distorceria todos os números. |
| Armazenamento | SQLite através do `node:sqlite` integrado | Sem etapa de construção nativa. |
| Fonte da verdade | `data/snapshots/*.json` | Bruta, comparável e apenas para anexar. O banco de dados é derivado: `npm run rebuild` o reconstrói offline. |
| Registro de varredura | `data/sweeps.jsonl` | Uma linha por varredura, incluindo varreduras que falharam e varreduras que não encontraram nada de novo. |

Os instantâneos são imutáveis e aditivos, portanto, a diferença entre duas datas é um `JOIN`.

## Requisitos

- Node.js 22.5 ou posterior.
- A [CLI GitHub](https://cli.github.com/), conectado (`gh auth status`) como uma
conta que pode ler a organização. A leitura de faturas e alertas de segurança
requer o acesso correspondente; uma varredura sem ele registra "não medido" e
continua. Nunca registra uma permissão ausente como um resultado válido.
- Windows ou Linux. É desenvolvido no Windows e seus testes são executados no Linux em
CI. macOS deve funcionar e não é testado.

## Uso

```bash
npm install -g @mcptoolshop/housekeeping   # puts `hk` and `hk-mcp` on your path
mkdir warehouse && cd warehouse            # housekeeping keeps its data here
hk refresh your-org                        # collect, load, analyze, write reports/AUDIT-<date>.md
```

Para manter as configurações entre as varreduras, coloque um `housekeeping.config.json` nesse
diretório (veja Configuração); então, `hk refresh` não precisa de nenhum argumento.

Ou execute-o a partir de um clone, o que mantém seus dados no clone:

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
hk branches              # branches by state: merged, moved after merge, no PR
hk watch                 # open PRs, alerts and branches for a short watch list
hk versions              # package.json against git tag against npm
hk actions               # every workflow and its rule flags
hk cost                  # Actions cost, gross and net side by side
hk sql "SELECT ..."      # one read-only statement
hk help                  # every command and flag
```

Em um clone sem `npm link`, cada `hk <command>` é `node src/cli.mjs <command>`.

`npm run rebuild` rederiva o banco de dados e o relatório a partir de instantâneos já
armazenados em disco, sem acesso à rede.

Uma varredura completa faz algumas centenas de chamadas de API. Não execute `refresh` em um loop.

Os resultados são enviados para a saída padrão; o progresso e os erros são enviados para a saída de erro padrão. Cada
erro imprime um código e uma dica. Códigos de saída: 0 ok, 1 erro do usuário, 2 erro de tempo de execução, 3 parcial (a varredura foi concluída, com lacunas).

## Configuração

`housekeeping.config.json`, no diretório em que a ferramenta de limpeza funciona (veja abaixo):

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` é a organização a ser varrida. `hk refresh <org>` o substitui. Sem
nenhum dos dois, uma varredura se recusará a iniciar.
- `metaRepos` são repositórios que contêm configurações, ativos ou
ferramentas padrão da organização, não um produto lançado. Eles estão isentos das descobertas que só
fazem sentido para um produto: ausência de arquivos README, LICENSE e semelhantes, ausência de
fluxos de trabalho e ausência de lançamentos.

Um arquivo malformado é um erro, nunca um padrão silencioso: uma chave desconhecida, um tipo incorreto ou um JSON corrompido interrompe a execução.

Execute a partir de um clone, a ferramenta de limpeza mantém `data/`, `reports/` e o arquivo de configuração
no clone. Execute como um pacote instalado, ele os mantém no diretório de onde
você o executa ou em `HK_HOME` quando isso for definido.

Ambiente: `HK_HOME` (onde os dados, relatórios e a configuração estão localizados),
`HK_CONFIG` (caminho da configuração), `HK_DB` (caminho do banco de dados), `HK_LOG`
(`silent`, `normal`, `verbose` ou `debug`), `HK_COST_REPOS` e
`HK_COST_BUDGET` (limites da passagem de custo por trabalho), `GH_PATH` (caminho para `gh`).

## Mantenha os dados privados

**O que uma varredura grava é confidencial. Não envie `data/` ou `reports/` para um
repositório público.**

Um instantâneo registra os nomes e as descrições de repositórios privados, todos os
alertas de segurança abertos com o pacote que ele nomeia, arquivos de fluxo de trabalho e faturamento do Actions. GitHub oculta deliberadamente os alertas de segurança de um repositório público de
todos, exceto seus mantenedores; um instantâneo publicado entregaria essa lista.

O `.gitignore` deste repositório exclui `data/`, `reports/` e
`housekeeping.config.json`. Para manter o histórico, que é o objetivo dos instantâneos,
execute a ferramenta a partir de um **repositório privado** de sua propriedade e envie-os para lá.

## Descobertas

As regras estão em `src/analyze.mjs`. Cada uma cita a regra escrita que ela aplica,
portanto, uma descoberta pode ser contestada em relação a um padrão e não em relação ao gosto. As regras
que este repositório envia estão em [`rules/`](rules/):

- [`rules/github-actions.md`](rules/github-actions.md): filtros de caminho, executores, tamanho da matriz, limite do arquivo de fluxo de trabalho, concorrência.
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md): o CI deve ser aprovado, os portões de envio, versões.
- [`rules/repo-first.md`](rules/repo-first.md): o branch padrão.
- [`rules/atlas-map.md`](rules/atlas-map.md): um mapa comprometido de cada repositório, verificado no CI.

São os padrões de uma organização. Se os seus forem diferentes, altere o arquivo de regra
e a regra juntos.

As regras têm o cuidado de manter separados os itens que parecem semelhantes, porque combiná-los produz ruído:

- **Um branch padrão vermelho não é um branch de solicitação de pull vermelho.** Um branch Dependabot com falha é um backlog; uma execução `push` com falha no branch padrão é
uma falha. O evento da execução decide qual é.
- **O histórico não é uma falha.** Um fluxo de trabalho movido para gatilhos apenas de lançamento mantém
sua última falha no branch padrão para sempre. Um fluxo de trabalho excluído mantém suas execuções.
Nenhum deles é um defeito ativo.
- **Uma verificação obrigatória que nada pode emitir não é uma verificação que não foi executada aqui.**
Uma diz para remover o requisito; a outra diz para corrigir o gatilho. As correções
se contradizem.
- **Uma solicitação de pull que o gatilho ignorou não é uma solicitação de pull com conflitos.** GitHub não executa
nenhum fluxo de trabalho de solicitação de pull em uma solicitação de pull com conflitos, portanto, sua verificação ausente não diz nada sobre o gatilho. Essa precisa de uma rebase.
- **Uma execução com falha não é uma execução cancelada.** `cancel-in-progress` existe para matar
execuções substituídas, portanto, os minutos cancelados geralmente são a regra de concorrência em funcionamento.
- **O custo bruto não é o custo líquido.** GitHub mede repositórios públicos com o preço total
e os desconta para zero. O bruto é a computação real; o líquido é o dinheiro real.
Eles nunca são somados.
- **Não medido não é limpo.** Um repositório GitHub não está digitalizando relatórios
zero alertas. Um repositório que a passagem de custo não alcançou não tem linha de custo. Ambos
são relatados como desconhecidos.

A gravidade impulsiona uma pontuação de integridade: crítico 40, alto 15, médio 6, baixo 2, informativo 0,
deduzido de 100. A pontuação classifica a atenção, não a qualidade.

O [manual](https://mcp-tool-shop-org.github.io/housekeeping/handbook/) lista todos os resultados, comandos, códigos de erro e tabelas.

## Segurança

- **Apenas leitura.** O coletor emite GraphQL consultas e solicitações REST `GET`. Ele nunca
combina, envia, lança, publica ou edita uma configuração.
- **Sem credenciais.** A autenticação é o que `gh` já possui. Nada é
gravado em disco a respeito.
- **Sem telemetria.** Os únicos servidores contactados são a API GitHub, através de `gh`,
e o registo npm, para verificar versões e avisos.
- **O que ele armazena** é a parte sensível: veja "Mantenha os dados privados".

Reporte uma vulnerabilidade conforme descrito em [SECURITY.md](SECURITY.md).

## Testes

```bash
npm test
```

Cada regra é testada em ambas as direções: a forma que deve ser ativada e a
forma vizinha que não deve ser. Um verificador separado deriva novamente uma amostra de
resultados a partir de GitHub em tempo real, através do seu próprio transporte, e ignora, de forma evidente, quando
não há banco de dados ou rede.

## Licença

MIT. Veja [LICENSE](LICENSE).

---

Criado por <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>
