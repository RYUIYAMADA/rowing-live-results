#!/usr/bin/env python3
"""
BoatTimerCSV → race_XXX.json ローカル変換ツール

GAS（Google Apps Script）の処理をローカルで再現するスクリプト。
本番前のテストや、GASなしでの動作確認に使う。

使い方:
  python3 tools/simulate_pipeline.py                         # data/results/ に出力
  python3 tools/simulate_pipeline.py --push                  # GitHub にもPush
  python3 tools/simulate_pipeline.py --csv test/csv/         # CSVディレクトリ指定
  python3 tools/simulate_pipeline.py --race 1,2,3            # 特定レースのみ
  python3 tools/simulate_pipeline.py --dry-run               # 出力せず表示のみ
  python3 tools/simulate_pipeline.py --points 500m,1000m     # 計測ポイント指定
  python3 tools/simulate_pipeline.py --token ghp_xxx --push  # トークン直指定

必要な環境変数（--push 使用時）:
  GITHUB_TOKEN  GitHub Personal Access Token（repo スコープ）
  GITHUB_REPO   対象リポジトリ（例: RYUIYAMADA/rowing-live-results）
"""

import argparse
import csv
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

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

def log_info(msg: str)    -> None: print(f"{C.CYAN}[INFO]{C.RESET}  {msg}")
def log_ok(msg: str)      -> None: print(f"{C.GREEN}[OK]{C.RESET}    {msg}")
def log_warn(msg: str)    -> None: print(f"{C.YELLOW}[WARN]{C.RESET}  {msg}")
def log_error(msg: str)   -> None: print(f"{C.RED}[ERROR]{C.RESET} {msg}", file=sys.stderr)
def log_debug(msg: str)   -> None: print(f"{C.GRAY}[DEBUG]{C.RESET} {msg}")
def log_section(msg: str) -> None: print(f"\n{C.BOLD}{C.CYAN}{'='*60}{C.RESET}")
def log_title(msg: str)   -> None: print(f"{C.BOLD}{C.CYAN}  {msg}{C.RESET}\n{'='*60}{C.RESET}\n")

# ---------------------------------------------------------------------------
# CSV ファイル名パース
# フォーマット: YYYYMMDD_HHMMSS_R{NNN}_{計測ポイント}.csv
# 例: 20250607_101523_R001_500m.csv
# ---------------------------------------------------------------------------
CSV_FILENAME_RE = re.compile(
    r"^\d{8}_\d{6}_R(\d+)_(.+?)\.csv$", re.IGNORECASE
)

def parse_csv_filename(filename: str):
    """
    ファイル名から (race_no: int, measurement_point: str) を返す。
    マッチしない場合は None。
    """
    m = CSV_FILENAME_RE.match(filename)
    if not m:
        return None
    return int(m.group(1)), m.group(2)

# ---------------------------------------------------------------------------
# タイム変換ユーティリティ
# ---------------------------------------------------------------------------

def ms_to_formatted(ms: int) -> str:
    """
    ミリ秒 → 'M:SS.ss' 形式。
    例: 108220 → '1:48.22'
    """
    total_cs = ms // 10          # センチ秒（0.01秒単位）
    centisec = total_cs % 100
    total_sec = total_cs // 100
    sec = total_sec % 60
    minutes = total_sec // 60
    return f"{minutes}:{sec:02d}.{centisec:02d}"

def parse_time_to_ms(time_str: str) -> Optional[int]:
    """
    'M:SS.cs' または 'M:SS.ss' 形式の文字列をミリ秒に変換。
    パース失敗時は None。
    例: '1:48.22' → 108220
    """
    time_str = time_str.strip()
    if not time_str:
        return None
    # RowingTimerWeb は time_ms カラムに整数ミリ秒を出力する
    if re.match(r"^\d+$", time_str):
        return int(time_str)
    # M:SS.cs パターン
    m = re.match(r"^(\d+):(\d{2})\.(\d{2})$", time_str)
    if m:
        minutes = int(m.group(1))
        seconds = int(m.group(2))
        centisec = int(m.group(3))
        return (minutes * 60 * 100 + seconds * 100 + centisec) * 10
    # SS.cs パターン（分なし）
    m = re.match(r"^(\d+)\.(\d{2})$", time_str)
    if m:
        seconds = int(m.group(1))
        centisec = int(m.group(2))
        return (seconds * 100 + centisec) * 10
    return None

# ---------------------------------------------------------------------------
# RowingTimerWeb CSV パーサ
# 期待カラム: lane, rank, time, tie_group, photo_flag, note
# ※ 実際のカラム名は大文字小文字を無視してマッチ
# ---------------------------------------------------------------------------

# カラム名エイリアス（小文字で定義）
_COL_ALIASES = {
    "lane":       ["lane", "コース", "lane_no"],
    "rank":       ["rank", "順位", "place"],
    # RowingTimerWeb は time_ms（ミリ秒整数）と formatted（表示用文字列）を出力する
    "time":       ["time_ms", "time", "タイム", "result_time", "finish_time"],
    "formatted":  ["formatted", "display_time", "time_str"],
    "tie_group":  ["tie_group", "tie", "同着"],
    "photo_flag": ["photo_flag", "photo", "写真判定", "fp"],
    "note":       ["note", "備考", "memo"],
}

def _build_col_map(headers: List[str]) -> Dict[str, int]:
    """
    CSVのヘッダー行から正規化済みカラムインデックスマップを返す。
    キー: 正規化カラム名, 値: ヘッダー内のインデックス
    """
    lower_headers = [h.strip().lower() for h in headers]
    col_map = {}
    for normalized, aliases in _COL_ALIASES.items():
        for alias in aliases:
            if alias in lower_headers:
                col_map[normalized] = lower_headers.index(alias)
                break
    return col_map

def parse_csv(filepath: Path) -> list[dict]:
    """
    RowingTimerWeb 形式の CSV を読み込み、レコードのリストを返す。
    各レコード: {"lane": int, "time_ms": int, "tie_group": str,
                 "photo_flag": bool, "note": str}
    """
    records = []
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        headers = next(reader, None)
        if not headers:
            log_warn(f"空のCSVファイル: {filepath.name}")
            return records

        col = _build_col_map(headers)

        if "lane" not in col or "time" not in col:
            log_warn(f"必須カラム (lane/time) が見つかりません: {filepath.name}")
            log_debug(f"  ヘッダー: {headers}")
            return records

        for row in reader:
            if not any(v.strip() for v in row):
                continue  # 空行スキップ

            def get(key, default=""):
                idx = col.get(key)
                if idx is None or idx >= len(row):
                    return default
                return row[idx].strip()

            lane_str = get("lane")
            time_str = get("time")
            if not lane_str or not time_str:
                continue

            try:
                lane = int(lane_str)
            except ValueError:
                log_warn(f"無効なレーン番号: {lane_str!r} in {filepath.name}")
                continue

            time_ms = parse_time_to_ms(time_str)
            if time_ms is None:
                log_warn(f"タイムのパース失敗: {time_str!r} in {filepath.name} lane={lane}")
                continue

            photo_raw = get("photo_flag", "").lower()
            photo_flag = photo_raw in ("1", "true", "yes", "○", "◯")

            # formatted フィールド: CSVの値は無視し、常に time_ms から再計算する
            # （RowingTimerWebはミリ秒3桁を出力するが、競技慣習はセンチ秒2桁）
            fmt_str = ms_to_formatted(time_ms)

            records.append({
                "lane":       lane,
                "time_ms":    time_ms,
                "formatted":  fmt_str,
                "tie_group":  get("tie_group"),
                "photo_flag": photo_flag,
                "note":       get("note"),
            })

    return records

# ---------------------------------------------------------------------------
# race_XXX.json 生成
# ---------------------------------------------------------------------------

def build_race_json(
    race_no: int,
    point_records: Dict[str, List[dict]],
    measurement_points: List[str],
) -> dict:
    """
    計測ポイントごとのレコード群から race_XXX.json の dict を構築する。

    Args:
        race_no:             レース番号
        point_records:       {計測ポイント名: [レコード, ...]}
        measurement_points:  計測ポイントの順序リスト（先頭が最初の計測点）
    """
    # フィニッシュポイント（最後の計測ポイント）
    finish_point = measurement_points[-1]
    first_point  = measurement_points[0]

    # レーン→各ポイントのタイムをマッピング
    lane_times: Dict[int, Dict[str, dict]] = {}

    for point in measurement_points:
        if point not in point_records:
            continue
        for rec in point_records[point]:
            lane = rec["lane"]
            if lane not in lane_times:
                lane_times[lane] = {
                    "_tie_group":  rec["tie_group"],
                    "_photo_flag": rec["photo_flag"],
                    "_note":       rec["note"],
                }
            lane_times[lane][point] = {
                "time_ms":   rec["time_ms"],
                # 常に time_ms から再計算（センチ秒2桁統一）
                "formatted": ms_to_formatted(rec["time_ms"]),
            }

    # フィニッシュタイムが存在するレーンのみ結果に含める
    results_raw = []
    for lane, times in lane_times.items():
        if finish_point not in times:
            log_warn(f"  レーン {lane}: フィニッシュタイム ({finish_point}) なし → スキップ")
            continue
        finish_ms = times[finish_point]["time_ms"]

        # スプリットタイム = フィニッシュ - 最初の計測ポイント
        split_str = ""
        if first_point != finish_point and first_point in times:
            split_ms = finish_ms - times[first_point]["time_ms"]
            split_str = f"({ms_to_formatted(split_ms)})"

        # 計測ポイントのみ times に含める（内部フラグ除外）
        point_times = {k: v for k, v in times.items() if not k.startswith("_")}

        results_raw.append({
            "lane":       lane,
            "finish_ms":  finish_ms,
            "times":      point_times,
            "tie_group":  times["_tie_group"],
            "photo_flag": times["_photo_flag"],
            "note":       times["_note"],
            "split":      split_str,
        })

    # フィニッシュタイムでソート（タイムなし = 最後尾）
    results_raw.sort(key=lambda r: r["finish_ms"])

    # ランク付け（同着考慮）
    results = []
    rank = 1
    prev_ms = None
    prev_tie = None
    for i, r in enumerate(results_raw):
        cur_tie = r["tie_group"]
        cur_ms  = r["finish_ms"]

        if i == 0:
            assigned_rank = 1
        elif cur_tie and cur_tie == prev_tie:
            # 同着グループ継続 → 前と同じ順位
            assigned_rank = results[-1]["rank"]
        else:
            assigned_rank = i + 1

        results.append({
            "lane":       r["lane"],
            "rank":       assigned_rank,
            "times":      r["times"],
            "finish":     r["times"].get(finish_point, {}),
            "split":      r["split"],
            "tie_group":  r["tie_group"],
            "photo_flag": r["photo_flag"],
            "note":       r["note"],
        })

        prev_ms  = cur_ms
        prev_tie = cur_tie

    return {
        "race_no":    race_no,
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "results":    results,
    }

# ---------------------------------------------------------------------------
# GitHub Contents API Push
# ---------------------------------------------------------------------------

def github_get_sha(token: str, repo: str, branch: str, path: str) -> Optional[str]:
    """
    GitHub Contents API でファイルの現在の SHA を取得する。
    ファイルが存在しない場合は None を返す。
    """
    url = f"https://api.github.com/repos/{repo}/contents/{path}?ref={branch}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "simulate_pipeline/1.0",
    })
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            return data.get("sha")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None  # 新規ファイル
        raise

def github_push_file(
    token: str,
    repo: str,
    branch: str,
    path: str,
    content_bytes: bytes,
    message: str,
) -> None:
    """
    GitHub Contents API を使ってファイルを作成または更新する。
    既存ファイルの場合は SHA を取得してから PUT する。
    """
    import base64

    sha = github_get_sha(token, repo, branch, path)
    encoded = base64.b64encode(content_bytes).decode("ascii")

    payload: dict = {
        "message": message,
        "content": encoded,
        "branch":  branch,
    }
    if sha:
        payload["sha"] = sha

    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="PUT", headers={
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "simulate_pipeline/1.0",
    })
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
        commit_sha = result.get("commit", {}).get("sha", "")[:7]
        log_ok(f"  GitHub Push 完了: {path} (commit: {commit_sha})")

# ---------------------------------------------------------------------------
# メイン処理
# ---------------------------------------------------------------------------

def collect_csv_files(csv_dir: Path, race_filter: Optional[Set[int]]) -> Dict[int, Dict[str, Path]]:
    """
    CSVディレクトリを走査し、{race_no: {point: Path}} の辞書を返す。
    race_filter が指定されている場合は対象レースのみ返す。
    """
    race_files: Dict[int, Dict[str, Path]] = {}
    for f in sorted(csv_dir.glob("*.csv")):
        parsed = parse_csv_filename(f.name)
        if not parsed:
            log_debug(f"スキップ（命名規則不一致）: {f.name}")
            continue
        race_no, point = parsed
        if race_filter and race_no not in race_filter:
            continue
        race_files.setdefault(race_no, {})[point] = f
    return race_files

def run(args: argparse.Namespace) -> int:
    """
    メイン処理。終了コードを返す（0=成功, 1=エラーあり）.
    """
    log_section("")
    log_title("simulate_pipeline — BoatTimerCSV → race_XXX.json")

    # ---- パスの解決 --------------------------------------------------------
    script_dir  = Path(__file__).resolve().parent
    project_dir = script_dir.parent

    csv_dir    = Path(args.csv).resolve()
    output_dir = Path(args.output).resolve()
    measurement_points = [p.strip() for p in args.points.split(",") if p.strip()]

    log_info(f"CSV ディレクトリ : {csv_dir}")
    log_info(f"出力ディレクトリ : {output_dir}")
    log_info(f"計測ポイント     : {', '.join(measurement_points)}")
    if args.dry_run:
        log_warn("--dry-run モード: ファイル出力・GitHub Push を行いません")

    # ---- レースフィルター --------------------------------------------------
    race_filter: Optional[Set[int]] = None
    if args.race:
        try:
            race_filter = {int(r.strip()) for r in args.race.split(",")}
            log_info(f"対象レース       : {sorted(race_filter)}")
        except ValueError:
            log_error(f"--race の値が不正です: {args.race}")
            return 1

    # ---- CSV収集 -----------------------------------------------------------
    if not csv_dir.is_dir():
        log_error(f"CSVディレクトリが存在しません: {csv_dir}")
        return 1

    race_files = collect_csv_files(csv_dir, race_filter)
    if not race_files:
        log_warn("処理対象のCSVファイルが見つかりませんでした")
        return 0

    log_info(f"検出レース数: {len(race_files)}")

    # ---- GitHub Push 準備 --------------------------------------------------
    github_token = args.token or os.environ.get("GITHUB_TOKEN", "")
    github_repo  = args.repo  or os.environ.get("GITHUB_REPO",  "")
    do_push      = args.push and not args.dry_run

    if args.push and not github_token:
        log_error("--push が指定されましたが GITHUB_TOKEN / --token が設定されていません")
        return 1
    if args.push and not github_repo:
        log_error("--push が指定されましたが GITHUB_REPO / --repo が設定されていません")
        return 1

    # ---- レースごとに処理 --------------------------------------------------
    success_count = 0
    skip_count    = 0
    error_count   = 0

    for race_no in sorted(race_files):
        points_found = race_files[race_no]
        missing = [p for p in measurement_points if p not in points_found]

        print()
        log_info(f"レース {race_no:03d}: 計測ポイント {list(points_found.keys())}")

        if missing:
            log_warn(f"  計測ポイント未揃い（不足: {missing}）→ スキップ")
            skip_count += 1
            continue

        # CSVパース
        point_records: Dict[str, List[dict]] = {}
        parse_ok = True
        for point in measurement_points:
            filepath = points_found[point]
            log_debug(f"  パース: {filepath.name}")
            records = parse_csv(filepath)
            if not records:
                log_warn(f"  {point}: レコードなし → スキップ")
                parse_ok = False
                break
            point_records[point] = records
            log_info(f"  {point}: {len(records)} レコード読み込み")

        if not parse_ok:
            skip_count += 1
            continue

        # JSON生成
        race_json = build_race_json(race_no, point_records, measurement_points)
        json_str  = json.dumps(race_json, ensure_ascii=False, indent=2) + "\n"
        filename  = f"race_{race_no:03d}.json"

        # 結果プレビュー
        log_info(f"  生成結果: {len(race_json['results'])} 艇")
        for r in race_json["results"]:
            finish_fmt = r.get("finish", {}).get("formatted", "---")
            tie_str    = f" [{r['tie_group']}]" if r["tie_group"] else ""
            print(f"    {C.GRAY}  {r['rank']:2d}位  レーン{r['lane']}  {finish_fmt}  {r['split']}{tie_str}{C.RESET}")

        if args.dry_run:
            log_warn(f"  [dry-run] 出力スキップ: {filename}")
            success_count += 1
            continue

        # ファイル出力
        output_dir.mkdir(parents=True, exist_ok=True)
        out_path = output_dir / filename
        out_path.write_text(json_str, encoding="utf-8")
        log_ok(f"  書き出し完了: {out_path}")

        # GitHub Push
        if do_push:
            remote_path = f"data/results/{filename}"
            try:
                github_push_file(
                    token         = github_token,
                    repo          = github_repo,
                    branch        = args.branch,
                    path          = remote_path,
                    content_bytes = json_str.encode("utf-8"),
                    message       = f"chore: update {filename} [auto]",
                )
            except Exception as e:
                log_error(f"  GitHub Push 失敗: {e}")
                error_count += 1
                continue

        success_count += 1

    # ---- サマリー ----------------------------------------------------------
    print()
    log_section("")
    print(f"  完了: {C.GREEN}{success_count}{C.RESET}  スキップ: {C.YELLOW}{skip_count}{C.RESET}  エラー: {C.RED}{error_count}{C.RESET}")
    print()

    return 1 if error_count > 0 else 0

# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="BoatTimerCSV → race_XXX.json ローカル変換ツール",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--csv",
        default="test/csv/",
        metavar="DIR",
        help="CSVファイルが置かれたディレクトリ（デフォルト: test/csv/）",
    )
    parser.add_argument(
        "--output",
        default="data/results/",
        metavar="DIR",
        help="race_XXX.json の出力先ディレクトリ（デフォルト: data/results/）",
    )
    parser.add_argument(
        "--points",
        default="500m,1000m",
        metavar="POINTS",
        help="計測ポイント（カンマ区切り。デフォルト: 500m,1000m）",
    )
    parser.add_argument(
        "--race",
        default=None,
        metavar="RACES",
        help="処理するレース番号（カンマ区切り。例: 1,2,3）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="ファイル出力・GitHub Push を行わず、処理結果を表示のみ",
    )
    parser.add_argument(
        "--push",
        action="store_true",
        help="GitHub にも Push する（GITHUB_TOKEN 必須）",
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
        help="Push 先ブランチ（デフォルト: main）",
    )
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(run(parse_args()))
