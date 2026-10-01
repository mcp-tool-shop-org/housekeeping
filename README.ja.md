<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

1回のスキャンで、すべてのリポジトリのCIステータス、未解決の問題、プルリクエスト、リリース、バージョンタグ、ワークフローファイル、ブランチ保護、セキュリティアラート、ロックファイル、およびActionsの課金をSQLiteに収集し、次に、それらすべてを記述されたルールに対して監査します。

これにより、組織全体に対して、以下のことが一度に回答されます。

- どのデフォルトブランチが問題があり、それが壊れたメインラインまたは古い履歴ですか？
- 必須のチェックが何も実行されないために、マージできないプルリクエストはどれですか？
- リポジトリ自体の設定で、どのデプロイが拒否されますか？
- `package.json`、Gitタグ、およびnpmレジストリは、どこで乖離していますか？
- どのワークフローがActionsのコストルールに違反し、そのコストはいくらで、どのジョブがそのコストを負担しましたか？
- GitHub自体のアラートカウントでは検出されないアドバイザリを保持しているリポジトリはどれですか？

これは監査ツールであり、修正ツールではありません。GitHubを読み取り、何も変更しません。

## すべてのリポジトリにわたるエージェント

数十のリポジトリを持つ組織では、その状態が保存される単一の場所はありません。housekeepingがその場所であり、そのMCPサーバーである`hk-mcp`が、それをAIエージェントに渡します。これにより、1つのエージェントが組織全体のコーディネーターとして機能できます。

1. **スキャン。** `hk refresh`は、すべてのリポジトリのスナップショットを1つ取得します。
2. **トリアージ。** エージェントは、何が問題があり、何がブロックされており、何が悪化しているかを尋ね、壊れたメインラインと古い履歴、および競合しているプルリクエストと停止しているプルリクエストを区別する回答を取得します。
3. **一連の処理を計画。** 1つの`hk_sql`クエリは、同じ形状を持つすべてのリポジトリを見つけ、修正を1つのリポジトリあたり1つのプルリクエストにするようにします。
4. **作業を実行。** housekeepingは書き込みを行いません。エージェントは、独自のツールと独自の権限の下で、プルリクエストを開き、レビューを行います。
5. **検証。** 再度スキャンします。問題が解決されているか、またはされていないかを確認し、2つのスナップショット間の変更はクエリになります。

エージェントが1回の呼び出しで回答する質問：

- どのデフォルトブランチが問題があり、どのジョブとステップが原因ですか？
- どのプルリクエストがマージできず、トリガーまたは競合が原因ですか？
- GitHubにはアラートが表示されない、本番環境のアドバイザリを保持しているリポジトリはどれですか？
- スケジュールのルールに違反しているスケジュールされたワークフローはどれで、どのように違反していますか？
- Actionsのコストはいくらで、どのジョブがそのコストを負担しましたか？
- 最後のスキャンの後に何が変更されましたか？

| ツール | 回答内容 |
|---|---|
| `hk_summary` | 最新のスキャンの合計：リポジトリ、問題、プルリクエスト、ワークフロー、検出結果。 |
| `hk_findings` | コード、重大度、カテゴリ、またはリポジトリごとの検出結果。フィルターを適用していない場合のコードごとのカウント。問題のあるメインラインの検出結果は、問題を引き起こしたジョブとステップの名前を示します。 |
| `hk_ci` | デフォルトブランチが問題のあるリポジトリと、失敗したワークフロー。また、失敗したスケジュール、失敗したプルリクエストブランチ、およびCIがないリポジトリ。 |
| `hk_repo` | 完全な1つのリポジトリ：検出結果、ワークフロー、未解決のプルリクエストと問題。 |
| `hk_backlog` | 組織全体の未解決のプルリクエストまたは問題（古いものから）。 |
| `hk_health` | リポジトリごとの健全性スコア（最も低いものから）。 |
| `hk_cost` | リポジトリ、ワークフロー、またはジョブごとのActionsの消費額（総額と純額）。 |
| `hk_sql` | ウェアハウスに対する読み取り専用の1つの`SELECT`または`WITH`ステートメント。 |
| `hk_schema` | `hk_sql`クエリを記述するためのテーブルと列。 |

すべての回答は、開いてある読み取り専用の最新のスナップショットから取得されます。失敗した呼び出しは、構造化されたエラーを返し、スタックトレースは返しません。

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

[Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas)（`@dogfood-lab/atlas`）は、1つのリポジトリをマッピングします。その構成要素と、すべてのワークフロー、実行内容、公開内容、およびデプロイ内容です。このマップは、`atlas/`としてコミットされ、CIでチェックインされます。housekeepingは組織全体のビューです。これら2つは連携して動作するように構築されています。

- **すべてのマップをスキャン。** スキャンは、各リポジトリのコミットされたマップと、その他のすべての情報を読み取り、マップがないリポジトリ、`atlas check`を実行していないリポジトリ、および組織の残りの部分がピンしているものとは異なるエンジンを保持しているリポジトリを報告します。
- **問題のある実行がどこで発生したか。** デフォルトブランチが問題がある場合、検出結果は、失敗したジョブとステップの名前を示し、マップを通じて、そのステップが実行するコマンドを示します。したがって、修正は適切なファイルから開始されます。
- **マップからのデプロイメントの事実。** ジョブがデプロイする環境は、マップに記録されている環境から取得されるため、両方のツールはワークフローを同じように読み取ります。
- **フリート全体のアラート。** Atlasは、実行前に問題が発生するワークフローステップ（たとえば、ジョブがインストールするよりも新しいランタイムを必要とするツール）をフラグします。レポートは、これらをすべてのリポジトリに対して一度にリストします。

両方のサーバーを持つエージェントは、「これらの12個のリポジトリがブロックされています」（housekeeping）から、「これはワークフロー、ジョブ、および変更が到達するファイルです」（Atlas）へと移行し、各リポジトリを手動で開く必要はありません。

## この構造になっている理由

| レイヤー | 選択 | 理由 |
|---|---|---|
| トランスポート | `gh` CLI | すでにトークンを保持しています。ツールは、認証情報を保存または要求しません。 |
| 収集 | GitHub GraphQL、ページング | 1つのクエリは、リポジトリのページに対して、メタデータ、未解決の問題、未解決のプルリクエスト、リリース、およびファイルツリーを返します。タイムアウトし続けるページは半分に分割され、同じカーソルから再要求されます。 |
| Actionsの実行 | REST | GraphQLにはActionsのインターフェースはありません。 |
| アクションにはコストがかかる | 請求 API に加えて、ジョブごとの実行時間 | 請求書にはどのリポジトリが記載されており、ジョブにはどのワークフローが記載されているか。GitHub の `/timing` エンドポイントは 0 を返すため、ジョブごとの合計が再計算され、その後、請求書と照合される。 |
| ランナーの料金 | 請求書から読み取る | 請求される料金は、リスト価格と異なる場合があり、ソースコード内の定数はすべての数値を誤って表示する。 |
| ストレージ | 組み込みの `node:sqlite` を使用した SQLite | ネイティブのビルドステップはない。 |
| 信頼できる情報源 | `data/snapshots/*.json` | 生のデータで、差分を比較でき、追加のみが可能。データベースはそこから派生する：`npm run rebuild` はオフラインで再構築する。 |
| スウィープログ | `data/sweeps.jsonl` | 1行に1つのスウィープを記録。失敗したスウィープと、新しいものが見つからなかったスウィープも含む。 |

スナップショットは不変で累積的であるため、2つの日付間のドリフトは `JOIN` である。

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
npm install -g @mcptoolshop/housekeeping   # puts `hk` and `hk-mcp` on your path
mkdir warehouse && cd warehouse            # housekeeping keeps its data here
hk refresh your-org                        # collect, load, analyze, write reports/AUDIT-<date>.md
```

スウィープ間で設定を保持するには、そのディレクトリに `housekeeping.config.json` を配置する（構成を参照）。その後、`hk refresh` に引数は不要。

または、クローンから実行すると、そのデータはクローンに保存される。

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh
```

次に、クエリを実行する。

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

`npm link` がないクローンでは、各 `hk <command>` は `node src/cli.mjs <command>` である。

`npm run rebuild` は、ディスク上の既存のスナップショットからデータベースとレポートを再派生させ、ネットワークアクセスは行わない。

完全なスウィープでは、数百回の API 呼び出しが行われる。`refresh` をループで実行しないこと。

結果は標準出力に出力され、進行状況とエラーは標準エラーに出力される。すべてのエラーには、コードとヒントが出力される。終了コード：0（正常）、1（ユーザーエラー）、2（実行時エラー）、3（部分的 - スウィープは完了したが、ギャップがある）。

## 構成

`housekeeping.config.json` は、ハウスキーピングが実行されるディレクトリにある（下記参照）。

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` は、スウィープする組織である。`hk refresh <org>` でオーバーライドできる。どちらも指定されていない場合、スウィープは開始されない。
- `metaRepos` は、組織のデフォルト、アセット、またはツールを格納するリポジトリであり、出荷される製品ではない。これらは、製品にのみ意味がある結果（README、LICENSE などのファイルがない、ワークフローがない、リリースがない）から除外される。

形式が正しくないファイルはエラーであり、サイレントなデフォルトになることはない。不明なキー、誤った型、または破損した JSON は、実行を停止させる。

クローンから実行すると、ハウスキーピングは `data/`、`reports/`、および構成ファイルをクローンに保存する。インストールされたパッケージとして実行すると、実行するディレクトリまたは `HK_HOME`（設定されている場合）に保存する。

環境：`HK_HOME`（データ、レポート、および構成が保存される場所）、`HK_CONFIG`（構成パス）、`HK_DB`（データベースパス）、`HK_LOG`（`silent`、`normal`、`verbose`、または `debug`）、`HK_COST_REPOS`、および `HK_COST_BUDGET`（ジョブごとのコストの制限）、`GH_PATH`（`gh` へのパス）。

## データを非公開に保つ

**スウィープによって書き込まれる内容は機密情報である。`data/` または `reports/` をパブリックリポジトリにコミットしないこと。**

スナップショットには、プライベートリポジトリの名前と説明、パッケージ名を含むすべての開いているセキュリティアラート、ワークフローファイル、および Actions の請求情報が記録される。GitHub は、パブリックリポジトリのセキュリティアラートを、そのリポジトリのメンテナー以外のすべてのユーザーから意図的に非表示にする。公開されたスナップショットは、そのリストを公開することになる。

このリポジトリの `.gitignore` は、`data/`、`reports/`、および `housekeeping.config.json` を除外する。履歴を保持することがスナップショットの目的であるため、独自の**プライベート**リポジトリからツールを実行し、そこにコミットすること。

## 検出結果

ルールは `src/analyze.mjs` にある。各ルールは、適用する書面によるルールを参照するため、検出結果は、好みに基づいてではなく、標準に基づいて議論できる。このリポジトリに同梱されているルールは、[`rules/`](rules/) にある。

- [`rules/github-actions.md`](rules/github-actions.md)：パスフィルター、ランナー、マトリックスサイズ、ワークフローファイルの制限、同時実行。
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md)：CI はパスする必要がある、出荷ゲート、バージョン。
- [`rules/repo-first.md`](rules/repo-first.md)：デフォルトブランチ。
- [`rules/atlas-map.md`](rules/atlas-map.md)：各リポジトリのコミットされたマップ。CI でチェックされる。

これらは、ある組織の標準である。異なる場合は、ルールファイルとルールを一緒に変更する。

ルールは、似たもの同士を区別するように注意している。なぜなら、それらをまとめてしまうとノイズが発生するからである。

- **赤いデフォルトブランチは、赤いプルリクエストブランチではありません。** 失敗した Dependabot ブランチはバックログであり、デフォルトブランチで失敗した `push` の実行は問題を引き起こします。どちらであるかは、実行のイベントによって決まります。
- **履歴は問題ではありません。** リリース専用のトリガーに移動したワークフローは、最後のデフォルトブランチでの失敗を永久に保持します。削除されたワークフローは、その実行を保持します。どちらも現在の欠陥ではありません。
- **実行できないチェックは、ここで実行されなかったチェックではありません。** 一方は、要件を削除すると言います。もう一方は、トリガーを修正すると言います。これらの修正は互いに矛盾します。
- **トリガーがスキップしたプルリクエストは、競合しているプルリクエストではありません。** GitHub は、競合のあるプルリクエストに対してプルリクエストワークフローを実行しないため、欠落しているチェックはトリガーについて何も意味しません。これは、リベースが必要です。
- **失敗した実行は、キャンセルされた実行ではありません。** `cancel-in-progress` は、古い実行を終了させるために存在するため、キャンセルされた時間は通常、同時実行ルールの動作によるものです。
- **総コストは、純コストではありません。** GitHub は、パブリックリポジトリに対して全額料金を請求し、それをゼロに割引します。総コストは実際の計算量であり、純コストは実際の費用です。これらは決して合計されません。
- **測定されていないものは、問題ありません。** GitHub がスキャンしていないリポジトリは、アラートをゼロとして報告します。コストの計算に達していないリポジトリは、コストの行を持ちません。どちらも不明として報告されます。

重大度によって健全性スコアが決まります。重大なものは 40、高いものは 15、中程度のものは 6、低いものは 2、情報提供のみのものは 0 で、これらはすべて 100 から差し引かれます。スコアは品質ではなく、優先度を示します。

[ハンドブック](https://mcp-tool-shop-org.github.io/housekeeping/handbook/) には、すべての検出結果、コマンド、エラーコード、およびテーブルがリストされています。

## セキュリティ

- **読み取り専用。** コレクターは GraphQL クエリと REST `GET` を発行します。マージ、プッシュ、リリース、公開、または設定の編集は行いません。
- **認証情報なし。** 認証は、`gh` がすでに保持しているものを使用します。それに関する情報はディスクに書き込まれません。
- **テレメトリなし。** 連絡するホストは、`gh` を介した GitHub API と、バージョンおよびアドバイザリの検索のための npm レジストリのみです。
- **保存する内容** が機密性の高い部分です。「データのプライバシーを維持する」を参照してください。

[SECURITY.md] に説明されているように、脆弱性を報告してください。

## テスト

```bash
npm test
```

すべてのルールは、両方向でテストされます。つまり、トリガーされるべき形状と、トリガーされるべきでない隣接する形状です。別の検証ツールは、独自のトランスポートを介して、ライブ GitHub から検出結果のサンプルを再計算し、データベースまたはネットワークがない場合は、エラーを発生させます。

## ライセンス

MIT。 [LICENSE](LICENSE) を参照してください。

---

<a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a> によって作成されました。
