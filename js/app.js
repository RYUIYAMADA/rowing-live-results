/**
 * ボート競技ライブリザルト - フロントエンドアプリ
 * data/master.json と data/results/race_XXX.json を fetch して動的に表示する
 */

// ========= 設定値 =========
const CONFIG = {
  // master.json のパス
  MASTER_JSON: 'data/master.json',
  // 結果JSONのパスパターン（race_no を3桁ゼロ埋め）
  RESULT_JSON: (no) => `data/results/race_${String(no).padStart(3, '0')}.json`,
  // 自動更新間隔（ミリ秒）
  REFRESH_INTERVAL: 60000,
  // ラウンドの表示名マッピング
  ROUND_NAMES: {
    FA: '決勝A', FB: '決勝B', SF: '準決勝',
    H: '予選', RK: '順位決定', R: '敗者復活'
  },
  // カテゴリの表示名
  CATEGORY_NAMES: { M: '男子', W: '女子', X: '混成' },
};

// ========= ユーティリティ =========

/** HTMLエスケープ（XSS対策） */
function h(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ========= グローバル状態 =========
let masterData = null;       // master.json の内容
let resultsCache = {};       // race_no → race_XXX.json の内容
let lastUpdated = null;      // 最終更新時刻
let isOffline = false;       // オフラインフラグ
let isUpdating = false;      // 自動更新多重実行防止フラグ
// タイマーを一元管理（メモリリーク防止）
const timers = { refresh: null, highlight: null };
// フィルタ状態（status フィールドを追加）
const filterState = { category: 'all', round: 'all', date: 'all', crew: '', status: 'all' };
// スケジュールビューの日付フィルタ
let scheduleFilterDate = 'all';
// テーブルビューのソート状態
const sortState = { col: null, dir: 'asc' };
// テーブルビュー用の生データ行（ソート用に保持）
let dbRows = [];
// 使用中プロパティ（未使用列を非表示にするため）
let usedProps = {};

// ========= 初期化 =========
document.addEventListener('DOMContentLoaded', () => {
  // URLハッシュによるビュー切替対応
  handleHashChange();
  window.addEventListener('hashchange', handleHashChange);

  loadAll();
  setupRefreshTimer();
  setupOfflineDetection();
});

/**
 * URLハッシュに応じてビューを切り替え、対象レースにスクロールする
 */
function handleHashChange() {
  const hash = location.hash;
  if (!hash) return;

  // #view-table などのビュー切替ハッシュに対応
  if (hash === '#view-table') {
    const tab = document.querySelector('.view-tab:nth-child(2)');
    if (tab) switchView('table', tab);
    return;
  }
  if (hash === '#view-toggle') {
    const tab = document.querySelector('.view-tab:nth-child(1)');
    if (tab) switchView('toggle', tab);
    return;
  }
  if (hash === '#view-schedule') {
    const tab = document.querySelector('.view-tab:nth-child(3)');
    if (tab) switchView('schedule', tab);
    return;
  }

  // #race-N 形式: 該当レースのトグルを開いてスクロール＆ハイライト
  const raceMatch = hash.match(/^#race-(\d+)$/);
  if (raceMatch) {
    const raceNo = parseInt(raceMatch[1], 10);
    // DOMが構築されてから実行
    setTimeout(() => scrollToRace(raceNo), 300);
  }
}

/**
 * 指定レース番号のトグルを開いてハイライトしスクロールする
 */
function scrollToRace(raceNo) {
  if (!masterData) return;
  // race_no が属する event_code のトグルを探す
  const race = (masterData?.schedule || []).find(r => r.race_no === raceNo);
  if (!race) return;

  const toggle = document.querySelector(
    `#view-toggle-content .toggle[data-code="${race.event_code}"]`
  );
  if (!toggle) return;

  // トグルを開く
  toggle.classList.add('open');
  // ハイライト
  toggle.classList.add('highlighted');
  setTimeout(() => toggle.classList.remove('highlighted'), 3000);
  // スクロール
  toggle.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ========= データ読み込み =========

/**
 * マスタと全結果を読み込んでUIを描画する
 */
async function loadAll() {
  try {
    showLoading(true);
    // スケルトンUIを先に表示
    showSkeletonToggle();

    masterData = await fetchJSON(CONFIG.MASTER_JSON).catch(e => {
      // master.json 404 専用エラーメッセージ
      if (e.message.startsWith('HTTP 404')) {
        throw new Error('MASTER_NOT_FOUND');
      }
      throw e;
    });

    // 必須フィールドの存在チェック
    if (!masterData || !masterData.schedule) {
      throw new Error('MASTER_NOT_FOUND');
    }

    // ページタイトルを大会名に動的更新
    document.title = (masterData.tournament?.race_name || '速報サイト') + ' 速報';

    // master.json 読み込み直後にスケジュールの骨格を表示
    renderAll();

    // 結果だけを後から埋める
    await loadResults();
    renderToggleView();
    renderTableView();
    renderScheduleView();
    // 初回ロード時にも実施中レースをハイライト
    highlightCurrentRace();

    lastUpdated = new Date();
    updateStatusBar();

    // URLハッシュ対応（データ読み込み後）
    handleHashChange();
  } catch (e) {
    console.error('データ読み込みエラー:', e);
    if (e.message === 'MASTER_NOT_FOUND') {
      showError('大会データが見つかりません。管理者にお問い合わせください。');
    } else {
      showError('データの読み込みに失敗しました。しばらく待ってから再試行してください。');
    }
  } finally {
    showLoading(false);
    clearSkeletonToggle();
  }
}

/**
 * 全レースの結果JSONを並列 fetch する（存在しないものはスキップ）
 * 更新があった race_no のリストを返す
 */
async function loadResults() {
  const raceNos = (masterData?.schedule || []).map(r => r.race_no);
  const newlyUpdated = [];

  const promises = raceNos.map(async (no) => {
    try {
      const data = await fetchJSON(CONFIG.RESULT_JSON(no));
      // 以前キャッシュになかった場合は「新規更新」として記録
      if (!resultsCache[no]) {
        newlyUpdated.push(no);
      }
      resultsCache[no] = data;
    } catch (e) {
      // 404は正常系（結果未投入）、それ以外は警告
      if (!e.message.includes('HTTP 404')) {
        console.warn(`結果JSON取得失敗 race_no=${no}:`, e.message);
      }
    }
  });

  await Promise.all(promises);
  console.log(`結果JSON読み込み完了: ${Object.keys(resultsCache).length}/${raceNos.length}件`);
  return newlyUpdated;
}

/**
 * JSONをfetchしてパースする
 */
async function fetchJSON(path, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path + '?t=' + Date.now(), { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${path}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`JSONパースエラー: ${path}`);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`タイムアウト: ${path}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ========= 描画 =========

/**
 * 全UIを描画する
 */
function renderAll() {
  // 使用中プロパティを計算（未使用列の非表示判定に使用）
  usedProps = detectUsedProps();
  renderTournamentHeader();
  renderYoutube();
  renderFilterOptions();
  renderToggleView();
  renderTableView();
  renderScheduleView();
}

/**
 * 大会名・日程・会場をヘッダーに反映する
 */
function renderTournamentHeader() {
  const t = masterData?.tournament || {};
  const el = document.getElementById('tournament-name');
  if (el) el.textContent = '🏁 ' + (t.race_name || '');

  const metaEl = document.getElementById('tournament-meta');
  const dates = (t.dates || []).map(d => formatDate(d)).join('・');
  if (metaEl) {
    metaEl.innerHTML = `<span>📅 ${h(dates)}</span><span>📍 ${h(t.venue || '')}</span>`;
  }

  // カバーエリアにも大会情報を表示
  const coverName = document.getElementById('cover-tournament-name');
  if (coverName) coverName.textContent = t.race_name || '';
  const coverMeta = document.getElementById('cover-meta');
  if (coverMeta) coverMeta.textContent = `${dates} | ${t.venue || ''}`;
}

/**
 * YouTube Live URLがあれば埋め込む
 */
function renderYoutube() {
  const url = masterData?.tournament?.youtube_url;
  const container = document.getElementById('youtube-container');
  if (!container) return;
  if (!url) { container.style.display = 'none'; return; }

  // youtube.com/watch?v=ID または youtu.be/ID 形式に対応
  const videoId = extractYoutubeId(url);
  if (!videoId) { container.style.display = 'none'; return; }

  container.innerHTML = `
    <div class="youtube-wrapper">
      <iframe src="https://www.youtube.com/embed/${videoId}?autoplay=0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen></iframe>
    </div>`;
}

/**
 * 日別タブとフィルタの日程オプションをマスタから動的生成する
 */
function renderFilterOptions() {
  const dates = [...new Set((masterData?.schedule || []).map(r => r.date))].sort();

  // 日別タブを生成（日数に関わらず常に表示）
  const dayTabs = document.getElementById('day-tabs');
  if (dayTabs) {
    const tabs = [{ value: 'all', label: 'すべて' }]
      .concat(dates.map((d, i) => ({ value: d, label: `${i + 1}日目｜${formatDate(d)}` })));
    dayTabs.innerHTML = tabs.map(t =>
      `<button class="day-tab${filterState.date === t.value ? ' active' : ''}"
        onclick="selectDayTab('${t.value}')">${t.label}</button>`
    ).join('');
    dayTabs.style.display = '';
  }

  // セレクトボックスも更新（互換性のため残す）
  const daySelect = document.getElementById('filter-day');
  if (daySelect) {
    while (daySelect.options.length > 1) daySelect.remove(1);
    dates.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = `${i + 1}日目 (${formatDate(d)})`;
      daySelect.appendChild(opt);
    });
  }
}

/**
 * 日別タブをクリックしたときに呼ばれる
 */
function selectDayTab(date) {
  filterState.date = date;
  // タブのactive状態を更新
  document.querySelectorAll('.day-tab').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.includes(date === 'all' ? 'すべて' : formatDate(date)));
  });
  // セレクトボックスも同期
  const daySelect = document.getElementById('filter-day');
  if (daySelect) daySelect.value = date;
  applyFilters();
}

/**
 * スケジュールビューの日別タブをクリックしたときに呼ばれる
 */
function selectScheduleDayTab(date) {
  scheduleFilterDate = date;
  renderScheduleView();
}

/**
 * 種目別トグルビューを描画する
 */
function renderToggleView() {
  const container = document.getElementById('view-toggle-content');
  if (!container) return;

  // 種目コードでグループ化
  const groups = groupByEventCode(masterData?.schedule || []);

  container.innerHTML = '';
  groups.forEach(({ eventCode, eventName, category, races }) => {
    // フィルタ適用
    if (!matchesFilter(category, races)) return;

    const completedCount = races.filter(r => resultsCache[r.race_no]).length;
    const totalCount = races.length;
    const allDone = completedCount === totalCount && totalCount > 0;
    const anyLive = !allDone && completedCount > 0;

    const statusBadge = allDone
      ? '<span class="badge badge-done">確定</span>'
      : anyLive
      ? '<span class="badge badge-live">実施中</span>'
      : '<span class="badge badge-upcoming">未実施</span>';

    const toggleEl = document.createElement('div');
    toggleEl.className = 'toggle';
    toggleEl.dataset.category = category;
    toggleEl.dataset.code = eventCode;
    // 結果ありかどうかをdata属性に付与（状態フィルタ用）
    toggleEl.dataset.hasDone = completedCount > 0 ? 'true' : 'false';
    toggleEl.dataset.crews = races.flatMap(r =>
      (r.entries || []).map(e => `${e.crew_name} ${e.affiliation}`)
    ).join(' ').toLowerCase();

    toggleEl.innerHTML = `
      <div class="toggle-header" onclick="this.parentElement.classList.toggle('open')">
        <span class="toggle-arrow">▶</span>
        <span class="toggle-title">${eventName}</span>
        <span class="toggle-code">${displayCode(eventCode)}</span>
        <span class="toggle-count">${totalCount}レース</span>
        ${statusBadge}
      </div>
      <div class="toggle-body">
        ${races.map(r => renderRaceBlock(r)).join('')}
      </div>`;

    container.appendChild(toggleEl);
  });

  updateFilterCount();
}

/**
 * 1レースのHTMLブロックを返す
 */
function renderRaceBlock(race) {
  const result = resultsCache[race.race_no];
  const roundName = CONFIG.ROUND_NAMES[race.round] || race.round;
  const dateStr = formatDate(race.date);
  const ageLabel = (usedProps.hasAgeGroup && race.age_group) ? `<span class="age-group">(${race.age_group})</span>` : '';

  const statusBadge = result
    ? '<span class="badge badge-done">確定</span>'
    : '<span class="badge badge-upcoming">未実施</span>';

  const tableHTML = result
    ? renderResultTable(race, result)
    : '<p class="no-result">結果は未投入です</p>';

  return `
    <div class="race-header" id="race-${race.race_no}">
      <div>
        <span class="race-label">${h(race.event_name)}${ageLabel} ${roundName}</span>
        ${statusBadge}
      </div>
      <div class="race-info">Race No.${race.race_no} | ${dateStr} ${formatRaceTime(race.time)}</div>
    </div>
    ${tableHTML}`;
}

/**
 * レース結果テーブルHTMLを返す
 */
function renderResultTable(race, result) {
  // レースごとの course_length があれば優先、なければ大会デフォルト
  const raceCourseLength = race.course_length || masterData.tournament?.course_length || 1000;
  const allPts = masterData?.measurement_points || ['500', '1000'];
  // このレースの距離以下の計測ポイントのみ有効とする（例: 500m種目では500m列のみ）
  const pts = allPts.filter(p => {
    const m = parseInt(p, 10);
    return isNaN(m) || m <= raceCourseLength;
  });
  const showMidpoint = pts.length > 1;

  // エントリー情報をlaneで引く
  const entryMap = {};
  (race.entries || []).forEach(e => { entryMap[e.lane] = e; });

  // エントリーにあるが結果にないレーン → 棄権（DNS）として追加
  const resultsList = result?.results || [];
  const resultLanes = new Set(resultsList.map(r => r.lane));
  const dnsRows = (race.entries || [])
    .filter(e => !resultLanes.has(e.lane))
    .map(e => ({ lane: e.lane, rank: null, times: {}, finish: null, split: '', tie_group: '', photo_flag: false, note: '', status: 'dns' }));

  // 結果をrank順にソート（完走→DNF→DNS の順）
  const sorted = [...resultsList, ...dnsRows].sort((a, b) => {
    if (a.status === 'finish' && b.status !== 'finish') return -1;
    if (a.status !== 'finish' && b.status === 'finish') return 1;
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    return a.lane - b.lane;
  });

  // 同着グループを集計: tie_group が同じ艇が複数いるか
  const tieGroupCounts = {};
  sorted.forEach(r => {
    if (r.tie_group) {
      tieGroupCounts[r.tie_group] = (tieGroupCounts[r.tie_group] || 0) + 1;
    }
  });

  const rows = sorted.map(r => {
    const entry = entryMap[r.lane] || {};
    const isDns = r.status === 'dns';
    const isDnf = r.status === 'dnf';

    const midTime = showMidpoint && r.times && r.times[pts[0]]
      ? `<span class="time-split">${r.times[pts[0]].formatted}</span>`
      : (isDns ? '-' : '-');

    const rankClass = r.rank !== null && r.rank <= 3 ? `rank-${r.rank}` : '';
    const photoMark = r.photo_flag ? '📷' : '';
    const note = r.note ? `<span style="color:#e03e3e;font-size:11px">${h(r.note)}</span>` : '';
    const isTie = r.tie_group && tieGroupCounts[r.tie_group] > 1;

    let rankDisplay, finishDisplay;
    if (isDns) {
      rankDisplay = `<span class="rank-dns">棄権</span>`;
      finishDisplay = `<span class="status-dns">DNS</span>`;
    } else if (isDnf) {
      rankDisplay = `<span class="rank-dnf">途中棄権</span>`;
      finishDisplay = `<span class="status-dnf">DNF</span>`;
    } else {
      rankDisplay = `<span class="rank rank-${r.rank}">${r.rank}${isTie ? '=' : ''}</span>`;
      finishDisplay = `<span class="time-main">${r.finish ? r.finish.formatted : '-'}</span>${r.split ? `<div class="time-half">${r.split}</div>` : ''}`;
    }

    // エントリー個別のage_groupがある場合（混合レース）はクラス名を表示
    const entryAgeLabel = entry.age_group ? `<span class="entry-age-group">${h(entry.age_group)}</span>` : '';

    return `
      <tr class="${rankClass}${isDns || isDnf ? ' row-retired' : ''}">
        <td>${rankDisplay}</td>
        <td>${r.lane}</td>
        <td>${h(entry.affiliation) || '-'}</td>
        <td class="crew-name">${h(entry.crew_name) || '-'}${entryAgeLabel}</td>
        <td class="hide-mobile">${isDns ? '-' : midTime}</td>
        <td>${finishDisplay}</td>
        <td>${isDns ? '' : photoMark + note}</td>
      </tr>`;
  }).join('');

  const midHeader = showMidpoint
    ? `<th class="hide-mobile" style="width:70px">${pts[0]}</th>`
    : '';
  const finishHeader = `${raceCourseLength}m`;

  return `
    <div class="result-table-wrapper">
    <table class="result-table">
      <thead>
        <tr>
          <th style="width:36px">順位</th>
          <th style="width:28px">B</th>
          <th style="min-width:100px">所属</th>
          <th style="min-width:120px">クルー</th>
          ${midHeader}
          <th style="width:90px">${finishHeader}</th>
          <th style="min-width:80px">備考</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}

/**
 * スケジュールビュー（時系列順レース一覧）を描画する
 */
function renderScheduleView() {
  const container = document.getElementById('schedule-table-container');
  if (!container || !masterData) return;

  // 日付・時刻順にソート
  const sorted = [...(masterData?.schedule || [])].sort((a, b) => {
    const aStr = a.date + ' ' + a.time;
    const bStr = b.date + ' ' + b.time;
    return aStr.localeCompare(bStr);
  });

  // 日付ごとにグループ化（日付セパレーター挿入用）
  const uniqueDates = [...new Set(sorted.map(r => r.date))].sort();

  // 日別タブを生成
  const schedDayTabs = document.getElementById('schedule-day-tabs');
  if (schedDayTabs) {
    const tabs = [{ value: 'all', label: 'すべて' }]
      .concat(uniqueDates.map((d, i) => ({ value: d, label: `${i + 1}日目｜${formatDate(d)}` })));
    schedDayTabs.innerHTML = tabs.map(t =>
      `<button class="day-tab${scheduleFilterDate === t.value ? ' active' : ''}"
        onclick="selectScheduleDayTab('${t.value}')">${t.label}</button>`
    ).join('');
  }

  // 日付フィルタを適用
  const filtered = scheduleFilterDate === 'all' ? sorted : sorted.filter(r => r.date === scheduleFilterDate);

  // 現在時刻より後で最も近い「未確定」レースを「次」とする
  const now = new Date();
  let nextRaceNo = null;
  let minFutureDiff = Infinity;
  sorted.forEach(race => {
    if (resultsCache[race.race_no]) return; // 結果確定済みは除外
    const raceTime = new Date(race.date + 'T' + race.time + ':00+09:00');
    const diff = raceTime - now;
    if (diff >= 0 && diff < minFutureDiff) {
      minFutureDiff = diff;
      nextRaceNo = race.race_no;
    }
  });

  let html = '<table class="schedule-table">';
  html += '<thead><tr>';
  html += '<th class="sc-time">時刻</th>';
  html += '<th class="sc-no">Race No.</th>';
  html += '<th class="sc-event">種目名</th>';
  html += '<th class="sc-round hide-mobile">ラウンド</th>';
  html += '<th class="sc-status">状態</th>';
  html += '<th class="sc-winner">1位クルー</th>';
  html += '</tr></thead><tbody>';

  let lastDate = null;
  filtered.forEach((race, idx) => {
    // 複数日表示のときだけ日付セパレーターを挿入
    if (scheduleFilterDate === 'all' && race.date !== lastDate) {
      lastDate = race.date;
      const dayIdx = uniqueDates.indexOf(race.date) + 1;
      html += `<tr class="schedule-date-sep">
        <td colspan="6">── ${dayIdx}日目 (${formatDate(race.date)}) ──</td>
      </tr>`;
    }

    const result = resultsCache[race.race_no];
    const roundName = CONFIG.ROUND_NAMES[race.round] || race.round;
    const ageLabel = (usedProps.hasAgeGroup && race.age_group) ? ` (${race.age_group})` : '';
    const isNext = race.race_no === nextRaceNo;

    // 状態バッジ
    const statusBadge = result
      ? '<span class="badge badge-done">確定</span>'
      : '<span class="badge badge-upcoming">未実施</span>';

    // 1位クルー名・所属（結果ありの場合のみ）
    let winnerHtml = '-';
    if (result) {
      const winner = (result.results || []).find(r => r.rank === 1);
      if (winner) {
        const entryMap = {};
        (race.entries || []).forEach(e => { entryMap[e.lane] = e; });
        const entry = entryMap[winner.lane] || {};
        const affiliation = entry.affiliation ? `${h(entry.affiliation)} / ` : '';
        winnerHtml = `<span class="sc-winner-name">${affiliation}${h(entry.crew_name) || '-'}</span>`;
      }
    }

    // 未実施レースは薄い色で表示、実施済みは通常
    const rowClass = [
      isNext ? 'schedule-next-race' : '',
      result ? '' : 'schedule-row-pending',
    ].filter(Boolean).join(' ');

    html += `<tr class="${rowClass}" data-race="${race.race_no}">
      <td class="sc-time">${formatRaceTime(race.time)}</td>
      <td class="sc-no">${race.race_no}</td>
      <td class="sc-event"><span class="sc-event-name">${h(race.event_name)}${ageLabel}</span></td>
      <td class="sc-round hide-mobile">${roundName}</td>
      <td class="sc-status">${statusBadge}</td>
      <td class="sc-winner">${winnerHtml}</td>
    </tr>`;
  });

  html += '</tbody></table>';

  // 全レースが確定済みの場合は「本日のレースは終了しました」を末尾に表示
  const allConfirmed = (masterData?.schedule || []).every(r => resultsCache[r.race_no]);
  if (allConfirmed) {
    html += '<p class="schedule-all-done">全レース結果が確定しました</p>';
  }

  container.innerHTML = html;

  // 次のレース行があればスクロール位置を設定（ページ先頭から遠い場合のみ）
  const nextRow = container.querySelector('.schedule-next-race');
  if (nextRow) {
    setTimeout(() => {
      nextRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }
}

/**
 * 現在時刻に基づいて「実施中」レースを推定してハイライトする
 * - マスタの date + time が現在時刻の ±15分以内のレースを「実施中」とみなす
 * - まだ結果JSONがないレースが対象
 * - 対象トグルに badge-live バッジを追加
 */
function highlightCurrentRace() {
  if (!masterData) return;
  const now = new Date();
  const WINDOW_MS = 15 * 60 * 1000; // ±15分

  // 結果未確定のレースの中で、現在時刻に最も近い1レースだけを「実施中」にする
  let currentRace = null;
  let minDiff = Infinity;
  (masterData?.schedule || []).forEach(race => {
    if (resultsCache[race.race_no]) return; // 結果済みはスキップ
    const raceTime = new Date(race.date + 'T' + race.time + ':00+09:00');
    const diff = Math.abs(now - raceTime);
    if (diff <= WINDOW_MS && diff < minDiff) {
      minDiff = diff;
      currentRace = race;
    }
  });

  // 全トグルのliveバッジを一旦リセット
  document.querySelectorAll('#view-toggle-content .toggle .badge-live').forEach(badge => {
    badge.className = 'badge badge-upcoming';
    badge.textContent = '予定';
  });

  // 該当レースだけliveに設定
  if (currentRace) {
    const toggle = document.querySelector(
      `#view-toggle-content .toggle[data-code="${currentRace.event_code}"]`
    );
    if (toggle) {
      const existingBadge = toggle.querySelector('.toggle-header .badge');
      if (existingBadge) {
        existingBadge.className = 'badge badge-live';
        existingBadge.textContent = '実施中';
      }
    }
  }

  // スケジュールビューの「次のレース」ハイライトだけDOM最小更新（全再描画は不要）
  const prevNext = document.querySelector('.schedule-next-race');
  if (prevNext) prevNext.classList.remove('schedule-next-race');
  if (currentRace) {
    const nextRow = document.querySelector(`#schedule-table-container [data-race="${currentRace.race_no}"]`);
    if (nextRow) nextRow.classList.add('schedule-next-race');
  }
}

/**
 * 全レース一覧ビューをトグル形式で描画する（レースごとに折り畳み可能）
 */
function renderTableView() {
  const container = document.getElementById('view-table-content');
  if (!container) return;

  const allPts = masterData?.measurement_points || ['500', '1000'];

  const html = (masterData?.schedule || []).map(race => {
    const raceCourseLength = race.course_length || masterData.tournament?.course_length || 1000;
    const pts = allPts.filter(p => { const m = parseInt(p, 10); return isNaN(m) || m <= raceCourseLength; });
    const showMid = pts.length > 1;
    const result = resultsCache[race.race_no];
    const entryMap = {};
    (race.entries || []).forEach(e => { entryMap[e.lane] = e; });
    const roundName = CONFIG.ROUND_NAMES[race.round] || race.round;
    const hasResult = !!result;

    // ヘッダー情報
    const badge = hasResult
      ? `<span class="badge badge-done">結果あり</span>`
      : `<span class="badge badge-pending">未実施</span>`;
    const agePart = usedProps.hasAgeGroup && race.age_group ? ` (${race.age_group})` : '';
    const title = `Race ${race.race_no}｜${race.event_name}${agePart}　${roundName}`;

    // テーブル内容
    let tableBody = '';
    if (hasResult) {
      // 棄権（DNS）を追加
      const resultsList2 = result?.results || [];
      const resultLanes = new Set(resultsList2.map(r => r.lane));
      const dnsEntries = (race.entries || [])
        .filter(e => !resultLanes.has(e.lane))
        .map(e => ({ lane: e.lane, rank: null, times: {}, finish: null, split: '', tie_group: '', photo_flag: false, note: '', status: 'dns' }));
      const allResults = [...resultsList2, ...dnsEntries].sort((a, b) => {
        if (a.status === 'finish' && b.status !== 'finish') return -1;
        if (a.status !== 'finish' && b.status === 'finish') return 1;
        if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
        return a.lane - b.lane;
      });

      const tieGroupCounts = {};
      resultsList2.forEach(r => {
        if (r.tie_group) tieGroupCounts[r.tie_group] = (tieGroupCounts[r.tie_group] || 0) + 1;
      });

      tableBody = allResults.map(r => {
        const entry = entryMap[r.lane] || {};
        const isDns = r.status === 'dns';
        const isDnf = r.status === 'dnf';
        const midTime = showMid && r.times && r.times[pts[0]] ? r.times[pts[0]].formatted : '-';
        const isTie = r.tie_group && tieGroupCounts[r.tie_group] > 1;
        let rankCell, finishCell;
        if (isDns) {
          rankCell = `<span class="rank-dns">棄権</span>`;
          finishCell = `<span class="status-dns">DNS</span>`;
        } else if (isDnf) {
          rankCell = `<span class="rank-dnf">途中棄権</span>`;
          finishCell = `<span class="status-dnf">DNF</span>`;
        } else {
          rankCell = `<span class="rank rank-${r.rank}">${r.rank}${isTie ? '=' : ''}</span>`;
          finishCell = `<span class="time-main">${r.finish ? r.finish.formatted : '-'}</span>${r.split ? `<div class="time-half">${r.split}</div>` : ''}`;
        }
        const entryAgeLabel = entry.age_group ? `<span class="entry-age-group">${h(entry.age_group)}</span>` : '';
        return `<tr class="${r.rank && r.rank <= 3 ? `rank-${r.rank}` : ''}${isDns || isDnf ? ' row-retired' : ''}">
          <td>${rankCell}</td>
          <td>${r.lane}</td>
          <td>${h(entry.affiliation) || '-'}</td>
          <td class="crew-name">${h(entry.crew_name) || '-'}${entryAgeLabel}</td>
          ${showMid ? `<td class="hide-mobile">${isDns ? '-' : midTime}</td>` : ''}
          <td>${finishCell}</td>
          <td>${(!isDns && r.note) ? `<span style="color:#e03e3e;font-size:11px">${h(r.note)}</span>` : ''}</td>
        </tr>`;
      }).join('');
    } else {
      tableBody = (race.entries || []).map(e => `
        <tr class="row-retired">
          <td>-</td><td>${e.lane}</td>
          <td>${h(e.affiliation)}</td>
          <td class="crew-name">${h(e.crew_name)}</td>
          ${showMid ? `<td class="hide-mobile">-</td>` : ''}
          <td>-</td><td></td>
        </tr>`).join('');
    }

    const midHeader = showMid ? `<th class="hide-mobile">${pts[0]}</th>` : '';
    const finishHeader = `${raceCourseLength}m`;

    return `
      <div class="toggle" data-race="${race.race_no}">
        <div class="toggle-header" onclick="this.parentElement.classList.toggle('open')">
          <span class="toggle-title">${title}</span>
          <span class="toggle-meta">${formatDate(race.date)} ${formatRaceTime(race.time)}</span>
          ${badge}
          <span class="toggle-arrow">▶</span>
        </div>
        <div class="toggle-body">
          <div class="result-table-wrapper">
          <table class="result-table">
            <thead><tr>
              <th style="width:52px">順位</th>
              <th style="width:28px">B</th>
              <th style="min-width:100px">所属</th><th style="min-width:120px">クルー</th>
              ${midHeader}
              <th style="width:90px">${finishHeader}</th>
              <th style="min-width:80px">備考</th>
            </tr></thead>
            <tbody>${tableBody}</tbody>
          </table>
          </div>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = html;
  updateDbTableCount();
}

// ========= テーブルビューのソート =========

/**
 * テーブルヘッダーをクリックしたときにソートする
 */
function sortDbTable(thEl) {
  // 全レース一覧はトグル形式のため、ソートは無効
}

// ========= フィルタ =========

/**
 * フィルタを適用してトグルの表示/非表示を更新する
 */
function applyFilters() {
  filterState.category = document.getElementById('filter-cat')?.value || 'all';
  filterState.round = document.getElementById('filter-round')?.value || 'all';
  filterState.date = document.getElementById('filter-day')?.value || 'all';
  filterState.crew = (document.getElementById('filter-crew')?.value || '').toLowerCase();
  filterState.status = document.getElementById('filter-status')?.value || 'all';

  document.querySelectorAll('#view-toggle-content .toggle').forEach(toggle => {
    const cat = toggle.dataset.category;
    const code = toggle.dataset.code;
    const crews = toggle.dataset.crews || '';
    const hasDone = toggle.dataset.hasDone === 'true';

    let show = true;
    if (filterState.category !== 'all' && cat !== filterState.category) show = false;
    if (filterState.crew && !crews.includes(filterState.crew)) show = false;

    // 状態フィルタ
    if (show && filterState.status !== 'all') {
      if (filterState.status === 'done' && !hasDone) show = false;
      if (filterState.status === 'upcoming' && hasDone) show = false;
    }

    // round・date フィルタはトグル内のレースで判定
    if (show && (filterState.round !== 'all' || filterState.date !== 'all')) {
      const races = (masterData?.schedule || []).filter(r => r.event_code === code);
      const hasMatch = races.some(r =>
        (filterState.round === 'all' || r.round === filterState.round) &&
        (filterState.date === 'all' || r.date === filterState.date)
      );
      if (!hasMatch) show = false;
    }

    toggle.style.display = show ? 'block' : 'none';
  });

  updateFilterCount();
}

/**
 * フィルタをリセットする
 */
function resetFilters() {
  ['filter-cat', 'filter-round', 'filter-day', 'filter-status'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = 'all';
  });
  const crewEl = document.getElementById('filter-crew');
  if (crewEl) crewEl.value = '';
  Object.assign(filterState, { category: 'all', round: 'all', date: 'all', crew: '', status: 'all' });

  document.querySelectorAll('#view-toggle-content .toggle').forEach(t => {
    t.style.display = 'block';
  });
  updateFilterCount();
}

/**
 * フィルタ件数を更新する
 */
function updateFilterCount() {
  const el = document.getElementById('filter-count');
  if (!el) return;
  const visible = document.querySelectorAll('#view-toggle-content .toggle:not([style*="display: none"])').length;
  const total = document.querySelectorAll('#view-toggle-content .toggle').length;
  el.textContent = `${visible}/${total}種目 表示中`;
}

/**
 * テーブルビューの件数ラベルを更新する
 */
function updateDbTableCount() {
  // 非表示のため何もしない
}

// ========= 全展開・全折畳 =========

/** 全トグルを開く */
function expandAll() {
  document.querySelectorAll('#view-toggle-content .toggle').forEach(t => t.classList.add('open'));
}

/** 全トグルを折畳む */
function collapseAll() {
  document.querySelectorAll('#view-toggle-content .toggle').forEach(t => t.classList.remove('open'));
}

// ========= ビュー切替 =========

/**
 * ビュータブを切り替える
 * @param {string} id - ビューID ('toggle' | 'table' | 'schedule')
 * @param {HTMLElement} [tabEl] - クリックされたタブ要素（onclick="switchView('toggle', this)" 形式で渡す）
 */
function switchView(id, tabEl) {
  document.querySelectorAll('.view-content').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('view-' + id)?.classList.add('active');
  if (tabEl) tabEl.classList.add('active');
  // URLハッシュを更新（pushStateで履歴に残さない）
  history.replaceState(null, '', '#view-' + id);
}

// ========= ステータスバー =========

/**
 * 大会日程が全て過去かどうかを判定する
 */
function isTournamentOver() {
  if (!masterData || !masterData.tournament?.dates?.length) return false;
  const lastDate = masterData.tournament.dates.slice(-1)[0];
  const today = new Date().toISOString().split('T')[0];
  return lastDate < today;
}

/**
 * ステータスバーを更新する
 */
function updateStatusBar() {
  const timeEl = document.getElementById('last-updated');
  if (timeEl && lastUpdated) {
    timeEl.textContent = lastUpdated.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }

  const summaryEl = document.getElementById('status-summary');
  if (summaryEl && masterData) {
    const totalRaces = (masterData?.schedule || []).length;
    const doneRaces = Object.keys(resultsCache).length;
    // 全レース確定の場合は専用メッセージを表示
    if (doneRaces === totalRaces && totalRaces > 0) {
      summaryEl.textContent = '全レース結果確定';
    } else {
      summaryEl.textContent = `${doneRaces}/${totalRaces} 確定`;
    }
  }

  // 大会終了後はライブドットを非表示、アーカイブバッジを表示
  const liveDot = document.querySelector('.live-dot');
  const archiveBadge = document.getElementById('archive-badge');
  const tournamentOver = isTournamentOver();
  if (liveDot) liveDot.style.display = tournamentOver ? 'none' : '';
  if (archiveBadge) archiveBadge.style.display = tournamentOver ? 'inline-block' : 'none';

  // 次のレース情報を計算して中央に表示
  const nextInfoEl = document.getElementById('next-race-info');
  if (nextInfoEl && masterData) {
    const now = new Date();
    // 全レース確定、または大会終了後は「次のレース」なし
    const totalRaces = (masterData?.schedule || []).length;
    const doneRaces = Object.keys(resultsCache).length;
    if (doneRaces === totalRaces && totalRaces > 0) {
      nextInfoEl.textContent = '本日のレースは終了しました';
    } else {
      // 未実施レースから現在時刻以降に最も近いものを選ぶ
      let nextRace = null;
      let minFutureDiff = Infinity;
      (masterData?.schedule || []).forEach(race => {
        if (resultsCache[race.race_no]) return;
        const raceTime = new Date(race.date + 'T' + race.time + ':00+09:00');
        const diff = raceTime - now;
        if (diff >= 0 && diff < minFutureDiff) {
          minFutureDiff = diff;
          nextRace = race;
        }
      });
      if (nextRace) {
        const ageLabel = nextRace.age_group ? ` ${nextRace.age_group}` : '';
        nextInfoEl.textContent = `次: Race ${nextRace.race_no} ${nextRace.event_name}${ageLabel} ${formatRaceTime(nextRace.time)}`;
      } else {
        nextInfoEl.textContent = '';
      }
    }
  }
}

// ========= 手動更新 =========

/**
 * 手動更新ボタンから即時リフレッシュする
 */
async function manualRefresh() {
  if (isUpdating) return; // 自動更新中は二重実行を防止
  const btn = document.getElementById('refresh-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '更新中...';
  }
  isUpdating = true;
  try {
    const newlyUpdated = await loadResults();
    renderToggleView();
    renderTableView();
    renderScheduleView();
    highlightCurrentRace();
    lastUpdated = new Date();
    updateStatusBar();
    // 更新されたレースのトースト通知
    newlyUpdated.forEach(no => {
      showToast(`Race No.${no} の結果が更新されました`);
    });
  } catch (e) {
    console.error('手動更新エラー:', e);
    showToast('更新に失敗しました。しばらく待ってから再試行してください。');
  } finally {
    isUpdating = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄';
    }
  }
}

// ========= 自動更新 =========

/**
 * 自動更新タイマーをセットする（既存タイマーをクリアしてから登録）
 */
function setupRefreshTimer() {
  // 既存タイマーをクリア（メモリリーク防止）
  if (timers.refresh) clearInterval(timers.refresh);
  if (timers.highlight) clearInterval(timers.highlight);

  timers.refresh = setInterval(async () => {
    if (isOffline || isUpdating) return; // オフライン中・更新中はスキップ
    isUpdating = true;
    try {
      const newlyUpdated = await loadResults();
      if (newlyUpdated.length > 0) {
        renderToggleView();
        renderTableView();
        renderScheduleView();
        highlightCurrentRace();
        lastUpdated = new Date();
        updateStatusBar();
        newlyUpdated.forEach(no => showToast(`Race No.${no} の結果が更新されました`));
      }
    } catch (e) {
      console.error('自動更新エラー:', e);
      showToast('データの更新に失敗しました。通信状況をご確認ください。');
    } finally {
      isUpdating = false;
    }
  }, CONFIG.REFRESH_INTERVAL);

  // 実施中レース判定タイマー（独立管理）
  timers.highlight = setInterval(highlightCurrentRace, 60000);

  // ページ離脱時にタイマーをクリア（beforeunload + pagehide 両対応）
  const cleanup = () => {
    clearInterval(timers.refresh);
    clearInterval(timers.highlight);
  };
  window.addEventListener('beforeunload', cleanup, { once: true });
  window.addEventListener('pagehide', cleanup, { once: true });
}

// ========= オフライン検知 =========

/**
 * オンライン/オフラインイベントを監視してステータスバーに反映する
 */
function setupOfflineDetection() {
  // 重複登録防止
  if (window.__offlineListenerAdded) return;
  window.__offlineListenerAdded = true;

  window.addEventListener('offline', () => {
    isOffline = true;
    updateOfflineStatus();
    showToast('⚠️ オフラインです。キャッシュ表示中。');
  });
  window.addEventListener('online', () => {
    isOffline = false;
    updateOfflineStatus();
    showToast('✓ オンライン復帰 - 最新データを取得中');
    setTimeout(() => manualRefresh(), 500);
  });
}

/**
 * オフライン状態をステータスバーに反映する
 */
function updateOfflineStatus() {
  const timeEl = document.getElementById('last-updated');
  if (!timeEl) return;
  if (isOffline) {
    const timeStr = lastUpdated ? lastUpdated.toLocaleTimeString('ja-JP') : '-';
    timeEl.textContent = `⚠️ オフライン中 - 最後の更新: ${timeStr}`;
  } else {
    // オンライン復帰時は通常表示に戻す
    if (lastUpdated) timeEl.textContent = lastUpdated.toLocaleTimeString('ja-JP');
  }
}

// ========= トースト通知 =========

/**
 * トースト通知を表示する（durationミリ秒後に自動消去）
 */
function showToast(message, duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  // アニメーション: 表示
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('toast-show'));
  });

  // durationミリ秒後にフェードアウトして削除
  setTimeout(() => {
    toast.classList.remove('toast-show');
    toast.classList.add('toast-hide');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
}

// ========= スケルトンUI =========

/**
 * データ読み込み前にスケルトンブロックを表示する
 */
function showSkeletonToggle() {
  const container = document.getElementById('view-toggle-content');
  if (!container) return;
  // 5つのスケルトンブロックを表示
  container.innerHTML = Array.from({ length: 5 }, () =>
    '<div class="toggle skeleton skeleton-toggle"></div>'
  ).join('');
}

/**
 * スケルトンブロックをクリアする
 */
function clearSkeletonToggle() {
  // renderToggleView() が上書きするので特に何もしなくてよいが、
  // エラー時用に明示的にクリアする
  const container = document.getElementById('view-toggle-content');
  if (container && container.querySelector('.skeleton-toggle')) {
    container.innerHTML = '';
  }
}

// ========= ユーティリティ =========

/**
 * スケジュールを event_code でグループ化して返す
 */
function groupByEventCode(schedule) {
  const map = new Map();
  schedule.forEach(race => {
    if (!map.has(race.event_code)) {
      map.set(race.event_code, {
        eventCode: race.event_code,
        eventName: race.event_name,
        category: race.category,
        races: [],
      });
    }
    map.get(race.event_code).races.push(race);
  });
  return Array.from(map.values());
}

/**
 * カテゴリとレース一覧がフィルタ条件に合うか判定する
 */
function matchesFilter(category, races) {
  return true; // 表示時にtoggle単位で制御するので常にtrue
}

/**
 * "07:00" → "7:00" に変換（先頭ゼロを除去）
 * スケジュールビューやレースヘッダーで使用する
 */
function formatRaceTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return '--:--';
  const parts = timeStr.split(':');
  if (parts.length !== 2) return '--:--';
  const h = parseInt(parts[0], 10);
  if (isNaN(h)) return '--:--';
  return `${h}:${parts[1]}`;
}

/**
 * YYYY-MM-DD を M/D 形式にフォーマットする
 */
function formatDate(dateStr) {
  if (!dateStr || dateStr === 'all') return dateStr || '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return '';
  return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}`;
}

/**
 * YouTube URL から動画IDを抽出する
 */
function extractYoutubeId(url) {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * 種目コードの表示用変換（アンダースコアを除去）
 * 内部データ（event_code）は変更せず、表示時のみ変換する
 */
function displayCode(code) {
  return code ? code.replace(/_/g, '') : '';
}

/**
 * スケジュール全体を走査して使用中のプロパティセットを返す
 */
function detectUsedProps() {
  if (!masterData) return {};
  const schedule = masterData.schedule || [];
  return {
    hasAgeGroup: schedule.some(r => r.age_group && r.age_group.trim() !== ''),
    hasRound:    schedule.some(r => r.round    && r.round.trim()    !== ''),
  };
}

/**
 * ミリ秒を "M:SS.cc" 形式（センチ秒2桁）にフォーマットする
 * 例: 112834 → "1:52.83"
 * JSONのformattedが正しく生成されている場合は不要だが、
 * 将来的にms→表示変換が必要になった場合のためのユーティリティ
 * @param {number} ms
 * @returns {string}
 */
function formatTime(ms) {
  const totalCentiseconds = Math.floor(ms / 10);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  return minutes + ':' + String(seconds).padStart(2, '0') + '.' + String(centiseconds).padStart(2, '0');
}

/**
 * ローディング表示の切替
 */
function showLoading(show) {
  const el = document.getElementById('loading');
  if (el) el.style.display = show ? 'block' : 'none';
}

/**
 * エラーメッセージをカード形式で表示する
 */
function showError(msg) {
  const el = document.getElementById('error-message');
  if (el) {
    el.innerHTML = `
      <div class="error-card">
        <div class="error-icon">⚠</div>
        <div class="error-title">データを読み込めませんでした</div>
        <div class="error-body">${msg || 'しばらく待ってから画面を更新してください'}</div>
        <button onclick="location.reload()">再読み込み</button>
      </div>`;
    el.style.display = 'block';
  }
}
