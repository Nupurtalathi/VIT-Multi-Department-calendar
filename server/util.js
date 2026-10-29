/** Small helpers shared by server.js, excel.js and scripts/manage-users.js. */
const crypto = require('crypto');

/** Same scrypt parameters as the original Admin.hashPassword, so existing hashes keep verifying. */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  if (typeof password !== 'string' || !salt || !expectedHash) return false;
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Random, unambiguous password (no 0/O/1/l/I) for seeded accounts. */
function randomPassword(length = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** Collapses whitespace, trims, and applies Unicode NFKC. Used for category names. */
function normalizeName(name) {
  return String(name === null || name === undefined ? '' : name).normalize('NFKC').replace(/\s+/g, ' ').trim();
}
/** Case-insensitive comparison key used by the (scope, name_key) uniqueness constraint. */
function nameKey(name) {
  return normalizeName(name).toLowerCase();
}

/** "9:00 am" / "2 PM" / "14:30" -> minutes since midnight; empty or unparseable -> -1 (sorts first). */
function timeToMinutes(t) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(t || '');
  if (!m) return -1;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase();
  if (ap.startsWith('p') && h < 12) h += 12;
  if (ap.startsWith('a') && h === 12) h = 0;
  return h * 60 + min;
}

function compareEvents(a, b) {
  return a.date.localeCompare(b.date) || timeToMinutes(a.time) - timeToMinutes(b.time) || a.title.localeCompare(b.title);
}

/** True only for a real calendar date written exactly as YYYY-MM-DD. */
function isValidIsoDate(value) {
  const m = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

module.exports = { hashPassword, verifyPassword, randomPassword, normalizeName, nameKey, timeToMinutes, compareEvents, isValidIsoDate };
