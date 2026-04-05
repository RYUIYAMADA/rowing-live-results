#!/usr/bin/env python3
"""
E2Eテスト — CSV → JSON パイプラインの全工程を検証する自動テストスクリプト

テストCSVから race_XXX.json を生成し、スキーマ・ランキング・同着・
タイムフォーマット・master.json・splitTime の各項目を検証する。

使い方:
  python3 test/e2e_test.py                # 全テスト実行
  python3 test/e2e_test.py --verbose      # 詳細出力
  python3 test/e2e_test.py --skip-pipeline  # JSONのみ検証（CI用）
"""

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# プロジェクトルートを特定し、tools/ をパスに追加
TEST_DIR    = Path(__file__).resolve().parent
PROJECT_DIR = TEST_DIR.parent
TOOLS_DIR   = PROJECT_DIR / "tools"
sys.path.insert(0, str(TOOLS_DIR))

def _ms_to_fmt(ms: int) -> str:
    """ミリ秒 → M:SS.cc 形式（pipeline モジュール不要のスタンドアロン版）。"""
    cs = ms // 10
    return f"{cs // 6000}:{(cs % 6000) // 100:02d}.{cs % 100:02d}"

# --skip-pipeline 時は simulate_pipeline のインポートを遅延させる
# （GitHub Actions 環境では依存ライブラリが不要）
_pipeline_loaded = False
pipeline = None

def _load_pipeline():
    """simulate_pipeline を遅延インポートする。"""
    global pipeline, _pipeline_loaded
    if not _pipeline_loaded:
        import simulate_pipeline as _p
        pipeline = _p
        _pipeline_loaded = True

# ---------------------------------------------------------------------------
# ANSIカラー定義
# ---------------------------------------------------------------------------
class C:
    RESET  = "\033[0m"
    BOLD   = "\033[1m"
    GREEN  = "\033[32m"
    RED    = "\033[31m"
    YELLOW = "\033[33m"
    CYAN   = "\033[36m"
    GRAY   = "\033[90m"


# ---------------------------------------------------------------------------
# テスト定数
# ---------------------------------------------------------------------------

# プロジェクトルートディレクトリ
ROOT_DIR = PROJECT_DIR

# テスト用CSVディレクトリ
CSV_DIR = TEST_DIR / "csv"

# テスト対象レース（CSV に存在するレース番号）
TEST_RACES = [1, 2, 3]

# 計測ポイント
MEASUREMENT_POINTS = ["500m", "1000m"]

# master.json パス
MASTER_JSON_PATH = PROJECT_DIR / "data" / "master.json"

# タイムフォーマット正規表現: M:SS.cc（2桁センチ秒）
TIME_FORMAT_RE = re.compile(r"^\d+:\d{2}\.\d{2}$")

# splitTimeフォーマット正規表現: (M:SS.cc)
SPLIT_FORMAT_RE = re.compile(r"^\(\d+:\d{2}\.\d{2}\)$")

# ---------------------------------------------------------------------------
# テスト結果管理
# ---------------------------------------------------------------------------

class TestResult:
    """テスト結果を集約するクラス。"""

    def __init__(self):
        self.passed: list = []   # 成功したテスト名
        self.failed: list = []   # 失敗したテスト名と理由

    def ok(self, name: str, detail: str = "") -> None:
        """テスト成功を記録し、出力する。"""
        label = f"{C.GREEN}[PASS]{C.RESET}"
        msg   = f"{label} {name}"
        if detail:
            msg += f": {C.GRAY}{detail}{C.RESET}"
        print(msg)
        self.passed.append(name)

    def fail(self, name: str, reason: str = "") -> None:
        """テスト失敗を記録し、出力する。"""
        label = f"{C.RED}[FAIL]{C.RESET}"
        msg   = f"{label} {name}"
        if reason:
            msg += f": {C.RED}{reason}{C.RESET}"
        print(msg)
        self.failed.append((name, reason))

    @property
    def total(self) -> int:
        return len(self.passed) + len(self.failed)

    @property
    def pass_count(self) -> int:
        return len(self.passed)

    @property
    def all_passed(self) -> bool:
        return len(self.failed) == 0


# ---------------------------------------------------------------------------
# ヘルパー関数
# ---------------------------------------------------------------------------

def build_race_json_for_test(
    race_no: int,
    csv_dir: Path,
    measurement_points: list,
) -> Optional[dict]:
    """
    指定レース番号のCSVを読み込んでrace_XXX.json dictを生成して返す。
    CSVが揃っていない場合はNoneを返す。
    """
    _load_pipeline()
    race_files = pipeline.collect_csv_files(csv_dir, {race_no})
    if race_no not in race_files:
        return None

    found_points = race_files[race_no]
    missing = [p for p in measurement_points if p not in found_points]
    if missing:
        return None

    point_records = {}
    for pt in measurement_points:
        records = pipeline.parse_csv(found_points[pt])
        if not records:
            return None
        point_records[pt] = records

    return pipeline.build_race_json(race_no, point_records, measurement_points)


# ---------------------------------------------------------------------------
# 個別テスト関数
# ---------------------------------------------------------------------------

def test_pipeline(result: TestResult, verbose: bool) -> dict:
    """
    テスト1: パイプラインテスト
    テストCSVを処理して race_XXX.json が生成できるか確認する。
    生成されたJSONのdictを返す（後続テストで再利用）。
    """
    generated: Dict[int, dict] = {}
    for race_no in TEST_RACES:
        race_json = build_race_json_for_test(race_no, CSV_DIR, MEASUREMENT_POINTS)
        if race_json is None:
            result.fail(
                f"パイプライン: Race {race_no}",
                "CSVが見つからないか処理に失敗しました",
            )
        else:
            generated[race_no] = race_json
            entry_count = len(race_json.get("results", []))
            result.ok(
                f"パイプライン: Race {race_no} 生成成功",
                f"{entry_count}艇",
            )
            if verbose:
                for r in race_json["results"]:
                    finish_fmt = r.get("finish", {}).get("formatted", "---")
                    print(
                        f"  {C.GRAY}  {r['rank']:2d}位  レーン{r['lane']}  "
                        f"{finish_fmt}  {r.get('split','')}{C.RESET}"
                    )
    return generated


def test_schema(result: TestResult, generated: dict, verbose: bool) -> None:
    """
    テスト2: JSONスキーマ検証
    生成されたJSONが必須フィールドを持つか確認する。
    - トップレベル: race_no, updated_at, results[]
    - 各result: lane, rank, times, finish, split
    """
    top_required    = ["race_no", "updated_at", "results"]
    result_required = ["lane", "rank", "times", "finish", "split"]

    for race_no, race_json in generated.items():
        filename = f"race_{race_no:03d}.json"

        # トップレベルフィールド
        missing_top = [k for k in top_required if k not in race_json]
        if missing_top:
            result.fail(
                f"スキーマ: {filename}",
                f"トップレベルに必須フィールドなし: {missing_top}",
            )
            continue

        if not isinstance(race_json["results"], list):
            result.fail(f"スキーマ: {filename}", "results がリストではありません")
            continue

        # 各resultのフィールド
        missing_in_result = []
        for idx, r in enumerate(race_json["results"]):
            for k in result_required:
                if k not in r:
                    missing_in_result.append(f"results[{idx}].{k}")

        if missing_in_result:
            result.fail(
                f"スキーマ: {filename}",
                f"必須フィールドなし: {missing_in_result[:3]}{'...' if len(missing_in_result) > 3 else ''}",
            )
        else:
            result.ok(f"スキーマ: {filename} 全フィールド存在")
            if verbose:
                print(f"  {C.GRAY}  確認フィールド: {top_required + result_required}{C.RESET}")


def test_ranking(result: TestResult, generated: dict, verbose: bool) -> None:
    """
    テスト3: ランキング検証
    rank=1 の艇が最短フィニッシュタイムを持つか確認する。
    """
    finish_point = MEASUREMENT_POINTS[-1]

    for race_no, race_json in generated.items():
        results = race_json.get("results", [])
        if not results:
            result.fail(f"ランキング: Race {race_no}", "resultsが空です")
            continue

        # rank=1 の艇を収集
        rank1_boats = [r for r in results if r.get("rank") == 1]
        if not rank1_boats:
            result.fail(f"ランキング: Race {race_no}", "rank=1 の艇が存在しません")
            continue

        # フィニッシュタイム（time_ms）で最短を確認
        finish_times = []
        for r in results:
            t = r.get("finish", {}).get("time_ms")
            if t is not None:
                finish_times.append(t)

        if not finish_times:
            result.fail(f"ランキング: Race {race_no}", "フィニッシュタイムが取得できません")
            continue

        min_time = min(finish_times)

        # rank=1 の全艇が最短タイムと一致するか（同着考慮）
        rank1_times = [r.get("finish", {}).get("time_ms") for r in rank1_boats]
        if all(t == min_time for t in rank1_times):
            result.ok(
                f"ランキング: Race {race_no} 順位が正しい",
                f"1位={_ms_to_fmt(min_time)}",
            )
        else:
            result.fail(
                f"ランキング: Race {race_no}",
                f"rank=1の艇が最短タイムを持っていません "
                f"(rank1={rank1_times}, min={min_time})",
            )
            if verbose:
                for r in results:
                    print(
                        f"  {C.GRAY}  rank={r['rank']}  "
                        f"lane={r['lane']}  "
                        f"finish_ms={r.get('finish',{}).get('time_ms')}{C.RESET}"
                    )


def test_tie(result: TestResult, generated: dict, verbose: bool) -> None:
    """
    テスト4: 同着検証
    Race3で tie_group が同じ艇が同じ rank になっているか確認する。
    """
    # Race3 に同着データが含まれている前提
    race_no = 3
    if race_no not in generated:
        result.fail(f"同着: Race {race_no}", "Race3のデータが生成されていません")
        return

    results = generated[race_no].get("results", [])

    # tie_group ごとにグルーピング
    tie_groups: dict = {}
    for r in results:
        tg = r.get("tie_group", "")
        if tg:
            tie_groups.setdefault(tg, []).append(r)

    if not tie_groups:
        # tie_groupが存在しない場合：同着CSVが意図通り機能していない
        result.fail(
            f"同着: Race {race_no}",
            "tie_group を持つ艇が存在しません（CSVに tie_group データが必要）",
        )
        return

    all_ok = True
    for tg, boats in tie_groups.items():
        ranks = [b["rank"] for b in boats]
        if len(set(ranks)) == 1:
            result.ok(
                f"同着: Race {race_no} tie_group={tg} は同順位",
                f"rank={ranks[0]}, 艇数={len(boats)}",
            )
            if verbose:
                for b in boats:
                    print(
                        f"  {C.GRAY}  lane={b['lane']}  rank={b['rank']}  "
                        f"tie_group={b['tie_group']}{C.RESET}"
                    )
        else:
            result.fail(
                f"同着: Race {race_no} tie_group={tg}",
                f"同着グループの順位が不一致: {ranks}",
            )
            all_ok = False


def test_time_format(result: TestResult, generated: dict, verbose: bool) -> None:
    """
    テスト5: タイムフォーマット検証
    全タイムの formatted フィールドが M:SS.cc 形式（センチ秒2桁）であるか確認する。
    """
    invalid_list = []

    for race_no, race_json in generated.items():
        for r in race_json.get("results", []):
            for point, time_data in r.get("times", {}).items():
                fmt = time_data.get("formatted", "")
                if not TIME_FORMAT_RE.match(fmt):
                    invalid_list.append(
                        f"Race{race_no} lane={r['lane']} {point}: {fmt!r}"
                    )

    if invalid_list:
        result.fail(
            "フォーマット: タイムが M:SS.cc 形式ではない",
            ", ".join(invalid_list[:3]) + ("..." if len(invalid_list) > 3 else ""),
        )
    else:
        total = sum(
            len(r.get("times", {}))
            for rj in generated.values()
            for r in rj.get("results", [])
        )
        result.ok(
            "フォーマット: 全タイムが M:SS.cc 形式",
            f"{total}件のタイムを検証",
        )
        if verbose:
            print(f"  {C.GRAY}  パターン: M:SS.cc（分:秒.センチ秒2桁）{C.RESET}")


def test_master_json(result: TestResult, verbose: bool) -> None:
    """
    テスト6: master.json 検証
    必須キー (schedule, measurement_points, tournament) が存在するか確認する。
    """
    required_keys = ["schedule", "measurement_points", "tournament"]

    if not MASTER_JSON_PATH.exists():
        result.fail("master.json", f"ファイルが存在しません: {MASTER_JSON_PATH}")
        return

    try:
        with open(MASTER_JSON_PATH, encoding="utf-8") as f:
            master = json.load(f)
    except json.JSONDecodeError as e:
        result.fail("master.json", f"JSONパースエラー: {e}")
        return

    missing = [k for k in required_keys if k not in master]
    if missing:
        for k in missing:
            result.fail(f"master.json: {k} が Missing")
    else:
        race_count  = len(master.get("schedule", []))
        entry_count = sum(
            len(race.get("entries", []))
            for race in master.get("schedule", [])
        )
        result.ok(
            "master.json: 全必須キー存在",
            f"{race_count}レース, {entry_count}エントリー",
        )
        if verbose:
            pts = master.get("measurement_points", [])
            print(f"  {C.GRAY}  計測ポイント: {pts}{C.RESET}")
            print(
                f"  {C.GRAY}  大会名: {master.get('tournament', {}).get('name', '')}{C.RESET}"
            )


def test_html_structure(result: TestResult, verbose: bool) -> None:
    """
    テスト8: フロントエンド HTML構造検証
    index.html の構造が正しいか検証する。
    - 必須IDが存在するか: tournament-name, view-toggle, view-table, view-schedule 等
    - 必須スクリプトが読み込まれているか: js/app.js
    - 必須CSSが読み込まれているか: css/style.css
    """
    html_path = ROOT_DIR / "index.html"

    if not html_path.exists():
        result.fail("HTML構造: index.html", f"ファイルが存在しません: {html_path}")
        return

    content = html_path.read_text(encoding="utf-8")

    required_ids = [
        "tournament-name",
        "view-toggle",
        "view-table",
        "view-schedule",
        "filter-cat",
        "filter-round",
        "filter-day",
        "last-updated",
    ]
    required_scripts = ["js/app.js"]
    required_css     = ["css/style.css"]

    # 必須IDの存在確認
    missing_ids = [id_ for id_ in required_ids if f'id="{id_}"' not in content]
    if missing_ids:
        result.fail(
            "HTML構造: 必須IDが見つかりません",
            f"不足: {missing_ids}",
        )
    else:
        result.ok(
            "HTML構造: 全必須IDが存在",
            f"{len(required_ids)}件確認",
        )
        if verbose:
            for id_ in required_ids:
                print(f"  {C.GRAY}  id=\"{id_}\" ... OK{C.RESET}")

    # 必須スクリプトの存在確認
    missing_scripts = [s for s in required_scripts if s not in content]
    if missing_scripts:
        result.fail(
            "HTML構造: 必須スクリプトが見つかりません",
            f"不足: {missing_scripts}",
        )
    else:
        result.ok(
            "HTML構造: 必須スクリプトが読み込まれている",
            f"{', '.join(required_scripts)}",
        )

    # 必須CSSの存在確認
    missing_css = [c for c in required_css if c not in content]
    if missing_css:
        result.fail(
            "HTML構造: 必須CSSが見つかりません",
            f"不足: {missing_css}",
        )
    else:
        result.ok(
            "HTML構造: 必須CSSが読み込まれている",
            f"{', '.join(required_css)}",
        )


def test_split_format(result: TestResult, generated: dict, verbose: bool) -> None:
    """
    テスト7: splitTime フォーマット検証
    split フィールドが空文字または (M:SS.cc) 形式であるか確認する。
    """
    invalid_list = []
    valid_count  = 0

    for race_no, race_json in generated.items():
        for r in race_json.get("results", []):
            split = r.get("split", "")
            if split == "":
                # splitなし（計測ポイントが1つの場合）は正常
                continue
            if SPLIT_FORMAT_RE.match(split):
                valid_count += 1
            else:
                invalid_list.append(
                    f"Race{race_no} lane={r['lane']}: {split!r}"
                )

    if invalid_list:
        result.fail(
            "splitTime: (M:SS.cc) 形式ではない",
            ", ".join(invalid_list[:3]) + ("..." if len(invalid_list) > 3 else ""),
        )
    else:
        result.ok(
            f"splitTime: 全splitが (M:SS.cc) 形式",
            f"{valid_count}件のsplitを検証",
        )
        if verbose:
            print(f"  {C.GRAY}  パターン: (M:SS.cc)（括弧付き）{C.RESET}")


# ---------------------------------------------------------------------------
# メイン処理
# ---------------------------------------------------------------------------

def load_existing_jsons(result: TestResult, verbose: bool) -> dict:
    """
    --skip-pipeline 用: data/results/*.json を読み込んで generated dict を返す。
    1件も存在しない場合は空dictを返す。
    """
    results_dir = PROJECT_DIR / "data" / "results"
    generated: Dict[int, dict] = {}

    json_files = sorted(results_dir.glob("race_*.json")) if results_dir.exists() else []

    if not json_files:
        print(
            f"{C.YELLOW}[SKIP]{C.RESET} data/results/*.json が存在しないため"
            "スキーマ検証をスキップします"
        )
        return generated

    for json_path in json_files:
        try:
            with open(json_path, encoding="utf-8") as f:
                race_json = json.load(f)
            race_no = race_json.get("race_no", 0)
            generated[race_no] = race_json
            if verbose:
                print(f"  {C.GRAY}  読み込み: {json_path.name}{C.RESET}")
        except (json.JSONDecodeError, KeyError) as e:
            result.fail(f"JSON読み込み: {json_path.name}", str(e))

    entry_count = len(generated)
    if entry_count > 0:
        print(
            f"{C.CYAN}[INFO]{C.RESET} {entry_count}件の race JSON を検証対象にします"
        )

    return generated


def run(args: argparse.Namespace) -> int:
    """
    全テストを実行し、失敗があれば exit code 1 を返す。
    """
    verbose      = args.verbose
    skip_pipeline = getattr(args, "skip_pipeline", False)

    # ヘッダー出力
    print(f"\n{'='*40}")
    if skip_pipeline:
        print(f"  E2E テスト（--skip-pipeline モード）")
    else:
        print(f"  E2E テスト")
    print(f"{'='*40}")

    result = TestResult()

    if skip_pipeline:
        # --skip-pipeline: テスト1〜3（CSV生成・同着）をスキップし、
        # 既存JSONを対象にスキーマ・ランキング・フォーマット検証のみ実行
        generated = load_existing_jsons(result, verbose)
    else:
        # テスト1: パイプライン（生成されたJSONを後続テストに渡す）
        generated = test_pipeline(result, verbose)

        # テスト4: 同着検証（パイプライン実行時のみ）
        test_tie(result, generated, verbose)

    # テスト2: スキーマ検証
    test_schema(result, generated, verbose)

    # テスト3: ランキング検証
    test_ranking(result, generated, verbose)

    # テスト5: タイムフォーマット検証
    test_time_format(result, generated, verbose)

    # テスト6: master.json 検証
    test_master_json(result, verbose)

    # テスト7: splitTime フォーマット検証
    test_split_format(result, generated, verbose)

    # テスト8: フロントエンドHTML構造検証
    test_html_structure(result, verbose)

    # フッター出力
    print(f"{'='*40}")
    pass_str = f"{C.GREEN}{result.pass_count}{C.RESET}"
    total_str = f"{result.total}"
    if result.all_passed:
        status = f"{C.GREEN}{C.BOLD}全テスト PASS{C.RESET}"
    else:
        fail_count = len(result.failed)
        status = f"{C.RED}{C.BOLD}{fail_count}件 FAIL{C.RESET}"
    print(f"  結果: {pass_str}/{total_str} PASS  {status}")
    print(f"{'='*40}\n")

    return 0 if result.all_passed else 1


# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="E2Eテスト — CSV→JSONパイプラインの全工程を検証する",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="詳細出力（各テストの内訳を表示）",
    )
    parser.add_argument(
        "--skip-pipeline",
        action="store_true",
        dest="skip_pipeline",
        help=(
            "CSV→JSON変換（テスト1〜3）をスキップし、"
            "data/results/*.json を対象にスキーマ・ランキング・"
            "フォーマット検証のみ実行する（CI/CD用）"
        ),
    )
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(run(parse_args()))
