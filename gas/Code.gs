/**
 * ボート競技ライブリザルト - Google Apps Script
 * Google Drive のCSVを監視し、GitHub にレース結果JSONをPushする
 */

// ============================================================
// ▼▼▼ はじめにここだけ入力してください ▼▼▼
// ============================================================

// 1. Google Drive のルートフォルダID
//    （DriveでフォルダURLの末尾の文字列 例: https://drive.google.com/drive/folders/★ここ★）
const SETUP_DRIVE_FOLDER_ID = '';  // ← ここに貼り付け（saveSetup()実行後は空に戻してください）

// 2. GitHub Personal Access Token
//    （https://github.com/settings/tokens で取得）
const SETUP_GITHUB_TOKEN = '';  // ← ここに貼り付け例: 'ghp_xxxxxxxxxxxx'

// 3. 計測ポイント（カンマ区切り、変更不要）
const SETUP_MEASUREMENT_POINTS = '500,1000';

// ============================================================
// ▲▲▲ 入力ここまで ▲▲▲
// ============================================================

/**
 * 上記の値をスクリプトプロパティに保存する
 * ★最初に1回だけこの関数を実行してください★
 */
function saveSetup() {
  if (!SETUP_GITHUB_TOKEN || SETUP_GITHUB_TOKEN.trim() === '') {
    Logger.log('[エラー] SETUP_GITHUB_TOKEN が空です。コード上部に GitHub Token を入力してください。');
    return;
  }
  if (!SETUP_DRIVE_FOLDER_ID || SETUP_DRIVE_FOLDER_ID.trim() === '') {
    Logger.log('[エラー] SETUP_DRIVE_FOLDER_ID が空です。コード上部にフォルダIDを入力してください。');
    return;
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty('DRIVE_ROOT_FOLDER_ID', SETUP_DRIVE_FOLDER_ID.trim());
  props.setProperty('GITHUB_TOKEN', SETUP_GITHUB_TOKEN.trim());
  props.setProperty('MEASUREMENT_POINTS', SETUP_MEASUREMENT_POINTS.trim());
  Logger.log('[OK] スクリプトプロパティを保存しました');
  Logger.log('  DRIVE_ROOT_FOLDER_ID = ' + SETUP_DRIVE_FOLDER_ID);
  Logger.log('  GITHUB_TOKEN = ' + SETUP_GITHUB_TOKEN.substring(0, 6) + '***');
  Logger.log('  MEASUREMENT_POINTS = ' + SETUP_MEASUREMENT_POINTS);
  Logger.log('');
  Logger.log('次のステップ: setupAll() を実行してください');
}

// ============================================================
// ▼▼▼ テスト実行用ショートカット（ドロップダウンから選んで実行） ▼▼▼
// ============================================================

/** テスト用: R001〜R005のCSVをDriveに生成 */
function runTest1to5() { createTestCSVs(); }

/** テスト用: R006（棄権・途中棄権）のCSVをDriveに生成 */
function runTest006() { createTestRace006(); }

/** テスト用: マスターデータをGitHubにPush */
function runImportMaster() { importMasterData(); }

/** 手動: CSVを今すぐ処理してJSONをPush */
function runNow() { processPendingCSVs(); }

// ============================================================
// 設定オブジェクト
// ============================================================
const CONFIG = {
  // GitHub リポジトリ情報
  github: {
    owner: 'RYUIYAMADA',
    repo: 'rowing-live-results',
    branch: 'main',
    resultsPath: 'data/results',
    masterPath: 'data/master.json',
    apiBase: 'https://api.github.com',
  },
  // Google Drive フォルダ名
  folders: {
    raceCsv: 'race_csv',
    master: 'master',
    processed: 'processed',
  },
  // CSVファイル名の正規表現パターン
  // 推奨形式: R001_500.csv / R001_1000.csv
  // 旧形式（後方互換）: 20260309_002304_R001_500m.csv
  csvPattern: /^(?:\d{8}_\d{6}_)?R(\d{3})_(.+)\.csv$/i,
  // スクリプトプロパティキー
  props: {
    driveFolderId: 'DRIVE_ROOT_FOLDER_ID',
    githubToken: 'GITHUB_TOKEN',
    measurementPoints: 'MEASUREMENT_POINTS',
    lastError: 'LAST_ERROR',
    apiRateLimited: 'API_RATE_LIMITED',
  },
  // 最大実行時間（ミリ秒）
  maxExecutionMs: 4 * 60 * 1000,
};

// ============================================================
// 1. メイントリガー関数（2分間隔で実行）
// ============================================================

/**
 * スケジュールトリガーから呼ばれるメイン関数
 * 実行時間が5分を超えたら自動停止する
 */
function onTrigger() {
  const startTime = Date.now();
  Logger.log('[onTrigger] 開始: ' + new Date().toISOString());

  // 二重実行防止ロック（前の実行がまだ動いていればスキップ）
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('[onTrigger] 別の実行が進行中のためスキップ（5秒待機後もロック取得失敗）');
    return;
  }

  try {
    // API レート制限フラグを確認（1時間経過で自動解除）
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(CONFIG.props.apiRateLimited) === 'true') {
      const flaggedAt = parseInt(props.getProperty('API_RATE_LIMITED_AT') || '0', 10);
      const elapsed = Date.now() - flaggedAt;
      if (elapsed < 15 * 60 * 1000) {
        Logger.log('[onTrigger] API レート制限中のため処理をスキップ（残り約' + Math.ceil((15 * 60 * 1000 - elapsed) / 60000) + '分）');
        return;
      }
      // 1時間経過したら自動解除
      props.deleteProperty(CONFIG.props.apiRateLimited);
      props.deleteProperty('API_RATE_LIMITED_AT');
      Logger.log('[onTrigger] API レート制限フラグを自動解除しました');
    }

    processPendingCSVs(startTime);

    // 定期実行ハートビート：master.json の last_trigger_at を更新
    try {
      updateTriggerHeartbeat_();
    } catch (e) {
      Logger.log('[onTrigger] ハートビート更新失敗（処理には影響なし）: ' + e.message);
    }

    const elapsed = Date.now() - startTime;
    Logger.log('[onTrigger] 完了: ' + elapsed + 'ms');
  } catch (e) {
    Logger.log('[onTrigger] エラー: ' + e.message);
    recordError('onTrigger', e);
  } finally {
    lock.releaseLock();
  }
}

/**
 * master.json の last_trigger_at フィールドのみを更新する
 * 定期トリガーが正常に動作していることを管理者ダッシュボードで確認できるようにするため
 */
function updateTriggerHeartbeat_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(CONFIG.props.githubToken);
  if (!token) return;

  const apiUrl = CONFIG.github.apiBase + '/repos/' + CONFIG.github.owner + '/' +
    CONFIG.github.repo + '/contents/' + CONFIG.github.masterPath;

  // 現在の master.json を取得
  const getRes = UrlFetchApp.fetch(apiUrl, {
    method: 'GET',
    headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github.v3+json' },
    muteHttpExceptions: true,
  });
  if (getRes.getResponseCode() !== 200) {
    Logger.log('[heartbeat] master.json 取得失敗: ' + getRes.getResponseCode());
    return;
  }

  const existing = JSON.parse(getRes.getContentText());
  const currentContent = Utilities.newBlob(Utilities.base64Decode(existing.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  const masterJson = JSON.parse(currentContent);

  // last_trigger_at のみ更新
  masterJson.last_trigger_at = new Date().toISOString();

  const newContent = Utilities.base64Encode(JSON.stringify(masterJson, null, 2), Utilities.Charset.UTF_8);
  UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      message: 'heartbeat: update last_trigger_at [GAS auto]',
      content: newContent,
      sha: existing.sha,
      branch: CONFIG.github.branch,
    }),
    muteHttpExceptions: true,
  });
  Logger.log('[heartbeat] last_trigger_at 更新完了: ' + masterJson.last_trigger_at);
}

// ============================================================
// 2. 未処理CSVを全件処理
// ============================================================

/**
 * race_csv/ 以下のCSVを走査し、計測ポイントが揃ったレースをPushする
 * @param {number} startTime - 開始時刻（ミリ秒）
 */
function processPendingCSVs(startTime) {
  Logger.log('[processPendingCSVs] 開始');

  const props = PropertiesService.getScriptProperties();
  const rootFolderId = props.getProperty(CONFIG.props.driveFolderId);
  const measurementPoints = getMeasurementPoints();

  if (!rootFolderId) {
    throw new Error('DRIVE_ROOT_FOLDER_ID が設定されていません');
  }

  const rootFolder = DriveApp.getFolderById(rootFolderId);

  // race_csv フォルダを取得
  const raceCsvFolder = getOrCreateFolder(rootFolderId, CONFIG.folders.raceCsv);

  // 計測ポイントごとにCSVファイルを収集
  // raceFiles: { raceNo: { "500m": file, "1000m": file } }
  const raceFiles = {};

  for (const point of measurementPoints) {
    const pointFolder = getOrCreateFolder(raceCsvFolder.getId(), point);
    const files = pointFolder.getFiles();

    while (files.hasNext()) {
      const file = files.next();
      const fileName = file.getName();
      const match = fileName.match(CONFIG.csvPattern);

      if (!match) {
        Logger.log('[processPendingCSVs] パターン不一致のためスキップ: ' + fileName);
        continue;
      }

      const raceNo = parseInt(match[1], 10);
      const filePoint = match[2];

      if (filePoint !== point) {
        Logger.log('[processPendingCSVs] ポイント不一致のためスキップ: ' + fileName);
        continue;
      }

      if (!raceFiles[raceNo]) {
        raceFiles[raceNo] = {};
      }
      // 同じレース・同じポイントで複数ファイルがある場合は新しい方を採用
      // 旧形式（YYYYMMDD_HHMMSS_...）はファイル名比較、簡略形式（R001_...）はDriveの更新日時で比較
      const existing = raceFiles[raceNo][point];
      if (existing) {
        const isNewerByName = existing.getName() < fileName; // 旧形式：名前の辞書順で新しい
        const isNewerByDate = file.getLastUpdated() > existing.getLastUpdated(); // 簡略形式：更新日時
        const useNew = isNewerByName || (!isNewerByName && isNewerByDate);
        if (!useNew) {
          Logger.log('[processPendingCSVs] 古いファイルのためスキップ: ' + fileName + ' (採用中: ' + existing.getName() + ')');
          continue;
        }
      }
      raceFiles[raceNo][point] = file;
      Logger.log('[processPendingCSVs] CSV検知: race_no=' + raceNo + ' point=' + point + ' file=' + fileName);
    }
  }

  // 全計測ポイントが揃ったレースを処理
  for (const raceNo in raceFiles) {
    // 実行時間チェック
    if (startTime && Date.now() - startTime > CONFIG.maxExecutionMs) {
      Logger.log('[processPendingCSVs] 最大実行時間を超過したため停止');
      break;
    }

    const files = raceFiles[raceNo];
    const collectedPoints = Object.keys(files);
    const allPointsReady = measurementPoints.every(p => collectedPoints.includes(p));

    if (!allPointsReady) {
      Logger.log('[processPendingCSVs] race_no=' + raceNo + ' 計測ポイント未揃い: ' + collectedPoints.join(','));
      continue;
    }

    Logger.log('[processPendingCSVs] race_no=' + raceNo + ' 全ポイント揃い。処理開始');

    try {
      buildAndPushRaceJSON(parseInt(raceNo, 10), files, measurementPoints);
    } catch (e) {
      Logger.log('[processPendingCSVs] race_no=' + raceNo + ' 処理エラー: ' + e.message);
      recordError('processPendingCSVs_race' + raceNo, e);
    }
  }

  Logger.log('[processPendingCSVs] 完了');
}

/**
 * レースJSONを組み立てて GitHub に Push し、CSVをprocessed/へ移動する
 * @param {number} raceNo
 * @param {{ [point: string]: GoogleAppsScript.Drive.File }} files
 * @param {string[]} measurementPoints
 */
function buildAndPushRaceJSON(raceNo, files, measurementPoints) {
  // 各計測ポイントのCSVをパース
  const measurementData = {};
  for (const point of measurementPoints) {
    const file = files[point];
    const csvContent = file.getBlob().getDataAsString('UTF-8');
    measurementData[point] = parseResultCSV(csvContent);
    Logger.log('[buildAndPushRaceJSON] race_no=' + raceNo + ' point=' + point + ' rows=' + measurementData[point].length);
  }

  // JSON組み立て
  const raceJson = buildRaceJSON(raceNo, measurementData, measurementPoints);

  // GitHub へ Push
  const paddedNo = String(raceNo).padStart(3, '0');
  const path = CONFIG.github.resultsPath + '/race_' + paddedNo + '.json';
  pushToGitHub(path, JSON.stringify(raceJson, null, 2));

  // CSVを processed/ へ移動
  for (const point of measurementPoints) {
    moveToProcessed(files[point], point);
  }

  Logger.log('[buildAndPushRaceJSON] race_no=' + raceNo + ' Push完了');
}

// ============================================================
// 3. CSVパーサー
// ============================================================

/**
 * RowingTimerWeb の計測結果CSVをパースする
 * ヘッダー: measurement_point,lane,lap_index,time_ms,formatted,race_no,tie_group,photo_flag,note
 * @param {string} csvContent
 * @returns {{ lane: number, time_ms: number, formatted: string, tie_group: string, photo_flag: boolean, note: string }[]}
 */
function parseResultCSV(csvContent) {
  // BOM除去（Excel保存CSVで付与される場合がある）
  const cleaned = removeBom_(csvContent);
  const lines = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const results = [];

  // 1行目はヘッダーなのでスキップ
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCsvLine(line);
    if (cols.length < 9) {
      Logger.log('[parseResultCSV] カラム数不足のためスキップ: ' + line);
      continue;
    }

    // measurement_point,lane,lap_index,time_ms,formatted,race_no,tie_group,photo_flag,note
    const lane = parseInt(cols[1], 10);
    const time_ms = parseInt(cols[3], 10);

    // NaNチェック: 数値変換失敗の行はスキップ
    if (isNaN(lane) || isNaN(time_ms)) {
      Logger.log('[parseResultCSV] 数値変換エラーのためスキップ: lane=' + cols[1] + ' time_ms=' + cols[3]);
      continue;
    }

    results.push({
      lane: lane,
      time_ms: time_ms,
      formatted: cols[4].trim(),
      tie_group: cols[6].trim(),
      photo_flag: cols[7].trim().toLowerCase() === 'true' || cols[7].trim() === '1',
      note: cols[8].trim(),
    });
  }

  return results;
}

/**
 * CSV 1行をカラム配列にパースする（ダブルクォート対応）
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ============================================================
// 4. レースJSON組み立て
// ============================================================

/**
 * race_XXX.json を組み立てる
 * @param {number} raceNo
 * @param {{ [point: string]: object[] }} measurementData
 * @param {string[]} measurementPoints - 順序付き計測ポイント配列（例: ["500m","1000m"]）
 * @returns {object}
 */
function buildRaceJSON(raceNo, measurementData, measurementPoints) {
  // 最初と最後の計測ポイント
  const firstPoint = measurementPoints[0];
  const lastPoint = measurementPoints[measurementPoints.length - 1];

  // レーンをキーにしてデータをマージ
  const laneMap = {};

  for (const point of measurementPoints) {
    const rows = measurementData[point] || [];
    for (const row of rows) {
      if (!laneMap[row.lane]) {
        laneMap[row.lane] = {
          lane: row.lane,
          times: {},
          tie_group: row.tie_group,
          photo_flag: row.photo_flag,
          note: row.note,
        };
      }
      laneMap[row.lane].times[point] = {
        time_ms: row.time_ms,
        // CSVのformatted値は無視し、time_msから再計算（センチ秒2桁統一）
        formatted: formatTime(row.time_ms),
      };
      // 最後のポイントの情報で上書き（tie_group等はフィニッシュ基準）
      if (point === lastPoint) {
        laneMap[row.lane].tie_group = row.tie_group;
        laneMap[row.lane].photo_flag = row.photo_flag;
        laneMap[row.lane].note = row.note;
      }
    }
  }

  // フィニッシュあり（完走）とDNF（途中棄権）に分ける
  const allLanes = Object.values(laneMap);
  const laneEntries = allLanes.filter(entry => entry.times[lastPoint]);
  const dnfLanes = allLanes.filter(entry => !entry.times[lastPoint]);

  // 完走レーンをフィニッシュタイムでソート
  laneEntries.sort((a, b) => a.times[lastPoint].time_ms - b.times[lastPoint].time_ms);

  // ランク付け（同着考慮）
  let rank = 1;
  for (let i = 0; i < laneEntries.length; i++) {
    if (i > 0) {
      const prev = laneEntries[i - 1];
      const curr = laneEntries[i];
      const prevTieGroup = prev.tie_group;
      const currTieGroup = curr.tie_group;

      // tie_group が同じ非空文字列なら同順位
      const isTied = prevTieGroup && currTieGroup && prevTieGroup === currTieGroup;
      if (!isTied) {
        rank = i + 1;
      }
    }
    laneEntries[i].rank = rank;
  }

  // split タイム計算（計測ポイントが2つ以上の場合）
  const finishedResults = laneEntries.map(entry => {
    let split = '';
    if (measurementPoints.length >= 2 && entry.times[firstPoint] && entry.times[lastPoint]) {
      const splitMs = entry.times[lastPoint].time_ms - entry.times[firstPoint].time_ms;
      split = '(' + formatTime(splitMs) + ')';
    }
    return {
      lane: entry.lane,
      rank: entry.rank,
      times: entry.times,
      finish: entry.times[lastPoint] || null,
      split: split,
      tie_group: entry.tie_group || '',
      photo_flag: entry.photo_flag || false,
      note: entry.note || '',
      status: 'finish',
    };
  });

  // 途中棄権（DNF）レーン: 順位なし
  const dnfResults = dnfLanes.map(entry => ({
    lane: entry.lane,
    rank: null,
    times: entry.times,
    finish: null,
    split: '',
    tie_group: '',
    photo_flag: false,
    note: entry.note || '',
    status: 'dnf',
  }));

  return {
    race_no: raceNo,
    updated_at: new Date().toISOString(),
    results: [...finishedResults, ...dnfResults],
  };
}

/**
 * ミリ秒を "M:SS.ss" 形式にフォーマットする
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

// ============================================================
// 5. GitHub Contents API Push
// ============================================================

/**
 * GitHub Contents API でファイルをPushする
 * 既存ファイルがある場合はSHAを取得してPUT
 * @param {string} path - リポジトリ内のパス（例: data/results/race_001.json）
 * @param {string} content - ファイルの内容（文字列）
 */
function pushToGitHub(path, content) {
  Logger.log('[pushToGitHub] path=' + path);

  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(CONFIG.props.githubToken);

  if (!token) {
    throw new Error('GITHUB_TOKEN が設定されていません');
  }

  const apiUrl = CONFIG.github.apiBase + '/repos/' + CONFIG.github.owner + '/' +
    CONFIG.github.repo + '/contents/' + path;

  // 既存ファイルのSHAを取得（存在しない場合はnull）
  let sha = null;
  try {
    const getResponse = UrlFetchApp.fetch(apiUrl, {
      method: 'GET',
      headers: {
        Authorization: 'token ' + token,
        Accept: 'application/vnd.github.v3+json',
      },
      muteHttpExceptions: true,
    });

    if (getResponse.getResponseCode() === 200) {
      const existing = JSON.parse(getResponse.getContentText());
      sha = existing.sha;
      Logger.log('[pushToGitHub] 既存ファイルSHA: ' + sha);
    } else if (getResponse.getResponseCode() === 404) {
      Logger.log('[pushToGitHub] 新規ファイルとして作成');
    } else {
      checkRateLimit(getResponse);
    }
  } catch (e) {
    Logger.log('[pushToGitHub] GET エラー: ' + e.message);
    throw e;
  }

  // コンテンツをBase64エンコード
  const encodedContent = Utilities.base64Encode(content, Utilities.Charset.UTF_8);

  const payload = {
    message: 'Update ' + path + ' [GAS auto-push]',
    content: encodedContent,
    branch: CONFIG.github.branch,
  };
  if (sha) {
    payload.sha = sha;
  }

  const putResponse = UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Authorization: 'token ' + token,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const statusCode = putResponse.getResponseCode();
  Logger.log('[pushToGitHub] PUT レスポンス: ' + statusCode);

  if (statusCode === 200 || statusCode === 201) {
    Logger.log('[pushToGitHub] Push成功: ' + path);
    return;
  }

  // エラー処理
  checkRateLimit(putResponse);
  throw new Error('GitHub Push失敗: HTTP ' + statusCode + ' ' + putResponse.getContentText());
}

/**
 * レート制限エラーを検知してスクリプトプロパティに記録し例外を投げる
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} response
 */
function checkRateLimit(response) {
  const code = response.getResponseCode();
  if (code === 401 || code === 403 || code === 429 || code === 503) {
    Logger.log('[checkRateLimit] GitHub API エラー検知: HTTP ' + code);
    const props = PropertiesService.getScriptProperties();
    props.setProperty(CONFIG.props.apiRateLimited, 'true');
    props.setProperty('API_RATE_LIMITED_AT', String(Date.now())); // 自動解除用タイムスタンプ
    props.setProperty(CONFIG.props.lastError, 'API error at ' + new Date().toISOString() + ': HTTP ' + code);
    throw new Error('GitHub API エラー: HTTP ' + code + '（1時間後に自動解除）');
  }
}

// ============================================================
// 6. 処理済みCSVをprocessed/へ移動
// ============================================================

/**
 * 処理済みCSVファイルを processed/{point}/ フォルダへ移動する
 * @param {GoogleAppsScript.Drive.File} file
 * @param {string} point - 計測ポイント名（例: "500m"）
 */
function moveToProcessed(file, point) {
  const fileName = file.getName();
  Logger.log('[moveToProcessed] ファイル移動: ' + fileName + ' -> processed/' + point + '/');

  try {
    const props = PropertiesService.getScriptProperties();
    const rootFolderId = props.getProperty(CONFIG.props.driveFolderId);

    const processedFolder = getOrCreateFolder(rootFolderId, CONFIG.folders.processed);
    const processedPointFolder = getOrCreateFolder(processedFolder.getId(), point);

    file.moveTo(processedPointFolder);
    Logger.log('[moveToProcessed] 移動完了: ' + fileName);
    return true;
  } catch (e) {
    Logger.log('[moveToProcessed] [エラー] ' + fileName + ' の移動に失敗: ' + e.message + ' ※手動で processed/' + point + '/ に移動してください');
    return false;
  }
}

// ============================================================
// 7. マスターデータのインポート（手動実行用）
// ============================================================

/**
 * master/ フォルダの schedule.csv と entries.csv から data/master.json を生成して GitHub にPushする
 * 手動実行用関数（トリガーには登録しない）
 */
function importMasterData() {
  Logger.log('[importMasterData] 開始');

  try {
    const props = PropertiesService.getScriptProperties();
    const rootFolderId = props.getProperty(CONFIG.props.driveFolderId);

    if (!rootFolderId) {
      throw new Error('DRIVE_ROOT_FOLDER_ID が設定されていません');
    }

    const masterFolder = getOrCreateFolder(rootFolderId, CONFIG.folders.master);

    // tournament.csv を読み込み（任意ファイル。なければデフォルト値を使用）
    let tournamentInfo = {};
    try {
      const tRows = readMasterFile_(masterFolder, 'tournament');
      if (tRows.length > 0) {
        // key,value 形式（1列目=項目名, 2列目=値）
        tRows.forEach(row => {
          const key = (row.key || row['項目'] || '').trim();
          const val = (row.value || row['値'] || '').trim();
          if (key) tournamentInfo[key] = val;
        });
        Logger.log('[importMasterData] tournament.csv 読込: ' + JSON.stringify(tournamentInfo));
      }
    } catch (e) {
      Logger.log('[importMasterData] tournament.csv なし（スキップ）');
    }

    // schedule を読み込み（CSV または Googleスプレッドシート どちらでも対応）
    const scheduleRows = readMasterFile_(masterFolder, 'schedule');
    Logger.log('[importMasterData] schedule 行数: ' + scheduleRows.length);

    // entries を読み込み（CSV または Googleスプレッドシート どちらでも対応）
    const entriesRows = readMasterFile_(masterFolder, 'entries');
    Logger.log('[importMasterData] entries 行数: ' + entriesRows.length);

    // master.json を組み立て
    // schedule.csv カラム: race_no,event_code,event_name,category,age_group,round,date,time[,course_length]
    // entries.csv カラム: race_no,lane,crew_name,affiliation

    // エントリーをrace_noでグループ化
    const entriesByRace = {};
    for (const row of entriesRows) {
      const raceNo = parseInt(row.race_no, 10);
      if (!entriesByRace[raceNo]) {
        entriesByRace[raceNo] = [];
      }
      const entry = {
        lane: parseInt(row.lane, 10),
        crew_name: row.crew_name || '',
        affiliation: row.affiliation || '',
      };
      // age_group が指定されている場合のみ追加（レースのage_groupと異なる場合に使用）
      if (row.age_group && row.age_group.trim()) {
        entry.age_group = row.age_group.trim();
      }
      entriesByRace[raceNo].push(entry);
    }

    // スケジュールをマージ
    // course_length: レースごとの距離（m）。省略時は大会デフォルト（後述）を使用
    const schedule = scheduleRows.map(row => {
      const raceNo = parseInt(row.race_no, 10);
      const raceCourseLength = row.course_length ? parseInt(row.course_length, 10) : null;
      const result = {
        race_no: raceNo,
        event_code: row.event_code || '',
        event_name: row.event_name || '',
        category: row.category || '',
        age_group: row.age_group || '',
        round: row.round || '',
        date: formatDateValue_(row.date),
        time: formatTimeValue_(row.time),
        entries: entriesByRace[raceNo] || [],
      };
      // course_length が指定されている場合のみセット（省略時はtournament.course_lengthを参照）
      if (raceCourseLength) result.course_length = raceCourseLength;
      return result;
    });

    // MEASUREMENT_POINTS プロパティから計測ポイント一覧を取得
    let measurementPointsList = [];
    try {
      measurementPointsList = getMeasurementPoints();
    } catch (e) {
      Logger.log('[importMasterData] MEASUREMENT_POINTS 未設定のため measurement_points は空配列');
    }

    const now = new Date().toISOString();
    const masterJson = {
      generated_at: now,
      updated_at: now,
      measurement_points: measurementPointsList,
      tournament: {
        race_name: tournamentInfo['race_name'] || '',
        // dates は schedule.csv の date 列から自動収集（tournament.csv で追加指定も可）
        dates: [...new Set([
          ...(tournamentInfo['dates'] ? tournamentInfo['dates'].split(',').map(d => d.trim()).filter(Boolean) : []),
          ...schedule.map(r => r.date).filter(Boolean),
        ])].sort(),
        venue: tournamentInfo['venue'] || '',
        course_length: tournamentInfo['course_length'] ? parseInt(tournamentInfo['course_length'], 10) : 1000,
        youtube_url: tournamentInfo['youtube_url'] || '',
      },
      schedule: schedule,
    };

    pushToGitHub(CONFIG.github.masterPath, JSON.stringify(masterJson, null, 2));
    Logger.log('[importMasterData] master.json Push完了');

  } catch (e) {
    Logger.log('[importMasterData] エラー: ' + e.message);
    recordError('importMasterData', e);
    throw e;
  }
}

/**
 * スプレッドシートのセル値を YYYY-MM-DD 形式の文字列に変換する
 * 文字列の場合はそのまま返す
 */
function formatDateValue_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  return String(val).trim();
}

/**
 * スプレッドシートのセル値を HH:MM 形式の文字列に変換する
 * Date型・数値（日付シリアル値の小数部）・文字列すべてに対応
 */
function formatTimeValue_(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) {
    const h = String(val.getHours()).padStart(2, '0');
    const m = String(val.getMinutes()).padStart(2, '0');
    return h + ':' + m;
  }
  // スプレッドシートの時刻は0〜1の小数値で格納されることがある（例: 0.2917 = 07:00）
  if (typeof val === 'number') {
    const totalMin = Math.round(val * 24 * 60);
    const h = String(Math.floor(totalMin / 60)).padStart(2, '0');
    const m = String(totalMin % 60).padStart(2, '0');
    return h + ':' + m;
  }
  return String(val).trim();
}

/**
 * ヘッダー付きCSVをオブジェクト配列にパースする
 * @param {string} csvContent
 * @returns {object[]}
 */
function parseMasterCSV(csvContent) {
  const lines = csvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const results = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cols[idx] || '').trim();
    });
    results.push(obj);
  }

  return results;
}

/**
 * フォルダ内から指定ファイル名のファイルを検索する
 * @param {GoogleAppsScript.Drive.Folder} folder
 * @param {string} fileName
 * @returns {GoogleAppsScript.Drive.File|null}
 */
/**
 * master/ フォルダから指定名のファイルを読み込む
 * CSV (.csv) と Googleスプレッドシート の両方に対応
 * @param {GoogleAppsScript.Drive.Folder} folder
 * @param {string} baseName - 拡張子なしのファイル名（例: 'schedule'）
 * @returns {Array<Object>} パース済み行データ
 */
function readMasterFile_(folder, baseName) {
  // まずCSVを探す
  const csvFile = findFileInFolder(folder, baseName + '.csv');
  if (csvFile) {
    Logger.log('[readMasterFile] CSV読み込み: ' + baseName + '.csv');
    return parseMasterCSV(removeBom_(csvFile.getBlob().getDataAsString('UTF-8')));
  }

  // 次にGoogleスプレッドシートを探す（拡張子なし）
  const ssFile = findFileInFolder(folder, baseName);
  if (ssFile) {
    Logger.log('[readMasterFile] スプレッドシート読み込み: ' + baseName);
    const ss = SpreadsheetApp.openById(ssFile.getId());
    const sheet = ss.getSheets()[0];
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return [];
    const headers = values[0].map(h => String(h).trim());
    return values.slice(1).map(row => {
      const obj = {};
      // Date型はそのまま保持（formatDateValue_/formatTimeValue_ で変換）
      headers.forEach((h, i) => {
        const v = row[i] ?? '';
        obj[h] = (v instanceof Date) ? v : String(v).trim();
      });
      return obj;
    });
  }

  throw new Error(
    baseName + '.csv（またはGoogleスプレッドシート "' + baseName + '"）が master/ フォルダに見つかりません。\n' +
    'Drive の master/ フォルダにアップロードしてから再実行してください。'
  );
}

function findFileInFolder(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    return files.next();
  }
  return null;
}

// ============================================================
// 8. フォルダ取得・作成ユーティリティ
// ============================================================

/**
 * 指定した親フォルダ内にフォルダを取得する。存在しない場合は作成する。
 * @param {string} parentId - 親フォルダのID
 * @param {string} name - フォルダ名
 * @returns {GoogleAppsScript.Drive.Folder}
 */
function getOrCreateFolder(parentId, name) {
  const parentFolder = DriveApp.getFolderById(parentId);
  const folders = parentFolder.getFoldersByName(name);

  if (folders.hasNext()) {
    return folders.next();
  }

  Logger.log('[getOrCreateFolder] フォルダ作成: ' + name + ' in ' + parentId);
  return parentFolder.createFolder(name);
}

// ============================================================
// 9. 動作確認用手動実行関数
// ============================================================

/**
 * 動作確認用のドライラン関数
 * DRY_RUN = true の場合、GitHub Push と processed/ 移動を行わない
 */
function testRun() {
  const DRY_RUN = true; // false にすると実際にPushと移動を実行する

  Logger.log('[testRun] 開始 (DRY_RUN=' + DRY_RUN + ')');

  try {
    const props = PropertiesService.getScriptProperties();
    const rootFolderId = props.getProperty(CONFIG.props.driveFolderId);
    const measurementPoints = getMeasurementPoints();

    Logger.log('[testRun] rootFolderId=' + rootFolderId);
    Logger.log('[testRun] measurementPoints=' + measurementPoints.join(','));

    if (!rootFolderId) {
      Logger.log('[testRun] DRIVE_ROOT_FOLDER_ID が未設定');
      return;
    }

    const raceCsvFolder = getOrCreateFolder(rootFolderId, CONFIG.folders.raceCsv);
    Logger.log('[testRun] race_csv フォルダID: ' + raceCsvFolder.getId());

    // 計測ポイントごとにCSVを収集
    const raceFiles = {};
    for (const point of measurementPoints) {
      const pointFolder = getOrCreateFolder(raceCsvFolder.getId(), point);
      Logger.log('[testRun] ' + point + ' フォルダID: ' + pointFolder.getId());

      const files = pointFolder.getFiles();
      let count = 0;
      while (files.hasNext()) {
        const file = files.next();
        count++;
        const fileName = file.getName();
        const match = fileName.match(CONFIG.csvPattern);
        Logger.log('[testRun] ファイル: ' + fileName + ' マッチ: ' + (match ? 'Yes race_no=' + parseInt(match[1], 10) : 'No'));

        if (match) {
          const raceNo = parseInt(match[1], 10);
          if (!raceFiles[raceNo]) raceFiles[raceNo] = {};
          raceFiles[raceNo][point] = file;
        }
      }
      Logger.log('[testRun] ' + point + ' ファイル数: ' + count);
    }

    Logger.log('[testRun] 検知レース数: ' + Object.keys(raceFiles).length);

    // 揃ったレースを処理
    for (const raceNo in raceFiles) {
      const files = raceFiles[raceNo];
      const collectedPoints = Object.keys(files);
      const allReady = measurementPoints.every(p => collectedPoints.includes(p));
      Logger.log('[testRun] race_no=' + raceNo + ' ポイント: ' + collectedPoints.join(',') + ' 揃い: ' + allReady);

      if (!allReady) continue;

      // CSVパース
      const measurementData = {};
      for (const point of measurementPoints) {
        const csvContent = files[point].getBlob().getDataAsString('UTF-8');
        measurementData[point] = parseResultCSV(csvContent);
        Logger.log('[testRun] race_no=' + raceNo + ' ' + point + ' パース行数: ' + measurementData[point].length);
      }

      // JSON組み立て
      const raceJson = buildRaceJSON(parseInt(raceNo, 10), measurementData, measurementPoints);
      Logger.log('[testRun] 生成JSON: ' + JSON.stringify(raceJson, null, 2));

      if (!DRY_RUN) {
        const paddedNo = String(raceNo).padStart(3, '0');
        const path = CONFIG.github.resultsPath + '/race_' + paddedNo + '.json';
        pushToGitHub(path, JSON.stringify(raceJson, null, 2));

        for (const point of measurementPoints) {
          moveToProcessed(files[point], point);
        }
        Logger.log('[testRun] race_no=' + raceNo + ' Push・移動完了');
      } else {
        Logger.log('[testRun] DRY_RUN のためPush・移動はスキップ');
      }
    }

    Logger.log('[testRun] 完了');

  } catch (e) {
    Logger.log('[testRun] エラー: ' + e.message);
    recordError('testRun', e);
  }
}

// ============================================================
// ユーティリティ関数
// ============================================================

/**
 * スクリプトプロパティから計測ポイント一覧を取得する
 * @returns {string[]} 例: ["500m", "1000m"]
 */
function getMeasurementPoints() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(CONFIG.props.measurementPoints);
  if (!raw) {
    throw new Error('MEASUREMENT_POINTS が設定されていません');
  }
  return raw.split(',').map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * 文字列先頭のBOM（Byte Order Mark: \uFEFF）を除去する
 * Excelで保存したCSVのUTF-8 BOMによる文字化けを防ぐ
 * @param {string} str
 * @returns {string}
 */
function removeBom_(str) {
  if (str && str.charCodeAt(0) === 0xFEFF) {
    return str.slice(1);
  }
  return str;
}

/**
 * エラーをスクリプトプロパティに記録する
 * @param {string} context - エラー発生箇所
 * @param {Error} e
 */
function recordError(context, e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const errorInfo = '[' + new Date().toISOString() + '] ' + context + ': ' + e.message;
    props.setProperty(CONFIG.props.lastError, errorInfo);
    Logger.log('[recordError] ' + errorInfo);
  } catch (recordErr) {
    Logger.log('[recordError] エラー記録中に例外: ' + recordErr.message);
  }
}

/**
 * API レート制限フラグをリセットする（手動実行用）
 */
function resetRateLimitFlag() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(CONFIG.props.apiRateLimited);
  Logger.log('[resetRateLimitFlag] レート制限フラグをリセットしました');
}

// ============================================================
// 10. 初回セットアップ関数群
// ============================================================

/**
 * 【初回実行】セットアップを一括実行する
 * 1. スクリプトプロパティの確認
 * 2. Google Drive フォルダ構成の自動作成
 * 3. GitHub API 接続確認
 * 4. トリガー設定案内
 *
 * 実行方法: GASエディタで setupAll を選択して「実行」をクリック
 */
function setupAll() {
  Logger.log('=== セットアップ開始 ===');

  // 1. スクリプトプロパティ確認
  const ok = checkScriptProperties_();
  if (!ok) {
    Logger.log('[エラー] スクリプトプロパティを設定してから再実行してください');
    Logger.log('  プロジェクト設定 → スクリプトプロパティ から以下を設定:');
    Logger.log('  DRIVE_ROOT_FOLDER_ID: Google DriveのルートフォルダID');
    Logger.log('  GITHUB_TOKEN: GitHubのPersonal Access Token');
    Logger.log('  MEASUREMENT_POINTS: 500m,1000m');
    return;
  }

  // 2. Driveフォルダ構成を自動作成
  createDriveFolderStructure_();

  // 3. GitHub API 接続確認
  testGitHubConnection_();

  // 4. 完了メッセージ
  Logger.log('');
  Logger.log('=== セットアップ完了 ===');
  Logger.log('次のステップ:');
  Logger.log('1. トリガーを設定: setupTrigger() を実行するか、');
  Logger.log('   編集 → トリガー → +追加 → onTrigger → 2分間隔 で手動設定');
  Logger.log('2. master/ フォルダに schedule.csv, entries.csv をアップロード');
  Logger.log('3. importMasterData() を手動実行して data/master.json を生成');
}

/**
 * スクリプトプロパティが必須キーすべて設定済みか確認する（内部関数）
 * @returns {boolean} 全て設定済みなら true
 */
function checkScriptProperties_() {
  const props = PropertiesService.getScriptProperties();
  const required = [CONFIG.props.driveFolderId, CONFIG.props.githubToken, CONFIG.props.measurementPoints];
  let allOk = true;

  required.forEach(key => {
    const val = props.getProperty(key);
    if (!val || val.trim() === '') {
      Logger.log('[未設定] ' + key);
      allOk = false;
    } else {
      // トークンは先頭4文字だけ表示
      const display = key === CONFIG.props.githubToken ? val.substring(0, 4) + '***' : val;
      Logger.log('[OK] ' + key + ' = ' + display);
    }
  });

  return allOk;
}

/**
 * Google Drive に必要なフォルダ構成を自動作成する
 *
 * 作成するフォルダ構成:
 * [ROOT]/
 * ├── race_csv/
 * │   ├── 500m/
 * │   └── 1000m/    ← MEASUREMENT_POINTS から動的生成
 * ├── master/
 * └── processed/
 *     ├── 500m/
 *     └── 1000m/
 */
function createDriveFolderStructure_() {
  Logger.log('[createDriveFolderStructure_] フォルダ構成を作成します');

  const props = PropertiesService.getScriptProperties();
  const rootFolderId = props.getProperty(CONFIG.props.driveFolderId);

  if (!rootFolderId) {
    throw new Error('DRIVE_ROOT_FOLDER_ID が設定されていません');
  }

  // 計測ポイント一覧を取得
  const measurementPoints = getMeasurementPoints();

  // race_csv/ フォルダと各計測ポイントのサブフォルダを作成
  const raceCsvFolder = getOrCreateFolder(rootFolderId, CONFIG.folders.raceCsv);
  Logger.log('[createDriveFolderStructure_] race_csv/ ID: ' + raceCsvFolder.getId());

  for (const point of measurementPoints) {
    const pointFolder = getOrCreateFolder(raceCsvFolder.getId(), point);
    Logger.log('[createDriveFolderStructure_] race_csv/' + point + '/ ID: ' + pointFolder.getId());
  }

  // master/ フォルダを作成
  const masterFolder = getOrCreateFolder(rootFolderId, CONFIG.folders.master);
  Logger.log('[createDriveFolderStructure_] master/ ID: ' + masterFolder.getId());

  // processed/ フォルダと各計測ポイントのサブフォルダを作成
  const processedFolder = getOrCreateFolder(rootFolderId, CONFIG.folders.processed);
  Logger.log('[createDriveFolderStructure_] processed/ ID: ' + processedFolder.getId());

  for (const point of measurementPoints) {
    const pointFolder = getOrCreateFolder(processedFolder.getId(), point);
    Logger.log('[createDriveFolderStructure_] processed/' + point + '/ ID: ' + pointFolder.getId());
  }

  Logger.log('[createDriveFolderStructure_] フォルダ構成の作成が完了しました');
}

/**
 * GitHub API への接続と書き込み権限を確認する
 * テスト用ファイル data/.setup_test を作成して削除する
 */
function testGitHubConnection_() {
  Logger.log('[testGitHubConnection_] GitHub API 接続テスト開始');

  const testPath = 'data/.setup_test';
  const testContent = 'setup test ' + new Date().toISOString();

  try {
    // テストファイルを作成
    pushToGitHub(testPath, testContent);
    Logger.log('[testGitHubConnection_] テストファイル作成成功');
  } catch (e) {
    const msg = e.message || '';
    if (msg.indexOf('HTTP 403') !== -1) {
      Logger.log('[testGitHubConnection_] [エラー] 403 Forbidden: GitHubトークンの権限が不足しています');
      Logger.log('  → GitHub Settings → Developer settings → Personal access tokens で');
      Logger.log('    repo スコープが有効になっているか確認してください');
    } else if (msg.indexOf('HTTP 404') !== -1) {
      Logger.log('[testGitHubConnection_] [エラー] 404 Not Found: リポジトリが見つかりません');
      Logger.log('  → Code.gs の CONFIG.github.owner / repo が正しいか確認してください');
    } else {
      Logger.log('[testGitHubConnection_] [エラー] 接続失敗: ' + msg);
    }
    return;
  }

  // テストファイルを削除
  try {
    deleteFromGitHub_(testPath);
    Logger.log('[testGitHubConnection_] テストファイル削除成功');
  } catch (e) {
    Logger.log('[testGitHubConnection_] テストファイルの削除に失敗しました（手動で削除してください）: ' + e.message);
  }

  Logger.log('[testGitHubConnection_] GitHub API 接続テスト完了 ✓');
}

/**
 * GitHub Contents API でファイルを削除する（内部関数）
 * @param {string} path - リポジトリ内のパス
 */
function deleteFromGitHub_(path) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(CONFIG.props.githubToken);

  const apiUrl = CONFIG.github.apiBase + '/repos/' + CONFIG.github.owner + '/' +
    CONFIG.github.repo + '/contents/' + path;

  // SHAを取得
  const getResponse = UrlFetchApp.fetch(apiUrl, {
    method: 'GET',
    headers: {
      Authorization: 'token ' + token,
      Accept: 'application/vnd.github.v3+json',
    },
    muteHttpExceptions: true,
  });

  if (getResponse.getResponseCode() !== 200) {
    throw new Error('ファイルのSHA取得失敗: HTTP ' + getResponse.getResponseCode());
  }

  const existing = JSON.parse(getResponse.getContentText());
  const sha = existing.sha;

  const payload = {
    message: 'Delete ' + path + ' [GAS setup test cleanup]',
    sha: sha,
    branch: CONFIG.github.branch,
  };

  const deleteResponse = UrlFetchApp.fetch(apiUrl, {
    method: 'DELETE',
    headers: {
      Authorization: 'token ' + token,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (deleteResponse.getResponseCode() !== 200) {
    throw new Error('ファイル削除失敗: HTTP ' + deleteResponse.getResponseCode());
  }
}

/**
 * onTrigger を2分間隔で自動実行するトリガーを設定する
 * 既存のトリガーがある場合は重複して作成しない
 */
function setupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some(t => t.getHandlerFunction() === 'onTrigger');

  if (exists) {
    Logger.log('[INFO] onTrigger のトリガーは既に設定されています');
    return;
  }

  ScriptApp.newTrigger('onTrigger')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('[OK] トリガーを設定しました: onTrigger (5分間隔)');
}

/**
 * 全トリガーを削除する（リセット用）
 */
function deleteTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('[OK] 全トリガーを削除しました');
}

// ============================================================
// テスト用: サンプルCSVをDriveに生成する
// ============================================================

/**
 * テスト用サンプルCSVを race_csv/500m/ と race_csv/1000m/ に生成する
 * 本番前の動作確認用（R001〜R005の5レース分）
 * 実行後5分以内に onTrigger が自動でJSONを生成してGitHubにPushする
 */
function createTestCSVs() {
  const props = PropertiesService.getScriptProperties();
  const rootId = props.getProperty(CONFIG.props.driveFolderId);
  const raceCsvFolder = getOrCreateFolder(rootId, CONFIG.folders.raceCsv);
  const folder500 = getOrCreateFolder(raceCsvFolder.getId(), '500m');
  const folder1000 = getOrCreateFolder(raceCsvFolder.getId(), '1000m');

  const header = 'measurement_point,lane,lap_index,time_ms,formatted,race_no,tie_group,photo_flag,note\n';

  const csvData = [
    {
      name: '20250607_070000_R001_500m.csv', folder: folder500,
      content: header +
        '500m,1,1,112834,1:52.834,1,,,\n' +
        '500m,2,1,113201,1:53.201,1,,,\n' +
        '500m,3,1,111490,1:51.490,1,,,\n' +
        '500m,4,1,114560,1:54.560,1,,,\n'
    },
    {
      name: '20250607_070800_R001_1000m.csv', folder: folder1000,
      content: header +
        '1000m,1,1,228410,3:48.410,1,,,\n' +
        '1000m,2,1,231750,3:51.750,1,,,\n' +
        '1000m,3,1,224880,3:44.880,1,,,\n' +
        '1000m,4,1,235200,3:55.200,1,,,\n'
    },
    {
      name: '20250607_071600_R002_500m.csv', folder: folder500,
      content: header +
        '500m,1,1,115320,1:55.320,2,,,\n' +
        '500m,2,1,116880,1:56.880,2,,,\n' +
        '500m,3,1,118100,1:58.100,2,,,\n' +
        '500m,4,1,114950,1:54.950,2,,,\n'
    },
    {
      name: '20250607_072400_R002_1000m.csv', folder: folder1000,
      content: header +
        '1000m,1,1,234560,3:54.560,2,,,\n' +
        '1000m,2,1,238900,3:58.900,2,,,\n' +
        '1000m,3,1,240100,4:00.100,2,,,\n' +
        '1000m,4,1,233200,3:53.200,2,,,\n'
    },
    {
      name: '20250607_073200_R003_500m.csv', folder: folder500,
      content: header +
        '500m,1,1,104210,1:44.210,3,,,\n' +
        '500m,2,1,105880,1:45.880,3,,,\n' +
        '500m,3,1,106340,1:46.340,3,,,\n' +
        '500m,4,1,105880,1:45.880,3,1,,同着\n'
    },
    {
      name: '20250607_073200_R004_500m.csv', folder: folder500,
      content: header +
        '500m,1,1,125400,2:05.400,4,,,\n' +
        '500m,2,1,127800,2:07.800,4,,,\n' +
        '500m,3,1,124100,2:04.100,4,,,\n'
    },
    {
      name: '20250607_074000_R003_1000m.csv', folder: folder1000,
      content: header +
        '1000m,1,1,208540,3:28.540,3,,,\n' +
        '1000m,2,1,213760,3:33.760,3,,,\n' +
        '1000m,3,1,218300,3:38.300,3,,,\n' +
        '1000m,4,1,213760,3:33.760,3,1,true,フォトフィニッシュ判定\n'
    },
    {
      name: '20250607_074000_R004_1000m.csv', folder: folder1000,
      content: header +
        '1000m,1,1,252000,4:12.000,4,,,\n' +
        '1000m,2,1,258600,4:18.600,4,,,\n' +
        '1000m,3,1,249800,4:09.800,4,,,\n'
    },
    {
      name: '20250607_080000_R005_500m.csv', folder: folder500,
      content: header +
        '500m,1,1,91200,1:31.200,5,,,\n' +
        '500m,2,1,90500,1:30.500,5,,,\n' +
        '500m,3,1,92800,1:32.800,5,,,\n'
    },
    {
      name: '20250607_080800_R005_1000m.csv', folder: folder1000,
      content: header +
        '1000m,1,1,183500,3:03.500,5,,,\n' +
        '1000m,2,1,181200,3:01.200,5,,,\n' +
        '1000m,3,1,186900,3:06.900,5,,,\n'
    },
  ];

  csvData.forEach(({ name, folder, content }) => {
    // 同名ファイルが既にあれば削除してから作成
    const existing = folder.getFilesByName(name);
    while (existing.hasNext()) existing.next().setTrashed(true);
    folder.createFile(name, content, MimeType.PLAIN_TEXT);
    Logger.log('[createTestCSVs] 作成: ' + name);
  });

  Logger.log('[createTestCSVs] 完了: ' + csvData.length + 'ファイル生成');
  Logger.log('5分以内に onTrigger が自動実行してJSONを生成します');
}

/**
 * テスト用: 棄権・途中棄権を含むrace_006のCSVをDriveに生成する
 * レーン1〜3: 完走 / レーン4: 途中棄権（500mのみ） / レーン5: 棄権（CSVなし）
 */
function createTestRace006() {
  const props = PropertiesService.getScriptProperties();
  const rootId = props.getProperty(CONFIG.props.driveFolderId);
  const raceCsvFolder = getOrCreateFolder(rootId, CONFIG.folders.raceCsv);
  const folder500 = getOrCreateFolder(raceCsvFolder.getId(), '500m');
  const folder1000 = getOrCreateFolder(raceCsvFolder.getId(), '1000m');
  const header = 'measurement_point,lane,lap_index,time_ms,formatted,race_no,tie_group,photo_flag,note\n';

  const csvData = [
    // 500m: レーン1〜4（レーン5はDNS=CSVなし）
    {
      name: '20250607_083000_R006_500m.csv', folder: folder500,
      content: header +
        '500m,1,1,118200,1:58.200,6,,,\n' +
        '500m,2,1,119800,1:59.800,6,,,\n' +
        '500m,3,1,117500,1:57.500,6,,,\n' +
        '500m,4,1,121000,2:01.000,6,,,\n'  // レーン4: DNF（1000mなし）
    },
    // 1000m: レーン1〜3のみ（レーン4はDNF・レーン5はDNS）
    {
      name: '20250607_083800_R006_1000m.csv', folder: folder1000,
      content: header +
        '1000m,1,1,239400,3:59.400,6,,,\n' +
        '1000m,2,1,242600,4:02.600,6,,,\n' +
        '1000m,3,1,237200,3:57.200,6,,,\n'
    },
  ];

  csvData.forEach(({ name, folder, content }) => {
    const existing = folder.getFilesByName(name);
    while (existing.hasNext()) existing.next().setTrashed(true);
    folder.createFile(name, content, MimeType.PLAIN_TEXT);
    Logger.log('[createTestRace006] 作成: ' + name);
  });

  Logger.log('[createTestRace006] 完了');
  Logger.log('  レーン1〜3: 完走 / レーン4: 途中棄権（500mのみ） / レーン5: 棄権（CSVなし）');
  Logger.log('5分以内に onTrigger が自動実行します');
}
