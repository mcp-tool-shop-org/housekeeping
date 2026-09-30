<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

1回の実行で、すべてのリポジトリのCIステータス、未解決の問題、プルリクエスト、リリース、バージョンタグ、ワークフローファイル、ブランチ保護、セキュリティアラート、ロックファイル、Actionsの課金をSQLiteに収集し、次に、それらを記述されたルールに対して監査します。

これにより、組織全体に対して、以下のことが一度に回答されます。

- どのデフォルトブランチが問題があり、それが壊れたメインラインまたは古い履歴ですか？
- 必須チェックが何も実行されないために、マージできないプルリクエストはどれですか？
- リポジトリ自体の設定で、どのデプロイが拒否されますか？
- `package.json`、Gitタグ、npmレジストリは、どこでずれが生じていますか？
- どのワークフローがActionsのコストルールに違反し、そのコストはいくらで、どのジョブがそのコストを消費しましたか？
- どのリポジトリに、GitHub自体のアラートカウントでは検出されないアドバイザリーが含まれていますか？

これは監査ツールであり、修正ツールではありません。GitHubを読み取り、何も変更しません。

## この構造になっている理由

| レイヤー | 選択 | 理由 |
|---|---|---|
| 転送 | `gh` CLI | すでにトークンを保持しています。このツールは、認証情報を保存したり、要求したりすることはありません。 |
| 収集 | GitHub GraphQL、ページング | 1つのクエリで、リポジトリの1ページのメタデータ、未解決の問題、未解決のプルリクエスト、リリース、ファイルツリーが返されます。タイムアウトが発生し続けるページは半分にされ、同じカーソルから再度要求されます。 |
| Actionsの実行 | REST | GraphQLにはActionsのインターフェースはありません。 |
| Actionsのコスト | 課金APIとジョブごとの期間 | 請求書にはどのリポジトリであるかが記載されています。ジョブごとにどのワークフローであるかが記載されています。GitHubの`/timing`エンドポイントはゼロを返すため、ジョブごとの合計を再計算し、次に請求書と照合します。 |
| ランナーの料金 | 請求書から読み取ります | 請求される料金は、リスト価格と異なる場合があり、ソースに定数を使用すると、すべての数値が誤って表示されます。 |
| ストレージ | 組み込みの`node:sqlite`を介したSQLite | ネイティブのビルドステップはありません。 |
| 信頼できる情報源 | `data/snapshots/*.json` | 生の、差分化可能で、追加のみのデータ。データベースは派生したものです。`npm run rebuild`がオフラインで再構築します。 |
| スウィープログ | `data/sweeps.jsonl` | 1つのスウィープあたり1行。失敗したスウィープと、新しいものが見つからなかったスウィープも含まれます。 |

スナップショットは不変で追加されるため、2つの日付間のずれは`JOIN`です。

## 要件

- Node.js 22.5 or later.
- The [GitHub CLI](https://cli.github.com/), signed in (`gh auth status`) as an
  account that can read the organization. Reading billing and security alerts
  needs the matching access; a sweep without it records "not measured" and
  carries on. It never records a missing permission as a clean result.
- Windows or Linux. It is developed on Windows and its tests run on Linux in
  CI. macOS should work and is not tested.

## 使用方法

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh               # collect, load, analyze, write reports/AUDIT-<date>.md
```

次に、クエリを実行します。

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

`npm link`がない場合、各`hk <command>`は`node src/cli.mjs <command>`です。

`npm run rebuild`は、ディスクにすでに存在するスナップショットからデータベースとレポートを再構築し、ネットワークアクセスは行いません。

完全なスウィープでは、数百のAPI呼び出しが行われます。`refresh`をループで実行しないでください。

結果は標準出力に出力され、進行状況とエラーは標準エラーに出力されます。すべてのエラーには、コードとヒントが出力されます。終了コード：0（正常）、1（ユーザーエラー）、2（実行時エラー）、3（部分的な実行 - スウィープは完了しましたが、ギャップがあります）。

## 構成

`housekeeping.config.json`、および`package.json`：

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org`は、スウィープする組織です。`hk refresh <org>`でオーバーライドできます。どちらも指定されていない場合、スウィープは開始されません。
- `metaRepos`は、組織のデフォルト、アセット、またはツールを保持するリポジトリであり、出荷される製品ではありません。これらは、製品にのみ意味がある結果（README、LICENSEなどのファイルがない、ワークフローがない、リリースがない）から除外されます。

形式が正しくないファイルはエラーであり、サイレントなデフォルトになることはありません。不明なキー、間違った型、または破損したJSONは、実行を停止します。

環境：`HK_CONFIG`（構成ファイルのパス）、`HK_DB`（データベースファイルのパス）、`HK_LOG`（`silent`、`normal`、`verbose`、または`debug`）、`HK_COST_REPOS`、および`HK_COST_BUDGET`（ジョブごとのコストの範囲）、`GH_PATH`（`gh`へのパス）。

## データを非公開に保つ

**スウィープによって書き込まれる内容は機密情報です。`data/`または`reports/`をパブリックリポジトリにコミットしないでください。**

スナップショットには、プライベートリポジトリの名前と説明、パッケージ名を含むすべての未解決のセキュリティアラート、ワークフローファイル、Actionsの課金が記録されます。GitHubは、パブリックリポジトリのセキュリティアラートを、そのリポジトリのメンテナー以外のすべてのユーザーから意図的に非表示にします。公開されたスナップショットは、そのリストを公開することになります。

このリポジトリの`.gitignore`は、`data/`、`reports/`、および`housekeeping.config.json`を除外します。履歴を保持することがスナップショットの目的であるため、独自の**プライベート**リポジトリからツールを実行し、そこにコミットしてください。

## MCPサーバー

`npm run mcp`は、標準出力経由でウェアハウスを提供するため、アシスタントは、数メガバイトのスナップショットを読み込むことなく質問をすることができます。

`hk_summary` · `hk_findings` · `hk_ci` · `hk_repo` · `hk_backlog` · `hk_health` · `hk_cost` · `hk_sql` · `hk_schema`

```json
{
  "mcpServers": {
    "housekeeping": { "command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"] }
  }
}
```

`hk_sql`は、単一の`SELECT`または`WITH`ステートメントを受け取り、データベースを読み取り専用で開きます。呼び出しが失敗すると、構造化されたエラーが返され、スタックトレースは返されません。

## 検出結果

ルールは`src/analyze.mjs`にあります。各ルールは、適用する記述されたルールを参照するため、検出結果は、好みに基づいてではなく、標準に対して議論することができます。このリポジトリに付属するルールは、[`rules/`](rules/)にあります。

- [`rules/github-actions.md`](rules/github-actions.md)：パスフィルター、ランナー、マトリックスサイズ、ワークフローファイルの制限、同時実行。
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md)：CIがパスしていること、出荷ゲート、バージョン。
- [`rules/repo-first.md`](rules/repo-first.md)：デフォルトブランチ。
- [`rules/atlas-map.md`](rules/atlas-map.md)：各リポジトリのコミットされたマップ。CIでチェックされます。

これらは、ある組織の標準です。もしあなたの標準と異なる場合は、ルールファイルとルールを一緒に変更してください。

ルールは、見た目が似ているものを区別するように設計されており、それらをまとめてしまうとノイズが発生するためです。

- **赤いデフォルトブランチは、赤いプルリクエストブランチではありません。** 失敗したDependabotブランチは、未処理のタスクです。デフォルトブランチで失敗した`push`の実行は、問題を引き起こします。どちらであるかは、実行のイベントによって決まります。
- **履歴は、問題ではありません。** リリース専用のトリガーに移動したワークフローは、最後のデフォルトブランチでの失敗を永久に保持します。削除されたワークフローは、その実行を保持します。どちらも、現在の欠陥ではありません。
- **実行できないチェックは、ここで実行されなかったチェックではありません。** 一方は、要件を削除すると言います。もう一方は、トリガーを修正すると言います。これらの修正は、互いに矛盾します。
- **失敗した実行は、キャンセルされた実行ではありません。** `cancel-in-progress`は、古い実行を終了させるために存在します。したがって、キャンセルされた時間は、通常、同時実行ルールが機能していることを示します。
- **総コストは、純コストではありません。** GitHubは、パブリックリポジトリに対して全額料金を請求し、その後、料金をゼロに割引します。総コストは、実際の計算リソースです。純コストは、実際の費用です。これらは決して合計されません。
- **測定されていないものは、問題ありません。** GitHubがスキャンしていないリポジトリは、アラートをゼロとして報告します。コスト計算に達していないリポジトリは、コスト行を持ちません。どちらも、不明として報告されます。

重大度によって、健全性スコアが決まります。重大なものは40、高いものは15、中程度のものは6、低いものは2、情報提供のみのものは0で、これらは100から差し引かれます。スコアは、品質ではなく、優先度を示します。

[ハンドブック](https://mcp-tool-shop-org.github.io/housekeeping/handbook/)には、すべての検出結果、コマンド、エラーコード、およびテーブルがリストされています。

## セキュリティ

- **読み取り専用。** コレクターは、GraphQLクエリとREST `GET`を発行します。設定をマージ、プッシュ、リリース、公開、または編集することはありません。
- **認証情報なし。** 認証は、`gh`がすでに保持しているものを使用します。それに関する情報は、ディスクに書き込まれません。
- **テレメトリなし。** 連絡するホストは、GitHub API（`gh`経由）と、バージョンおよびアドバイザリの検索のためのnpmレジストリのみです。
- **保存する内容**が機密性の高い部分です。「データを非公開にする」を参照してください。

[SECURITY.md]に記載されているように、脆弱性を報告してください。

## テスト

```bash
npm test
```

すべてのルールは、両方向でテストされます。つまり、トリガーされるべき形状と、トリガーされるべきでない隣接する形状です。別の検証ツールは、独自のトランスポートを通じて、ライブGitHubから検出結果のサンプルを再計算し、データベースまたはネットワークがない場合は、エラーメッセージを大きく表示します。

## ライセンス

MIT。 [LICENSE](LICENSE)を参照してください。

---

<a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>によって作成されました。
