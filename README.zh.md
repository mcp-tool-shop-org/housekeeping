<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.md">English</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

一次扫描收集每个仓库的 CI 状态、未解决的问题和拉取请求、发布、版本标签、工作流文件、分支保护、安全警报、锁文件和 Actions 账单，并将所有内容存储到 SQLite 中，然后根据编写的规则对所有内容进行审核。

它一次性回答整个组织的问题：

- 哪些默认分支显示为红色，这是否表示主线已损坏或历史记录已过时？
- 哪些拉取请求永远无法合并，因为一个必需的检查未发出，从而阻止了它们？
- 哪些部署被仓库自身的设置拒绝？
- `package.json`、Git 标签和 npm 注册表之间的差异在哪里？
- 哪些工作流违反了 Actions 成本规则，它们花费了多少，哪些任务花费了这些成本？
- 哪些仓库包含 GitHub 自身的警报计数未识别的建议？

它是一种审计工具，而不是修复工具。它读取 GitHub 数据，但不进行任何更改。

## 每个仓库都有一个代理

拥有数十个仓库的组织没有一个统一的地方来存储其状态。housekeeping 就是这个地方，它的 MCP 服务器 `hk-mcp` 将数据提供给一个 AI 代理。通过它，一个代理可以充当整个组织的协调器：

1. **扫描。** `hk refresh` 提取每个仓库的快照。
2. **分类。** 代理询问哪些内容显示为红色、哪些内容被阻止以及哪些内容变得更糟，并获得答案，这些答案可以区分已损坏的主线和过时的历史记录，以及区分停滞的拉取请求和冲突的拉取请求。
3. **规划一个批次。** 一个 `hk_sql` 查询找到具有相同结构的每个仓库，因此修复变成每个仓库一个拉取请求，而不是一次性查找。
4. **执行工作。** housekeeping 从不进行写入。代理使用自己的工具，在自己的权限下打开拉取请求，并由您进行审核。
5. **验证。** 再次扫描。如果发现的问题已解决，或者未解决，那么两次快照之间的差异就是一个查询。

代理在一次或两次调用中回答的问题：

- 哪些默认分支显示为红色，以及哪个任务和步骤导致了错误？
- 哪些拉取请求永远无法合并，是触发器还是冲突导致了问题？
- 哪些仓库包含生产建议，而 GitHub 没有显示任何警报？
- 哪些计划工作流违反了计划规则，以及如何违反？
- Actions 花费了多少，哪些任务花费了这些成本？
- 自上次扫描以来，发生了哪些变化？

| 工具 | 它回答的问题 |
|---|---|
| `hk_summary` | 最新扫描的总计：仓库、问题、拉取请求、工作流、发现。 |
| `hk_findings` | 按代码、严重程度、类别或仓库分类的发现；未筛选时，按代码计数。红色主线的发现会命名导致错误的作业和步骤。 |
| `hk_ci` | 默认分支显示为红色的仓库以及失败的工作流；还包括失败的计划、失败的拉取请求分支以及没有 CI 的仓库。 |
| `hk_repo` | 完整的单个仓库：发现、工作流、未解决的拉取请求和问题。 |
| `hk_backlog` | 整个组织中未解决的拉取请求或问题，按时间顺序排列。 |
| `hk_health` | 每个仓库的健康评分，按从好到坏的顺序排列。 |
| `hk_cost` | Actions 按仓库、工作流或作业花费的成本，分别显示总成本和净成本。 |
| `hk_sql` | 针对仓库执行的单个只读 `SELECT` 或 `WITH` 语句。 |
| `hk_schema` | 表和列，用于编写 `hk_sql` 查询。 |

每个答案都来自最新的快照，并且以只读方式打开。如果调用失败，则返回结构化的错误，而不是堆栈跟踪。

### 连接它

```json
{
  "mcpServers": {
    "housekeeping": { "command": "hk-mcp", "env": { "HK_HOME": "/path/to/warehouse" } },
    "atlas": { "command": "atlas", "args": ["mcp"] }
  }
}
```

`HK_HOME` 是您从中进行扫描的目录。从克隆版本开始，使用 `"command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"]`。第二个服务器是 [Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas)，它回答关于单个仓库的相同代理的问题（参见下文）。在 Windows 上，通过 `cmd /c` 启动全局安装的命令。

## housekeeping 和 Atlas

[Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas) (`@dogfood-lab/atlas`) 映射一个仓库：它的各个部分以及它的入口，这意味着每个工作流及其运行、发布和部署的内容。该映射作为 `atlas/` 提交并检查到 CI 中。housekeeping 是组织视图。这两个工具是为协同工作而设计的。

- **每个映射，都进行扫描。** 扫描读取每个仓库的已提交映射以及所有其他内容，并报告哪些仓库没有映射，哪些仓库从未运行 `atlas check`，以及哪些仓库包含与组织中其他仓库使用的引擎不同的引擎。
- **红色运行失败的位置。** 当默认分支显示为红色时，该发现会命名失败的作业和步骤，并通过映射，命名该步骤运行的命令，因此修复从正确的文件开始。
- **从映射中获取部署事实。** 作业部署到的环境是从映射中获取的，映射中记录了该环境，因此这两个工具以相同的方式读取工作流。
- **整个组织中的警告。** Atlas 标记一个工作流步骤，该步骤将在运行之前失败，例如需要比作业安装的更新运行时环境的工具。该报告一次性列出所有仓库中的这些步骤。

使用这两个服务器的代理从“这十二个仓库被阻止” (housekeeping) 变为“这是工作流、作业和更改将影响的文件” (Atlas)，而无需手动打开每个仓库。

## 为什么它具有这种结构

| 层 | 选择 | 原因 |
|---|---|---|
| 传输 | `gh` CLI | 它已经持有您的令牌。该工具从不存储或请求任何凭据。 |
| 收集 | GitHub GraphQL，分页 | 一个查询返回一个页面中仓库的元数据、未解决的问题、未解决的拉取请求、发布和文件树。如果一个页面持续超时，则将其减半并从相同的游标重新请求。 |
| Actions 运行 | REST | GraphQL 没有 Actions 接口。 |
| 操作需要成本 | 计费 API 加上每个作业的持续时间 | 发票上会显示哪个仓库；只有作业会显示哪个工作流程。GitHub 的 `/timing` 端点返回零，因此会重新计算每个作业的总和，然后与发票进行核对。 |
| 运行器费率 | 从发票中读取 | 已计费的费率可能与列表价格不同，并且源中的常量会错误地显示每个数字。 |
| 存储 | 通过内置的 `node:sqlite` 使用 SQLite | 没有本地构建步骤。 |
| 事实来源 | `data/snapshots/*.json` | 原始、可比较且仅可追加。数据库是派生的：`npm run rebuild` 在离线状态下重建它。 |
| 扫描日志 | `data/sweeps.jsonl` | 每条扫描记录一行，包括失败的扫描和未发现任何新内容的扫描。 |

快照是不可变的且具有累积性，因此两个日期之间的差异是 `JOIN`。

## 要求

- Node.js 22.5 或更高版本。
- [GitHub CLI](https://cli.github.com/)，已登录（`gh auth status`），并且是
可以读取组织的帐户。读取计费和安全警报
需要相应的权限；如果没有，扫描会记录“未测量”并
继续。它绝不会将缺少权限记录为干净的结果。
- Windows 或 Linux。它在 Windows 上开发，其测试在 Linux 上运行
CI。macOS 应该可以工作，但未进行测试。

## 使用方法

```bash
npm install -g @mcptoolshop/housekeeping   # puts `hk` and `hk-mcp` on your path
mkdir warehouse && cd warehouse            # housekeeping keeps its data here
hk refresh your-org                        # collect, load, analyze, write reports/AUDIT-<date>.md
```

为了在扫描之间保留设置，请在 `housekeeping.config.json` 目录中放置一个
文件（请参阅“配置”）；然后 `hk refresh` 不需要任何参数。

或者从克隆运行，这样它的数据将保存在克隆中：

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh
```

然后查询它：

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

在没有 `npm link` 的克隆中，每次 `hk <command>` 都是 `node src/cli.mjs <command>`。

`npm run rebuild` 会重新派生数据库和报告，这些报告来自已
存储在磁盘上的快照，无需网络访问。

一次完整的扫描会进行数百次 API 调用。不要在循环中运行 `refresh`。

结果输出到标准输出；进度和错误输出到标准错误。每个
错误都会打印一个代码和一个提示。退出代码：0 表示正常，1 表示用户错误，2 表示运行时
错误，3 表示部分（扫描已完成，但存在差距）。

## 配置

`housekeeping.config.json`，位于 housekeeping 运行的目录中（请参阅下文）：

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` 是要扫描的组织。`hk refresh <org>` 会覆盖它。如果
两者都没有，扫描将拒绝启动。
- `metaRepos` 是包含组织默认设置、资源或
工具的仓库，而不是已发布的最终产品。它们不适用于仅
对最终产品有意义的发现：缺少 README、LICENSE 和类似文件，没有
工作流程，以及没有发布。

格式不正确的文件是一个错误，绝不会是无声的默认值：未知的键、错误的
类型或损坏的 JSON 会停止运行。

Run from a clone, housekeeping keeps `data/`, `reports/` and the config file
in the clone. Run as an installed package, it keeps them in the directory you
run it from, or in `HK_HOME` when that is set.

环境：`HK_HOME`（数据、报告和配置所在的位置）、
`HK_CONFIG`（配置路径）、`HK_DB`（数据库路径）、`HK_LOG`
（`silent`、`normal`、`verbose` 或 `debug`）、`HK_COST_REPOS` 和
`HK_COST_BUDGET`（每个作业成本的上限）、`GH_PATH`（`gh` 的路径）。

## 保护数据

**扫描写入的内容是敏感信息。请勿将 `data/` 或 `reports/` 提交到
公共仓库。**

快照会记录私有仓库的名称和描述、每个
公开的安全警报以及它引用的软件包、工作流程文件和 Actions
计费。GitHub 会故意将公共仓库的安全警报隐藏起来，只向其维护者显示；发布的快照会将该列表提供给所有人。

此仓库的 `.gitignore` 排除 `data/`、`reports/` 和
`housekeeping.config.json`。为了保留历史记录，这是快照的目的，
请从您自己的**私有**仓库运行该工具，并将它们提交到那里。

## 发现

规则位于 `src/analyze.mjs` 中。每个规则都引用了它所执行的书面规则，
因此可以针对标准而不是针对个人喜好来争论发现。此仓库提供的规则位于 [`rules/`](rules/) 中：

- [`rules/github-actions.md`](rules/github-actions.md)：路径过滤器、运行器、矩阵大小、工作流程文件限制、并发。
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md)：CI 必须通过、发布门控、版本。
- [`rules/repo-first.md`](rules/repo-first.md)：默认分支。
- [`rules/atlas-map.md`](rules/atlas-map.md)：每个仓库的已提交映射，在 CI 中进行检查。

这些是一个组织的标准。如果您的标准不同，请同时更改规则文件
和规则。

规则会注意区分看起来相似的事物，因为将它们合并会产生噪音：

- **默认分支为红色的状态并不意味着拉取请求分支也为红色。** 如果 Dependabot 分支出现故障，则表示存在未处理的问题；如果在默认分支上出现 `push` 运行失败，则表示存在错误。运行的事件决定了是哪种情况。
- **历史记录并不等同于错误。** 如果工作流程被移动到仅触发发布，则其最后一次在默认分支上的失败状态将永久保留。即使删除了工作流程，其运行记录也会保留。两者都不是当前存在的缺陷。
- **如果某个必需的检查无法执行，这并不意味着该检查未在此处运行。** 一种情况是建议取消该要求；另一种情况是建议修复触发器。这两种修复方法相互矛盾。
- **如果触发器跳过了一个拉取请求，这并不意味着该拉取请求存在冲突。** GitHub 不会对存在冲突的拉取请求运行任何拉取请求工作流程，因此，如果缺少检查，则说明该触发器没有问题。在这种情况下，需要重新进行基准测试。
- **失败的运行并不等同于已取消的运行。** `cancel-in-progress` 的作用是终止过时的运行，因此，通常情况下，已取消的运行是并发规则在起作用。
- **总成本不等于净成本。** GitHub 对公共仓库收取全部费用，然后将其折扣为零。总成本是实际的计算成本；净成本是实际的支出。两者不能简单地相加。
- **未测量的数据并不意味着数据是干净的。** 如果 GitHub 未对某个仓库进行扫描，则报告的警报数量为零。如果成本评估未达到某个阈值，则该仓库不会显示任何成本行。两者都将报告为未知。

严重程度决定了健康评分：严重 40，高 15，中 6，低 2，信息 0，从 100 中扣除。评分衡量的是需要关注的程度，而不是质量。

[手册](https://mcp-tool-shop-org.github.io/housekeeping/handbook/) 列出了所有发现、命令、错误代码和表格。

## 安全性

- **只读。** 收集器会发出 GraphQL 查询和 REST `GET` 请求。它绝不会合并、推送、发布、公开或编辑任何设置。
- **不存储凭据。** 身份验证使用 `gh` 中已有的凭据。不会将任何凭据写入磁盘。
- **不收集遥测数据。** 唯一联系的主机是 GitHub API（通过 `gh`）和 npm 注册表，用于查找版本和安全建议。
- **它存储的内容** 是敏感部分：请参阅“保护数据”。

如 [SECURITY.md](SECURITY.md) 中所述，报告漏洞。

## 测试

```bash
npm test
```

每个规则都从两个方向进行测试：必须触发的模式，以及不应触发的相邻模式。一个单独的验证器会从实时 GitHub 中重新推导出样本发现，并通过其自身的传输方式进行验证，并在没有数据库或没有网络时发出明确的警告。

## 许可证

MIT。请参阅 [LICENSE](LICENSE)。

---

由 <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a> 构建。
