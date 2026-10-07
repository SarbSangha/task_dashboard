/**
 * Sheet Activity capture for the dashboard's "Sheet Activity" section.
 *
 * Bound to the spreadsheet (Extensions -> Apps Script). Records every edit
 * and structural change - who, when, where, old -> new - and POSTs it to
 * the dashboard backend (POST /api/sheet-activity). If the POST fails, the
 * event is appended to a hidden, protected "_AuditLog" tab, and an hourly
 * trigger (resendAuditLog) delivers it later.
 *
 * Setup (see apps-script/README.md):
 *   1. Project Settings -> Script Properties:
 *        BACKEND_URL     https://dashboard.ritzmediaworld.in/api/sheet-activity
 *        WEBHOOK_SECRET  the same value as SHEET_ACTIVITY_WEBHOOK_SECRET on the backend
 *   2. Run setupTriggers() once, signed in as the spreadsheet owner.
 *   3. Run checkConfiguration() - it must log "OK".
 *
 * The handlers are deliberately NOT named onEdit/onChange: those names are
 * Apps Script's simple triggers, which cannot call UrlFetchApp and would
 * fire a second time next to the installable triggers.
 */

var AUDIT_SHEET_NAME = '_AuditLog';
var AUDIT_HEADERS = [
  'eventId', 'timestamp', 'userEmail', 'spreadsheetId', 'sheetName', 'range', 'row', 'column',
  'numRows', 'numColumns', 'changeType', 'oldValue', 'newValue', 'newValues', 'formula', 'truncated', 'sent'
];
var MAX_VALUE_CHARS = 2000;   // per value sent to the backend
var MAX_GRID_ROWS = 20;       // multi-cell edits: only the top-left 20 x 20 values are sent
var MAX_GRID_COLUMNS = 20;
var RESEND_BATCH = 100;
var CHANGE_TYPES = ['EDIT', 'INSERT_ROW', 'REMOVE_ROW', 'INSERT_COLUMN', 'REMOVE_COLUMN',
                    'INSERT_GRID', 'REMOVE_GRID', 'FORMAT', 'OTHER'];


// --------------------------------------------------------------------------
// Triggers
// --------------------------------------------------------------------------

/** Install the onEdit, onChange and hourly resend triggers (safe to re-run). */
function setupTriggers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var handlers = ['handleEdit', 'handleChange', 'resendAuditLog'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('handleEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('handleChange').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('resendAuditLog').timeBased().everyHours(1).create();
  getAuditSheet_();
  Logger.log('Installed handleEdit, handleChange and hourly resendAuditLog for %s', ss.getName());
}

/** Installable onEdit: one event per edit, with old/new values when Apps Script provides them. */
function handleEdit(e) {
  if (!e || !e.range) return;
  var range = e.range;
  var sheet = range.getSheet();
  if (sheet.getName() === AUDIT_SHEET_NAME) return;

  var numRows = range.getNumRows();
  var numColumns = range.getNumColumns();
  var single = numRows === 1 && numColumns === 1;
  var truncated = false;
  var event = baseEvent_(e, 'EDIT', sheet);
  event.range = range.getA1Notation();
  event.row = range.getRow();
  event.column = range.getColumn();
  event.numRows = numRows;
  event.numColumns = numColumns;

  if (single) {
    // e.oldValue / e.value only exist for single-cell edits. e.value is also
    // missing when a cell is cleared or pasted into, so read the cell back.
    var oldValue = e.oldValue !== undefined ? String(e.oldValue) : null;
    var newValue = e.value !== undefined ? String(e.value) : range.getDisplayValue();
    var t1 = trim_(oldValue), t2 = trim_(newValue);
    event.oldValue = t1.value;
    event.newValue = t2.value;
    var formula = range.getFormula();
    event.formula = formula ? trim_(formula).value : null;
    truncated = t1.truncated || t2.truncated;
  } else {
    // Multi-cell edit or paste: there is no old value; send a capped grid of new values.
    var rows = Math.min(numRows, MAX_GRID_ROWS);
    var cols = Math.min(numColumns, MAX_GRID_COLUMNS);
    var grid = sheet.getRange(event.row, event.column, rows, cols).getDisplayValues();
    event.newValues = grid.map(function (r) {
      return r.map(function (v) {
        var t = trim_(v);
        if (t.truncated) truncated = true;
        return t.value;
      });
    });
    if (rows < numRows || cols < numColumns) truncated = true;
  }
  event.truncated = truncated;
  deliver_(event);
  fillRequestIds_(sheet, event.row, numRows);
}


// --------------------------------------------------------------------------
// Optional: hidden "Request ID" column (Sheets section)
// --------------------------------------------------------------------------
// The dashboard's Sheets section keys each content request by this column
// when it exists (otherwise by "No."), so a row keeps its history even if
// rows are renumbered. Off until setupRequestIds() is run. The Claude agent
// should map columns by header name; check it still works after enabling.

var REQUEST_ID_HEADER = 'Request ID';

function trackedTabs_() {
  var raw = PropertiesService.getScriptProperties().getProperty('TRACKED_TABS') || '';
  return raw.split(',').map(function (s) { return s.trim(); }).filter(String);
}

/** Add a hidden "Request ID" column to each tab in Script Property TRACKED_TABS and fill existing rows. */
function setupRequestIds() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  trackedTabs_().forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) { Logger.log('Tab not found: %s', name); return; }
    var col = requestIdColumn_(sheet);
    if (!col) {
      col = sheet.getLastColumn() + 1;
      sheet.getRange(1, col).setValue(REQUEST_ID_HEADER).setFontWeight('bold');
      sheet.hideColumns(col);
    }
    fillRequestIds_(sheet, 2, Math.max(0, sheet.getLastRow() - 1));
    Logger.log('Request IDs ready on %s (column %s)', name, col);
  });
}

function requestIdColumn_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return 0;
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var i = headers.indexOf(REQUEST_ID_HEADER);
  return i === -1 ? 0 : i + 1;
}

/** Give every row in [firstRow, firstRow + count) that has content but no ID a new ID. */
function fillRequestIds_(sheet, firstRow, count) {
  if (!sheet || !count || firstRow < 2) return;
  if (trackedTabs_().indexOf(sheet.getName()) === -1) return;
  var col = requestIdColumn_(sheet);
  if (!col) return;
  var width = sheet.getLastColumn();
  // Columns that never mean "someone started a request": the ID itself and
  // pre-filled row numbers. Matched by header name, never by position.
  var headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  var skip = headers.map(function (h) {
    var n = String(h).trim().toLowerCase();
    return n === REQUEST_ID_HEADER.toLowerCase() || ['no', 'no.', '#', 's.no', 'sr no', 'row'].indexOf(n) !== -1;
  });
  var rows = sheet.getRange(firstRow, 1, count, width).getDisplayValues();
  var ids = sheet.getRange(firstRow, col, count, 1);
  var current = ids.getValues();
  var changed = false;
  rows.forEach(function (row, i) {
    var hasContent = row.some(function (v, j) { return !skip[j] && v !== ''; });
    if (hasContent && !current[i][0]) { current[i][0] = Utilities.getUuid(); changed = true; }
  });
  if (changed) ids.setValues(current);   // script writes don't re-fire onEdit
}

/** Installable onChange: structural changes. Plain edits are left to handleEdit. */
function handleChange(e) {
  if (!e || e.changeType === 'EDIT') return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = null;
  try { sheet = ss.getActiveSheet(); } catch (err) { sheet = null; }
  if (sheet && sheet.getName() === AUDIT_SHEET_NAME) return;
  var type = CHANGE_TYPES.indexOf(e.changeType) !== -1 ? e.changeType : 'OTHER';
  var event = baseEvent_(e, type, sheet);
  // onChange carries no cell details. The active selection is the best hint
  // available (e.g. the row the user right-clicked to insert above).
  try {
    var active = sheet ? sheet.getActiveRange() : null;
    if (active && type !== 'INSERT_GRID' && type !== 'REMOVE_GRID') {
      event.range = active.getA1Notation();
      event.row = active.getRow();
      event.column = active.getColumn();
      event.numRows = active.getNumRows();
      event.numColumns = active.getNumColumns();
    }
  } catch (err) { /* no active range in this context */ }
  deliver_(event);
}


// --------------------------------------------------------------------------
// Delivery and backup
// --------------------------------------------------------------------------

function baseEvent_(e, changeType, sheet) {
  return {
    eventId: Utilities.getUuid(),
    timestamp: new Date().toISOString(),
    userEmail: editorEmail_(e),
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: sheet ? sheet.getName() : null,
    range: null, row: null, column: null, numRows: null, numColumns: null,
    changeType: changeType,
    oldValue: null, newValue: null, newValues: null, formula: null,
    truncated: false
  };
}

/** Editor email, or "unknown" (outside the Workspace domain, consumer accounts). */
function editorEmail_(e) {
  var email = '';
  try { if (e && e.user && e.user.getEmail) email = e.user.getEmail(); } catch (err) { email = ''; }
  if (!email) {
    try { email = Session.getActiveUser().getEmail(); } catch (err) { email = ''; }
  }
  return email || 'unknown';
}

function trim_(value) {
  if (value === null || value === undefined) return { value: null, truncated: false };
  var text = String(value);
  if (text.length <= MAX_VALUE_CHARS) return { value: text, truncated: false };
  return { value: text.slice(0, MAX_VALUE_CHARS - 1) + '…', truncated: true };
}

function settings_() {
  var props = PropertiesService.getScriptProperties();
  return { url: props.getProperty('BACKEND_URL'), secret: props.getProperty('WEBHOOK_SECRET') };
}

function post_(body, source) {
  var s = settings_();
  if (!s.url || !s.secret) return { ok: false, code: 0, text: 'BACKEND_URL / WEBHOOK_SECRET not set' };
  var url = s.url + (s.url.indexOf('?') === -1 ? '?' : '&') + 'source=' + encodeURIComponent(source || 'webhook');
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    headers: { 'X-Sheet-Activity-Secret': s.secret },
    muteHttpExceptions: true,
    followRedirects: false
  });
  var code = res.getResponseCode();
  return { ok: code >= 200 && code < 300, code: code, text: res.getContentText().slice(0, 300) };
}

function deliver_(event) {
  var result;
  try {
    result = post_(event, 'webhook');
  } catch (err) {
    result = { ok: false, code: 0, text: String(err) };
  }
  if (!result.ok) {
    console.warn('Sheet activity POST failed (%s): %s - kept in %s', result.code, result.text, AUDIT_SHEET_NAME);
    appendAudit_(event);
  }
}

function getAuditSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(AUDIT_SHEET_NAME);
  if (sheet) return sheet;
  sheet = ss.insertSheet(AUDIT_SHEET_NAME);
  sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.hideSheet();
  // Only the trigger owner (who runs these handlers) may edit the backup.
  var protection = sheet.protect().setDescription('Sheet Activity backup - written by Apps Script only');
  var me = Session.getEffectiveUser();
  protection.addEditor(me);
  protection.removeEditors(protection.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); }));
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
  return sheet;
}

function appendAudit_(event) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) {
    console.error('Could not lock %s; event %s lost', AUDIT_SHEET_NAME, event.eventId);
    return;
  }
  try {
    var row = AUDIT_HEADERS.map(function (h) {
      if (h === 'sent') return false;
      if (h === 'newValues') return event.newValues ? JSON.stringify(event.newValues) : '';
      var v = event[h];
      return v === null || v === undefined ? '' : v;
    });
    // Write as plain text so a value like "=SUM(A1)" is stored, not evaluated.
    var sheet = getAuditSheet_();
    var target = sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length);
    target.setNumberFormat('@').setValues([row]);
  } finally {
    lock.releaseLock();
  }
}

/** Re-send unsent _AuditLog rows in batches; runs hourly and can be run by hand. */
function resendAuditLog() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AUDIT_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return;
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return;
  try {
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, AUDIT_HEADERS.length).getValues();
    var sentCol = AUDIT_HEADERS.indexOf('sent');
    var pending = [];
    data.forEach(function (row, i) {
      if (String(row[sentCol]).toUpperCase() !== 'TRUE') pending.push({ index: i, event: rowToEvent_(row) });
    });
    for (var start = 0; start < pending.length; start += RESEND_BATCH) {
      var batch = pending.slice(start, start + RESEND_BATCH);
      var result = post_({ events: batch.map(function (p) { return p.event; }) }, 'resend');
      if (!result.ok) {
        console.warn('Resend stopped (%s): %s', result.code, result.text);
        return;
      }
      batch.forEach(function (p) { sheet.getRange(p.index + 2, sentCol + 1).setValue(true); });
    }
    Logger.log('Resent %s events', pending.length);
  } finally {
    lock.releaseLock();
  }
}

function rowToEvent_(row) {
  var ev = {};
  AUDIT_HEADERS.forEach(function (h, i) {
    if (h === 'sent') return;
    var v = row[i];
    if (v === '' || v === null) { ev[h] = null; return; }
    if (h === 'newValues') { try { ev[h] = JSON.parse(v); } catch (err) { ev[h] = null; } return; }
    if (['row', 'column', 'numRows', 'numColumns'].indexOf(h) !== -1) { ev[h] = Number(v); return; }
    if (h === 'truncated') { ev[h] = String(v).toUpperCase() === 'TRUE'; return; }
    if (h === 'timestamp' && v instanceof Date) { ev[h] = v.toISOString(); return; }
    ev[h] = String(v);
  });
  return ev;
}

/**
 * Check the backend URL and secret without recording anything: posts an
 * empty body, which the backend rejects as malformed (422) only after the
 * secret has been accepted.
 */
function checkConfiguration() {
  var r = post_({}, 'webhook');
  if (r.code === 422) Logger.log('OK - backend reachable and secret accepted');
  else if (r.code === 401) Logger.log('Secret rejected: WEBHOOK_SECRET does not match SHEET_ACTIVITY_WEBHOOK_SECRET');
  else if (r.code === 503) Logger.log('Backend has no SHEET_ACTIVITY_WEBHOOK_SECRET configured');
  else Logger.log('Unexpected response %s: %s', r.code, r.text);
}
