/**
 * PDF import helpers — extracted unchanged from the original server.js
 * (text extraction via pdfjs-dist + the heuristic line-by-line date scanner),
 * except that category *guessing* now returns a plain display name
 * ("Exam", "Holiday", ...) instead of a hard-coded slug. The server maps
 * that name onto whatever categories exist in the target calendar (or asks
 * the admin to create/map one) during the import preview.
 *
 * See the long comment block in the original README ("Importing events from
 * a PDF") for why this is deliberately best-effort and always sits behind a
 * review step.
 */
let pdfjsLibPromise = null;
function loadPdfJs() {
  if (!pdfjsLibPromise) pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsLibPromise;
}

/** @param {Buffer} buffer raw PDF file bytes @returns {Promise<string>} extracted text */
async function extractTextFromPdf(buffer) {
  const pdfjsLib = await loadPdfJs();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false
  });

  const doc = await loadingTask.promise;
  try {
    let fullText = '';
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();

      // pdf.js returns individual text fragments, not whole lines — group
      // fragments that share a vertical (Y) position back into one line,
      // reading top-to-bottom, so "04-08-2026" and "Orientation Day" on
      // the same row end up on the same text line for the extractor.
      const rowsByY = {};
      content.items.forEach((item) => {
        const y = Math.round(item.transform[5]);
        if (!rowsByY[y]) rowsByY[y] = [];
        rowsByY[y].push(item.str);
      });

      Object.keys(rowsByY)
        .map(Number)
        .sort((a, b) => b - a)
        .forEach((y) => { fullText += rowsByY[y].join(' ') + '\n'; });
      fullText += '\n';

      page.cleanup();
    }
    return fullText;
  } finally {
    await doc.destroy();
  }
}

const PDF_MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};
const PDF_MONTH_NAMES = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)';

class PdfEventExtractor {
  constructor({ maxEvents = 300 } = {}) {
    this.maxEvents = maxEvents;
  }

  /** @returns {Array<{title:string,date:string,time:string,venue:string,description:string,category:string}>} */
  extract(rawText) {
    const defaultYear = this._guessDefaultYear(rawText);
    const lines = rawText.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);

    const results = [];
    const seen = new Set();

    for (const line of lines) {
      if (results.length >= this.maxEvents) break;

      const match = this._matchDate(line, defaultYear);
      if (!match) continue;

      let title = line
        .replace(match.matchedText, ' ')
        .replace(/^[\s,\-:|–—]+|[\s,\-:|–—]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      title = title.replace(/^[-|•\u2022]+\s*/, '').trim();
      if (!title) title = 'Untitled event';
      if (title.length > 200) title = title.slice(0, 200);

      const dedupeKey = `${match.isoDate}::${title.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      results.push({ title, date: match.isoDate, time: '', venue: '', description: line, suggestedCategory: this._guessCategory(line) });
    }

    return results;
  }

  /** Picks the most common 4-digit "20xx" year mentioned, as a fallback for dates with no year. */
  _guessDefaultYear(text) {
    const years = (text.match(/\b20\d{2}\b/g) || []).map(Number);
    if (!years.length) return new Date().getFullYear();
    const counts = {};
    years.forEach((y) => { counts[y] = (counts[y] || 0) + 1; });
    const [bestYear] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return Number(bestYear);
  }

  /** Returns a human-readable category *name* guess; the server maps it to the target calendar's categories. */
  _guessCategory(line) {
    const l = line.toLowerCase();
    if (/\b(exam|examination|mid[- ]?term|end[- ]?sem|viva)\b/.test(l)) return 'Exam';
    if (/\b(holiday|vacation|break|no instructional day)\b/.test(l)) return 'Holiday';
    if (/\b(fest|festival|hackathon|carnival)\b/.test(l)) return 'Fest';
    if (/\b(seminar|lecture|talk|webinar|guest)\b/.test(l)) return 'Seminar';
    return 'Workshop';
  }

  /**
   * Tries date formats in order of specificity: ISO (YYYY-MM-DD), "D Month
   * YYYY" (ranges like "12-14 Aug 2026" take the first day), "Month D,
   * YYYY", "DD/MM/YYYY" or "DD-MM-YYYY", and finally "D Month" with no
   * year (uses the guessed default year).
   */
  _matchDate(line, defaultYear) {
    let m = line.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
    if (m) {
      const iso = this._toIso(m[1], m[2], m[3]);
      if (iso) return { isoDate: iso, matchedText: m[0] };
    }

    const dayMonthYearRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*[-–—]\\s*\\d{1,2}(?:st|nd|rd|th)?)?\\s+${PDF_MONTH_NAMES}\\.?,?\\s+(\\d{4})\\b`, 'i');
    m = line.match(dayMonthYearRe);
    if (m) {
      const mo = PDF_MONTHS[m[2].toLowerCase().replace('.', '')];
      const iso = this._toIso(m[3], mo, m[1]);
      if (iso) return { isoDate: iso, matchedText: m[0] };
    }

    const monthDayYearRe = new RegExp(`\\b${PDF_MONTH_NAMES}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i');
    m = line.match(monthDayYearRe);
    if (m) {
      const mo = PDF_MONTHS[m[1].toLowerCase().replace('.', '')];
      const iso = this._toIso(m[3], mo, m[2]);
      if (iso) return { isoDate: iso, matchedText: m[0] };
    }

    m = line.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
    if (m) {
      const year = m[3].length === 2 ? `20${m[3]}` : m[3];
      const iso = this._toIso(year, m[2], m[1]);
      if (iso) return { isoDate: iso, matchedText: m[0] };
    }

    const dayMonthRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${PDF_MONTH_NAMES}\\b`, 'i');
    m = line.match(dayMonthRe);
    if (m) {
      const mo = PDF_MONTHS[m[2].toLowerCase().replace('.', '')];
      const iso = this._toIso(defaultYear, mo, m[1]);
      if (iso) return { isoDate: iso, matchedText: m[0] };
    }

    return null;
  }

  /** Validates the triple is a real calendar date and formats it as 'YYYY-MM-DD'. */
  _toIso(y, mo, d) {
    y = Number(y); mo = Number(mo); d = Number(d);
    if (!y || !mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
}


module.exports = { extractTextFromPdf, PdfEventExtractor };
