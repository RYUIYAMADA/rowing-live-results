#!/usr/bin/env python3
"""
当日運用状態確認ツール — 大会当日のシステム稼働状況をチェックする

ローカルファイル・GitHub・公開サイトの状態を確認し、
異常があれば赤字で通知する。

使い方:
  python3 tools/check_status.py                       # ローカルチェックのみ
  python3 tools/check_status.py --github              # GitHubの最新コミットも確認
  python3 tools/check_status.py --github --token ghp_xxx
  python3 tools/check_status.py --site https://your-site.pages.dev  # サイトも確認
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Tuple

# プロジェクトルート
TOOLS_DIR   = Path(__file__).resolve().parent
PROJECT_DIR = TOOLS_DIR.parent

# ---------------------------------------------------------------------------
# 定数
# ---------------------------------------------------------------------------

# master.json パス
MASTER_JSON_PATH = PROJECT_DIR / "data" / "master.json"

# レース結果ディレクトリ
RESULTS_DIR = PROJECT_DIR / "data" / "results"

# 「最近の更新」とみなす閾値（分）
RECENT_THRESHOLD_MINUTES = 30

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


def log_ok(msg: str) -> None:
    print(f"{C.GREEN}[OK]{C.RESET}    {msg}")


def log_warn(msg: str) -> None:
    print(f"{C.YELLOW}[WARN]{C.RESET}  {msg}")


def log_fail(msg: str) -> None:
    print(f"{C.RED}[FAIL]{C.RESET}  {C.RED}{msg}{C.RESET}")


def log_info(msg: str) -> None:
    print(f"{C.CYAN}[INFO]{C.RESET}  {msg}")


def log_sub(msg: str) -> None:
    """インデント付きサブ情報の出力。"""
    print(f"  {C.GRAY}{msg}{C.RESET}")


# ---------------------------------------------------------------------------
# 経過時間の人間向けフォーマット
# ---------------------------------------------------------------------------

def elapsed_str(dt: datetime) -> str:
    """
    datetime から現在時刻までの経過時間を人間向け文字列で返す。
    例: '2分前', '1時間前', '3日前'
    datetime は UTC または tzinfo 付きを渡すこと。
    """
    now     = datetime.now(timezone.utc)
    # tzinfo がない場合は UTC とみなす
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta   = now - dt
    seconds = int(delta.total_seconds())

    if seconds < 0:
        return "未来"
    if seconds < 60:
        return f"{seconds}秒前"
    if seconds < 3600:
        minutes = seconds // 60
        return f"{minutes}分前"
    if seconds < 86400:
        hours = seconds // 3600
        return f"{hours}時間前"
    days = seconds // 86400
    return f"{days}日前"


def elapsed_minutes(dt: datetime) -> float:
    """datetime から現在までの経過時間を分で返す。"""
    now = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (now - dt).total_seconds() / 60


# ---------------------------------------------------------------------------
# エントリー整合性チェック（master.json の schedule を検査）
# ---------------------------------------------------------------------------

# エントリー件数が少ないと警告する閾値（未満で WARN）
ENTRY_WARN_THRESHOLD = 3


def check_entry_consistency(schedule: list) -> None:
    """
    スケジュールとエントリーの整合性をチェックし結果を出力する。

    チェック内容:
      - エントリーが 0 件のレースがないか
      - レーン番号が重複していないか
      - エントリー件数が少ない（ENTRY_WARN_THRESHOLD 未満）レースを警告
    """
    if not schedule:
        log_warn("エントリー整合性: スケジュールデータが空です")
        return

    no_entry_races  = []  # エントリー0件のレース番号
    dup_lane_races  = []  # レーン番号重複のレース番号
    few_entry_races = []  # エントリーが少ないレース (race_no, 件数)

    for race in schedule:
        race_no = race.get("race_no", "?")
        entries = race.get("entries", [])
        count   = len(entries)

        # エントリーなし
        if count == 0:
            no_entry_races.append(race_no)
            continue

        # エントリー件数が少ない
        if count < ENTRY_WARN_THRESHOLD:
            few_entry_races.append((race_no, count))

        # レーン番号の重複チェック
        lanes = [e.get("lane") for e in entries]
        if len(lanes) != len(set(lanes)):
            dup_lane_races.append(race_no)

    # 結果出力
    if not no_entry_races and not dup_lane_races:
        log_ok(f"エントリー整合性: 全{len(schedule)}レースにエントリーあり")
    else:
        if no_entry_races:
            log_fail(f"エントリー整合性: エントリー0件のレース → Race {no_entry_races}")
        else:
            log_ok(f"エントリー整合性: 全{len(schedule)}レースにエントリーあり")

    # 重複レーン警告
    for race_no in dup_lane_races:
        log_warn(f"Race {race_no}: レーン番号に重複があります")

    # 少エントリー警告
    for race_no, count in few_entry_races:
        log_warn(f"Race {race_no}: エントリー {count}件（少ない可能性）")


# ---------------------------------------------------------------------------
# チェック1: ローカルファイル確認
# ---------------------------------------------------------------------------

def check_local_files(verbose: bool) -> Tuple[bool, Optional[datetime]]:
    """
    ローカルファイルのチェックを行い、
    (全体OK?, 最後に更新されたrace JSONのdatetime) を返す。
    """
    all_ok = True
    latest_updated_at: Optional[datetime] = None

    # ---- master.json ----
    if not MASTER_JSON_PATH.exists():
        log_fail(f"data/master.json: ファイルが存在しません")
        all_ok = False
    else:
        try:
            with open(MASTER_JSON_PATH, encoding="utf-8") as f:
                master = json.load(f)
            schedule    = master.get("schedule", [])
            race_count  = len(schedule)
            entry_count = sum(len(race.get("entries", [])) for race in schedule)
            log_ok(f"data/master.json: {race_count}レース, {entry_count}エントリー")

            # ---- エントリー整合性チェック ----------------------------------------
            check_entry_consistency(schedule)

        except json.JSONDecodeError as e:
            log_fail(f"data/master.json: JSONパースエラー — {e}")
            all_ok = False
        except Exception as e:
            log_fail(f"data/master.json: 読み込みエラー — {e}")
            all_ok = False

    # ---- data/results/ ----
    if not RESULTS_DIR.is_dir():
        log_fail(f"data/results/: ディレクトリが存在しません")
        all_ok = False
        return all_ok, latest_updated_at

    json_files = sorted(RESULTS_DIR.glob("race_*.json"))

    if not json_files:
        log_warn(f"data/results/: JSONファイルが0件です")
        all_ok = False
        return all_ok, latest_updated_at

    log_ok(f"data/results/: {len(json_files)}ファイル確認")

    # 各race_XXX.json の詳細確認
    for jf in json_files:
        try:
            with open(jf, encoding="utf-8") as f:
                race_json = json.load(f)
        except json.JSONDecodeError as e:
            log_fail(f"  - {jf.name}: JSONパースエラー — {e}")
            all_ok = False
            continue
        except Exception as e:
            log_fail(f"  - {jf.name}: 読み込みエラー — {e}")
            all_ok = False
            continue

        boat_count  = len(race_json.get("results", []))
        updated_raw = race_json.get("updated_at", "")

        # updated_at をパース
        updated_dt: datetime | None = None
        if updated_raw:
            try:
                # ISO 8601形式: 2026-04-05T12:00:00.000Z
                updated_dt = datetime.fromisoformat(
                    updated_raw.replace("Z", "+00:00")
                )
            except ValueError:
                pass

        if updated_dt:
            elapsed = elapsed_str(updated_dt)
            elapsed_m = elapsed_minutes(updated_dt)
            # 古すぎる場合は警告（RECENT_THRESHOLD_MINUTES分以上）
            if elapsed_m > RECENT_THRESHOLD_MINUTES:
                log_sub(f"- {jf.name}: {C.YELLOW}{elapsed}に更新{C.RESET} ({boat_count}艇)")
            else:
                log_sub(f"- {jf.name}: {elapsed}に更新 ({boat_count}艇)")

            # 最新の updated_at を追跡
            if latest_updated_at is None or updated_dt > latest_updated_at:
                latest_updated_at = updated_dt
        else:
            log_sub(f"- {jf.name}: updated_at 不明 ({boat_count}艇)")
            all_ok = False

    return all_ok, latest_updated_at


# ---------------------------------------------------------------------------
# チェック2: GitHub確認
# ---------------------------------------------------------------------------

def check_github(token: str, repo: str, branch: str, verbose: bool) -> bool:
    """
    GitHub API を使って最新コミット情報と data/results/ のファイル一覧を確認する。
    成功した場合は True を返す。
    """
    if not token:
        log_fail("GitHub: GITHUB_TOKEN / --token が未設定です")
        return False
    if not repo:
        log_fail("GitHub: --repo (OWNER/REPO) が指定されていません")
        return False

    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "check_status/1.0",
    }

    def gh_get(url: str) -> Optional[dict]:
        """GitHub APIへGETリクエストを送り、レスポンスを返す。失敗時はNone。"""
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            log_fail(f"GitHub API HTTPエラー: {e.code} {e.reason} ({url})")
            return None
        except Exception as e:
            log_fail(f"GitHub API 接続エラー: {e}")
            return None

    # ---- 最新コミット取得 ----
    commits_url = (
        f"https://api.github.com/repos/{repo}/commits"
        f"?sha={branch}&per_page=1"
    )
    commits = gh_get(commits_url)
    if not commits or not isinstance(commits, list) or len(commits) == 0:
        log_fail("GitHub: コミット情報を取得できませんでした")
        return False

    latest_commit   = commits[0]
    commit_message  = latest_commit.get("commit", {}).get("message", "").split("\n")[0]
    commit_date_raw = latest_commit.get("commit", {}).get("author", {}).get("date", "")
    commit_sha      = latest_commit.get("sha", "")[:7]

    try:
        commit_dt = datetime.fromisoformat(commit_date_raw.replace("Z", "+00:00"))
        elapsed   = elapsed_str(commit_dt)
    except ValueError:
        elapsed = commit_date_raw

    log_ok(f"GitHub: 最新コミット {elapsed}  [{commit_sha}] {commit_message[:50]}")

    # ---- data/results/ のファイル一覧 ----
    if verbose:
        contents_url = (
            f"https://api.github.com/repos/{repo}/contents/data/results"
            f"?ref={branch}"
        )
        contents = gh_get(contents_url)
        if contents and isinstance(contents, list):
            for item in sorted(contents, key=lambda x: x.get("name", "")):
                if item.get("name", "").endswith(".json"):
                    log_sub(
                        f"- {item['name']}: "
                        f"{item.get('size', 0)} bytes  "
                        f"sha={item.get('sha','')[:7]}"
                    )

    return True


# ---------------------------------------------------------------------------
# チェック3: サイト確認
# ---------------------------------------------------------------------------

def check_site(site_url: str, verbose: bool) -> bool:
    """
    公開サイトのHTTPステータスと master.json の取得を確認する。
    成功した場合は True を返す。
    """
    site_url = site_url.rstrip("/")
    all_ok   = True

    # ---- HTTPステータス確認 ----
    try:
        req = urllib.request.Request(
            site_url,
            headers={"User-Agent": "check_status/1.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = resp.getcode()
        log_ok(f"サイト: HTTP {status}  ({site_url})")
    except urllib.error.HTTPError as e:
        log_fail(f"サイト: HTTP {e.code} {e.reason}  ({site_url})")
        all_ok = False
    except Exception as e:
        log_fail(f"サイト: 接続エラー — {e}")
        all_ok = False

    # ---- master.json 取得確認 ----
    master_url = f"{site_url}/data/master.json"
    try:
        req = urllib.request.Request(
            master_url,
            headers={"User-Agent": "check_status/1.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read()
        master = json.loads(body)
        race_count = len(master.get("schedule", []))
        log_ok(f"サイト: master.json 取得成功 ({race_count}レース)")
        if verbose:
            log_sub(f"URL: {master_url}")
    except urllib.error.HTTPError as e:
        log_fail(f"サイト: master.json が取得できません — HTTP {e.code}")
        all_ok = False
    except json.JSONDecodeError as e:
        log_fail(f"サイト: master.json JSONパースエラー — {e}")
        all_ok = False
    except Exception as e:
        log_fail(f"サイト: master.json 接続エラー — {e}")
        all_ok = False

    return all_ok


# ---------------------------------------------------------------------------
# メイン処理
# ---------------------------------------------------------------------------

def run(args: argparse.Namespace) -> int:
    """
    全チェックを実行し、総合判定を出力する。
    異常があれば exit code 1 を返す。
    """
    verbose = getattr(args, "verbose", False)

    # ヘッダー出力
    print(f"\n{'='*40}")
    print(f"  当日状態チェック")
    print(f"{'='*40}")

    overall_ok    = True
    latest_update: Optional[datetime] = None

    # ---- チェック1: ローカルファイル ----
    local_ok, latest_update = check_local_files(verbose)
    if not local_ok:
        overall_ok = False

    # ---- チェック2: GitHub（--github指定時） ----
    if args.github:
        token  = args.token  or os.environ.get("GITHUB_TOKEN", "")
        repo   = args.repo   or os.environ.get("GITHUB_REPO",  "")
        branch = args.branch
        github_ok = check_github(token, repo, branch, verbose)
        if not github_ok:
            overall_ok = False

    # ---- チェック3: サイト（--site指定時） ----
    if args.site:
        site_ok = check_site(args.site, verbose)
        if not site_ok:
            overall_ok = False

    # ---- 最終更新からの経過時間 ----
    if latest_update:
        elapsed_m = elapsed_minutes(latest_update)
        elapsed   = elapsed_str(latest_update)
        if elapsed_m > RECENT_THRESHOLD_MINUTES:
            log_warn(f"最後の更新から {elapsed}（{int(elapsed_m)}分経過）")
            # 経過時間が長すぎる場合は警告だが overall_ok は変更しない
        else:
            log_info(f"最後の更新: {elapsed}")

    # ---- 総合判定 ----
    print(f"{'='*40}")
    if overall_ok:
        print(f"  総合: {C.GREEN}{C.BOLD}正常稼働中{C.RESET}")
    else:
        print(f"  総合: {C.RED}{C.BOLD}異常あり — 上記の [FAIL] を確認してください{C.RESET}")
    print(f"{'='*40}\n")

    return 0 if overall_ok else 1


# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="当日運用状態確認ツール — システムの稼働状況を確認する",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--github",
        action="store_true",
        help="GitHubの最新コミット・ファイル一覧を確認する",
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
        help="確認するブランチ（デフォルト: main）",
    )
    parser.add_argument(
        "--site",
        default=None,
        metavar="URL",
        help="公開サイトのURL（例: https://your-site.pages.dev）",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="詳細出力（GitHubのファイル一覧等）",
    )
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(run(parse_args()))
