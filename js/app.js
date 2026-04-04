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

// ========= グローバル状態 =========
let masterData = null;       // master.json の内容
let resultsCache = {};       // race_no → race_XXX.json の内容
let lastUpdated = null;      // 最終更新時刻
let refreshTimer = null;     // 自動更新タイマー
// フィルタ状態
const filterState = { category: 'all', round: 'all', date: 'all', crew: '' };

// ========= 初期化 =========
document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  setupRefreshTimer();
});

/**
 * マスタと全結果を読み込んでUIを描画する
 */
async function loadAll() {
  try {
    showLoading(true);
    masterData = await fetchJSON(CONFIG.MASTER_JSON);
    await loadResults();
    renderAll();
    updateStatusBar();
    lastUpdated = new Date();
  } catch (e) {
    console.error('データ読み込みエラー:', e);
    showError('データの読み込みに失敗しました。しばらく待ってから再試行してください。');
  } finally {
    showLoading(false);
  }
}

/**
 * 全レースの結果JSONを並列 fetch する（存在しないものはスキップ）
 */
async function loadResults() {
  const raceNos = masterData.schedule.map(r => r.race_no);
  const promises = raceNos.map(async (no) => {
    try {
      const data = await fetchJSON(CONFIG.RESULT_JSON(no));
      resultsCache[no] = data;
    } catch (_) {
      // 結果未投入のレースは無視する
    }
  });
  await Promise.all(promises);
  console.log(`結果JSON読み込み完了: ${Object.keys(resultsCache).length}/${raceNos.length}件`);
}

/**
 * JSONをfetchしてパースする
 */
async function fetchJSON(path) {
  const res = await fetch(path + '?t=' + Date.now());
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${path}`);
  return res.json();
}

// ========= 描画 =========

/**
 * 全UIを描画する
 */
function renderAll() {
  renderTournamentHeader();
  renderYoutube();
  renderFilterOptions();
  renderToggleView();
  renderTableView();
}

/**
 * 大会名・日程・会場をヘッダーに反映する
 */
function renderTournamentHeader() {
  const t = masterData.tournament;
  const el = document.getElementById('tournament-name');
  if (el) el.textContent = '🏁 ' + t.name;

  const metaEl = document.getElementById('tournament-meta');
  if (metaEl) {
    const dates = t.dates.map(d => formatDate(d)).join('・');
    metaEl.innerHTML = `<span>📅 ${dates}</span><span>📍 ${t.venue}</span>`;
  }
}

/**
 * YouTube Live URLがあれば埋め込む
 */
function renderYoutube() {
  const url = masterData.tournament.youtube_url;
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
 * フィルタの日程オプションをマスタから動的生成する
 */
function renderFilterOptions() {
  const dates = [...new Set(masterData.schedule.map(r => r.date))].sort();
  const daySelect = document.getElementById('filter-day');
  if (!daySelect) return;

  // 既存のオプション（"all"）を残して追加
  while (daySelect.options.length > 1) daySelect.remove(1);
  dates.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = `${i + 1}日目 (${formatDate(d)})`;
    daySelect.appendChild(opt);
  });
}

/**
 * 種目別トグルビューを描画する
 */
function renderToggleView() {
  const container = document.getElementById('view-toggle-content');
  if (!container) return;

  // 種目コードでグループ化
  const groups = groupByEventCode(masterData.schedule);

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
    toggleEl.dataset.crews = races.flatMap(r =>
      (r.entries || []).map(e => `${e.crew_name} ${e.affiliation}`)
    ).join(' ').toLowerCase();

    toggleEl.innerHTML = `
      <div class="toggle-header" onclick="this.parentElement.classList.toggle('open')">
        <span class="toggle-arrow">▶</span>
        <span class="toggle-title">${eventName}</span>
        <span class="toggle-code">${eventCode}</span>
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
  const ageLabel = race.age_group ? `(${race.age_group})` : '';

  const statusBadge = result
    ? '<span class="badge badge-done">確定</span>'
    : '<span class="badge badge-upcoming">未実施</span>';

  const tableHTML = result
    ? renderResultTable(race, result)
    : '<p class="no-result">結果は未投入です</p>';

  return `
    <div class="race-header">
      <div>
        <span class="race-label">${race.event_name}${ageLabel} ${roundName}</span>
        ${statusBadge}
      </div>
      <div class="race-info">Race No.${race.race_no} | ${dateStr} ${race.time}</div>
    </div>
    ${tableHTML}`;
}

/**
 * レース結果テーブルHTMLを返す
 */
function renderResultTable(race, result) {
  const pts = masterData.measurement_points || ['500m', '1000m'];
  const showMidpoint = pts.length > 1;

  // エントリー情報をlaneで引く
  const entryMap = {};
  (race.entries || []).forEach(e => { entryMap[e.lane] = e; });

  // 結果をrank順にソート
  const sorted = [...result.results].sort((a, b) => a.rank - b.rank);

  const rankIcon = (rank) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return rank;
  };

  const rows = sorted.map(r => {
    const entry = entryMap[r.lane] || {};
    const midTime = showMidpoint && r.times && r.times[pts[0]]
      ? `<span class="time-split">${r.times[pts[0]].formatted}</span>`
      : '-';

    const rankClass = r.rank <= 3 ? `rank-${r.rank}` : '';
    const photoMark = r.photo_flag ? '📷' : '';
    const note = r.note ? `<span style="color:#e03e3e;font-size:11px">${r.note}</span>` : '';

    return `
      <tr class="${rankClass}">
        <td>${rankIcon(r.rank)}</td>
        <td>${r.lane}</td>
        <td class="crew-name">${entry.crew_name || '-'}</td>
        <td>${entry.affiliation || '-'}</td>
        <td class="hide-mobile">${midTime}</td>
        <td>
          <span class="time-main">${r.finish ? r.finish.formatted : '-'}</span>
          ${r.split ? `<div class="time-half">${r.split}</div>` : ''}
        </td>
        <td>${photoMark}${note}</td>
      </tr>`;
  }).join('');

  const midHeader = showMidpoint
    ? `<th class="hide-mobile" style="width:70px">${pts[0]}</th>`
    : '';

  return `
    <table class="result-table">
      <thead>
        <tr>
          <th style="width:36px">順位</th>
          <th style="width:28px">B</th>
          <th>クルー名</th>
          <th>所属</th>
          ${midHeader}
          <th style="width:90px">フィニッシュ</th>
          <th style="width:40px">備考</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * 全レーステーブルビューを描画する
 */
function renderTableView() {
  const tbody = document.getElementById('db-table-body');
  if (!tbody) return;

  const pts = masterData.measurement_points || ['500m', '1000m'];
  const rows = [];

  masterData.schedule.forEach(race => {
    const result = resultsCache[race.race_no];
    const entryMap = {};
    (race.entries || []).forEach(e => { entryMap[e.lane] = e; });
    const roundName = CONFIG.ROUND_NAMES[race.round] || race.round;
    const roundClass = race.round === 'FA' || race.round === 'FB' ? 'db-round-fa'
      : race.round === 'H' ? 'db-round-h' : 'db-round-rk';

    if (result) {
      const sorted = [...result.results].sort((a, b) => a.rank - b.rank);
      sorted.forEach(r => {
        const entry = entryMap[r.lane] || {};
        const midTime = r.times && r.times[pts[0]] ? r.times[pts[0]].formatted : '-';
        const rankIcon = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank;
        rows.push(`
          <tr>
            <td>${race.race_no}</td>
            <td><span class="db-code">${race.event_code}</span></td>
            <td>${race.event_name}</td>
            <td>${race.age_group || '-'}</td>
            <td><span class="db-round ${roundClass}">${roundName}</span></td>
            <td>${formatDate(race.date)}</td>
            <td>${race.time}</td>
            <td>${rankIcon}</td>
            <td>${r.lane}</td>
            <td class="crew-name">${entry.crew_name || '-'}</td>
            <td>${entry.affiliation || '-'}</td>
            <td class="time-split">${midTime}</td>
            <td class="time-main">${r.finish ? r.finish.formatted : '-'}</td>
            <td>${r.note || ''}</td>
          </tr>`);
      });
    } else {
      // 結果未投入のレースはエントリーのみ表示
      (race.entries || []).forEach(e => {
        rows.push(`
          <tr style="color:#ccc">
            <td>${race.race_no}</td>
            <td><span class="db-code">${race.event_code}</span></td>
            <td>${race.event_name}</td>
            <td>${race.age_group || '-'}</td>
            <td><span class="db-round ${roundClass}">${roundName}</span></td>
            <td>${formatDate(race.date)}</td>
            <td>${race.time}</td>
            <td>-</td>
            <td>${e.lane}</td>
            <td class="crew-name">${e.crew_name}</td>
            <td>${e.affiliation}</td>
            <td>-</td>
            <td>-</td>
            <td></td>
          </tr>`);
      });
    }
  });

  tbody.innerHTML = rows.join('');
  updateDbTableCount();
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

  document.querySelectorAll('#view-toggle-content .toggle').forEach(toggle => {
    const cat = toggle.dataset.category;
    const code = toggle.dataset.code;
    const crews = toggle.dataset.crews || '';

    let show = true;
    if (filterState.category !== 'all' && cat !== filterState.category) show = false;
    if (filterState.crew && !crews.includes(filterState.crew)) show = false;

    // round・date フィルタはトグル内のレースで判定
    if (show && (filterState.round !== 'all' || filterState.date !== 'all')) {
      const races = masterData.schedule.filter(r => r.event_code === code);
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
  ['filter-cat', 'filter-round', 'filter-day'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = 'all';
  });
  const crewEl = document.getElementById('filter-crew');
  if (crewEl) crewEl.value = '';
  Object.assign(filterState, { category: 'all', round: 'all', date: 'all', crew: '' });

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
  const el = document.getElementById('db-count');
  if (!el) return;
  const count = document.querySelectorAll('#db-table-body tr').length;
  el.textContent = `全 ${count} 件`;
}

// ========= ビュー切替 =========

/**
 * ビュータブを切り替える
 */
function switchView(id) {
  document.querySelectorAll('.view-content').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
  const content = document.getElementById('view-' + id);
  if (content) content.classList.add('active');
  event.target.closest('.view-tab').classList.add('active');
}

// ========= ステータスバー =========

/**
 * ステータスバーを更新する
 */
function updateStatusBar() {
  const timeEl = document.getElementById('last-updated');
  if (timeEl && lastUpdated) {
    timeEl.textContent = lastUpdated.toLocaleTimeString('ja-JP');
  }

  const summaryEl = document.getElementById('status-summary');
  if (summaryEl && masterData) {
    const totalRaces = masterData.schedule.length;
    const doneRaces = Object.keys(resultsCache).length;
    const totalEntries = masterData.schedule.reduce((sum, r) => sum + (r.entries?.length || 0), 0);
    summaryEl.textContent = `${doneRaces}/${totalRaces}レース確定 / ${totalEntries}エントリー`;
  }
}

// ========= 自動更新 =========

/**
 * 自動更新タイマーをセットする
 */
function setupRefreshTimer() {
  refreshTimer = setInterval(async () => {
    console.log('自動更新中...');
    try {
      await loadResults();
      renderToggleView();
      renderTableView();
      lastUpdated = new Date();
      updateStatusBar();
    } catch (e) {
      console.error('自動更新エラー:', e);
    }
  }, CONFIG.REFRESH_INTERVAL);
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
 * YYYY-MM-DD を M/D 形式にフォーマットする
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const [, m, d] = dateStr.split('-');
  return `${parseInt(m)}/${parseInt(d)}`;
}

/**
 * YouTube URL から動画IDを抽出する
 */
function extractYoutubeId(url) {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * ローディング表示の切替
 */
function showLoading(show) {
  const el = document.getElementById('loading');
  if (el) el.style.display = show ? 'block' : 'none';
}

/**
 * エラーメッセージを表示する
 */
function showError(msg) {
  const el = document.getElementById('error-message');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}
