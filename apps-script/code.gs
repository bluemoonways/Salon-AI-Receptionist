/**
 * Salon AI Receptionist — Vapi Custom Tools webhook (Google Apps Script) — v5
 *
 * Tools (Vapi tool name -> function):
 *   1. Check_Availability   -> checkAvailability   (date, service, staff?)
 *   2. Book_Appointment     -> bookAppointment     (customer_name, phone, service, date, time, staff?)
 *   3. Get_Services         -> getServices         (category?)
 *   4. Find_Appointment     -> findAppointment     (phone or appointment_id)
 *   5. Manage_Appointment   -> manageAppointment   (appointment_id, customer_name, action: cancel | reschedule, date?, time?, staff?)
 *   6. Get_Salon_Info       -> getSalonInfo        (field?)
 *
 * GOOGLE SHEET TABS (row 1 = headers, exactly as written):
 *   Services     : service_name | category | price | duration_min
 *   Staff        : staff_name | specialties | start_time | end_time | days_off | break_start | break_end   (break_* optional)
 *   Appointments : appointment_id | customer_name | phone | service | staff | date | time | duration_min | price | status
 *   Salon_Info   : field | value
 *   Holidays     : date | reason                (OPTIONAL, date as YYYY-MM-DD, plain text)
 *   Staff_Leave  : staff_name | date | reason   (OPTIONAL, one row per day off)
 *   Call_Log     : timestamp | tool | args | result   (OPTIONAL, filled automatically if the tab exists)
 *   Archive      : same headers as Appointments (OPTIONAL, filled by archivePastAppointments)
 *
 * OPTIONAL Salon_Info rows (defaults are used if missing):
 *   max_advance_days (60) | slot_step_min (30) | min_lead_minutes (60) | buffer_min (0)
 *   cancel_notice_hours (24) | enforce_cancel_notice (no)
 *
 * WHAT'S NEW IN v5:
 *   - Cancel / reschedule now requires the CUSTOMER NAME used at booking (fuzzy match, so speech-to-text
 *     slips like "Rafaim" for "Rafahim" still work). Wrong name never reveals the real name.
 *   - Optional shared secret: add ?key=YOUR_SECRET to the webhook URL and set SECRET below.
 *   - Every tool call has its own try/catch; callers never hear stack traces.
 *   - Formula-injection protection for customer names.
 *   - Phone must have at least 10 digits; overlap guard (same phone cannot hold two overlapping bookings).
 *   - Minimum lead time, buffer between appointments, stylist break time, per-date staff leave.
 *   - Cancellation notice policy (warn or enforce).
 *   - "Any stylist" picks the least busy stylist that day.
 *   - Smarter service matching (asks which one if ambiguous, one service per booking).
 *   - Availability is returned as short ranges (easy to read aloud). Opening hours spoken in 12-hour format.
 *   - Call_Log tab, monthly Archive trigger, setupExtras() and cleanTestData() helpers.
 *
 * AFTER PASTING: run setupExtras() once (non-destructive), optionally run setupTriggers() once,
 * then redeploy: Deploy > Manage deployments > Edit > New version > Deploy.
 * Edits to Services / Staff / Salon_Info / Holidays / Staff_Leave show up within CACHE_TTL seconds;
 * run clearCache() to refresh instantly.
 */

var SHEET_ID = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
var SERVICES_SHEET = 'Services';
var STAFF_SHEET = 'Staff';
var APPOINTMENTS_SHEET = 'Appointments';
var INFO_SHEET = 'Salon_Info';
var HOLIDAYS_SHEET = 'Holidays';
var LEAVE_SHEET = 'Staff_Leave';
var LOG_SHEET = 'Call_Log';
var ARCHIVE_SHEET = 'Archive';

var SECRET = PropertiesService.getScriptProperties().getProperty('SECRET') || '';                    // e.g. 'k9X2-secret'. If set, webhook URL must end with ?key=k9X2-secret
var CURRENCY = '$';
var TZ = 'America/Chicago';        // salon timezone
var CACHE_TTL = 600;                // seconds
var ARCHIVE_AFTER_DAYS = 30;

// Defaults (can be overridden from Salon_Info rows, see header)
var DEF_SLOT_STEP = 30;
var DEF_MAX_ADVANCE_DAYS = 60;
var DEF_MIN_LEAD_MIN = 60;
var DEF_BUFFER_MIN = 0;
var DEF_CANCEL_NOTICE_HOURS = 24;

var FRIENDLY_ERROR = 'Sorry, something went wrong on our side. Please apologise to the caller and offer to take their details so the salon can call back.';
var BUSY_MESSAGE = 'The booking system is busy right now. Please ask the caller to hold on a moment and try again.';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function doPost(e) {
  var results = [];
  var toolCalls = [];
  try {
    var body = JSON.parse(e.postData.contents);
    toolCalls = (body.message && (body.message.toolCallList || body.message.toolCalls)) || [];
  } catch (parseBodyErr) {
    Logger.log('Bad request body: ' + parseBodyErr.message);
    return jsonOut([{ toolCallId: 'error', result: FRIENDLY_ERROR }]);
  }

  var authorized = !SECRET || (e && e.parameter && e.parameter.key === SECRET);
  var ss = null;
  try { ss = SpreadsheetApp.openById(SHEET_ID); } catch (openErr) { Logger.log('Cannot open sheet: ' + openErr.message); }

  toolCalls.forEach(function (call) {
    var toolName = call.name || (call.function && call.function.name);
    var rawArgs = call.arguments || call.parameters || (call.function && call.function.arguments) || {};
    var args = rawArgs;
    if (typeof rawArgs === 'string') {
      try { args = JSON.parse(rawArgs); } catch (parseErr) { args = {}; }
    }
    var callId = call.id || call.toolCallId;
    var resultText;

    try {
      if (!authorized) {
        Logger.log('Unauthorized call blocked: ' + toolName);
        resultText = FRIENDLY_ERROR;
      } else if (!ss) {
        resultText = FRIENDLY_ERROR;
      } else {
        resultText = route(String(toolName || '').toLowerCase(), args, ss);
      }
    } catch (err) {
      Logger.log('ERROR in ' + toolName + ': ' + err.message + ' | ' + err.stack);
      resultText = FRIENDLY_ERROR;
    }

    results.push({ toolCallId: callId, result: resultText });
    if (authorized && ss) logCall(ss, toolName, args, resultText);
  });

  return jsonOut(results);
}

function route(toolName, args, ss) {
  switch (toolName) {
    case 'check_availability': return checkAvailability(args, ss);
    case 'book_appointment': return bookAppointment(args, ss);
    case 'get_services': return getServices(args, ss);
    case 'find_appointment': return findAppointment(args, ss);
    case 'manage_appointment':
    case 'cancel_appointment': return manageAppointment(args, ss);
    case 'get_salon_info': return getSalonInfo(args, ss);
    default:
      Logger.log('Unknown tool: ' + toolName);
      return 'Unknown tool: ' + toolName;
  }
}

function jsonOut(results) {
  return ContentService
    .createTextOutput(JSON.stringify({ results: results }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Shared validation. Returns an error message string, or '' if the date is OK.
// ---------------------------------------------------------------------------
function dateProblem(ss, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return 'I could not understand that date. Please ask the caller for the day again.';
  }
  if (isPastDate(date)) {
    return 'That date has already passed. Please choose today or a future date.';
  }
  var maxDays = cfgNum(ss, 'max_advance_days', DEF_MAX_ADVANCE_DAYS);
  if (isTooFar(date, maxDays)) {
    return 'We take bookings up to ' + maxDays + ' days in advance. Please choose an earlier date.';
  }
  var closed = closedReason(ss, date);
  if (closed) {
    return 'Sorry, the salon is closed on ' + dayLabel(date) + closed + '. Would you like to try another day?';
  }
  return '';
}

function timeProblem(ss, date, startMin) {
  var lead = cfgNum(ss, 'min_lead_minutes', DEF_MIN_LEAD_MIN);
  if (tooSoon(date, startMin, lead)) {
    return 'That time is too soon or has already passed. We need at least ' + lead + ' minutes notice for phone bookings. Please choose a later time.';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Tool 1: availability
// ---------------------------------------------------------------------------
function checkAvailability(args, ss) {
  if (!args.date || !args.service) {
    return 'Please provide the service and the date (YYYY-MM-DD) to check availability.';
  }
  var date = normalizeDate(args.date);
  var rs = resolveService(ss, args.service);
  if (rs.error) return rs.error;
  var service = rs.service;

  var problem = dateProblem(ss, date);
  if (problem) return problem;

  var staffList = eligibleStaff(ss, service, args.staff);
  if (staffList.error) return staffList.error;

  var step = cfgNum(ss, 'slot_step_min', DEF_SLOT_STEP);
  var buffer = cfgNum(ss, 'buffer_min', DEF_BUFFER_MIN);
  var lead = cfgNum(ss, 'min_lead_minutes', DEF_MIN_LEAD_MIN);
  var appts = activeAppointments(ss, date);
  var times = {};

  staffList.list.forEach(function (st) {
    if (staffOffOnDate(st, date)) return;
    for (var m = st.startMin; m + service.duration <= st.endMin; m += step) {
      if (tooSoon(date, m, lead)) continue;
      if (slotFree(st, m, service.duration, appts, null, buffer)) times[m] = true;
    }
  });

  var staffLabel = (args.staff && staffList.list.length === 1) ? staffList.list[0].name : (args.staff || '');
  var mins = Object.keys(times).map(Number).sort(function (a, b) { return a - b; });

  if (mins.length === 0) {
    return 'Sorry, there are no openings for ' + service.name + ' on ' + dayLabel(date) +
      (staffLabel ? ' with ' + staffLabel : '') + '. Would you like to try another day?';
  }

  var ranges = formatRanges(mins, step);
  var shown = ranges.slice(0, 6);
  return 'Openings for ' + service.name + ' (' + service.duration + ' min) on ' + dayLabel(date) +
    (staffLabel ? ' with ' + staffLabel : '') + '. Start times available: ' + shown.join(', ') +
    (ranges.length > 6 ? ', and some later times' : '') +
    ' (every ' + step + ' minutes within each range). Earliest is ' + fmt12(mins[0]) +
    '. Offer the caller two or three options, not the whole list.';
}

// [540,570,600,780] -> ["9:00 AM to 10:00 AM", "1:00 PM"]
function formatRanges(mins, step) {
  var out = [];
  var start = mins[0], prev = mins[0];
  for (var i = 1; i <= mins.length; i++) {
    if (i < mins.length && mins[i] - prev === step) { prev = mins[i]; continue; }
    out.push(start === prev ? fmt12(start) : fmt12(start) + ' to ' + fmt12(prev));
    if (i < mins.length) { start = mins[i]; prev = mins[i]; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool 2: book
// ---------------------------------------------------------------------------
function bookAppointment(args, ss) {
  if (!args.date || !args.time) {
    return 'Please provide both a date (YYYY-MM-DD) and a time (HH:MM).';
  }
  var name = cleanName(args.customer_name);
  if (!name || !args.phone || !args.service) {
    return 'To book I need the customer name, phone number and the service.';
  }
  if (last10(args.phone).length < 10) {
    return 'That phone number looks incomplete. Please ask the caller to say the full number again, including the area or country code.';
  }

  var date = normalizeDate(args.date);
  var time = normalizeTime(args.time);
  var startMin = toMinutes(time);
  if (startMin === null) return 'I could not understand that time. Please give it as HH:MM.';

  var problem = dateProblem(ss, date);
  if (problem) return problem;
  var tProblem = timeProblem(ss, date, startMin);
  if (tProblem) return tProblem;

  var rs = resolveService(ss, args.service);
  if (rs.error) return rs.error;
  var service = rs.service;

  var buffer = cfgNum(ss, 'buffer_min', DEF_BUFFER_MIN);
  var lock = acquireLock();
  if (!lock) return BUSY_MESSAGE;
  try {
    var staffList = eligibleStaff(ss, service, args.staff);
    if (staffList.error) return staffList.error;

    var appts = activeAppointments(ss, date);
    var phone10 = last10(args.phone);

    for (var d = 0; d < appts.length; d++) {
      var a = appts[d];
      if (last10(a.phone) !== phone10) continue;

      // Exact duplicate
      if (String(a.service).toLowerCase() === service.name.toLowerCase() && a.time === time) {
        return 'This appointment is already confirmed. Say the confirmation number to the caller exactly like this: ' +
          spellId(a.appointment_id) + '. ' + a.service + ' with ' + a.staff + ' on ' + dayLabel(date) +
          ' at ' + fmt12(startMin) + '.';
      }
      // Overlap with another booking by the same phone
      var aStart = toMinutes(a.time);
      var aEnd = aStart + (Number(a.duration_min) || 30);
      if (!(startMin + service.duration <= aStart || startMin >= aEnd)) {
        return 'This phone number already has ' + a.service + ' at ' + fmt12(aStart) + ' on ' + dayLabel(date) +
          ', which overlaps with that time. Please choose a different time.';
      }
    }

    var chosen = null;
    var ordered = orderByLoad(staffList.list, appts);
    for (var i = 0; i < ordered.length; i++) {
      var st = ordered[i];
      if (staffOffOnDate(st, date)) continue;
      if (slotFree(st, startMin, service.duration, appts, null, buffer)) { chosen = st; break; }
    }
    if (!chosen) {
      var label = (args.staff && staffList.list.length === 1) ? staffList.list[0].name : args.staff;
      return 'Sorry, ' + fmt12(startMin) + ' on ' + dayLabel(date) + ' is not available for ' + service.name +
        (label ? ' with ' + label : '') + '. Would you like me to check other times?';
    }

    var t = readTable(ss, APPOINTMENTS_SHEET);
    var newId = nextAppointmentId(t);
    var rowObj = {
      appointment_id: newId,
      customer_name: name,
      phone: String(args.phone),
      service: service.name,
      staff: chosen.name,
      date: date,
      time: time,
      duration_min: service.duration,
      price: service.price,
      status: 'Confirmed'
    };
    appendRowByHeaders(t, rowObj, ['appointment_id', 'customer_name', 'phone', 'date', 'time']);

    return 'Your appointment is confirmed. Say the confirmation number to the caller exactly like this: ' +
      spellId(newId) + '. ' + service.name + ' with ' + chosen.name +
      ' on ' + dayLabel(date) + ' at ' + fmt12(startMin) + '. Estimated price ' + CURRENCY + service.price +
      '. Tell the caller to keep this number and the name ' + name + ' for any changes. See you soon, ' + name + '!';
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Tool 3: services
// ---------------------------------------------------------------------------
function getServices(args, ss) {
  var services = loadServices(ss);
  var filter = args && args.category ? String(args.category).trim().toLowerCase() : null;

  var byCat = {};
  services.forEach(function (s) {
    if (filter && s.category.toLowerCase().indexOf(filter) === -1 && s.name.toLowerCase().indexOf(filter) === -1) return;
    if (!byCat[s.category]) byCat[s.category] = [];
    byCat[s.category].push(s.name + ' (' + CURRENCY + s.price + ', ' + s.duration + ' min)');
  });

  var cats = Object.keys(byCat);
  if (cats.length === 0) {
    return filter
      ? "We don't have anything under '" + args.category + "'. Would you like to hear all our services?"
      : 'The service list is currently empty.';
  }
  return 'Our services: ' + cats.map(function (c) { return c + ': ' + byCat[c].join(', '); }).join('. ') + '.';
}

// ---------------------------------------------------------------------------
// Tool 4: find appointment (by phone or id). Customer names are NOT returned.
// ---------------------------------------------------------------------------
function findAppointment(args, ss) {
  if (!args || (!args.phone && !args.appointment_id)) {
    return 'Please provide the phone number or the appointment ID.';
  }
  var t = readTable(ss, APPOINTMENTS_SHEET);
  var today = todayStr();
  var found = [];
  var reqDigits = idDigits(args.appointment_id);

  t.rows.forEach(function (r) {
    if (String(r.status).toLowerCase() !== 'confirmed') return;
    if (r.date < today) return;
    if (reqDigits && idDigits(r.appointment_id) === reqDigits) {
      found.push(r);
    } else if (args.phone && last10(args.phone).length >= 10 && last10(r.phone) === last10(args.phone)) {
      found.push(r);
    }
  });

  if (found.length === 0) {
    return "I couldn't find any upcoming appointments for that " + (args.appointment_id ? 'ID' : 'phone number') + '.';
  }
  found.sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; });

  return 'Upcoming appointments: ' + found.map(function (r) {
    return 'ID ' + spellId(r.appointment_id) + ': ' + r.service + ' with ' + r.staff + ' on ' + dayLabel(r.date) +
      ' at ' + fmt12(toMinutes(r.time));
  }).join('; ') + '. To cancel or reschedule, ask the caller for the full name used when booking.';
}

// ---------------------------------------------------------------------------
// Tool 5: cancel / reschedule (requires appointment_id + customer_name)
// ---------------------------------------------------------------------------
function manageAppointment(args, ss) {
  if (!args || !args.appointment_id) {
    return 'Please provide the appointment ID. (If the caller does not know it, look it up by phone first.)';
  }
  if (!args.action) return 'Do you want to cancel the appointment or reschedule it?';
  if (!args.customer_name || nameTokens(args.customer_name).length === 0) {
    return 'For security, please ask the caller for the full name the appointment was booked under, then try again.';
  }

  var buffer = cfgNum(ss, 'buffer_min', DEF_BUFFER_MIN);
  var lock = acquireLock();
  if (!lock) return BUSY_MESSAGE;
  try {
    var t = readTable(ss, APPOINTMENTS_SHEET);
    var appt = null;
    var reqId = idDigits(args.appointment_id);
    if (reqId) {
      t.rows.forEach(function (r) {
        if (idDigits(r.appointment_id) === reqId) appt = r;
      });
    }
    if (!appt) return "I couldn't find an appointment with ID " + args.appointment_id + '. Could you double-check it?';

    // Name verification. Same message whether the ID or the name is wrong, and never reveal the stored name.
    if (!nameMatches(args.customer_name, appt.customer_name)) {
      return "I couldn't verify that name against this appointment. Please ask the caller to double-check the appointment number and the exact name used when booking.";
    }

    if (String(appt.status).toLowerCase() === 'cancelled') {
      return 'Appointment ' + spellId(appt.appointment_id) + ' is already cancelled.';
    }

    var hoursLeft = minutesUntil(appt.date, appt.time) / 60;
    if (hoursLeft < 0) return 'That appointment has already passed, so it cannot be changed.';

    var noticeHrs = cfgNum(ss, 'cancel_notice_hours', DEF_CANCEL_NOTICE_HOURS);
    var enforce = String(loadInfo(ss)['enforce_cancel_notice'] || 'no').trim().toLowerCase() === 'yes';
    var lateNote = '';
    if (hoursLeft < noticeHrs) {
      if (enforce) {
        return 'Our policy requires at least ' + noticeHrs + ' hours notice to change an appointment, and this one is sooner than that. ' +
          'Please ask the caller to phone the salon directly' + (loadInfo(ss)['phone'] ? ' at ' + loadInfo(ss)['phone'] : '') + '.';
      }
      lateNote = ' Mention gently that our policy asks for ' + noticeHrs + ' hours notice.';
    }

    var action = String(args.action).trim().toLowerCase();
    var statusCol = t.headers.indexOf('status') + 1;

    if (action === 'cancel') {
      t.sheet.getRange(appt._row, statusCol).setValue('Cancelled');
      return 'Appointment ' + spellId(appt.appointment_id) + ' (' + appt.service + ' on ' + dayLabel(appt.date) +
        ' at ' + fmt12(toMinutes(appt.time)) + ') has been cancelled.' + lateNote;
    }

    if (action === 'reschedule' || action === 'update') {
      var newDate = args.date ? normalizeDate(args.date) : appt.date;
      var newTime = args.time ? normalizeTime(args.time) : appt.time;
      var startMin = toMinutes(newTime);
      if (startMin === null) return 'I could not understand that time. Please give it as HH:MM.';

      var problem = dateProblem(ss, newDate);
      if (problem) return problem;
      var tProblem = timeProblem(ss, newDate, startMin);
      if (tProblem) return tProblem;

      var service = lookupExactService(ss, appt.service) ||
        { name: appt.service, duration: Number(appt.duration_min) || 30, price: appt.price };

      var wantedStaff = args.staff || appt.staff;
      var staffList = eligibleStaff(ss, service, wantedStaff);
      if (staffList.error) return staffList.error;

      var appts = activeAppointments(ss, newDate);
      var chosen = null;
      var i, st;
      for (i = 0; i < staffList.list.length; i++) {
        st = staffList.list[i];
        if (staffOffOnDate(st, newDate)) continue;
        if (slotFree(st, startMin, service.duration, appts, appt.appointment_id, buffer)) { chosen = st; break; }
      }
      if (!chosen && !args.staff) {
        var others = orderByLoad(eligibleStaff(ss, service, null).list || [], appts);
        for (i = 0; i < others.length; i++) {
          st = others[i];
          if (staffOffOnDate(st, newDate)) continue;
          if (slotFree(st, startMin, service.duration, appts, appt.appointment_id, buffer)) { chosen = st; break; }
        }
      }
      if (!chosen) {
        return 'Sorry, ' + fmt12(startMin) + ' on ' + dayLabel(newDate) + ' is not available. Would you like me to check other times?';
      }

      setText(t, appt._row, 'date', newDate);
      setText(t, appt._row, 'time', newTime);
      t.sheet.getRange(appt._row, t.headers.indexOf('staff') + 1).setValue(chosen.name);

      return 'Appointment ' + spellId(appt.appointment_id) + ' is now ' + service.name + ' with ' + chosen.name +
        ' on ' + dayLabel(newDate) + ' at ' + fmt12(startMin) + '.' + lateNote;
    }

    return "I didn't understand that action. Please say cancel or reschedule.";
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Tool 6: salon info
// ---------------------------------------------------------------------------
function getSalonInfo(args, ss) {
  var info = loadInfo(ss);

  if (args && args.field) {
    var key = String(args.field).trim().toLowerCase();
    if (key in info) return args.field + ': ' + speakInfo(key, info[key]);
    return "I don't have information on '" + args.field + "'. I can tell you our name, location, phone, opening hours or booking policy.";
  }

  return (info['name'] || 'Our salon') + ' is located at ' + (info['location'] || 'N/A') +
    '. Phone: ' + (info['phone'] || 'N/A') +
    '. Open ' + speakInfo('opening_time', info['opening_time']) + ' to ' + speakInfo('closing_time', info['closing_time']) +
    (info['closed_days'] ? '. Closed on ' + info['closed_days'] : '') +
    ((info['services_summary'] || info['cuisine']) ? '. We offer ' + (info['services_summary'] || info['cuisine']) : '') + '.';
}

// "09:00" -> "9:00 AM" for *_time fields; everything else unchanged
function speakInfo(key, value) {
  if (value === undefined || value === null || value === '') return 'N/A';
  if (/_time$/.test(key)) {
    var mins = toMinutes(normalizeTime(value));
    if (mins !== null) return fmt12(mins);
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------
function cached(key, ttl, fn) {
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* ignore cache read errors */ }
  var result = fn();
  try { cache.put(key, JSON.stringify(result), ttl); } catch (e2) { /* too big or unavailable */ }
  return result;
}

// Run manually from the editor after editing Services / Staff / Salon_Info / Holidays / Staff_Leave
function clearCache() {
  CacheService.getScriptCache().removeAll(['services', 'staff', 'info', 'holidays']);
}

// ---------------------------------------------------------------------------
// Config / lock helpers
// ---------------------------------------------------------------------------
function cfgNum(ss, key, def) {
  var raw = loadInfo(ss)[key];
  var n = Number(raw);
  return (raw === undefined || raw === null || raw === '' || isNaN(n)) ? def : n;
}

function acquireLock() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    return lock;
  } catch (e) {
    Logger.log('Lock timeout');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
function readTable(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Missing sheet tab: ' + sheetName);
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = { _row: i + 1 };
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = values[i][c];
      if (values[i][c] !== '' && values[i][c] !== null) empty = false;
    }
    if (empty) continue;
    if ('date' in obj) obj.date = normalizeDate(obj.date);
    if ('time' in obj) obj.time = normalizeTime(obj.time);
    rows.push(obj);
  }
  return { sheet: sheet, headers: headers, rows: rows };
}

function loadServices(ss) {
  return cached('services', CACHE_TTL, function () {
    return readTable(ss, SERVICES_SHEET).rows.map(function (r) {
      return {
        name: String(r.service_name).trim(),
        category: String(r.category || 'Other').trim(),
        price: Number(r.price) || 0,
        duration: Number(r.duration_min) || 30
      };
    });
  });
}

function lookupExactService(ss, name) {
  var q = String(name || '').trim().toLowerCase();
  var list = loadServices(ss);
  for (var i = 0; i < list.length; i++) if (list[i].name.toLowerCase() === q) return list[i];
  return null;
}

// Returns { service } or { error }. Asks the caller to clarify when the name is ambiguous.
function resolveService(ss, name) {
  var q = String(name || '').trim().toLowerCase();
  if (!q) return { error: 'Please tell me which service you would like.' };
  var list = loadServices(ss);

  var exact = lookupExactService(ss, q);
  if (exact) return { service: exact };

  // Caller said several services in one sentence ("manicure and pedicure")
  var inQ = list.filter(function (s) { return q.indexOf(s.name.toLowerCase()) !== -1; });
  inQ = inQ.filter(function (s) {
    var n = s.name.toLowerCase();
    return !inQ.some(function (o) { var on = o.name.toLowerCase(); return on !== n && on.indexOf(n) !== -1; });
  });
  if (inQ.length === 1) return { service: inQ[0] };
  if (inQ.length > 1) {
    return { error: 'I can book one service at a time. Which would you like first: ' +
      inQ.map(function (s) { return s.name; }).join(' or ') + '?' };
  }

  // Partial name ("gel", "color")
  var contains = list.filter(function (s) { return s.name.toLowerCase().indexOf(q) !== -1; });
  if (contains.length === 1) return { service: contains[0] };
  if (contains.length > 1) {
    return { error: "Which one do you mean: " + contains.map(function (s) { return s.name; }).join(', ') + '?' };
  }

  return { error: "Sorry, I couldn't find the service '" + name + "'. Would you like to hear our list of services?" };
}

function loadInfo(ss) {
  return cached('info', CACHE_TTL, function () {
    var info = {};
    readTable(ss, INFO_SHEET).rows.forEach(function (r) {
      info[String(r.field).trim().toLowerCase()] = r.value;
    });
    return info;
  });
}

// Holidays tab is optional
function loadHolidays(ss) {
  return cached('holidays', CACHE_TTL, function () {
    var map = {};
    if (!ss.getSheetByName(HOLIDAYS_SHEET)) return map;
    readTable(ss, HOLIDAYS_SHEET).rows.forEach(function (r) {
      if (r.date) map[String(r.date)] = String(r.reason || '').trim();
    });
    return map;
  });
}

// '' if open, otherwise a short reason such as ' for bank holiday' or ' (we are closed every Sunday)'
function closedReason(ss, dateStr) {
  var holidays = loadHolidays(ss);
  if (dateStr in holidays) {
    return holidays[dateStr] ? ' for ' + holidays[dateStr] : ' for a holiday';
  }
  var info = loadInfo(ss);
  var closedDays = String(info['closed_days'] || '').toLowerCase().split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  var short = weekdayName(dateStr).toLowerCase().substring(0, 3);
  for (var i = 0; i < closedDays.length; i++) {
    if (closedDays[i].substring(0, 3) === short) return ' (we are closed every ' + weekdayName(dateStr) + ')';
  }
  return '';
}

function loadStaff(ss) {
  return cached('staff', CACHE_TTL, function () {
    var info = loadInfo(ss);
    var defStart = toMinutes(normalizeTime(info['opening_time'] || '09:00'));
    var defEnd = toMinutes(normalizeTime(info['closing_time'] || '18:00'));

    // Optional Staff_Leave tab: staff_name | date | reason
    var leave = {};
    if (ss.getSheetByName(LEAVE_SHEET)) {
      readTable(ss, LEAVE_SHEET).rows.forEach(function (r) {
        var k = String(r.staff_name || '').trim().toLowerCase();
        if (!k || !r.date) return;
        if (!leave[k]) leave[k] = [];
        leave[k].push(String(r.date));
      });
    }

    return readTable(ss, STAFF_SHEET).rows.map(function (r) {
      var spec = String(r.specialties || 'all').trim().toLowerCase();
      var s = toMinutes(normalizeTime(r.start_time));
      var e = toMinutes(normalizeTime(r.end_time));
      var name = String(r.staff_name).trim();
      return {
        name: name,
        specialties: spec === '' || spec === 'all' ? [] : spec.split(',').map(function (x) { return x.trim(); }),
        startMin: s === null ? defStart : s,
        endMin: e === null ? defEnd : e,
        breakStart: toMinutes(normalizeTime(r.break_start)),
        breakEnd: toMinutes(normalizeTime(r.break_end)),
        leaveDates: leave[name.toLowerCase()] || [],
        daysOff: String(r.days_off || '').toLowerCase().split(',').map(function (x) { return x.trim().substring(0, 3); }).filter(Boolean)
      };
    });
  });
}

// Levenshtein distance for fuzzy matching
function lev(a, b) {
  var d = [], i, j;
  for (i = 0; i <= a.length; i++) d[i] = [i];
  for (j = 0; j <= b.length; j++) d[0][j] = j;
  for (i = 1; i <= a.length; i++) {
    for (j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return d[a.length][b.length];
}

// ---- Name verification -----------------------------------------------------
function nameTokens(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

function tokenMatch(x, y) {
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4) return lev(x, y) <= 1;   // tolerate one speech-to-text slip
  return false;
}

// Every word of the shorter name must match a word of the longer name.
// "Abbas" matches "Rafahim Abbas"; "J" or a different name does not match.
function nameMatches(given, stored) {
  var g = nameTokens(given), s = nameTokens(stored);
  if (!g.length || !s.length) return false;
  var shorter = g.length <= s.length ? g : s;
  var longer = g.length <= s.length ? s : g;
  return shorter.every(function (t) {
    return longer.some(function (u) { return tokenMatch(t, u); });
  });
}

// Prevents spreadsheet formula injection ("=IMPORTXML(...)") and trims junk
function cleanName(n) {
  return String(n || '').replace(/^[\s=+\-@]+/, '').replace(/\s+/g, ' ').trim().substring(0, 80);
}

function eligibleStaff(ss, service, staffName) {
  var all = loadStaff(ss);
  var list = all.filter(function (st) {
    return st.specialties.length === 0 || st.specialties.indexOf(service.name.toLowerCase()) !== -1;
  });
  if (list.length === 0) return { error: 'Sorry, no stylist is currently set up for ' + service.name + '.' };

  if (staffName) {
    var q = String(staffName).trim().toLowerCase();

    var exact = list.filter(function (st) { return st.name.toLowerCase().indexOf(q) !== -1; });
    if (exact.length) {
      list = exact;
    } else {
      // fuzzy match (Mira -> Maria, Ahmaud -> Ahmed)
      var best = null, bestD = 99;
      list.forEach(function (st) {
        var dd = lev(q, st.name.toLowerCase());
        if (dd < bestD) { bestD = dd; best = st; }
      });
      if (best && bestD <= 2) {
        list = [best];
      } else {
        return {
          error: "Sorry, " + staffName + " does not do " + service.name +
            ". Our stylists for this service are: " + list.map(function (s) { return s.name; }).join(', ') + '.'
        };
      }
    }
  }
  return { list: list };
}

function staffOffOnDate(st, dateStr) {
  var dow = weekdayName(dateStr).toLowerCase().substring(0, 3);
  if (st.daysOff.indexOf(dow) !== -1) return true;
  return (st.leaveDates || []).indexOf(dateStr) !== -1;
}

// Least busy stylist first, so "any stylist" spreads the load
function orderByLoad(list, appts) {
  var counts = {};
  appts.forEach(function (a) { counts[a.staff] = (counts[a.staff] || 0) + 1; });
  return list.map(function (st, idx) { return { st: st, idx: idx }; })
    .sort(function (a, b) {
      var diff = (counts[a.st.name] || 0) - (counts[b.st.name] || 0);
      return diff !== 0 ? diff : a.idx - b.idx;
    })
    .map(function (x) { return x.st; });
}

function activeAppointments(ss, dateStr) {
  return readTable(ss, APPOINTMENTS_SHEET).rows.filter(function (r) {
    return r.date === dateStr && String(r.status).toLowerCase() === 'confirmed';
  });
}

function slotFree(st, startMin, duration, appts, ignoreId, buffer) {
  buffer = buffer || 0;
  if (startMin < st.startMin || startMin + duration > st.endMin) return false;

  // Stylist break (lunch etc.)
  if (st.breakStart !== null && st.breakStart !== undefined && st.breakEnd !== null && st.breakEnd !== undefined) {
    if (!(startMin + duration <= st.breakStart || startMin >= st.breakEnd)) return false;
  }

  for (var i = 0; i < appts.length; i++) {
    var a = appts[i];
    if (a.staff !== st.name) continue;
    if (ignoreId && String(a.appointment_id).toLowerCase() === String(ignoreId).toLowerCase()) continue;
    var aStart = toMinutes(a.time);
    var aEnd = aStart + (Number(a.duration_min) || 30);
    if (!(startMin + duration + buffer <= aStart || startMin >= aEnd + buffer)) return false;
  }
  return true;
}

function nextAppointmentId(t) {
  var maxNum = 1000;
  t.rows.forEach(function (r) {
    var n = parseInt(String(r.appointment_id).replace(/[^0-9]/g, ''), 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  });
  return 'APT' + (maxNum + 1);
}

function appendRowByHeaders(t, obj, textCols) {
  var row = t.sheet.getLastRow() + 1;
  textCols.forEach(function (name) {
    var c = t.headers.indexOf(name);
    if (c !== -1) t.sheet.getRange(row, c + 1).setNumberFormat('@');
  });
  var values = t.headers.map(function (h) { return h in obj ? obj[h] : ''; });
  t.sheet.getRange(row, 1, 1, t.headers.length).setValues([values]);
}

function setText(t, row, colName, value) {
  var cell = t.sheet.getRange(row, t.headers.indexOf(colName) + 1);
  cell.setNumberFormat('@');
  cell.setValue(String(value));
}

// ---------------------------------------------------------------------------
// Call log (only if a Call_Log tab exists). Phone numbers are masked.
// ---------------------------------------------------------------------------
function logCall(ss, toolName, args, result) {
  try {
    var sheet = ss.getSheetByName(LOG_SHEET);
    if (!sheet) return;
    var safe = {};
    Object.keys(args || {}).forEach(function (k) {
      safe[k] = (k === 'phone') ? '***' + last10(args[k]).slice(-4) : args[k];
    });
    sheet.appendRow([new Date(), String(toolName), JSON.stringify(safe), String(result).substring(0, 300)]);
  } catch (e) {
    Logger.log('Log failed: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Date / time helpers
// ---------------------------------------------------------------------------
function normalizeDate(d) {
  if (Object.prototype.toString.call(d) === '[object Date]') {
    return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  }
  return String(d).trim();
}

function normalizeTime(t) {
  if (Object.prototype.toString.call(t) === '[object Date]') {
    return Utilities.formatDate(t, TZ, 'HH:mm');
  }
  var s = String(t === undefined || t === null ? '' : t).trim();
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;
  return ('0' + m[1]).slice(-2) + ':' + m[2];
}

function toMinutes(hhmm) {
  var m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmt12(mins) {
  if (mins === null || mins === undefined) return '';
  var h = Math.floor(mins / 60), m = mins % 60;
  var ampm = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + ('0' + m).slice(-2) + ' ' + ampm;
}

function todayStr() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function isPastDate(dateStr) {
  return dateStr < todayStr();
}

// True if the slot is in the past or starts sooner than `lead` minutes from now (today only)
function tooSoon(dateStr, startMin, lead) {
  if (dateStr !== todayStr()) return false;
  var now = toMinutes(Utilities.formatDate(new Date(), TZ, 'HH:mm'));
  return startMin < now + (lead || 0);
}

function isTooFar(dateStr, maxDays) {
  var p = String(dateStr).split('-');
  var t = todayStr().split('-');
  if (p.length !== 3 || t.length !== 3) return false;
  var target = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var today = Date.UTC(Number(t[0]), Number(t[1]) - 1, Number(t[2]));
  return (target - today) / 86400000 > maxDays;
}

// Minutes from now (salon time) until a given date + HH:MM. Negative = already passed.
function minutesUntil(dateStr, timeStr) {
  var p = String(dateStr).split('-');
  var tm = toMinutes(timeStr) || 0;
  var target = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), Math.floor(tm / 60), tm % 60);
  var n = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd-HH-mm').split('-').map(Number);
  var now = Date.UTC(n[0], n[1] - 1, n[2], n[3], n[4]);
  return (target - now) / 60000;
}

// Weekday computed in UTC so it can never shift because of timezone
function weekdayName(dateStr) {
  var p = String(dateStr).split('-');
  if (p.length !== 3) return '';
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0));
  return Utilities.formatDate(d, 'UTC', 'EEEE');
}

// "2026-10-30" -> "Friday, October 30"
function dayLabel(dateStr) {
  var p = String(dateStr).split('-');
  if (p.length !== 3) return String(dateStr);
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0));
  return Utilities.formatDate(d, 'UTC', 'EEEE, MMMM d');
}

// "APT1013" -> "A, P, T, 1, 0, 1, 3"
function spellId(id) {
  return String(id).replace(/[\s,\-]/g, '').split('').join(', ');
}

// Match IDs by digits only, so speech-to-text errors in the letters ("EPT 1013") do not matter
function idDigits(id) {
  return String(id || '').replace(/[^0-9]/g, '');
}

function last10(phone) {
  var digits = String(phone || '').replace(/[^0-9]/g, '');
  return digits.slice(-10);
}

// ---------------------------------------------------------------------------
// Maintenance helpers (run manually from the editor)
// ---------------------------------------------------------------------------

// NON-DESTRUCTIVE one-time setup: creates optional tabs, adds missing Salon_Info rows,
// renames 'cuisine' -> 'services_summary', adds break_start / break_end columns to Staff.
function setupExtras() {
  var ss = SpreadsheetApp.openById(SHEET_ID);

  ensureTab(ss, LEAVE_SHEET, ['staff_name', 'date', 'reason'], [1]);
  ensureTab(ss, LOG_SHEET, ['timestamp', 'tool', 'args', 'result'], []);
  var apptHeaders = ['appointment_id', 'customer_name', 'phone', 'service', 'staff', 'date', 'time', 'duration_min', 'price', 'status'];
  ensureTab(ss, ARCHIVE_SHEET, apptHeaders, [0, 1, 2, 5, 6]);

  // Salon_Info
  var info = ss.getSheetByName(INFO_SHEET);
  var data = info.getDataRange().getValues();
  var existing = {};
  for (var i = 1; i < data.length; i++) {
    var f = String(data[i][0]).trim().toLowerCase();
    existing[f] = true;
    if (f === 'cuisine' && !existing['services_summary']) {
      info.getRange(i + 1, 1).setValue('services_summary');
      existing['services_summary'] = true;
    }
  }
  var defaults = [
    ['max_advance_days', DEF_MAX_ADVANCE_DAYS],
    ['slot_step_min', DEF_SLOT_STEP],
    ['min_lead_minutes', DEF_MIN_LEAD_MIN],
    ['buffer_min', DEF_BUFFER_MIN],
    ['cancel_notice_hours', DEF_CANCEL_NOTICE_HOURS],
    ['enforce_cancel_notice', 'no']
  ];
  defaults.forEach(function (row) {
    if (!existing[row[0]]) info.appendRow(row);
  });

  // Staff: break columns
  var staff = ss.getSheetByName(STAFF_SHEET);
  var sHeaders = staff.getRange(1, 1, 1, staff.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  ['break_start', 'break_end'].forEach(function (h) {
    if (sHeaders.indexOf(h) === -1) {
      var col = staff.getLastColumn() + 1;
      staff.getRange(1, col).setValue(h).setFontWeight('bold').setBackground('#f3f3f3');
      staff.getRange(1, col, Math.max(staff.getLastRow(), 2), 1).setNumberFormat('@');
      sHeaders.push(h);
    }
  });

  clearCache();
  Logger.log('setupExtras done.');
}

function ensureTab(ss, name, headers, textCols) {
  var sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  sheet = ss.insertSheet(name);
  (textCols || []).forEach(function (c) { sheet.getRange(1, c + 1, 1000, 1).setNumberFormat('@'); });
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f3f3f3');
  sheet.setFrozenRows(1);
  return sheet;
}

// Deletes the rows named "Test Customer" from Appointments
function cleanTestData() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var t = readTable(ss, APPOINTMENTS_SHEET);
  var rows = t.rows.filter(function (r) { return String(r.customer_name).trim().toLowerCase() === 'test customer'; });
  rows.sort(function (a, b) { return b._row - a._row; }).forEach(function (r) { t.sheet.deleteRow(r._row); });
  Logger.log('Deleted ' + rows.length + ' test rows.');
}

// Moves appointments older than ARCHIVE_AFTER_DAYS into the Archive tab
function archivePastAppointments() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var lock = acquireLock();
  if (!lock) return;
  try {
    var t = readTable(ss, APPOINTMENTS_SHEET);
    var cutoff = Utilities.formatDate(new Date(new Date().getTime() - ARCHIVE_AFTER_DAYS * 86400000), TZ, 'yyyy-MM-dd');
    var old = t.rows.filter(function (r) { return r.date && r.date < cutoff; });
    if (!old.length) return;

    var archive = ensureTab(ss, ARCHIVE_SHEET, t.headers, [0, 1, 2, 5, 6]);
    var values = old.map(function (r) {
      return t.headers.map(function (h) { return r[h]; });
    });
    var start = archive.getLastRow() + 1;
    archive.getRange(start, 1, values.length, t.headers.length).setNumberFormat('@').setValues(values);

    old.sort(function (a, b) { return b._row - a._row; }).forEach(function (r) { t.sheet.deleteRow(r._row); });
    Logger.log('Archived ' + old.length + ' appointments.');
  } finally {
    lock.releaseLock();
  }
}

// Run once: archive runs automatically on the 1st of every month at 3 AM
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'archivePastAppointments') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('archivePastAppointments').timeBased().onMonthDay(1).atHour(3).create();
}
function testServices() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  Logger.log(getServices({}, ss));
}

function testCheck() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  Logger.log(checkAvailability({ date: '2026-11-05', service: 'Haircut', staff: 'Maria' }, ss));
}