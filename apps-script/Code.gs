/**
 * Mošnja — personal monthly budget
 * Backend: Google Apps Script Web App bound to a Google Sheet.
 *
 * Data model (sheet "Postavke")
 *  - One-off item:   Ponavljajoce = FALSE, Mesec = the month it belongs to.
 *  - Series:         Ponavljajoce = TRUE,  Mesec = first month, DoMeseca = last month (empty = no end).
 *  - Month override: Nadrejena = series ID, Mesec = month. Replaces the series amount/note for that month,
 *                    or skips that month when Preskoci = TRUE.
 *  - VrstniRed:      manual sort position of an item/series (same in every month and view).
 *
 * Security model
 *  - 6-digit PIN stored only as a salted, iterated SHA-256 hash in Script Properties.
 *  - After MAX_ATTEMPTS wrong PINs the API locks for LOCK_MINUTES.
 *  - A correct PIN returns a random session token (CacheService, sliding expiry).
 *  - Forgot the PIN? Run resetPin() from the Apps Script editor, then set a new one in the app.
 */

const SHEET_NAME = 'Postavke';
const HEADERS = ['ID', 'Mesec', 'Tip', 'Naziv', 'Kategorija', 'Znesek', 'Ponavljajoce', 'Opomba',
                 'Ustvarjeno', 'Posodobljeno', 'DoMeseca', 'Nadrejena', 'Preskoci', 'VrstniRed'];
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const SESSION_MINUTES = 10;
const HASH_ROUNDS = 1000;

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({ ok: true, app: 'mosnja', version: 3 });
}

function doPost(e) {
  const p = (e && e.parameter) || {};
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);

    switch (p.action) {
      case 'status':   return json_({ ok: true, pinSet: !!props_().getProperty('PIN_HASH') });
      case 'setupPin': return json_(setupPin_(p.pin));
      case 'login':    return json_(login_(p.pin));
      case 'logout':
        if (p.token) CacheService.getScriptCache().remove('s_' + p.token);
        return json_({ ok: true });
    }

    requireSession_(p.token);
    switch (p.action) {
      case 'getAll':      return json_({ ok: true, items: readAll_().map(x => x.item) });
      case 'saveItem':    return json_(saveItem_(JSON.parse(p.item || '{}')));
      case 'deleteItem':  return json_(deleteItem_(p.id));
      case 'setOverride': return json_(setOverride_(p));
      case 'splitSeries': return json_(splitSeries_(p.id, p.month, JSON.parse(p.item || '{}')));
      case 'endSeries':   return json_(endSeries_(p.id, p.month));
      case 'setOrder':    return json_(setOrder_(JSON.parse(p.orders || '{}')));
      case 'changePin':   return json_(changePin_(p.oldPin, p.newPin));
    }
    throw err_('Neznana akcija.');
  } catch (error) {
    return json_({ ok: false, error: error.message, code: error.code || 'ERROR' });
  } finally {
    lock.releaseLock();
  }
}

/** Run manually from the Apps Script editor if you forget your PIN. */
function resetPin() {
  ['PIN_HASH', 'PIN_SALT', 'FAILS', 'LOCK_UNTIL'].forEach(k => props_().deleteProperty(k));
  Logger.log('PIN reset. Open the app and set a new PIN.');
}

/* ------------------------------------------------------------------ */
/* PIN & sessions                                                      */
/* ------------------------------------------------------------------ */

function props_() { return PropertiesService.getScriptProperties(); }

function validPin_(pin) { return /^\d{6}$/.test(String(pin || '')); }

function hash_(pin, salt) {
  let h = salt + ':' + pin;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + pin, Utilities.Charset.UTF_8)
    );
  }
  return h;
}

function storePin_(pin) {
  const salt = Utilities.getUuid();
  props_().setProperties({ PIN_SALT: salt, PIN_HASH: hash_(pin, salt), FAILS: '0', LOCK_UNTIL: '0' });
}

function setupPin_(pin) {
  if (props_().getProperty('PIN_HASH')) throw err_('PIN je že nastavljen.', 'PIN_EXISTS');
  if (!validPin_(pin)) throw err_('PIN mora imeti točno 6 številk.');
  storePin_(pin);
  return { ok: true, token: newSession_() };
}

function checkPin_(pin) {
  const pr = props_();
  const now = Date.now();
  const lockUntil = Number(pr.getProperty('LOCK_UNTIL') || 0);
  if (lockUntil > now) {
    throw err_('Preveč napačnih poskusov. Poskusi znova čez ' + Math.ceil((lockUntil - now) / 60000) + ' min.', 'LOCKED');
  }
  const ok = validPin_(pin) && hash_(pin, pr.getProperty('PIN_SALT')) === pr.getProperty('PIN_HASH');
  if (ok) {
    pr.setProperty('FAILS', '0');
    return;
  }
  const fails = Number(pr.getProperty('FAILS') || 0) + 1;
  if (fails >= MAX_ATTEMPTS) {
    pr.setProperties({ FAILS: '0', LOCK_UNTIL: String(now + LOCK_MINUTES * 60000) });
    throw err_('Napačen PIN. Dostop je zaklenjen za ' + LOCK_MINUTES + ' min.', 'LOCKED');
  }
  pr.setProperty('FAILS', String(fails));
  throw err_('Napačen PIN. Preostali poskusi: ' + (MAX_ATTEMPTS - fails) + '.', 'BAD_PIN');
}

function login_(pin) {
  if (!props_().getProperty('PIN_HASH')) throw err_('PIN še ni nastavljen.', 'NO_PIN');
  checkPin_(pin);
  return { ok: true, token: newSession_() };
}

function changePin_(oldPin, newPin) {
  checkPin_(oldPin);
  if (!validPin_(newPin)) throw err_('Novi PIN mora imeti točno 6 številk.');
  storePin_(newPin);
  return { ok: true };
}

function newSession_() {
  const token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put('s_' + token, '1', SESSION_MINUTES * 60);
  return token;
}

function requireSession_(token) {
  const cache = CacheService.getScriptCache();
  if (!token || !cache.get('s_' + token)) throw err_('Seja je potekla. Vnesi PIN.', 'AUTH');
  cache.put('s_' + token, '1', SESSION_MINUTES * 60); // sliding expiry
}

/* ------------------------------------------------------------------ */
/* Sheet access                                                        */
/* ------------------------------------------------------------------ */

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  const head = sh.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (head[HEADERS.length - 1] !== HEADERS[HEADERS.length - 1]) {   // new sheet or v1 sheet → (re)write header
    sh.getRange('A:E').setNumberFormat('@');   // ID, Mesec, Tip, Naziv, Kategorija
    sh.getRange('H:H').setNumberFormat('@');   // Opomba
    sh.getRange('K:L').setNumberFormat('@');   // DoMeseca, Nadrejena
    sh.getRange('F:F').setNumberFormat('#,##0.00 "€"');
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function monthStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM');
  return String(v || '');
}

const bool_ = v => v === true || String(v).toUpperCase() === 'TRUE';

function readAll_() {
  const values = sheet_().getDataRange().getValues();
  return values.slice(1).map((r, i) => ({
    row: i + 2,
    created: r[8] || new Date(),
    item: {
      id: String(r[0] || ''),
      month: monthStr_(r[1]),
      type: String(r[2] || ''),
      name: String(r[3] || ''),
      category: String(r[4] || ''),
      amount: Number(r[5]) || 0,
      recurring: bool_(r[6]),
      note: String(r[7] || ''),
      end: monthStr_(r[10]),
      parent: String(r[11] || ''),
      skip: bool_(r[12]),
      order: r[13] === '' || r[13] == null ? null : Number(r[13])
    }
  })).filter(x => x.item.id);
}

/** Prevent formula injection: text starting with = + - @ is stored as plain text. */
function safeText_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }

function toRow_(it, created) {
  return [it.id, it.month, it.type, safeText_(it.name), safeText_(it.category), it.amount, it.recurring,
          safeText_(it.note), created, new Date(), it.end, it.parent, it.skip,
          it.order == null ? '' : it.order];
}

function writeRow_(rec, item) {
  sheet_().getRange(rec.row, 1, 1, HEADERS.length).setValues([toRow_(item, rec.created)]);
}

function appendItems_(items) {
  if (!items.length) return;
  const sh = sheet_();
  const now = new Date();
  sh.getRange(sh.getLastRow() + 1, 1, items.length, HEADERS.length).setValues(items.map(it => toRow_(it, now)));
}

function deleteRows_(recs) {
  const sh = sheet_();
  recs.map(r => r.row).sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

function checkMonth_(m) {
  if (!/^\d{4}-\d{2}$/.test(String(m || ''))) throw err_('Napačen mesec.');
  return m;
}

function prevMonth_(m) {
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7));
  return mo === 1 ? (y - 1) + '-12' : y + '-' + ('0' + (mo - 1)).slice(-2);
}

const newId_ = () => Utilities.getUuid().slice(0, 8);

function clean_(it) {
  const type = it.type === 'prihodek' || it.type === 'odhodek' ? it.type : null;
  if (!type) throw err_('Napačen tip postavke.');
  checkMonth_(it.month);
  const amount = Math.round(Number(it.amount) * 100) / 100;
  if (!isFinite(amount) || amount < 0) throw err_('Napačen znesek.');
  const name = String(it.name || '').trim().slice(0, 80);
  if (!name) throw err_('Vnesi naziv.');
  const recurring = !!it.recurring;
  let end = '';
  if (recurring && it.end) {
    end = checkMonth_(it.end);
    if (end < it.month) throw err_('Končni mesec ne sme biti pred začetnim.');
  }
  return {
    id: it.id ? String(it.id) : '',
    month: it.month, type: type, name: name,
    category: String(it.category || 'Drugo').trim().slice(0, 40),
    amount: amount, recurring: recurring,
    note: String(it.note || '').trim().slice(0, 200),
    end: end, parent: '', skip: false, order: null
  };
}

function find_(all, id) {
  const rec = all.find(x => x.item.id === String(id) && !x.item.parent);
  if (!rec) throw err_('Postavka ne obstaja več.');
  return rec;
}

const children_ = (all, id) => all.filter(x => x.item.parent === String(id));

/** Create or update a one-off item or a whole series. */
function saveItem_(raw) {
  const item = clean_(raw);
  if (!item.id) {
    item.id = newId_();
    appendItems_([item]);
    return { ok: true, item: item };
  }
  const all = readAll_();
  const rec = find_(all, item.id);
  item.order = rec.item.order;          // editing never changes the manual position
  writeRow_(rec, item);
  // Drop overrides that no longer fall inside the series
  deleteRows_(children_(all, item.id).filter(c =>
    !item.recurring || c.item.month < item.month || (item.end && c.item.month > item.end)));
  return { ok: true, item: item };
}

/** Delete an item or a whole series (with its overrides). */
function deleteItem_(id) {
  const all = readAll_();
  deleteRows_([find_(all, id)].concat(children_(all, id)));
  return { ok: true };
}

/** Change (or skip) a single month of a series. clear=1 removes the override. */
function setOverride_(p) {
  const month = checkMonth_(p.month);
  const all = readAll_();
  const parent = find_(all, p.parent).item;
  if (!parent.recurring) throw err_('Postavka ni ponavljajoča.');
  const existing = children_(all, parent.id).find(c => c.item.month === month);
  if (p.clear === '1') {
    if (existing) deleteRows_([existing]);
    return { ok: true };
  }
  const skip = p.skip === '1';
  const amount = skip ? 0 : Math.round(Number(p.amount) * 100) / 100;
  if (!isFinite(amount) || amount < 0) throw err_('Napačen znesek.');
  const ov = {
    id: existing ? existing.item.id : newId_(), month: month,
    type: parent.type, name: parent.name, category: parent.category,
    amount: amount, recurring: false, note: String(p.note || '').trim().slice(0, 200),
    end: '', parent: parent.id, skip: skip, order: null
  };
  existing ? writeRow_(existing, ov) : appendItems_([ov]);
  return { ok: true };
}

/** "This and following months": end the old series before `month`, start a new one at `month`. */
function splitSeries_(id, month, raw) {
  checkMonth_(month);
  const all = readAll_();
  const rec = find_(all, id);
  const old = rec.item;
  if (month <= old.month) return saveItem_(Object.assign({}, raw, { id: old.id, month: old.month }));
  const next = clean_(Object.assign({}, raw, { id: '', month: month, recurring: true }));
  next.id = newId_();
  next.order = old.order;               // the continuation keeps its place in the list
  writeRow_(rec, Object.assign({}, old, { end: prevMonth_(month) }));
  deleteRows_(children_(all, id).filter(c => c.item.month >= month));
  appendItems_([next]);
  return { ok: true, item: next };
}

/** "Delete from this month on": the series ends the month before `month`. */
function endSeries_(id, month) {
  checkMonth_(month);
  const all = readAll_();
  const rec = find_(all, id);
  if (month <= rec.item.month) return deleteItem_(id);
  writeRow_(rec, Object.assign({}, rec.item, { end: prevMonth_(month) }));
  deleteRows_(children_(all, id).filter(c => c.item.month >= month));
  return { ok: true };
}

/** Manual ordering: { id: position, ... } for items/series whose position changed. */
function setOrder_(orders) {
  const sh = sheet_();
  const col = HEADERS.indexOf('VrstniRed') + 1;
  readAll_().forEach(rec => {
    if (rec.item.parent || !(rec.item.id in orders)) return;
    const pos = Number(orders[rec.item.id]);
    if (isFinite(pos)) sh.getRange(rec.row, col).setValue(pos);
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function err_(message, code) {
  const e = new Error(message);
  e.code = code || 'ERROR';
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
