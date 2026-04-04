#!/usr/bin/env python3
"""
新大会セットアップツール — 大会ごとに使い回せる対話式セットアップスクリプト

使い方:
  python3 tools/init_tournament.py

実行すると対話式で大会情報を入力し、以下を生成する:
  - data/master.json          : tournament情報のみ（scheduleは空配列）
  - master/schedule_template.csv : スケジュール入力用テンプレート
  - master/entries_template.csv  : エントリー入力用テンプレート
"""

import json
import os
import shutil
import sys
from pathlib import Path

# プロジェクトルートを特定
TOOLS_DIR   = Path(__file__).resolve().parent
PROJECT_DIR = TOOLS_DIR.parent

# 出力先パス
MASTER_JSON_PATH       = PROJECT_DIR / "data"   / "master.json"
MASTER_DIR             = PROJECT_DIR / "master"
SCHEDULE_TEMPLATE_PATH = MASTER_DIR  / "schedule_template.csv"
ENTRIES_TEMPLATE_PATH  = MASTER_DIR  / "entries_template.csv"

# テンプレートCSVコピー元（tools/ 直下にサンプルがある場合はそちらを優先）
SCHEDULE_SAMPLE = PROJECT_DIR / "test" / "csv" / "schedule_sample.csv"
ENTRIES_SAMPLE  = PROJECT_DIR / "test" / "csv" / "entries_sample.csv"

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


def prompt(label: str, default: str) -> str:
    """
    ユーザーに入力を促し、Enterのみで default を返す。
    """
    display_default = f" [{default}]" if default else ""
    try:
        value = input(f"{label}{display_default}: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)
    return value if value else default


def confirm(label: str, default_yes: bool = True) -> bool:
    """
    Y/n または y/N で確認。
    default_yes=True のとき Enter → Yes。
    """
    hint = "[Y/n]" if default_yes else "[y/N]"
    try:
        answer = input(f"{label} {hint}: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)
    if answer == "":
        return default_yes
    return answer in ("y", "yes")


def write_master_json(
    name: str,
    dates: list[str],
    venue: str,
    course_length: int,
    measurement_points: list[str],
    youtube_url: str,
) -> None:
    """
    tournament 情報のみ書き込んだ master.json を生成する。
    schedule は空配列で初期化する。
    """
    master = {
        "tournament": {
            "name":          name,
            "dates":         dates,
            "venue":         venue,
            "course_length": course_length,
            "youtube_url":   youtube_url,
        },
        "measurement_points": measurement_points,
        "schedule": [],
    }
    MASTER_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    json_str = json.dumps(master, ensure_ascii=False, indent=2) + "\n"
    MASTER_JSON_PATH.write_text(json_str, encoding="utf-8")
    print(f"  {C.GREEN}→ {MASTER_JSON_PATH.relative_to(PROJECT_DIR)} を生成しました{C.RESET}")


def write_schedule_template() -> None:
    """
    スケジュール入力用テンプレートCSVを master/ フォルダに出力する。
    test/csv/schedule_sample.csv が存在する場合はコメントヘッダーを付けてコピーする。
    """
    MASTER_DIR.mkdir(parents=True, exist_ok=True)

    comment_header = (
        "# レーススケジュール テンプレート\n"
        "# 列の説明:\n"
        "#   race_no   : レース番号（RowingTimerWebと一致させること）\n"
        "#   event_code: 種目コード（例: M_1X, W_2X, X_4+）\n"
        "#   event_name: 種目名（表示用）\n"
        "#   category  : M（男子）/ W（女子）/ X（混成）\n"
        "#   age_group : 年齢区分（A〜H、J=ジュニア、O=オープン等）\n"
        "#   round     : FA（決勝A）/ FB（決勝B）/ SF（準決勝）/ H（予選）/ RK（順位決定）\n"
        "#   date      : 開催日（YYYY-MM-DD形式）\n"
        "#   time      : 発艇時刻（HH:MM形式）\n"
    )

    if SCHEDULE_SAMPLE.is_file():
        # サンプルCSVを読み込んでコメントヘッダーを付与して出力
        sample_body = SCHEDULE_SAMPLE.read_text(encoding="utf-8")
        SCHEDULE_TEMPLATE_PATH.write_text(comment_header + sample_body, encoding="utf-8")
    else:
        # サンプルがない場合は最小限のテンプレートを生成
        body = (
            "race_no,event_code,event_name,category,age_group,round,date,time\n"
            "1,M_1X,男子シングルスカル,M,G,FA,2025-06-07,07:00\n"
            "2,W_1X,女子シングルスカル,W,G,FA,2025-06-07,07:08\n"
        )
        SCHEDULE_TEMPLATE_PATH.write_text(comment_header + body, encoding="utf-8")

    print(f"  {C.GREEN}→ {SCHEDULE_TEMPLATE_PATH.relative_to(PROJECT_DIR)} を出力しました{C.RESET}")


def write_entries_template() -> None:
    """
    エントリー入力用テンプレートCSVを master/ フォルダに出力する。
    test/csv/entries_sample.csv が存在する場合はコメントヘッダーを付けてコピーする。
    """
    MASTER_DIR.mkdir(parents=True, exist_ok=True)

    comment_header = (
        "# エントリー情報 テンプレート\n"
        "# 列の説明:\n"
        "#   race_no    : race_no と一致させること\n"
        "#   lane       : レーン番号（1〜6程度）\n"
        "#   crew_name  : クルー名（シングル=選手名、ペア以上=「選手A / 選手B」形式）\n"
        "#   affiliation: 所属（チーム名・学校名等）\n"
    )

    if ENTRIES_SAMPLE.is_file():
        sample_body = ENTRIES_SAMPLE.read_text(encoding="utf-8")
        ENTRIES_TEMPLATE_PATH.write_text(comment_header + sample_body, encoding="utf-8")
    else:
        body = (
            "race_no,lane,crew_name,affiliation\n"
            "1,1,選手名A,所属クラブA\n"
            "1,2,選手名B,所属クラブB\n"
            "1,3,選手名C,所属クラブC\n"
            "2,1,選手名D,所属クラブA\n"
        )
        ENTRIES_TEMPLATE_PATH.write_text(comment_header + body, encoding="utf-8")

    print(f"  {C.GREEN}→ {ENTRIES_TEMPLATE_PATH.relative_to(PROJECT_DIR)} を出力しました{C.RESET}")


def show_next_steps() -> None:
    """セットアップ完了後の次のステップを表示する。"""
    print(f"\n{C.BOLD}{C.GREEN}=== セットアップ完了 ==={C.RESET}")
    print()
    print("次のステップ:")
    print("1. 以下のファイルを編集してエントリーを入力してください:")
    print(f"   {C.CYAN}master/schedule_template.csv{C.RESET}  ← レーススケジュール")
    print(f"   {C.CYAN}master/entries_template.csv{C.RESET}   ← エントリー情報")
    print()
    print("2. 入力後、以下のコマンドで master.json を生成:")
    print(f"   {C.YELLOW}python3 tools/generate_master.py \\")
    print(f"     --schedule master/schedule_template.csv \\")
    print(f"     --entries  master/entries_template.csv  \\")
    print(f"     --output   data/master.json -y{C.RESET}")
    print()
    print("3. または Google Drive にアップして GAS の importMasterData() を実行")
    print()
    print("4. 確認:")
    print(f"   {C.YELLOW}python3 tools/check_status.py{C.RESET}")
    print()


def main() -> int:
    print(f"\n{C.BOLD}{C.CYAN}=== 新大会セットアップ ==={C.RESET}\n")

    # ---- 大会情報の入力 --------------------------------------------------------
    name             = prompt("大会名",               "第16回全日本マスターズレガッタ")
    dates_str        = prompt("開催日（カンマ区切り）", "2025-06-07,2025-06-08")
    venue            = prompt("会場",                 "長野・下諏訪ボートコース 1000m")
    course_len_str   = prompt("コース距離（m）",       "1000")
    points_str       = prompt("計測ポイント（カンマ区切り）", "500m,1000m")
    youtube_url      = prompt("YouTube Live URL（なければ空欄）", "")

    # 入力値のパース
    dates              = [d.strip() for d in dates_str.split(",")  if d.strip()]
    measurement_points = [p.strip() for p in points_str.split(",") if p.strip()]
    try:
        course_length = int(course_len_str.strip())
    except ValueError:
        print(f"{C.RED}[ERROR]{C.RESET} コース距離は整数で入力してください: {course_len_str!r}")
        return 1

    print()

    # ---- master.json 生成確認 ---------------------------------------------------
    do_master = confirm("→ data/master.json を生成しますか？", default_yes=True)

    # ---- テンプレートCSVコピー確認 ---------------------------------------------
    do_template = confirm("→ テンプレートCSVをコピーしますか？", default_yes=True)

    print()

    # ---- 処理実行 ---------------------------------------------------------------
    if do_master:
        write_master_json(
            name               = name,
            dates              = dates,
            venue              = venue,
            course_length      = course_length,
            measurement_points = measurement_points,
            youtube_url        = youtube_url,
        )

    if do_template:
        write_schedule_template()
        write_entries_template()

    # ---- 次のステップ表示 -------------------------------------------------------
    show_next_steps()
    return 0


if __name__ == "__main__":
    sys.exit(main())
