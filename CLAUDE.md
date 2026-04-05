# ボート競技ライブリザルトWebサイト

## プロジェクト概要
ボート競技大会のレース結果をリアルタイムでWeb公開する速報サイト。
計測システム（RowingTimerWeb v11）からCSVをGoogle Driveにアップするだけで、3分以内にサイトが自動更新される。

## 技術スタック
- **フロントエンド**: HTML / CSS / JavaScript（静的サイト）
- **ホスティング**: Cloudflare Pages（GitHub連携で自動デプロイ）
- **自動連携**: Google Apps Script（Drive監視 → CSV→JSON変換 → GitHub Push）
- **ファイル格納**: Google Drive
- **ソースコード**: GitHub (`RYUIYAMADA/rowing-live-results`)

## ディレクトリ構成
```
rowing-live-results/
├── CLAUDE.md              ← このファイル
├── index.html             ← メインページ
├── css/
│   └── style.css
├── js/
│   └── app.js             ← フィルタ・検索・レース表示ロジック
├── data/
│   ├── master.json        ← 大会マスタ・スケジュール・エントリー情報
│   └── results/           ← GASがPushするJSON（race_001.json等）
├── docs/
│   ├── 仕様書_v3.html     ← システム仕様書（公開用）
│   ├── 仕様書_v2.html     ← 内部仕様書（DB設計含む・開発者参照用）
│   ├── 担当者マニュアル.html
│   └── 見積書.xlsx
├── gas/
│   ├── Code.gs            ← GAS自動連携スクリプト
│   └── セットアップガイド.html
└── test/
    └── csv/               ← テスト用CSVデータ
```

## 自動更新フロー
```
Google Drive (race_csv/500/, race_csv/1000/)
  ↓ GAS 2分間隔トリガー
  ↓ 全ラップ揃いチェック（500m + 1000m 両方必要）
  ↓ CSV → JSON変換
  ↓ GitHub Contents API でPush (data/results/race_XXX.json)
  ↓ Cloudflare Pages 自動デプロイ（約1分）
サイト更新完了（合計3分以内）
```

## Google Drive フォルダ構成
```
マスターズ石川県大会/ (ID: 1sCKohwJK8DWjINLxEfe_eO9Nm-DBshop)
├── race_csv/
│   ├── 500m/       ← 500m計測CSV投入先
│   └── 1000m/      ← 1000m計測CSV投入先
├── master/          ← 大会マスタ・スケジュール・エントリーCSV
└── processed/       ← 処理済みCSV（GASが自動移動）
    ├── 500m/
    └── 1000m/
```

## CSV仕様
### レース結果CSV（RowingTimerWeb出力）
- ファイル名（推奨）: `R{NNN}_{計測ポイント}.csv`
- 例: `R001_500.csv` / `R001_1000.csv`
- 旧形式（後方互換）: `YYYYMMDD_HHMMSS_R{NNN}_{計測ポイント}.csv` も使用可能
- カラム: measurement_point, lane, lap_index, time_ms, formatted, race_no, tie_group, photo_flag, note

### 更新ルール
- **全ラップが揃ってから一括更新**（片方だけではサイトは更新されない）
- 1000mコース: 500m CSV + 1000m CSV の両方が必要
- 同一 race_no の全計測ポイントをGASが自動チェック

## 開発フェーズ
- [x] Phase 0: 設計（モックアップ・CSV仕様・マニュアル・見積もり）
- [x] Phase 1: MVP開発
  - [x] GAS自動連携スクリプト (gas/Code.gs) - 1047行
  - [x] セットアップガイド (gas/セットアップガイド.html)
  - [x] フロントエンド (index.html + css/style.css + js/app.js)
  - [x] GitHub Actions CI (.github/workflows/)
  - [x] Cloudflare Pages デプロイ済み (https://rowing-live-results.pages.dev)
  - [x] E2Eテスト (test/e2e_test.py) - 全13テストPASS
  - [x] 運用ツール (tools/)
- [ ] Phase 2: テスト大会実証 + スタッフトレーニング
- [ ] Phase 3: 通知機能（任意）

## データ構造

### data/master.json（大会マスタ）
```json
{
  "tournament": {
    "name": "大会名",
    "dates": ["2026-06-07", "2026-06-08"],
    "venue": "会場名 1000m",
    "course_length": 1000,
    "youtube_url": ""
  },
  "measurement_points": ["500m", "1000m"],
  "schedule": [
    {
      "race_no": 1,
      "event_code": "M_1X",
      "event_name": "男子シングルスカル",
      "category": "M",
      "age_group": "G",
      "round": "FA",
      "date": "2026-06-07",
      "time": "07:00",
      "entries": [
        { "lane": 1, "crew_name": "クルー名", "affiliation": "所属" }
      ]
    }
  ]
}
```

### data/results/race_XXX.json（GAS出力）
```json
{
  "race_no": 1,
  "updated_at": "2026-04-05T12:00:00.000Z",
  "results": [
    {
      "lane": 3,
      "rank": 1,
      "times": {
        "500m": { "time_ms": 9570, "formatted": "00:09.57" },
        "1000m": { "time_ms": 19900, "formatted": "00:19.90" }
      },
      "finish": { "time_ms": 19900, "formatted": "00:19.90" },
      "split": "(0:10.33)",
      "tie_group": "",
      "photo_flag": false,
      "note": ""
    }
  ]
}
```

## デプロイ先
- **本番サイト**: https://rowing-live-results.pages.dev
- **GitHub**: https://github.com/RYUIYAMADA/rowing-live-results

## 開発・運用コマンド
| コマンド | 用途 |
|---|---|
| `make test` | E2Eテスト実行 |
| `make watch` | CSV watchモード（ブラウザ確認あり） |
| `make status` | システム状態確認 |
| `make pipeline` | テストCSVからrace JSON生成 |
| `python3 tools/init_tournament.py` | 新大会セットアップ |
| `python3 tools/check_status.py --site URL` | 本番サイト確認 |

## コーディング規約
- コメントは日本語
- 設定値は定数化して上部にまとめる
- エラーハンドリング必須（API制限の自動検知・停止）
- ログ出力を充実させる

## 重要な制約
- Google Oneアカウント（Workspaceではない）: API制限は無料アカウントと同じ
- GAS実行時間制限: 6分/回
- トリガー総実行時間: 90分/日
- GitHub Personal Access Token: スクリプトプロパティで管理（コードに直書き禁止）

## 参照ドキュメント
- モックアップ: index.html（旧モックアップ → docs/mockup_v3.html に移動済み）
- 担当者マニュアル: docs/担当者マニュアル.html
- テストデータ: test/csv/
