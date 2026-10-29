/**
 * Calendar-style Excel export.
 *
 * Builds a genuine .xlsx workbook (real cells, borders, fills, rich text —
 * not an image) with exceljs:
 *   - Monthly mode: one worksheet containing a Sunday–Saturday grid.
 *   - Full-year mode: twelve worksheets, January → December, in order.
 *   - Optional "Event List" worksheet with every field of every event.
 *
 * Each event gets its own color; Central and Department date cells retain their
 * existing blue and teal calendar tones.
 */
const ExcelJS = require('exceljs');
const { timeToMinutes } = require('./util');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Keep in sync with --central-* / --dept-* in client/public/style.css.
const COLORS = {
  central: { fill: 'FFDCEBFA', text: 'FF0B4F9E', accent: 'FF1F6FD1', label: 'Central events' },
  department: { fill: 'FFD9F2EF', text: 'FF0F5F58', accent: 'FF14A0A0', label: 'Department events' },
  navy: 'FF0F2044',
  gold: 'FFB8862E',
  grey: 'FFF1F2F6',
  border: 'FF9AA3B8'
};

const THIN = { style: 'thin', color: { argb: COLORS.border } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

const COL_WIDTH = 25; // characters
const CHARS_PER_LINE = 27; // rough wrap estimate at 10pt for COL_WIDTH

/** Strips characters that are illegal in XML (they would corrupt the file) and caps cell length. */
function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, 32000);
}

function compareEvents(a, b) {
  return timeToMinutes(a.time) - timeToMinutes(b.time) || a.title.localeCompare(b.title);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function isoDate(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function firstWeekday(y, m) { return new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); }
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Worksheet names: max 31 chars, none of  \ / ? * [ ] : */
function safeSheetName(name) {
  return clean(name).replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Sheet';
}

/** Heading lines shown at the top of every sheet. */
function headingLines(calendar, college) {
  if (calendar.type === 'central') return [`${college} \u2014 Central Academic Calendar`];
  return [college, calendar.departmentFullName];
}

function eventLine(e) {
  const time = e.time ? `${e.time} \u00b7 ` : '';
  const cat = e.categoryName ? ` [${e.categoryName}]` : '';
  return `\u2022 ${time}${e.title}${cat}`;
}

function estimateLines(text) {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_LINE));
}

function hslHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = hue / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [r, g, b] = section < 1 ? [chroma, x, 0]
    : section < 2 ? [x, chroma, 0]
      : section < 3 ? [0, chroma, x]
        : section < 4 ? [0, x, chroma]
          : section < 5 ? [x, 0, chroma]
            : [chroma, 0, x];
  const m = l - chroma / 2;
  return [r, g, b].map((value) => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function createEventStyles(events) {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date)
    || compareEvents(a, b)
    || Number(a.id || 0) - Number(b.id || 0));
  const styles = new Map();
  sorted.forEach((event, index) => {
    const hue = (index * 137.508) % 360;
    styles.set(event, {
      text: `FF${hslHex(hue, 68, 34)}`,
      fill: `FF${hslHex(hue, 70, 92)}`
    });
  });
  return styles;
}

/** Builds one month's worksheet (grid + legend). */
function addMonthSheet(workbook, { calendar, college, year, month, events, includeCentralLegend, eventStyles }) {
  const ws = workbook.addWorksheet(safeSheetName(`${MONTH_NAMES[month - 1]} ${year}`), {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }
  });
  for (let c = 1; c <= 7; c++) ws.getColumn(c).width = COL_WIDTH;

  let row = 1;
  const lines = headingLines(calendar, college);
  lines.forEach((text, i) => {
    ws.mergeCells(row, 1, row, 7);
    const cell = ws.getCell(row, 1);
    cell.value = clean(text);
    cell.font = { name: 'Calibri', bold: true, size: i === 0 ? 18 : 14, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    ws.getRow(row).height = i === 0 ? 30 : 24;
    row++;
  });

  ws.mergeCells(row, 1, row, 7);
  const titleCell = ws.getCell(row, 1);
  titleCell.value = `${MONTH_NAMES[month - 1]} ${year}`;
  titleCell.font = { name: 'Calibri', bold: true, size: 16, color: { argb: COLORS.navy } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.border = { bottom: { style: 'medium', color: { argb: COLORS.gold } } };
  ws.getRow(row).height = 28;
  row++;

  // Sunday … Saturday header
  DAY_NAMES.forEach((name, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = name;
    cell.font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = BORDER;
  });
  ws.getRow(row).height = 22;
  row++;

  const byDate = {};
  events.forEach((e) => { (byDate[e.date] = byDate[e.date] || []).push(e); });
  Object.values(byDate).forEach((list) => list.sort(compareEvents));

  const offset = firstWeekday(year, month);
  const total = daysInMonth(year, month);
  const weeks = Math.ceil((offset + total) / 7);

  for (let w = 0; w < weeks; w++) {
    const numRow = row;
    const evtRow = row + 1;
    let maxLines = 3;

    for (let dow = 0; dow < 7; dow++) {
      const day = w * 7 + dow - offset + 1;
      const numCell = ws.getCell(numRow, dow + 1);
      const evtCell = ws.getCell(evtRow, dow + 1);
      numCell.border = BORDER;
      evtCell.border = BORDER;

      if (day < 1 || day > total) {
        numCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.grey } };
        evtCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.grey } };
        continue;
      }

      const dayEvents = byDate[isoDate(year, month, day)] || [];
      const hasCentral = dayEvents.some((e) => e.calendarType === 'central');
      const hasDept = dayEvents.some((e) => e.calendarType !== 'central');
      const tone = hasCentral && !hasDept ? 'central' : (hasDept && !hasCentral ? 'department' : null);

      numCell.value = day;
      numCell.font = { name: 'Calibri', bold: true, size: 11, color: { argb: tone ? COLORS[tone].text : COLORS.navy } };
      numCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      numCell.fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: tone ? COLORS[tone].fill : (hasCentral && hasDept ? COLORS.central.fill : 'FFFFFFFF') }
      };

      evtCell.alignment = { vertical: 'top', wrapText: true };
      if (tone) evtCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS[tone].fill } };

      if (dayEvents.length) {
        // One rich-text run per event so each keeps its own colour; events are
        // separated by newlines inside the same cell, so nothing is overwritten.
        const runs = [];
        let lineCount = 0;
        dayEvents.forEach((e, idx) => {
          const text = clean(eventLine(e)) + (idx < dayEvents.length - 1 ? '\n' : '');
          const color = eventStyles.get(e).text;
          runs.push({ text, font: { name: 'Calibri', size: 10, bold: false, color: { argb: color } } });
          lineCount += estimateLines(eventLine(e));
        });
        evtCell.value = { richText: runs };
        maxLines = Math.max(maxLines, lineCount);
      }
    }

    ws.getRow(numRow).height = 20;
    ws.getRow(evtRow).height = Math.min(409, Math.max(55, maxLines * 13.5 + 6));
    row += 2;
  }

  // Legend
  row++;
  [['central', COLORS.central.label], ['department', COLORS.department.label]].forEach(([key, label]) => {
    if (key === 'central' && !includeCentralLegend && !events.some((e) => e.calendarType === 'central') && calendar.type !== 'central') return;
    const swatch = ws.getCell(row, 1);
    swatch.value = '';
    swatch.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS[key].fill } };
    swatch.border = { top: { style: 'medium', color: { argb: COLORS[key].accent } }, left: THIN, bottom: THIN, right: THIN };
    const text = ws.getCell(row, 2);
    text.value = label;
    text.font = { name: 'Calibri', size: 10, color: { argb: COLORS[key].text }, bold: true };
    ws.mergeCells(row, 2, row, 4);
    row++;
  });

  return ws;
}

/** Adds the "Event List" worksheet with every stored field. */
function addEventListSheet(workbook, { calendar, college, events, periodLabel, eventStyles }) {
  const ws = workbook.addWorksheet('Event List', { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  const columns = [
    ['Date', 13], ['Day', 12], ['Time', 12], ['Title', 34], ['Calendar', 12], ['Department', 40],
    ['Category', 24], ['Venue', 24], ['Guest Name', 22], ['Schedule', 16], ['Meeting Details/Agenda', 34],
    ['Additional Details', 34], ['Description', 40]
  ];
  columns.forEach(([, width], i) => { ws.getColumn(i + 1).width = width; });

  const lines = headingLines(calendar, college);
  ws.mergeCells(1, 1, 1, columns.length);
  const h = ws.getCell(1, 1);
  h.value = clean(lines.join(' \u2014 '));
  h.font = { name: 'Calibri', bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
  h.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 28;

  ws.mergeCells(2, 1, 2, columns.length);
  const sub = ws.getCell(2, 1);
  sub.value = `Detailed event list \u00b7 ${periodLabel} \u00b7 ${events.length} event${events.length === 1 ? '' : 's'}`;
  sub.font = { name: 'Calibri', italic: true, size: 11, color: { argb: COLORS.navy } };
  sub.alignment = { indent: 1 };

  const headerRow = ws.getRow(4);
  columns.forEach(([name], i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = name;
    cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = BORDER;
  });
  headerRow.height = 22;

  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date) || compareEvents(a, b));
  sorted.forEach((e, i) => {
    const r = ws.getRow(5 + i);
    const isCentral = e.calendarType === 'central';
    const values = [
      e.date, DAY_NAMES[weekdayOf(e.date)], e.time, e.title,
      isCentral ? 'Central' : 'Department', isCentral ? 'Central Academic Calendar' : e.departmentName,
      e.categoryName, e.venue, e.guestName, e.schedule, e.meetingAgenda, e.additionalDetails, e.description
    ];
    values.forEach((v, c) => {
      const cell = r.getCell(c + 1);
      cell.value = clean(v);
      cell.font = { name: 'Calibri', size: 10 };
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: eventStyles.get(e).fill } };
      cell.border = BORDER;
    });
    const tone = COLORS[isCentral ? 'central' : 'department'];
    [5, 6].forEach((c) => {
      const cell = r.getCell(c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tone.fill } };
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: tone.text } };
    });
  });

  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: columns.length } };
  return ws;
}

/**
 * @param {object} opts
 * @param {{type:'central'|'department', departmentFullName?:string}} opts.calendar
 * @param {string} opts.college
 * @param {'month'|'year'} opts.mode
 * @param {number} opts.year
 * @param {number} [opts.month] 1-12, required for mode 'month'
 * @param {Array} opts.events already-authorized events (calendarType, date, title, ...)
 * @param {boolean} [opts.includeList=true]
 * @param {boolean} [opts.includesCentral=false] whether Central events were merged into a department view
 */
function buildWorkbook({ calendar, college, mode, year, month, events, includeList = true, includesCentral = false }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = college;
  workbook.created = new Date();
  workbook.title = `${headingLines(calendar, college).join(' \u2014 ')} ${mode === 'month' ? `${MONTH_NAMES[month - 1]} ` : ''}${year}`;

  const months = mode === 'month' ? [month] : Array.from({ length: 12 }, (_, i) => i + 1);
  const periodPrefix = mode === 'month' ? `${year}-${pad2(month)}-` : `${year}-`;
  const periodEvents = events.filter((e) => e.date.startsWith(periodPrefix));
  const eventStyles = createEventStyles(periodEvents);
  months.forEach((m) => {
    const prefix = `${year}-${pad2(m)}-`;
    addMonthSheet(workbook, {
      calendar, college, year, month: m,
      events: events.filter((e) => e.date.startsWith(prefix)),
      includeCentralLegend: includesCentral,
      eventStyles
    });
  });

  if (includeList) {
    const periodLabel = mode === 'month' ? `${MONTH_NAMES[month - 1]} ${year}` : `Full year ${year}`;
    addEventListSheet(workbook, { calendar, college, events: periodEvents, periodLabel, eventStyles });
  }
  return workbook;
}

module.exports = { buildWorkbook, MONTH_NAMES, DAY_NAMES, COLORS };
