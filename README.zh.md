<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.md">English</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

一次扫描收集每个仓库的 CI 状态、未解决的问题和拉取请求、发布版本、版本标签、工作流文件、分支保护、安全警报、锁文件和 Actions 计费信息，并将其存储到 SQLite 数据库中，然后根据编写的规则对所有信息进行审计。

它一次性回答整个组织的问题：

- 哪些默认分支显示为红色，这是否表示主分支出现问题或历史记录已过时？
- 哪些拉取请求无法合并，因为必需的检查未通过，从而阻止了合并？
- 哪些部署被仓库自身的设置拒绝？
- `package.json`、Git 标签和 npm 注册表之间存在哪些差异？
- 哪些工作流违反了 Actions 成本规则，它们花费了多少，哪些任务消耗了这些成本？
- 哪些仓库包含 GitHub 自身警报计数未检测到的建议？

它是一个审计工具，而不是一个修复工具。它读取 GitHub 数据，但不进行任何更改。

## 其设计方式的原因

| 分层 | 选择 | 原因 |
|---|---|---|
| 传输 | `gh` CLI | 它已经存储了您的令牌。该工具不会存储或请求任何凭据。 |
| 收集 | GitHub GraphQL，分页 | 一个查询返回一个页面中仓库的元数据、未解决的问题、未解决的拉取请求、发布版本和文件树。如果某个页面持续超时，则将其减半，并从相同的游标重新请求。 |
| Actions 运行 | REST | GraphQL 没有 Actions 接口。 |
| Actions 成本 | 计费 API 加上每个任务的持续时间 | 发票显示哪个仓库；只有任务会显示哪个工作流。GitHub 的 `/timing` 端点返回零，因此会重新计算每个任务的总和，然后将其与发票进行核对。 |
| 运行器费率 | 从发票中读取 | 已计费的费率可能与列表价格不同，并且源中的常量值会错误地显示每个数字。 |
| 存储 | 通过内置的 `node:sqlite` 使用 SQLite | 没有本地构建步骤。 |
| 事实来源 | `data/snapshots/*.json` | 原始、可比较且仅追加。数据库是派生的：`npm run rebuild` 在离线状态下重新构建它。 |
| 扫描日志 | `data/sweeps.jsonl` | 每条扫描记录一行，包括失败的扫描和未发现任何新内容的扫描。 |

快照是不可变的且是累积的，因此两个日期之间的差异是 `JOIN`。

## 要求

- Node.js 22.5 或更高版本。
- [GitHub CLI](https://cli.github.com/)，已登录（`gh auth status`），作为可以读取组织的帐户。读取计费和安全警报需要相应的访问权限；如果没有，扫描会记录“未测量”，并继续执行。它绝不会将缺少权限记录为干净的结果。
- Windows 或 Linux。它在 Windows 上开发，其测试在 CI 中在 Linux 上运行。macOS 应该可以工作，但未进行测试。

## 使用方法

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh               # collect, load, analyze, write reports/AUDIT-<date>.md
```

然后对其进行查询：

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

如果没有 `npm link`，则每个 `hk <command>` 都是 `node src/cli.mjs <command>`。

`npm run rebuild` 重新从磁盘上已有的快照中派生数据库和报告，无需网络访问。

一次完整的扫描会进行数百次 API 调用。不要在循环中运行 `refresh`。

结果输出到标准输出；进度和错误输出到标准错误。每个错误都会打印一个代码和一个提示。退出代码：0 表示正常，1 表示用户错误，2 表示运行时错误，3 表示部分完成（扫描已完成，但存在缺失）。

## 配置

`housekeeping.config.json`，除了 `package.json`：

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` 是要扫描的组织。`hk refresh <org>` 会覆盖它。如果两者都没有，扫描将拒绝开始。
- `metaRepos` 是包含组织默认设置、资产或工具的仓库，而不是已发布的最终产品。它们不适用于仅对最终产品有意义的发现：缺少 README、LICENSE 和类似文件，没有工作流，没有发布版本。

格式不正确的文件是一个错误，而不是静默的默认值：未知的键、错误的类型或损坏的 JSON 会停止运行。

环境：`HK_CONFIG`（配置文件路径）、`HK_DB`（数据库路径）、`HK_LOG`（`silent`、`normal`、`verbose` 或 `debug`）、`HK_COST_REPOS` 和 `HK_COST_BUDGET`（每个任务成本限制）、`GH_PATH`（`gh` 的路径）。

## 保护数据

**扫描写入的内容是敏感信息。请勿将 `data/` 或 `reports/` 提交到公共仓库。**

一个快照会记录私有仓库的名称和描述、每个未解决的安全警报以及它引用的软件包、工作流文件和 Actions 计费信息。GitHub 会故意将公共仓库的安全警报隐藏起来，只向其维护者显示；发布的快照会将该列表提供给其他人。

此仓库的 `.gitignore` 排除 `data/`、`reports/` 和 `housekeeping.config.json`。为了保留历史记录，这是快照的目的，请从您自己的**私有**仓库中运行该工具，并将它们提交到那里。

## MCP 服务器

`npm run mcp` 通过 stdio 提供仓库，因此助手可以提出问题，而无需读取多兆字节的快照：

`hk_summary` · `hk_findings` · `hk_ci` · `hk_repo` · `hk_backlog` · `hk_health` · `hk_cost` · `hk_sql` · `hk_schema`

```json
{
  "mcpServers": {
    "housekeeping": { "command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"] }
  }
}
```

`hk_sql` 接受单个 `SELECT` 或 `WITH` 语句，并以只读模式打开数据库。如果调用失败，则返回结构化的错误，而不是堆栈跟踪。

## 发现

规则存储在 `src/analyze.mjs` 中。每个规则都引用它所执行的编写规则，因此可以根据标准而不是个人喜好来争论发现结果。此仓库中包含的规则位于 [`rules/`](rules/) 中：

- [`rules/github-actions.md`](rules/github-actions.md)：路径过滤器、运行器、矩阵大小、工作流文件限制、并发。
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md)：CI 必须通过、发布门控、版本。
- [`rules/repo-first.md`](rules/repo-first.md)：默认分支。
- [`rules/atlas-map.md`](rules/atlas-map.md)：每个仓库的已提交映射，在 CI 中进行检查。

它们是某个组织的标准。如果您的标准不同，请更改规则文件和规则。

这些规则会注意区分那些看起来相似的事物，因为将它们合并会导致错误：

- **红色默认分支与红色拉取请求分支不同。** 失败的 Dependabot 分支是待处理的任务；在默认分支上失败的 `push` 运行是故障。运行的事件决定了是哪种情况。
- **历史记录不是故障。** 将工作流程移动到仅用于发布的触发器，会永久保留其上次在默认分支上的失败记录。删除的工作流程会保留其运行记录。两者都不是当前存在的缺陷。
- **一个必需的检查，但没有任何内容可以触发，与一个未在此处运行的检查不同。** 一个表示删除该要求；另一个表示修复触发器。这些修复措施相互矛盾。
- **失败的运行与已取消的运行不同。** `cancel-in-progress` 用于终止过时的运行，因此通常，已取消的运行是并发规则在起作用。
- **总成本与净成本不同。** GitHub 以全价计量公共仓库，并将其折扣为零。总成本是实际的计算量；净成本是实际的费用。两者不能相加。
- **未测量的数据并不意味着数据是干净的。** GitHub 未扫描的仓库报告的警报数量为零。成本检查未通过的仓库没有成本行。两者都报告为未知。

严重程度决定了健康评分：严重 40，高 15，中 6，低 2，信息 0，从 100 中扣除。评分衡量的是需要关注的程度，而不是质量。

[手册](https://mcp-tool-shop-org.github.io/housekeeping/handbook/) 列出了每个发现、命令、错误代码和表格。

## 安全性

- **只读。** 收集器会发出 GraphQL 查询和 REST `GET` 请求。它绝不会合并、推送、发布、公开或编辑任何设置。
- **无需凭据。** 身份验证使用 `gh` 已经拥有的凭据。没有任何内容会写入磁盘。
- **无遥测。** 唯一联系的主机是 GitHub API（通过 `gh`）和 npm 注册表，用于版本和安全建议查询。
- **它存储的内容** 是敏感部分：请参阅“保护数据”。

如 [SECURITY.md](SECURITY.md) 中所述，报告漏洞。

## 测试

```bash
npm test
```

每个规则都会在两个方向上进行测试：必须触发的模式，以及不应触发的相邻模式。一个单独的验证器会从实时 GitHub 通过其自身的传输重新推导出样本发现，并在没有数据库或没有网络时，会发出警告。

## 许可证

MIT。请参阅 [LICENSE](LICENSE)。

---

由 <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a> 构建。
