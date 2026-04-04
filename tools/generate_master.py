#!/usr/bin/env python3
"""
スケジュール・エントリーCSV → data/master.json 変換ツール

schedule.csv + entries.csv を読み込み、フロントエンドが参照する
master.json を生成する。大会情報（名称・日程・会場）はコマンドライン引数で指定。

使い方:
  python3 tools/generate_master.py \
    --schedule test/csv/schedule_sample.csv \
    --entries  test/csv/entries_sample.csv  \
    --output   data/master.json             \
    --tournament "第16回全日本マスターズレガッタ" \
    --dates    "2025-06-07,2025-06-08"      \
    --venue    "長野・下諏訪ボートコース 1000m" \
    --points   "500m,1000m" \
    --youtube  ""

入力フォーマット:
  schedule.csv: race_no,event_code,event_name,category,age_group,round,date,time
  entries.csv : race_no,lane,crew_name,affiliation

  ※ ヘッダー行は大文字小文字を無視してマッチ。
  ※ BOM付きUTF-8（Excel出力）にも対応。

出力フォーマット (data/master.json):
  {
    "tournament": { "name": "...", "dates": [...], "venue": "...", "youtube_url": "..." },
    "races": [
      {
        "race_no": 1,
        "event_code": "M1x",
        "event_name": "男子シングルスカル",
        "category": "一般",
        "age_group": "A",
        "round": "予選",
        "date": "2025-06-07",
        "time": "09:00",
        "entries": [
          { "lane": 1, "crew_name": "チーム名", "affiliation": "所属" }
        ]
      }
    ]
  }
"""

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

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

def log_info(msg: str)  -> None: print(f"{C.CYAN}[INFO]{C.RESET}  {msg}")
def log_ok(msg: str)    -> None: print(f"{C.GREEN}[OK]{C.RESET}    {msg}")
def log_warn(msg: str)  -> None: print(f"{C.YELLOW}[WARN]{C.RESET}  {msg}")
def log_error(msg: str) -> None: print(f"{C.RED}[ERROR]{C.RESET} {msg}", file=sys.stderr)
def log_debug(msg: str) -> None: print(f"{C.GRAY}[DEBUG]{C.RESET} {msg}")

# ---------------------------------------------------------------------------
# CSVユーティリティ
# ---------------------------------------------------------------------------

def read_csv_as_dicts(filepath: Path) -> List[Dict[str, str]]:
    """
    CSVファイルを読み込み、各行を {正規化カラム名: 値} の辞書リストで返す。
    正規化: strip() + lower()。BOM付きUTF-8に対応。
    # で始まる行はコメントとして読み飛ばす。
    """
    rows = []
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        # # で始まる行はコメントとしてスキップするため、先にフィルタリング
        lines = [line for line in f if not line.lstrip().startswith("#")]

    import io
    reader = csv.DictReader(io.StringIO("".join(lines)))
    if reader.fieldnames is None:
        log_warn(f"ヘッダーが読み取れません: {filepath}")
        return rows
    # ヘッダーを正規化したキーに変換するマッピング
    normalized = {h: h.strip().lower() for h in reader.fieldnames}
    for row in reader:
        if not any(v.strip() for v in row.values()):
            continue  # 空行スキップ
        # # で始まる行はコメントとしてスキップ
        first_val = next(iter(row.values()), "")
        if first_val.strip().startswith("#"):
            continue
        rows.append({normalized[k]: v.strip() for k, v in row.items() if k in normalized})
    return rows

def require_col(row: dict, col: str, filepath: Path, lineno: int) -> Optional[str]:
    """
    辞書から必須カラム値を取得。存在しない場合は警告を出し None を返す。
    """
    val = row.get(col)
    if val is None:
        log_warn(f"カラム '{col}' が見つかりません ({filepath.name} 行{lineno})")
    return val

# ---------------------------------------------------------------------------
# スケジュール CSV パース
# 期待カラム: race_no, event_code, event_name, category, age_group, round, date, time
# ---------------------------------------------------------------------------

def parse_schedule(filepath: Path) -> List[dict]:
    """
    schedule.csv を読み込み、レース情報のリストを返す。
    キー: race_no(int), event_code, event_name, category, age_group, round, date, time
    """
    raw = read_csv_as_dicts(filepath)
    races = []
    for i, row in enumerate(raw, start=2):  # 行番号はヘッダー=1 の次から
        race_no_str = row.get("race_no", "").strip()
        if not race_no_str:
            log_debug(f"  行{i}: race_no が空 → スキップ")
            continue
        try:
            race_no = int(race_no_str)
        except ValueError:
            log_warn(f"  行{i}: race_no が整数ではありません: {race_no_str!r}")
            continue

        races.append({
            "race_no":    race_no,
            "event_code": row.get("event_code", ""),
            "event_name": row.get("event_name", ""),
            "category":   row.get("category",   ""),
            "age_group":  row.get("age_group",  ""),
            "round":      row.get("round",       ""),
            "date":       row.get("date",        ""),
            "time":       row.get("time",        ""),
            "entries":    [],  # 後でエントリーを追加
        })

    log_info(f"スケジュール: {len(races)} レース読み込み ({filepath.name})")
    return races

# ---------------------------------------------------------------------------
# エントリー CSV パース
# 期待カラム: race_no, lane, crew_name, affiliation
# ---------------------------------------------------------------------------

def parse_entries(filepath: Path) -> Dict[int, List[dict]]:
    """
    entries.csv を読み込み、{race_no: [エントリー, ...]} の辞書を返す。
    各エントリー: {lane: int, crew_name: str, affiliation: str}
    """
    raw = read_csv_as_dicts(filepath)
    entries: Dict[int, List[dict]] = {}

    for i, row in enumerate(raw, start=2):
        race_no_str = row.get("race_no", "").strip()
        lane_str    = row.get("lane",    "").strip()

        if not race_no_str or not lane_str:
            log_debug(f"  行{i}: race_no または lane が空 → スキップ")
            continue

        try:
            race_no = int(race_no_str)
            lane    = int(lane_str)
        except ValueError:
            log_warn(f"  行{i}: race_no/lane が整数ではありません: {race_no_str!r}, {lane_str!r}")
            continue

        entries.setdefault(race_no, []).append({
            "lane":        lane,
            "crew_name":   row.get("crew_name",   ""),
            "affiliation": row.get("affiliation", ""),
        })

    total = sum(len(v) for v in entries.values())
    log_info(f"エントリー: {total} 件 / {len(entries)} レース ({filepath.name})")
    return entries

# ---------------------------------------------------------------------------
# master.json 構築
# ---------------------------------------------------------------------------

def build_master_json(
    tournament_name: str,
    dates: List[str],
    venue: str,
    youtube_url: str,
    races: List[dict],
    entries: Dict[int, List[dict]],
    measurement_points: Optional[List[str]] = None,
) -> dict:
    """
    スケジュール・エントリー情報を統合して master.json 用辞書を構築する。
    measurement_points が None の場合はデフォルト ["500m", "1000m"] を使用する。
    """
    if measurement_points is None:
        measurement_points = ["500m", "1000m"]

    # エントリーをスケジュールにマージ
    for race in races:
        race_no = race["race_no"]
        race_entries = entries.get(race_no, [])
        # レーン番号順にソート
        race["entries"] = sorted(race_entries, key=lambda e: e["lane"])

    # race_no 順にソート
    sorted_races = sorted(races, key=lambda r: r["race_no"])

    return {
        "tournament": {
            "name":        tournament_name,
            "dates":       dates,
            "venue":       venue,
            "youtube_url": youtube_url,
        },
        "measurement_points": measurement_points,
        "schedule": sorted_races,
    }

# ---------------------------------------------------------------------------
# メイン処理
# ---------------------------------------------------------------------------

def run(args: argparse.Namespace) -> int:
    print(f"\n{C.BOLD}{C.CYAN}{'='*60}{C.RESET}")
    print(f"{C.BOLD}{C.CYAN}  generate_master — CSV → master.json{C.RESET}")
    print(f"{'='*60}{C.RESET}\n")

    schedule_path = Path(args.schedule).resolve()
    entries_path  = Path(args.entries).resolve()
    output_path   = Path(args.output).resolve()

    # ---- 入力ファイル確認 --------------------------------------------------
    for p in [schedule_path, entries_path]:
        if not p.is_file():
            log_error(f"ファイルが存在しません: {p}")
            return 1

    log_info(f"スケジュール CSV : {schedule_path}")
    log_info(f"エントリー CSV   : {entries_path}")
    log_info(f"出力先           : {output_path}")
    log_info(f"大会名           : {args.tournament}")
    log_info(f"開催日           : {args.dates}")
    log_info(f"会場             : {args.venue}")
    log_info(f"計測ポイント     : {args.points}")
    print()

    # ---- 上書き確認 --------------------------------------------------------
    if output_path.exists() and not args.yes:
        answer = input(f"{C.YELLOW}[WARN]{C.RESET}  {output_path} は既に存在します。上書きしますか？ [y/N]: ")
        if answer.strip().lower() not in ("y", "yes"):
            log_warn("キャンセルしました")
            return 0

    # ---- パース ------------------------------------------------------------
    races   = parse_schedule(schedule_path)
    entries = parse_entries(entries_path)

    if not races:
        log_warn("スケジュールデータが空です")
        return 0

    # エントリーが紐付かないレースの確認
    no_entry_races = [r["race_no"] for r in races if r["race_no"] not in entries]
    if no_entry_races:
        log_warn(f"エントリーなしのレース: {no_entry_races}")

    # ---- master.json 構築 --------------------------------------------------
    dates_list  = [d.strip() for d in args.dates.split(",")  if d.strip()]
    points_list = [p.strip() for p in args.points.split(",") if p.strip()] or None
    master = build_master_json(
        tournament_name     = args.tournament,
        dates               = dates_list,
        venue               = args.venue,
        youtube_url         = args.youtube,
        races               = races,
        entries             = entries,
        measurement_points  = points_list,
    )

    # ---- 出力 --------------------------------------------------------------
    output_path.parent.mkdir(parents=True, exist_ok=True)
    json_str = json.dumps(master, ensure_ascii=False, indent=2) + "\n"
    output_path.write_text(json_str, encoding="utf-8")

    total_entries = sum(len(r["entries"]) for r in master["schedule"])
    print()
    log_ok(f"master.json を出力しました: {output_path}")
    log_info(f"  レース数    : {len(master['schedule'])}")
    log_info(f"  エントリー数: {total_entries}")
    print()
    return 0

# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="schedule.csv + entries.csv → data/master.json 変換ツール",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--schedule",
        required=True,
        metavar="CSV",
        help="スケジュールCSVファイルのパス",
    )
    parser.add_argument(
        "--entries",
        required=True,
        metavar="CSV",
        help="エントリーCSVファイルのパス",
    )
    parser.add_argument(
        "--output",
        default="data/master.json",
        metavar="JSON",
        help="出力先JSONファイルのパス（デフォルト: data/master.json）",
    )
    parser.add_argument(
        "--tournament",
        default="",
        metavar="NAME",
        help="大会名",
    )
    parser.add_argument(
        "--dates",
        default="",
        metavar="DATES",
        help="開催日（カンマ区切り。例: 2025-06-07,2025-06-08）",
    )
    parser.add_argument(
        "--venue",
        default="",
        metavar="VENUE",
        help="開催会場",
    )
    parser.add_argument(
        "--points",
        default="500m,1000m",
        metavar="POINTS",
        help="計測ポイント（カンマ区切り。例: 500m,1000m）",
    )
    parser.add_argument(
        "--youtube",
        default="",
        metavar="URL",
        help="YouTube Live URL（なければ空文字）",
    )
    parser.add_argument(
        "-y", "--yes",
        action="store_true",
        help="出力ファイルが既存でも確認なしに上書きする",
    )
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(run(parse_args()))
