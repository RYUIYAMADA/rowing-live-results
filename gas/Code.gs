/**
 * ボート競技ライブリザルト - Google Apps Script
 * Google Drive のCSVを監視し、GitHub にレース結果JSONをPushする
 */

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
  // 例: 20260309_002304_R001_500m.csv
  csvPattern: /^\d{8}_\d{6}_R(\d{3})_(.+)\.csv$/,
  // スクリプトプロパティキー
  props: {
    driveFolderId: 'DRIVE_ROOT_FOLDER_ID',
    githubToken: 'GITHUB_TOKEN',
    measurementPoints: 'MEASUREMENT_POINTS',
    lastError: 'LAST_ERROR',
    apiRateLimited: 'API_RATE_LIMITED',
  },
  // 最大実行時間（ミリ秒）
  maxExecutionMs: 5 * 60 * 1000,
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

  try {
    // API レート制限フラグを確認
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(CONFIG.props.apiRateLimited) === 'true') {
      Logger.log('[onTrigger] API レート制限中のため処理をスキップ');
      return;
    }

    processPendingCSVs(startTime);

    const elapsed = Date.now() - startTime;
    Logger.log('[onTrigger] 完了: ' + elapsed + 'ms');
  } catch (e) {
    Logger.log('[onTrigger] エラー: ' + e.message);
    recordError('onTrigger', e);
  }
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
  const lines = csvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
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
    results.push({
      lane: parseInt(cols[1], 10),
      time_ms: parseInt(cols[3], 10),
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
        formatted: row.formatted,
      };
      // 最後のポイントの情報で上書き（tie_group等はフィニッシュ基準）
      if (point === lastPoint) {
        laneMap[row.lane].tie_group = row.tie_group;
        laneMap[row.lane].photo_flag = row.photo_flag;
        laneMap[row.lane].note = row.note;
      }
    }
  }

  // フィニッシュタイム（最後の計測ポイント）でソート
  const laneEntries = Object.values(laneMap).filter(entry => entry.times[lastPoint]);
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
  const results = laneEntries.map(entry => {
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
    };
  });

  return {
    race_no: raceNo,
    updated_at: new Date().toISOString(),
    results: results,
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
  if (code === 403 || code === 429) {
    Logger.log('[checkRateLimit] API レート制限検知: HTTP ' + code);
    const props = PropertiesService.getScriptProperties();
    props.setProperty(CONFIG.props.apiRateLimited, 'true');
    props.setProperty(CONFIG.props.lastError, 'Rate limited at ' + new Date().toISOString() + ': HTTP ' + code);
    throw new Error('GitHub API レート制限: HTTP ' + code);
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
  Logger.log('[moveToProcessed] ファイル移動: ' + file.getName() + ' -> processed/' + point + '/');

  const props = PropertiesService.getScriptProperties();
  const rootFolderId = props.getProperty(CONFIG.props.driveFolderId);

  const processedFolder = getOrCreateFolder(rootFolderId, CONFIG.folders.processed);
  const processedPointFolder = getOrCreateFolder(processedFolder.getId(), point);

  // 元のフォルダを取得して親フォルダから削除
  const parents = file.getParents();
  file.moveTo(processedPointFolder);

  Logger.log('[moveToProcessed] 移動完了: ' + file.getName());
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

    // schedule.csv を読み込み
    const scheduleFile = findFileInFolder(masterFolder, 'schedule.csv');
    if (!scheduleFile) {
      throw new Error('schedule.csv が master/ フォルダに見つかりません');
    }
    const scheduleRows = parseMasterCSV(scheduleFile.getBlob().getDataAsString('UTF-8'));
    Logger.log('[importMasterData] schedule.csv 行数: ' + scheduleRows.length);

    // entries.csv を読み込み
    const entriesFile = findFileInFolder(masterFolder, 'entries.csv');
    if (!entriesFile) {
      throw new Error('entries.csv が master/ フォルダに見つかりません');
    }
    const entriesRows = parseMasterCSV(entriesFile.getBlob().getDataAsString('UTF-8'));
    Logger.log('[importMasterData] entries.csv 行数: ' + entriesRows.length);

    // master.json を組み立て
    // schedule.csv カラム: race_no,event_code,event_name,category,age_group,round,date,time
    // entries.csv カラム: race_no,lane,crew_name,affiliation

    // エントリーをrace_noでグループ化
    const entriesByRace = {};
    for (const row of entriesRows) {
      const raceNo = parseInt(row.race_no, 10);
      if (!entriesByRace[raceNo]) {
        entriesByRace[raceNo] = [];
      }
      entriesByRace[raceNo].push({
        lane: parseInt(row.lane, 10),
        crew_name: row.crew_name || '',
        affiliation: row.affiliation || '',
      });
    }

    // スケジュールをマージ
    const races = scheduleRows.map(row => {
      const raceNo = parseInt(row.race_no, 10);
      return {
        race_no: raceNo,
        event_code: row.event_code || '',
        event_name: row.event_name || '',
        category: row.category || '',
        age_group: row.age_group || '',
        round: row.round || '',
        date: row.date || '',
        time: row.time || '',
        entries: entriesByRace[raceNo] || [],
      };
    });

    const masterJson = {
      generated_at: new Date().toISOString(),
      races: races,
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
