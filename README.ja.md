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

1回のスキャンで、各リポジトリのCIステータス、未解決の問題、プルリクエスト、リリース、バージョンタグ、ワークフローファイル、ブランチ保護、セキュリティアラート、ロックファイル、およびActionsの課金をSQLiteに収集し、次に、それらすべてを記述されたルールに対して監査します。

これにより、組織全体に対して、以下の質問に一度に回答できます。

- どのデフォルトブランチが問題があり、それが壊れたメインラインまたは古い履歴ですか？
- 必須チェックが何も実行されていないために、どのプルリクエストもマージできませんか？
- リポジトリ自体の設定で、どのデプロイが拒否されていますか？
- `package.json`、Gitタグ、およびnpmレジストリは、どこで乖離していますか？
- どのワークフローがActionsのコストルールに違反し、そのコストはいくらで、どのジョブがそのコストを負担しましたか？
- どのリポジトリが、GitHub自体のアラートカウントでは検出されないアドバイザリーを保持していますか？

これは監査ツールであり、修正ツールではありません。GitHubを読み取り、何も変更しません。

## 各リポジトリに1つのエージェント

数十のリポジトリを持つ組織では、その状態が保存されている単一の場所はありません。housekeepingがその場所であり、そのMCPサーバーである`hk-mcp`が、AIエージェントにそれを渡します。これにより、1つのエージェントが組織全体のコーディネーターとして機能できます。

1. **スキャン。** `hk refresh`は、各リポジトリのスナップショットを1つ取得します。
2. **トリアージ。** エージェントは、何が問題があり、何がブロックされており、何が悪化しているかを尋ね、壊れたメインラインと古い履歴、および競合が発生しているプルリクエストと停止しているプルリクエストを区別できる回答を取得します。
3. **一連の処理を計画。** 1つの`hk_sql`クエリで、同じ形状を持つすべてのリポジトリを見つけ、修正を1つのリポジトリあたり1つのプルリクエストにすることで、修正作業が効率化されます。
4. **作業の実行。** housekeepingは書き込みを行いません。エージェントは、独自のツールと独自の権限を使用して、プルリクエストを開き、レビューを行います。
5. **検証。** 再度スキャンします。問題が解決されているか、またはされていないかを確認し、2つのスナップショット間の変更をクエリとして実行します。

エージェントが1回の呼び出しで回答する質問：

- どのデフォルトブランチが問題があり、どのジョブとステップが原因ですか？
- どのプルリクエストもマージできず、トリガーまたは競合が原因ですか？
- どのリポジトリが、GitHubではアラートが表示されないプロダクションアドバイザリーを保持していますか？
- どのスケジュールされたワークフローがスケジュールルールに違反し、どのように違反していますか？
- Actionsのコストはいくらで、どのジョブがそのコストを負担しましたか？
- 最後のスキャン以降、何が変更されましたか？

| ツール | 回答内容 |
|---|---|
| `hk_summary` | 最新のスキャンにおける合計：リポジトリ、問題、プルリクエスト、ワークフロー、検出結果。 |
| `hk_findings` | コード、重大度、カテゴリ、またはリポジトリごとの検出結果。フィルターを適用していない場合のコードごとのカウント。問題のあるメインラインの検出結果は、問題を引き起こしたジョブとステップの名前を示します。 |
| `hk_ci` | デフォルトブランチが問題のあるリポジトリと、失敗したワークフロー。また、失敗したスケジュール、失敗したプルリクエストブランチ、およびCIを実行していないリポジトリ。 |
| `hk_repo` | 完全な1つのリポジトリ：検出結果、ワークフロー、未解決のプルリクエストと問題。 |
| `hk_backlog` | 組織全体の未解決のプルリクエストまたは問題（古いものから）。 |
| `hk_health` | リポジトリごとの健全性スコア（最も低いものから）。 |
| `hk_cost` | リポジトリ、ワークフロー、またはジョブごとのActionsの消費量（総額と純額）。 |
| `hk_sql` | 読み取り専用の1つの`SELECT`または`WITH`ステートメントをデータウェアハウスに対して実行します。 |
| `hk_schema` | `hk_sql`クエリを記述するためのテーブルと列。 |

すべての回答は、最新のスナップショットから取得され、読み取り専用で開かれます。失敗した呼び出しは、構造化されたエラーを返し、スタックトレースは返しません。

### 接続

```json
{
  "mcpServers": {
    "housekeeping": { "command": "hk-mcp", "env": { "HK_HOME": "/path/to/warehouse" } },
    "atlas": { "command": "atlas", "args": ["mcp"] }
  }
}
```

`HK_HOME`は、スキャンを開始するディレクトリです。クローンから、`"command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"]`を使用します。2番目のサーバーは[Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas)であり、これは1つのリポジトリに対して同じエージェントに回答します（以下を参照）。Windowsでは、グローバルにインストールされたコマンドを`cmd /c`を通じて起動します。

## housekeepingとAtlas

[Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas)
（`@dogfood-lab/atlas`）は、あるリポジトリ、つまりその構成要素と、ワークフローが実行、公開、デプロイする内容をマッピングします。このマッピングは、`atlas/`としてコミットされ、CIでチェックインされます。ハウスキーピングは、組織の視点です。これら2つは、連携して機能するように設計されています。

- **すべてのマップをスキャン。** スキャンは、各リポジトリのコミットされたマップと、その他のすべての情報を読み取り、どのリポジトリにマップがないか、どのリポジトリが`atlas check`を実行していないか、およびどのリポジトリが、組織の残りの部分で使用されているものとは異なるエンジンを保持しているかを報告します。
- **問題のある実行がどこで発生したか。** デフォルトブランチに問題がある場合、検出結果は、問題を引き起こしたジョブとステップの名前を示し、マップを通じて、そのステップが実行するコマンドも示されるため、修正は適切なファイルから開始できます。
- **マップからのデプロイメントの事実。** ジョブがデプロイする環境は、マップに記録されている環境から取得されるため、両方のツールはワークフローを同じ方法で読み取ります。
- **フリート全体での警告。** Atlasは、実行前に問題が発生するワークフローステップ（たとえば、ジョブがインストールするよりも新しいランタイムを必要とするツール）をフラグします。レポートには、これらがすべてのリポジトリに対して一度にリストされます。

両方のサーバーを持つエージェントは、「これらの12個のリポジトリがブロックされています」（housekeeping）から、「これはワークフロー、ジョブ、および変更が到達するファイルです」（Atlas）へと移行し、各リポジトリを手動で開く必要はありません。

## この構造になっている理由

| レイヤー | 選択 | 理由 |
|---|---|---|
| トランスポート | `gh` CLI | すでにトークンを保持しています。ツールは、認証情報を保存または要求しません。 |
| 収集 | GitHub GraphQL、ページング | 1つのクエリは、リポジトリのページに関するメタデータ、未解決の問題、未解決のプルリクエスト、リリース、およびファイルツリーを返します。タイムアウトが発生し続けるページは、半分に分割され、同じカーソルから再要求されます。 |
| Actionsの実行 | REST | GraphQLにはActionsのインターフェースはありません。 |
| Actionsのコスト | 課金APIと、ジョブごとの期間 | 請求書にはどのリポジトリが記載されており、どのワークフローが実行されたかはジョブにのみ記載されます。GitHubの`/timing`エンドポイントはゼロを返します。そのため、ジョブごとの合計が再計算され、その後、請求書と照合されます。 |
| ランナー料金 | 請求書から読み取ります | 請求される料金は、リスト価格と異なる場合があり、ソースコード内の定数はすべての数値を誤って表示します。 |
| ストレージ | 組み込みの`node:sqlite`を通じてSQLiteにアクセスします | ネイティブのビルドステップはありません。 |
| 信頼できる情報源 | `data/snapshots/*.json` | 生のデータで、差分を比較でき、追加のみ可能です。データベースはそこから派生します。`npm run rebuild`はオフラインでデータベースを再構築します。 |
| スキャンログ | `data/sweeps.jsonl` | 1回のスキャンにつき1行。失敗したスキャンと新しい情報が見つからなかったスキャンも含まれます。 |

スナップショットは不変で累積的であるため、2つの日付間のドリフトは`JOIN`です。

## 要件

- Node.js 22.5 以降。
- ［GitHub CLI］（［https://cli.github.com/］）に、［`gh auth status`］としてログイン
組織の情報を閲覧できるアカウント。請求書やセキュリティアラートの確認が可能。
対応するアクセス権が必要です。そうでない場合、測定を行っても「測定不能」と記録されます。
処理を続行します。必要な権限が見つからない場合でも、エラーとして記録することはありません。
- WindowsまたはLinux。開発はWindowsで行い、テストはLinux上で実行します。
CIの機能であるmacOSは動作するはずですが、テストは行われていません。

## 使用方法

```bash
npm install -g @mcptoolshop/housekeeping   # puts `hk` and `hk-mcp` on your path
mkdir warehouse && cd warehouse            # housekeeping keeps its data here
hk refresh your-org                        # collect, load, analyze, write reports/AUDIT-<date>.md
```

スキャン間で設定を保持するには、そのディレクトリに`housekeeping.config.json`を配置します（構成を参照）。その後、`hk refresh`には引数が必要ありません。

または、クローンから実行すると、そのデータはクローンに保存されます。

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh
```

次に、クエリを実行します。

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

`npm link`がないクローンでは、各`hk <command>`は`node src/cli.mjs <command>`です。

`npm run rebuild`は、ディスク上の既存のスナップショットからデータベースとレポートを再派生させ、ネットワークアクセスは行いません。

完全なスキャンでは、数百回のAPI呼び出しが行われます。`refresh`をループで実行しないでください。

結果は標準出力に出力され、進行状況とエラーは標準エラーに出力されます。すべてのエラーには、コードとヒントが出力されます。終了コード：0（正常）、1（ユーザーエラー）、2（実行時エラー）、3（部分的な完了 - スキャンは完了しましたが、ギャップがあります）。

## 構成

ハウスキーピングが実行されるディレクトリにある`housekeeping.config.json`（下記参照）：

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org`はスキャンする組織です。`hk refresh <org>`でオーバーライドできます。どちらも指定されていない場合、スキャンは開始されません。
- `metaRepos`は、組織のデフォルト、アセット、またはツールを保持するリポジトリであり、出荷される製品ではありません。これらは、製品にのみ意味がある結果（README、LICENSEなどのファイルがない、ワークフローがない、リリースがない）から除外されます。

形式が正しくないファイルはエラーであり、サイレントなデフォルトになることはありません。不明なキー、誤った型、または破損したJSONは、実行を停止します。

クローンから実行すると、ハウスキーピングは`data/`、`reports/`、および構成ファイルをクローンに保持します。インストールされたパッケージとして実行すると、実行するディレクトリまたは`HK_HOME`（設定されている場合）に保持されます。

環境：`HK_HOME`（データ、レポート、および構成が保存される場所）、`HK_CONFIG`（構成パス）、`HK_DB`（データベースパス）、`HK_LOG`（`silent`、`normal`、`verbose`、または`debug`）、`HK_COST_REPOS`、および`HK_COST_BUDGET`（ジョブごとのコストの範囲）、`GH_PATH`（`gh`へのパス）。

## データを非公開に保つ

**スキャンによって書き込まれる内容は機密情報です。`data/`または`reports/`をパブリックリポジトリにコミットしないでください。**

スナップショットには、プライベートリポジトリの名前と説明、パッケージ名とともに開いているすべてのセキュリティアラート、ワークフローファイル、およびActionsの請求情報が記録されます。GitHubは、意図的にパブリックリポジトリのセキュリティアラートを、そのリポジトリのメンテナー以外のすべてのユーザーから隠します。公開されたスナップショットは、そのリストを公開することになります。

このリポジトリの`.gitignore`は、`data/`、`reports/`、および`housekeeping.config.json`を除外します。履歴を保持することがスナップショットの目的であるため、独自の**プライベート**リポジトリからツールを実行し、そこにコミットしてください。

## 検出結果

ルールは`src/analyze.mjs`に保存されます。各ルールは、適用するルールを引用するため、検出結果は標準に対して議論可能であり、個人の好みに基づくものではありません。このリポジトリに同梱されているルールは、[`rules/`](rules/)にあります。

- [`rules/github-actions.md`](rules/github-actions.md)：パスフィルター、ランナー、マトリックスサイズ、ワークフローファイルの制限、同時実行。
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md)：CIは合格している必要がある、出荷ゲート、バージョン。
- [`rules/repo-first.md`](rules/repo-first.md)：デフォルトブランチ。
- [`rules/atlas-map.md`](rules/atlas-map.md)：各リポジトリのコミットされたマップ。CIでチェックされます。

これらは、ある組織の標準です。異なる場合は、ルールファイルとルールを一緒に変更してください。

ルールは、似たもの同士を区別するように注意深く設計されています。それらをまとめてしまうと、ノイズが発生するからです。

- **デフォルトの赤いブランチは、赤いプルリクエストのブランチではありません。** 依存関係の更新に失敗した Dependabot のブランチは、未処理のタスクです。デフォルトブランチで `push` の実行が失敗した場合、それは問題です。どちらであるかは、実行イベントによって決まります。
- **履歴は問題ではありません。** リリース専用のトリガーに移行したワークフローは、デフォルトブランチでの最後の失敗を永久に保持します。削除されたワークフローは、その実行履歴を保持します。どちらも、現在の欠陥ではありません。
- **実行できないチェックは、ここで実行されなかったチェックではありません。** 片方は、その要件を削除すべきだと言い、もう片方は、トリガーを修正すべきだと言います。これらの修正は、互いに矛盾しています。
- **トリガーがスキップしたプルリクエストは、競合が発生したプルリクエストではありません。** GitHub は、競合が発生しているプルリクエストに対して、プルリクエストのワークフローを実行しません。そのため、欠落しているチェックは、トリガーについて何も示唆しません。この場合は、リベースが必要です。
- **失敗した実行は、キャンセルされた実行ではありません。** `cancel-in-progress` は、古い実行を終了させるために存在します。そのため、キャンセルされた時間は、通常、同時実行ルールが機能していることを示します。
- **総コストは、純コストではありません。** GitHub は、パブリックリポジトリを定価で計測し、割引を適用してゼロにします。総コストは実際の計算資源であり、純コストは実際の費用です。これらは決して合計されません。
- **計測されていないものは、問題ありません。** リポジトリ GitHub は、スキャンレポートでゼロ件の警告を表示していません。コストのチェックに達しなかったリポジトリには、コストの行がありません。どちらも、不明として報告されます。

重大度は、ヘルススコアを決定します。重大なものは40、高いものは15、中程度のものは6、低いものは2、情報提供のみのものは0であり、100から差し引かれます。スコアは、品質ではなく、注意の優先順位を示します。

[ハンドブック](https://mcp-tool-shop-org.github.io/housekeeping/handbook/)には、すべての調査結果、コマンド、エラーコード、およびテーブルが記載されています。

## セキュリティ

- **読み取り専用。** コレクターは、GraphQL個のクエリとREST `GET`を送信します。設定をマージ、プッシュ、リリース、公開、または編集することはありません。
- **認証情報なし。** 認証は、`gh`ですでに保持されているものを使用します。それに関する情報はディスクに書き込まれません。
- **テレメトリなし。** 連絡するホストは、`gh`を通じてGitHub APIにアクセスし、バージョンとアドバイザリを検索するためにnpmレジストリにアクセスするだけです。
- **保存する内容**が機密性の高い部分です。「データを非公開に保つ」を参照してください。

脆弱性を[SECURITY.md](SECURITY.md)に記載されている方法で報告してください。

## テスト

```bash
npm test
```

すべてのルールは、両方向でテストされます。つまり、トリガーされるべき形状と、トリガーされるべきでない隣接する形状です。別の検証ツールは、独自のトランスポートを通じて、ライブのGitHubから調査結果のサンプルを再生成し、データベースまたはネットワークがない場合は、エラーメッセージを大きく表示します。

## ライセンス

MIT。 [LICENSE](LICENSE)を参照してください。

---

<a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>によって作成されました。
