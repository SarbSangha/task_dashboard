/**
 * Ranking run logging for the dashboard (Sheets -> keyword_ranking_tracker).
 *
 * Add this file to the Apps Script project that runs the ranking checks, then
 * call it from the job. It reports what the sheet can't show: the URL that
 * actually ranked, the raw API response, cost and run time. The dashboard
 * still imports every run from the sheet itself, so a run that was never
 * reported is not lost - it just lacks those extra details.
 *
 * Script Properties (Project Settings -> Script Properties):
 *   RANKING_RESULTS_URL  https://dashboard.ritzmediaworld.in/api/sheets/ranking-results
 *   WEBHOOK_SECRET       same value as the backend's SHEET_ACTIVITY_WEBHOOK_SECRET
 *                        (already set if Code.gs is in this project too)
 *
 * Use, inside the job:
 *
 *   var run = startRankingRun('RitzMediaWorld', { trigger: 'scheduled', api: 'DataForSEO',
 *                                                 location: 'Noida,Uttar Pradesh,India', gl: 'in' });
 *   // for each keyword, after calling the API and writing the sheet:
 *   addRankingResult(run, {
 *     keyword: keyword, targetUrl: liveUrl,
 *     position: rank || null,               // integer, or null when not ranked
 *     positionRaw: cellValueWritten,        // exactly what went in the Position cell, e.g. "Not in Top 50"
 *     aiOverview: aiCellValueWritten,       // "Yes" / "No" / "No AI Overview"
 *     foundUrl: urlThatRanked,              // the result URL found for our domain, if any
 *     raw: trimmedApiItem,                  // optional; trimmed to 4,000 characters here
 *     error: errorMessageOrNull
 *   });
 *   run.cost += taskCost;                   // optional, if the API returns a cost
 *   finishRankingRun(run);                  // sends one report for the tab
 *
 * Call startRankingRun / finishRankingRun once per tab (site).
 */

var RANKING_LOG_SHEET = '_RankingLog';
var RANKING_RAW_MAX = 4000;
var RANKING_RESULTS_PER_POST = 500;

function startRankingRun(tab, options) {
  options = options || {};
  var now = new Date();
  return {
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    tab: tab,
    runDate: Utilities.formatDate(now, 'Asia/Kolkata', 'yyyy-MM-dd'),
    runId: options.runId || Utilities.getUuid(),
    trigger: options.trigger || null,            // scheduled | manual | baseline
    api: options.api || null,
    location: options.location || null,
    gl: options.gl || null,
    cost: options.cost || 0,
    startedAt: now.toISOString(),
    finishedAt: null,
    durationSeconds: null,
    errors: [],
    results: []
  };
}

function addRankingResult(run, result) {
  var raw = result.raw;
  if (raw !== undefined && raw !== null) {
    var text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    raw = text.length > RANKING_RAW_MAX ? text.slice(0, RANKING_RAW_MAX) : raw;
  }
  run.results.push({
    keyword: String(result.keyword || '').trim(),
    targetUrl: result.targetUrl || null,
    position: typeof result.position === 'number' && result.position > 0 ? Math.round(result.position) : null,
    positionRaw: result.positionRaw !== undefined && result.positionRaw !== null ? String(result.positionRaw) : null,
    aiOverview: result.aiOverview !== undefined && result.aiOverview !== null ? String(result.aiOverview) : null,
    foundUrl: result.foundUrl || null,
    raw: raw === undefined ? null : raw,
    error: result.error ? String(result.error).slice(0, 1000) : null
  });
  if (result.error) run.errors.push({ keyword: result.keyword, error: String(result.error).slice(0, 300) });
}

function finishRankingRun(run) {
  var end = new Date();
  run.finishedAt = end.toISOString();
  run.durationSeconds = (end.getTime() - new Date(run.startedAt).getTime()) / 1000;
  if (!run.cost) run.cost = null;
  // Large tabs go in several posts; the dashboard merges them by runId.
  for (var i = 0; i < Math.max(1, run.results.length); i += RANKING_RESULTS_PER_POST) {
    var part = JSON.parse(JSON.stringify(run));
    part.results = run.results.slice(i, i + RANKING_RESULTS_PER_POST);
    if (!postRankingReport_(part)) saveRankingReport_(part);
  }
}

function postRankingReport_(report) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('RANKING_RESULTS_URL');
  var secret = props.getProperty('WEBHOOK_SECRET');
  if (!url || !secret) {
    console.warn('RANKING_RESULTS_URL / WEBHOOK_SECRET not set; ranking report kept in %s', RANKING_LOG_SHEET);
    return false;
  }
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(report),
      headers: { 'X-Sheet-Activity-Secret': secret }, muteHttpExceptions: true, followRedirects: false
    });
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) return true;
    console.warn('Ranking report rejected (%s): %s', code, res.getContentText().slice(0, 300));
    return code >= 400 && code < 500 && code !== 401 && code !== 429;   // a malformed report would never succeed
  } catch (err) {
    console.warn('Ranking report failed: %s', err);
    return false;
  }
}

function saveRankingReport_(report) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RANKING_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(RANKING_LOG_SHEET);
    sheet.getRange(1, 1, 1, 4).setValues([['savedAt', 'tab', 'report', 'sent']]).setFontWeight('bold');
    sheet.hideSheet();
  }
  var json = JSON.stringify(report);
  if (json.length > 49000) {                       // one cell holds 50,000 characters
    report.results.forEach(function (r) { r.raw = null; });
    json = JSON.stringify(report).slice(0, 49000);
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 4).setNumberFormat('@')
    .setValues([[new Date().toISOString(), report.tab, json, 'false']]);
}

/** Resend saved reports. Add an hourly time trigger for this, or run it by hand. */
function resendRankingLog() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RANKING_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
  rows.forEach(function (row, i) {
    if (String(row[3]).toLowerCase() === 'true') return;
    var report;
    try { report = JSON.parse(row[2]); } catch (err) { return; }
    if (postRankingReport_(report)) sheet.getRange(i + 2, 4).setValue('true');
  });
}

/** Add an hourly trigger for resendRankingLog (safe to re-run). */
function setupRankingLogTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'resendRankingLog') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('resendRankingLog').timeBased().everyHours(1).create();
}
