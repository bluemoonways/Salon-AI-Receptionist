/**
 * DEMO DATA for the Salon AI Receptionist
 *
 * Run setupDemoData() ONCE from the Apps Script editor.
 * It creates (or overwrites) these tabs in your Sheet:
 *   Services, Staff, Appointments, Salon_Info
 *
 * WARNING: existing content in those 4 tabs is cleared.
 * Uses SHEET_ID from Code.gs (same project), so keep both files together.
 */

function setupDemoData() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var tz = Session.getScriptTimeZone();

  function dayStr(offset) {
    return Utilities.formatDate(new Date(new Date().getTime() + offset * 86400000), tz, 'yyyy-MM-dd');
  }

  // ---------------- Salon_Info ----------------
  writeTab(ss, 'Salon_Info', ['field', 'value'], [
    ['name', 'Glow & Co Salon'],
    ['location', '245 Madison Avenue,  Houston, Texas USA'],
    ['phone', '(212) 555-0142'],
    ['opening_time', '09:00'],
    ['closing_time', '19:00'],
    ['closed_days', 'Sunday'],
    ['cuisine', 'Hair, Nails, Skin and Spa services'],
    ['booking_policy', 'Please cancel or reschedule at least 24 hours in advance. Late arrivals over 15 minutes may need to be rebooked.'],
    ['parking', 'Street parking and a public garage on 38th Street'],
    ['payment', 'We accept cash, all major cards, Apple Pay and Google Pay']
  ], [1]);

  // ---------------- Services ----------------
  writeTab(ss, 'Services', ['service_name', 'category', 'price', 'duration_min'], [
    ['Haircut', 'Hair', 45, 45],
    ['Kids Haircut', 'Hair', 30, 30],
    ['Beard Trim', 'Hair', 20, 20],
    ['Blow Dry', 'Hair', 40, 30],
    ['Hair Color', 'Hair', 120, 120],
    ['Highlights', 'Hair', 160, 150],
    ['Keratin Treatment', 'Hair', 220, 150],
    ['Manicure', 'Nails', 30, 30],
    ['Gel Manicure', 'Nails', 45, 45],
    ['Pedicure', 'Nails', 45, 45],
    ['Facial', 'Skin', 80, 60],
    ['Eyebrow Threading', 'Skin', 18, 15],
    ['Full Body Massage', 'Spa', 110, 60],
    ['Bridal Makeup', 'Makeup', 200, 90]
  ], []);

  // ---------------- Staff ----------------
  writeTab(ss, 'Staff', ['staff_name', 'specialties', 'start_time', 'end_time', 'days_off'], [
    ['Maria', 'Haircut, Kids Haircut, Blow Dry, Hair Color, Highlights, Keratin Treatment', '09:00', '19:00', 'Sun'],
    ['Jessica', 'Haircut, Blow Dry, Hair Color, Highlights, Bridal Makeup', '10:00', '19:00', 'Sun, Mon'],
    ['Ahmed', 'Haircut, Kids Haircut, Beard Trim', '09:00', '18:00', 'Sun'],
    ['Sophia', 'Manicure, Gel Manicure, Pedicure, Eyebrow Threading, Facial, Full Body Massage', '09:00', '19:00', 'Sun, Wed']
  ], [2, 3]);

  // ---------------- Appointments (a few pre-booked so the demo shows busy slots) ----------------
  writeTab(ss, 'Appointments',
    ['appointment_id', 'customer_name', 'phone', 'service', 'staff', 'date', 'time', 'duration_min', 'price', 'status'], [
      ['APT1001', 'Emily Carter', '2125550101', 'Haircut', 'Maria', dayStr(1), '10:00', 45, 45, 'Confirmed'],
      ['APT1002', 'Olivia Brooks', '2125550102', 'Hair Color', 'Maria', dayStr(1), '13:00', 120, 120, 'Confirmed'],
      ['APT1003', 'James Wilson', '2125550103', 'Beard Trim', 'Ahmed', dayStr(1), '09:00', 20, 20, 'Confirmed'],
      ['APT1004', 'Ava Martinez', '2125550104', 'Gel Manicure', 'Sophia', dayStr(1), '11:00', 45, 45, 'Confirmed'],
      ['APT1005', 'Daniel Kim', '2125550105', 'Haircut', 'Ahmed', dayStr(2), '12:00', 45, 45, 'Confirmed'],
      ['APT1006', 'Sophie Turner', '2125550106', 'Facial', 'Sophia', dayStr(2), '15:00', 60, 80, 'Confirmed'],
      ['APT1007', 'Mia Johnson', '2125550107', 'Highlights', 'Jessica', dayStr(2), '11:00', 150, 160, 'Confirmed'],
      ['APT1008', 'Noah Davis', '2125550108', 'Haircut', 'Maria', dayStr(3), '16:00', 45, 45, 'Cancelled']
    ], [0, 2, 5, 6]);

  SpreadsheetApp.flush();
  Logger.log('Demo data created. Tabs: Salon_Info, Services, Staff, Appointments.');
}

// Creates the tab if missing, clears it, writes headers + rows.
// textCols = zero-based column indexes forced to plain text (phone, date, time...).
function writeTab(ss, name, headers, rows, textCols) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();

  var totalRows = rows.length + 1;
  (textCols || []).forEach(function (c) {
    sheet.getRange(1, c + 1, totalRows, 1).setNumberFormat('@');
  });

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f3f3f3');
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}