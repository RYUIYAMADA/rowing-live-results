#!/usr/bin/env python3
"""
CSV watchモード — 開発・当日リハーサル用ファイル監視ツール

test/csv/ フォルダを3秒ごとにポーリングし、新しいCSVが追加されるたびに
simulate_pipeline の処理ロジックを直接呼び出してJSONを生成する。

使い方:
  python3 tools/watch.py                          # test/csv/ を監視
  python3 tools/watch.py --csv-dir /path/to/dir  # 任意のフォルダを監視
  python3 tools/watch.py --push                   # 変換後にGitHubにもPush
  python3 tools/watch.py --serve                  # HTTPサーバーも同時起動（ポート8181）
"""

import argparse
import http.server
import json
import os
import sys
import threading
import time
from pathlib import Path
from datetime import datetime, timezone

# simulate_pipeline をインポートできるよう、tools/ ディレクトリをパスに追加
TOOLS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TOOLS_DIR.parent
sys.path.insert(0, str(TOOLS_DIR))

import simulate_pipeline as pipeline

# ---------------------------------------------------------------------------
# 定数
# ---------------------------------------------------------------------------

# 処理済みファイルリストの永続化ファイル
STATE_FILE = PROJECT_DIR / ".watch_state.json"

# ポーリング間隔（秒）
POLL_INTERVAL = 3

# HTTPサーバーのポート番号
HTTP_PORT = 8181

# デフォルトCSVディレクトリ（プロジェクトルートからの相対）
DEFAULT_CSV_DIR = PROJECT_DIR / "test" / "csv"

# JSON出力先ディレクトリ
OUTPUT_DIR = PROJECT_DIR / "data" / "results"

# デフォルト計測ポイント（カンマ区切り文字列）
DEFAULT_POINTS = "500m,1000m"

# ---------------------------------------------------------------------------
# ANSIカラー定義（colorama不要）
# ---------------------------------------------------------------------------
class C:
    RESET  = "\033[0m"
    BOLD   = "\033[1m"
    GREEN  = "\033[32m"
    YELLOW = "\033[33m"
    CYAN   = "\033[36m"
    RED    = "\033[31m"
    GRAY   = "\033[90m"
    BLUE   = "\033[34m"


def load_state() -> set:
    """
    前回の処理済みファイルリストを .watch_state.json から読み込む。
    ファイルが存在しない・壊れている場合は空セットを返す。
    """
    if not STATE_FILE.exists():
        return set()
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return set(data.get("processed_files", []))
    except (json.JSONDecodeError, OSError):
        return set()


def save_state(processed: set) -> None:
    """
    処理済みファイルリストを .watch_state.json に保存する。
    watch.py 終了・再起動時に同じファイルを再処理しないようにするため。
    """
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump({"processed_files": sorted(processed)}, f, ensure_ascii=False, indent=2)
    except OSError as e:
        log_error(f"状態ファイルの保存に失敗しました: {e}")


def _timestamp() -> str:
    """現在時刻を HH:MM:SS 形式で返す。"""
    return datetime.now().strftime("%H:%M:%S")


def log_watch(msg: str) -> None:
    """[Watch] プレフィックス付きのシアンログ。"""
    print(f"{C.CYAN}[Watch]{C.RESET} {_timestamp()} {msg}")


def log_detect(filename: str) -> None:
    """新ファイル検出ログ（黄色強調）。"""
    print(f"{C.YELLOW}[Watch]{C.RESET} {_timestamp()} 新ファイル検出: {C.BOLD}{filename}{C.RESET}")


def log_ok(msg: str) -> None:
    """成功ログ（緑）。"""
    print(f"{C.GREEN}[Watch]{C.RESET} {_timestamp()} {msg}")


def log_error(msg: str) -> None:
    """エラーログ（赤）。"""
    print(f"{C.RED}[Watch]{C.RESET} {_timestamp()} {msg}", file=sys.stderr)


def log_server(msg: str) -> None:
    """HTTPサーバーログ（青）。"""
    print(f"{C.BLUE}[Serve]{C.RESET} {_timestamp()} {msg}")


# ---------------------------------------------------------------------------
# HTTPサーバー（バックグラウンドスレッドで起動）
# ---------------------------------------------------------------------------

class _SilentHandler(http.server.SimpleHTTPRequestHandler):
    """アクセスログを抑制した SimpleHTTPRequestHandler。"""

    def log_message(self, format, *args):
        # 標準のアクセスログを無効化（ウォッチログを邪魔しないため）
        pass


def start_http_server(directory: Path, port: int) -> threading.Thread:
    """
    指定ディレクトリをルートとしてHTTPサーバーをバックグラウンドで起動する。
    起動したスレッドを返す。
    """
    handler = lambda *args, **kwargs: _SilentHandler(
        *args, directory=str(directory), **kwargs
    )
    server = http.server.HTTPServer(("", port), handler)

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log_server(f"HTTPサーバー起動: http://localhost:{port}")
    log_server(f"  ルートディレクトリ: {directory}")
    return thread


# ---------------------------------------------------------------------------
# CSVポーリング処理
# ---------------------------------------------------------------------------

def scan_csv_files(csv_dir: Path) -> set:
    """
    指定ディレクトリ内の .csv ファイル名のセットを返す。
    ディレクトリが存在しない場合は空セットを返す。
    """
    if not csv_dir.is_dir():
        return set()
    return {f for f in os.listdir(str(csv_dir)) if f.lower().endswith(".csv")}


def process_new_file(
    filename: str,
    csv_dir: Path,
    measurement_points: list,
    do_push: bool,
    push_token: str,
    push_repo: str,
    push_branch: str,
) -> None:
    """
    新規CSVファイルを検出した際の処理。

    ファイル名を parse_csv_filename でパースし、同一レースの全計測ポイントが
    そろっているか確認してから race_XXX.json を生成する。
    """
    # ファイル名をパース
    parsed = pipeline.parse_csv_filename(filename)
    if not parsed:
        log_watch(f"命名規則不一致のためスキップ: {filename}")
        return

    race_no, point = parsed
    log_detect(filename)
    log_watch(f"  → Race {race_no:03d} / 計測ポイント: {point}")

    # 同一レースの全計測ポイントが揃っているか確認
    race_files = pipeline.collect_csv_files(csv_dir, {race_no})
    if race_no not in race_files:
        log_watch(f"  レース {race_no:03d}: 対応CSVなし（スキップ）")
        return

    found_points = set(race_files[race_no].keys())
    required_points = set(measurement_points)
    missing = required_points - found_points

    if missing:
        log_watch(
            f"  レース {race_no:03d}: 計測ポイント未揃い "
            f"（揃い済み: {sorted(found_points)} / 不足: {sorted(missing)}）"
        )
        log_watch(f"  次のCSVが届くまで待機します...")
        return

    log_watch(f"  レース {race_no:03d}: 全計測ポイント揃い → JSON生成開始")

    # 各ポイントのCSVをパース
    point_records = {}
    for pt in measurement_points:
        filepath = race_files[race_no][pt]
        records = pipeline.parse_csv(filepath)
        if not records:
            log_error(f"  {pt}: レコードが空です → スキップ")
            return
        point_records[pt] = records
        log_watch(f"  {pt}: {len(records)} レコード読み込み")

    # race_XXX.json を構築
    race_json = pipeline.build_race_json(race_no, point_records, measurement_points)
    json_str  = json.dumps(race_json, ensure_ascii=False, indent=2) + "\n"
    filename_out = f"race_{race_no:03d}.json"

    # ファイル出力
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / filename_out
    out_path.write_text(json_str, encoding="utf-8")
    log_ok(f"  JSON書き出し完了: {out_path}")

    # 結果サマリーを表示
    for r in race_json["results"]:
        finish_fmt = r.get("finish", {}).get("formatted", "---")
        tie_str    = f" [同着:{r['tie_group']}]" if r.get("tie_group") else ""
        print(
            f"    {C.GRAY}  {r['rank']:2d}位  レーン{r['lane']}  "
            f"{finish_fmt}  {r.get('split', '')}{tie_str}{C.RESET}"
        )

    # GitHubへのPush（--push指定時）
    if do_push:
        if not push_token:
            log_error("GITHUB_TOKEN / --token が未設定のためPushをスキップ")
            return
        if not push_repo:
            log_error("GITHUB_REPO / --repo が未設定のためPushをスキップ")
            return

        remote_path = f"data/results/{filename_out}"
        try:
            pipeline.github_push_file(
                token         = push_token,
                repo          = push_repo,
                branch        = push_branch,
                path          = remote_path,
                content_bytes = json_str.encode("utf-8"),
                message       = f"chore: update {filename_out} [watch]",
            )
            log_ok(f"  GitHub Push 完了: {remote_path}")
        except Exception as e:
            log_error(f"  GitHub Push 失敗: {e}")


# ---------------------------------------------------------------------------
# メインループ
# ---------------------------------------------------------------------------

def run(args: argparse.Namespace) -> None:
    """
    監視ループのメイン処理。Ctrl+C で終了する。
    """
    csv_dir = Path(args.csv_dir).resolve()
    measurement_points = [p.strip() for p in args.points.split(",") if p.strip()]

    # GitHubトークン・リポジトリ（Push時）
    push_token  = args.token  or os.environ.get("GITHUB_TOKEN", "")
    push_repo   = args.repo   or os.environ.get("GITHUB_REPO",  "")
    push_branch = args.branch

    # 起動メッセージ
    print(f"\n{C.BOLD}{C.CYAN}{'='*50}{C.RESET}")
    print(f"{C.BOLD}{C.CYAN}  CSV Watch モード{C.RESET}")
    print(f"{C.CYAN}{'='*50}{C.RESET}\n")
    log_watch(f"監視ディレクトリ : {csv_dir}")
    log_watch(f"計測ポイント     : {', '.join(measurement_points)}")
    log_watch(f"ポーリング間隔   : {POLL_INTERVAL}秒")
    log_watch(f"JSON出力先       : {OUTPUT_DIR}")
    if args.push:
        log_watch(f"GitHub Push      : 有効 (repo={push_repo or '未設定'})")
    if args.serve:
        log_watch(f"HTTPサーバー     : 有効 (ポート={HTTP_PORT})")
    print()

    # CSVディレクトリが存在しない場合は警告
    if not csv_dir.is_dir():
        log_error(f"監視ディレクトリが存在しません: {csv_dir}")
        log_error("ディレクトリが作成されるまで待機します...")

    # --serve: HTTPサーバーをバックグラウンドで起動
    if args.serve:
        start_http_server(PROJECT_DIR, HTTP_PORT)
        log_server(f"ブラウザで確認: http://localhost:{HTTP_PORT}")
        print()

    # 前回の処理済みファイルリストを読み込む
    persisted_files = load_state()
    if persisted_files:
        log_watch(f"前回の処理済みファイルを復元: {len(persisted_files)} ファイル")

    # 初期ファイルリスト（起動時点の既存ファイルは処理済みとみなす）
    current_at_start = scan_csv_files(csv_dir)
    known_files: set = persisted_files | current_at_start
    if current_at_start - persisted_files:
        log_watch(
            f"起動時点で {len(current_at_start - persisted_files)} ファイルを新たに確認"
            "（処理済みとして登録）"
        )
    log_watch("新しいCSVファイルの追加を待機中... (Ctrl+C で終了)\n")

    # ポーリングループ
    try:
        while True:
            time.sleep(POLL_INTERVAL)

            current_files = scan_csv_files(csv_dir)
            new_files = current_files - known_files

            for filename in sorted(new_files):
                # 処理済みセットに追加（2重処理防止）
                known_files.add(filename)
                save_state(known_files)
                try:
                    process_new_file(
                        filename          = filename,
                        csv_dir           = csv_dir,
                        measurement_points = measurement_points,
                        do_push           = args.push,
                        push_token        = push_token,
                        push_repo         = push_repo,
                        push_branch       = push_branch,
                    )
                except Exception as e:
                    log_error(f"処理中に例外が発生しました ({filename}): {e}")

    except KeyboardInterrupt:
        print(f"\n{C.CYAN}[Watch]{C.RESET} Ctrl+C を受信 → 監視を終了します")
        print(f"{C.CYAN}[Watch]{C.RESET} 処理済みファイル数: {len(known_files)}")
        save_state(known_files)
        print(f"{C.CYAN}[Watch]{C.RESET} 状態を {STATE_FILE} に保存しました")
        print()


# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="CSV watchモード — CSVフォルダを監視して自動でJSONを生成する",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--csv-dir",
        default=str(DEFAULT_CSV_DIR),
        metavar="DIR",
        help=f"監視するCSVディレクトリ（デフォルト: {DEFAULT_CSV_DIR}）",
    )
    parser.add_argument(
        "--points",
        default=DEFAULT_POINTS,
        metavar="POINTS",
        help=f"計測ポイント（カンマ区切り。デフォルト: {DEFAULT_POINTS}）",
    )
    parser.add_argument(
        "--push",
        action="store_true",
        help="JSON生成後に GitHub へも Push する（GITHUB_TOKEN 必須）",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help=f"HTTPサーバーをバックグラウンドで起動する（ポート: {HTTP_PORT}）",
    )
    parser.add_argument(
        "--token",
        default=None,
        metavar="TOKEN",
        help="GitHub Personal Access Token（省略時は環境変数 GITHUB_TOKEN を使用）",
    )
    parser.add_argument(
        "--repo",
        default=None,
        metavar="OWNER/REPO",
        help="GitHub リポジトリ（例: RYUIYAMADA/rowing-live-results）",
    )
    parser.add_argument(
        "--branch",
        default="main",
        metavar="BRANCH",
        help="Push先ブランチ（デフォルト: main）",
    )
    return parser.parse_args()


if __name__ == "__main__":
    run(parse_args())
