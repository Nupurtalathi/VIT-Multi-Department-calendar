/**
 * VIT Multi-Department Academic Calendar — backend.
 *
 * Upgraded from the single-department "CSE (AI)" calendar. One shared app now
 * serves five department calendars plus one Central Academic Calendar; every
 * event, category and contact belongs to exactly one calendar scope, enforced
 * with foreign keys (department_id) and server-side authorization.
 *
 * Sections (same order as before):
 *   1. Config (from .env)        5. Services (business rules + authorization)
 *   2. Database + safe migration 6. Auth / permissions
 *   3. Models                    7. Express app, routes, startup
 *   4. Repositories (SQL)
 *
 * PDF text extraction lives in ./pdf-import.js and the Excel workbook builder
 * in ./excel.js; shared helpers (password hashing etc.) in ./util.js.
 */

const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const methodOverride = require('method-override');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const multer = require('multer');

require('dotenv').config();

const { hashPassword, verifyPassword, randomPassword, normalizeName, nameKey, compareEvents, isValidIsoDate } = require('./util');
const { extractTextFromPdf, PdfEventExtractor } = require('./pdf-import');
const { buildWorkbook, MONTH_NAMES } = require('./excel');

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------

const isProd = process.env.NODE_ENV === 'production';
const DEFAULT_SESSION_SECRET = 'vit-cse-ai-dept-secret-change-me';

const config = {
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET,
  cookieSecure: String(process.env.COOKIE_SECURE).toLowerCase() === 'true',

  // true  = anonymous visitors may *view* whichever calendar they pick (the original app's behaviour).
  // false = every calendar page/API requires a login. Signed-in users are always confined to their own scope.
  publicRead: String(process.env.PUBLIC_READ === undefined ? 'true' : process.env.PUBLIC_READ).toLowerCase() !== 'false',

  // Events/contacts that existed before this upgrade belonged to the CSE (AI) calendar.
  legacyDepartmentSlug: process.env.LEGACY_DEPARTMENT_SLUG || 'cse-ai',
  // Optional: password for newly seeded accounts. If unset, random passwords are generated and printed once.
  seedPassword: process.env.SEED_PASSWORD || '',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vit_cse_ai_calendar'
  },

  mail: {
    host: process.env.MAIL_HOST || '',
    port: Number(process.env.MAIL_PORT) || 587,
    secure: String(process.env.MAIL_SECURE).toLowerCase() === 'true',
    user: process.env.MAIL_USER || '',
    pass: process.env.MAIL_PASS || '',
    from: process.env.MAIL_FROM || 'VIT Academic Calendar <no-reply@example.com>'
  },

  instituteName: 'Vishwakarma Institute of Technology',
  centralHeading: 'Vishwakarma Institute of Technology \u2014 Central Academic Calendar'
};

/** Default department list. Seeded into the `departments` table once; after that the DB is the source of truth. */
const DEFAULT_DEPARTMENTS = [
  { code: 'CSE', slug: 'cse', shortName: 'CSE', fullName: 'Computer Science and Engineering', fileCode: 'CSE' },
  { code: 'CSE_AI', slug: 'cse-ai', shortName: 'CSE (AI)', fullName: 'Computer Science and Engineering (Artificial Intelligence)', fileCode: 'CSE_AI' },
  { code: 'IT', slug: 'it', shortName: 'IT', fullName: 'Information Technology', fileCode: 'IT' },
  { code: 'CSE_AIML', slug: 'cse-aiml', shortName: 'CSE (AIML)', fullName: 'Computer Science and Engineering (Artificial Intelligence and Machine Learning)', fileCode: 'CSE_AIML' },
  { code: 'AIDS', slug: 'aids', shortName: 'AIDS', fullName: 'Artificial Intelligence and Data Science', fileCode: 'AIDS' }
];

/** Predefined categories (colours are the ones the app already used). Slugs drive the conditional form fields. */
const CENTRAL_PREDEFINED = [
  { slug: 'workshop', name: 'Workshop', color: '#6D5FFD' },
  { slug: 'seminar', name: 'Seminar', color: '#2E86DE' },
  { slug: 'fest', name: 'Fest', color: '#E0812A' },
  { slug: 'exam', name: 'Exam', color: '#D5493F' },
  { slug: 'holiday', name: 'Holiday', color: '#2F9E5B' }
];
const DEPARTMENT_PREDEFINED = [
  { slug: 'hackathon', name: 'Hackathon', color: '#6D5FFD' },
  { slug: 'guest-lecture', name: 'Guest Lecture', color: '#2E86DE' },
  { slug: 'future-ready-saturday', name: 'Future Ready Saturday', color: '#E0812A' },
  { slug: 'aisf-events', name: 'AISF Events', color: '#9B59B6' },
  { slug: 'department-meetings', name: 'Department Meetings', color: '#547A52' },
  { slug: 'parent-teacher-meets', name: 'Parent-Teacher Meets', color: '#D5493F' },
  { slug: 'iab-meeting', name: 'IAB Meeting', color: '#287A8C' },
  { slug: 'academic-audit', name: 'Academic Audit', color: '#7A647D' },
  { slug: 'ios-audit', name: 'IOS Audit', color: '#A47B28' }
];
// Auto-assigned to custom categories (small indicator dots only; Central/Department identity is blue/teal).
const CUSTOM_COLORS = ['#9333EA', '#B45309', '#BE185D', '#4D7C0F', '#C2410C', '#475569', '#A21CAF'];

const RECURRING_SCHEDULE = { 'future-ready-saturday': 'Every Saturday', 'department-meetings': 'Every Friday' };
const GUEST_REQUIRED = new Set(['guest-lecture', 'future-ready-saturday']);
const AGENDA_REQUIRED = new Set(['department-meetings']);

const ROLES = ['super_admin', 'central_admin', 'dept_admin'];

// ---------------------------------------------------------------------------
// 2. Database — connection pool, helpers, and safe, idempotent migration.
//    (Reference schema also in ../database.sql.)
// ---------------------------------------------------------------------------

const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true // DATE/DATETIME come back as 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM:SS' strings
});

/** Runs a query and returns just the rows/result. All values are passed as bound parameters. */
async function query(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result;
}

/** Returns a query function bound to a transaction connection (or the pool when conn is omitted). */
function dbFor(conn) {
  if (!conn) return query;
  return async (sql, params = []) => {
    const [result] = await conn.query(sql, params);
    return result;
  };
}

async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* connection already gone */ }
    throw err;
  } finally {
    conn.release();
  }
}

async function hasColumn(table, column) {
  const rows = await query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [config.db.database, table, column]
  );
  return rows.length > 0;
}
async function hasIndex(table, index) {
  const rows = await query(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [config.db.database, table, index]
  );
  return rows.length > 0;
}
async function hasConstraint(table, name) {
  const rows = await query(
    'SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1',
    [config.db.database, table, name]
  );
  return rows.length > 0;
}
async function addColumnIfMissing(table, column, definition) {
  if (await hasColumn(table, column)) return false;
  await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}
async function addIndexIfMissing(table, index, ddl) {
  if (!(await hasIndex(table, index))) await query(`ALTER TABLE ${table} ADD ${ddl}`);
}
async function addConstraintIfMissing(table, name, ddl) {
  if (await hasConstraint(table, name)) return;
  try {
    await query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${ddl}`);
  } catch (err) {
    // Never block startup (or touch data) over an integrity nicety; app-level checks still apply.
    console.warn(`Migration note: could not add constraint ${name} on ${table}: ${err.message}`);
  }
}

/**
 * Creates/extends the schema. Safe to call on every boot: it only ever
 * CREATE TABLE IF NOT EXISTS / ADD COLUMN / ADD INDEX — it never drops,
 * truncates or rewrites existing events. Legacy rows are back-filled below.
 */
async function initDatabase() {
  // --- legacy tables (unchanged shape; created for fresh installs) ---
  await query(`
    CREATE TABLE IF NOT EXISTS admins (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      salt          VARCHAR(255) NOT NULL,
      UNIQUE KEY uq_admins_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS events (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      title       VARCHAR(255) NOT NULL,
      date        DATE NOT NULL,
      time        VARCHAR(50) DEFAULT '',
      venue       VARCHAR(255) DEFAULT '',
      description TEXT,
      section     VARCHAR(20) NOT NULL DEFAULT 'central',
      category    VARCHAR(100) NOT NULL,
      schedule    VARCHAR(100) DEFAULT '',
      guest_name  VARCHAR(255) DEFAULT '',
      meeting_agenda TEXT,
      created_by  VARCHAR(100) DEFAULT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_events_date (date),
      KEY idx_events_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await query('ALTER TABLE events MODIFY category VARCHAR(100) NOT NULL');
  for (const [column, definition] of [
    ['section', "VARCHAR(20) NOT NULL DEFAULT 'central'"],
    ['schedule', "VARCHAR(100) DEFAULT ''"],
    ['guest_name', "VARCHAR(255) DEFAULT ''"],
    ['meeting_agenda', 'TEXT']
  ]) {
    await addColumnIfMissing('events', column, definition);
  }

  await query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      event_id      INT NOT NULL,
      user_email    VARCHAR(255) NOT NULL,
      remind_before VARCHAR(50) DEFAULT '1 day',
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_reminders_event (event_id),
      CONSTRAINT fk_reminders_event FOREIGN KEY (event_id)
        REFERENCES events (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      email       VARCHAR(255) NOT NULL,
      label       VARCHAR(100) DEFAULT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_contacts_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // --- new: departments ---
  await query(`
    CREATE TABLE IF NOT EXISTS departments (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      code        VARCHAR(30)  NOT NULL,
      slug        VARCHAR(40)  NOT NULL,
      short_name  VARCHAR(40)  NOT NULL,
      full_name   VARCHAR(255) NOT NULL,
      file_code   VARCHAR(40)  NOT NULL,
      sort_order  INT NOT NULL DEFAULT 0,
      is_active   TINYINT(1) NOT NULL DEFAULT 1,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_departments_code (code),
      UNIQUE KEY uq_departments_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // --- new: event categories (department_id NULL = Central calendar) ---
  // scope_key makes "NULL = Central" participate in the unique keys (MySQL treats NULLs as distinct).
  await query(`
    CREATE TABLE IF NOT EXISTS event_categories (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      department_id INT NULL,
      slug          VARCHAR(100) NULL,
      name          VARCHAR(100) NOT NULL,
      name_key      VARCHAR(100) NOT NULL,
      color         VARCHAR(9) NOT NULL DEFAULT '#6B7280',
      is_predefined TINYINT(1) NOT NULL DEFAULT 0,
      is_active     TINYINT(1) NOT NULL DEFAULT 1,
      created_by    VARCHAR(100) DEFAULT NULL,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      scope_key     INT GENERATED ALWAYS AS (IFNULL(department_id, 0)) STORED,
      UNIQUE KEY uq_categories_scope_name (scope_key, name_key),
      UNIQUE KEY uq_categories_scope_slug (scope_key, slug),
      KEY idx_categories_department (department_id),
      CONSTRAINT fk_categories_department FOREIGN KEY (department_id) REFERENCES departments (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // --- new: users (replaces the single admins table) ---
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      salt          VARCHAR(255) NOT NULL,
      role          ENUM('super_admin','central_admin','dept_admin') NOT NULL,
      department_id INT NULL,
      is_active     TINYINT(1) NOT NULL DEFAULT 1,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      last_login_at DATETIME NULL,
      UNIQUE KEY uq_users_username (username),
      KEY idx_users_department (department_id),
      CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await addConstraintIfMissing('users', 'ck_users_role_scope',
    "CHECK ((role = 'dept_admin' AND department_id IS NOT NULL) OR (role <> 'dept_admin' AND department_id IS NULL))");

  // --- events: new columns (existing rows and columns are untouched) ---
  const addedUpdatedAt = await addColumnIfMissing('events', 'updated_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
  if (addedUpdatedAt) await query('UPDATE events SET updated_at = created_at');
  await addColumnIfMissing('events', 'category_id', 'INT NULL');
  await addColumnIfMissing('events', 'department_id', 'INT NULL');
  await addColumnIfMissing('events', 'additional_details', 'TEXT');
  await addColumnIfMissing('events', 'created_by_user_id', 'INT NULL');
  await addIndexIfMissing('events', 'idx_events_category_id', 'INDEX idx_events_category_id (category_id)');
  await addIndexIfMissing('events', 'idx_events_scope_date', 'INDEX idx_events_scope_date (department_id, date)');
  await addConstraintIfMissing('events', 'fk_events_category', 'FOREIGN KEY (category_id) REFERENCES event_categories (id)');
  await addConstraintIfMissing('events', 'fk_events_department', 'FOREIGN KEY (department_id) REFERENCES departments (id)');

  // --- contacts: scope the mail book per calendar ---
  await addColumnIfMissing('contacts', 'department_id', 'INT NULL');
  const contactsScopeAdded = await addColumnIfMissing('contacts', 'scope_key', 'INT GENERATED ALWAYS AS (IFNULL(department_id, 0)) STORED');
  if (contactsScopeAdded || !(await hasIndex('contacts', 'uq_contacts_scope_email'))) {
    // (old UNIQUE(email) is replaced by UNIQUE(scope, email) so each calendar keeps its own mail book)
    await addIndexIfMissing('contacts', 'uq_contacts_scope_email', 'UNIQUE KEY uq_contacts_scope_email (scope_key, email)');
    if (await hasIndex('contacts', 'uq_contacts_email')) await query('ALTER TABLE contacts DROP INDEX uq_contacts_email');
  }
  await addConstraintIfMissing('contacts', 'fk_contacts_department', 'FOREIGN KEY (department_id) REFERENCES departments (id)');

  await seedReferenceData();
  await backfillLegacyData();
}

/** Inserts the default departments and predefined categories that are missing. Never overwrites existing rows. */
async function seedReferenceData() {
  let order = 1;
  for (const d of DEFAULT_DEPARTMENTS) {
    await query(
      `INSERT INTO departments (code, slug, short_name, full_name, file_code, sort_order)
       SELECT ?, ?, ?, ?, ?, ? FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM departments WHERE code = ? OR slug = ?)`,
      [d.code, d.slug, d.shortName, d.fullName, d.fileCode, order++, d.code, d.slug]
    );
  }
  const depts = await query('SELECT id FROM departments');

  const ensurePredefined = async (departmentId, list) => {
    for (const c of list) {
      await query(
        `INSERT INTO event_categories (department_id, slug, name, name_key, color, is_predefined, is_active, created_by)
         SELECT ?, ?, ?, ?, ?, 1, 1, 'system' FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM event_categories WHERE IFNULL(department_id, 0) = ? AND (slug = ? OR name_key = ?))`,
        [departmentId, c.slug, c.name, nameKey(c.name), c.color, departmentId || 0, c.slug, nameKey(c.name)]
      );
    }
  };
  await ensurePredefined(null, CENTRAL_PREDEFINED);
  for (const d of depts) await ensurePredefined(d.id, DEPARTMENT_PREDEFINED);
}

/** "future-ready-saturday" -> "Future Ready Saturday" (only used for odd legacy slugs). */
function humanizeSlug(slug) {
  return normalizeName(String(slug || '').replace(/[-_]+/g, ' ')).replace(/\b\w/g, (ch) => ch.toUpperCase()) || 'Uncategorised';
}

/**
 * One-time (idempotent) data migration:
 *  - legacy `admins` -> `users` (hashes preserved, so the existing login keeps working)
 *  - legacy events: section/category slug -> department_id + category_id
 *  - legacy contacts -> the legacy department's mail book
 * Rows are only ever UPDATEd to fill the new columns; nothing is deleted.
 */
async function backfillLegacyData() {
  const legacyDept = (await query('SELECT id FROM departments WHERE slug = ? LIMIT 1', [config.legacyDepartmentSlug]))[0];

  // admins -> users. The old single admin could manage everything, so it becomes a super administrator.
  await query(
    `INSERT INTO users (username, password_hash, salt, role)
     SELECT a.username, a.password_hash, a.salt, 'super_admin' FROM admins a
     WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.username = a.username)`
  );

  if (legacyDept) {
    await query('UPDATE contacts SET department_id = ? WHERE department_id IS NULL', [legacyDept.id]);
  }

  const pending = await query('SELECT id, section, category FROM events WHERE category_id IS NULL OR (section = \'department\' AND department_id IS NULL)');
  if (!pending.length) return;

  await withTransaction(async (conn) => {
    const q = dbFor(conn);
    for (const ev of pending) {
      const isDept = ev.section === 'department';
      const departmentId = isDept ? (legacyDept ? legacyDept.id : null) : null;
      if (isDept && !departmentId) continue; // legacy department missing: leave untouched rather than guess

      let cat = (await q(
        'SELECT id FROM event_categories WHERE IFNULL(department_id, 0) = ? AND (slug = ? OR name_key = ?) LIMIT 1',
        [departmentId || 0, ev.category, nameKey(ev.category)]
      ))[0];
      if (!cat) {
        // A category the old app allowed but that isn't predefined for this scope: keep it as a custom category.
        const name = humanizeSlug(ev.category);
        const created = await q(
          `INSERT INTO event_categories (department_id, slug, name, name_key, color, is_predefined, is_active, created_by)
           VALUES (?, NULL, ?, ?, ?, 0, 1, 'migration')`,
          [departmentId, name, nameKey(name), CUSTOM_COLORS[0]]
        ).catch(async (err) => {
          if (err.code !== 'ER_DUP_ENTRY') throw err;
          const again = await q('SELECT id FROM event_categories WHERE IFNULL(department_id, 0) = ? AND name_key = ? LIMIT 1', [departmentId || 0, nameKey(name)]);
          return { insertId: again[0].id };
        });
        cat = { id: created.insertId };
      }
      // `updated_at = updated_at` stops ON UPDATE CURRENT_TIMESTAMP from rewriting the original timestamp during back-fill.
      await q('UPDATE events SET category_id = ?, department_id = ?, updated_at = updated_at WHERE id = ?', [cat.id, departmentId, ev.id]);
    }
  });

  // Integrity rule: Central events have no department, department events always have one.
  await addConstraintIfMissing('events', 'ck_events_scope',
    "CHECK ((section = 'central' AND department_id IS NULL) OR (section = 'department' AND department_id IS NOT NULL))");
}

/**
 * Seeds login accounts that don't exist yet: a super administrator (fresh installs only),
 * a Central administrator, and one administrator per department. Generated passwords are
 * printed to the console exactly once, at creation time.
 */
async function seedAccounts() {
  const created = [];
  const mk = async (username, role, departmentId) => {
    const exists = (await query('SELECT id FROM users WHERE username = ? LIMIT 1', [username]))[0];
    if (exists) return;
    const password = config.seedPassword || randomPassword();
    const { hash, salt } = hashPassword(password);
    await query('INSERT INTO users (username, password_hash, salt, role, department_id) VALUES (?, ?, ?, ?, ?)', [username, hash, salt, role, departmentId]);
    created.push({ username, role, password });
  };

  const anySuper = (await query("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1"))[0];
  if (!anySuper) await mk('admin', 'super_admin', null);
  await mk('central_admin', 'central_admin', null);
  for (const d of await query('SELECT id, slug FROM departments ORDER BY sort_order, id')) {
    await mk(`${d.slug.replace(/-/g, '_')}_admin`, 'dept_admin', d.id);
  }

  if (created.length) {
    console.log('\n=== Accounts created (shown once \u2014 store these securely, then change them) ===');
    created.forEach((c) => console.log(`  ${c.username.padEnd(18)} ${c.role.padEnd(14)} ${c.password}`));
    console.log('====================================================================================\n');
  }

  // The pre-upgrade app shipped admin / admin123. That account is now a super administrator.
  const legacy = (await query("SELECT password_hash, salt FROM users WHERE username = 'admin' AND role = 'super_admin' AND is_active = 1 LIMIT 1"))[0];
  if (legacy && verifyPassword('admin123', legacy.salt, legacy.password_hash)) {
    console.warn('\n!!! SECURITY: the "admin" super-administrator still uses the old default password (admin123). Change it now:');
    console.warn('!!!   node scripts/manage-users.js reset-password admin\n');
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}
function validationError(errors, extra = {}) {
  const err = httpError(400, 'Validation failed', extra);
  err.details = Array.isArray(errors) ? errors : [errors];
  return err;
}
function errorBody(err) {
  const message = err.details ? err.details.join(' ') : err.message;
  const body = { success: false, message };
  if (err.rowErrors) body.rowErrors = err.rowErrors;
  if (err.existing) body.existing = err.existing;
  return body;
}
function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json(status >= 500 ? { success: false, message: 'Internal server error.' } : errorBody(err));
}

// ---------------------------------------------------------------------------
// 3. Models
// ---------------------------------------------------------------------------

const LIMITS = { title: 255, time: 50, venue: 255, guest: 255, longText: 10000, categoryName: 60 };

class Event {
  constructor(d) {
    this.id = d.id || null;
    this.title = d.title;
    this.date = d.date; // 'YYYY-MM-DD'
    this.time = d.time || '';
    this.venue = d.venue || '';
    this.description = d.description || '';
    this.calendarType = d.calendarType; // 'central' | 'department' (stored in the legacy `section` column)
    this.departmentId = d.departmentId || null;
    this.departmentName = d.departmentName || '';
    this.departmentShort = d.departmentShort || '';
    this.categoryId = d.categoryId || null;
    this.categoryName = d.categoryName || '';
    this.categorySlug = d.categorySlug || null;
    this.categoryColor = d.categoryColor || '#6B7280';
    this.schedule = typeof d.schedule === 'string' ? d.schedule : '';
    this.guestName = typeof d.guestName === 'string' ? d.guestName : '';
    this.meetingAgenda = typeof d.meetingAgenda === 'string' ? d.meetingAgenda : '';
    this.additionalDetails = typeof d.additionalDetails === 'string' ? d.additionalDetails : '';
    this.createdBy = d.createdBy || null;
    this.createdAt = d.createdAt || null;
    this.updatedAt = d.updatedAt || null;
  }

  /** Shape/length checks that don't need the database. Category-specific rules live in the service. */
  validateShape() {
    const errors = [];
    if (typeof this.title !== 'string' || !this.title.trim()) errors.push('Title is required.');
    else if (this.title.trim().length > LIMITS.title) errors.push(`Title must be ${LIMITS.title} characters or fewer.`);
    if (!isValidIsoDate(this.date)) errors.push('A valid date (YYYY-MM-DD) is required.');
    if (this.time.length > LIMITS.time) errors.push(`Time must be ${LIMITS.time} characters or fewer.`);
    if (this.venue.length > LIMITS.venue) errors.push(`Venue must be ${LIMITS.venue} characters or fewer.`);
    if (this.guestName.length > LIMITS.guest) errors.push(`Guest Name must be ${LIMITS.guest} characters or fewer.`);
    for (const [label, value] of [['Description', this.description], ['Meeting Details/Agenda', this.meetingAgenda], ['Additional Details', this.additionalDetails]]) {
      if (value.length > LIMITS.longText) errors.push(`${label} must be ${LIMITS.longText} characters or fewer.`);
    }
    return errors;
  }

  toJSON() {
    return {
      id: this.id, title: this.title, date: this.date, time: this.time, venue: this.venue, description: this.description,
      calendarType: this.calendarType, section: this.calendarType, // `section` kept for older clients
      departmentId: this.departmentId, departmentName: this.departmentName, departmentShort: this.departmentShort,
      categoryId: this.categoryId, categoryName: this.categoryName, categoryColor: this.categoryColor,
      category: this.categorySlug || this.categoryName, // legacy field: slug for predefined, name for custom
      schedule: this.schedule, guestName: this.guestName, meetingAgenda: this.meetingAgenda, additionalDetails: this.additionalDetails,
      createdBy: this.createdBy, createdAt: this.createdAt, updatedAt: this.updatedAt
    };
  }

  static fromRow(r) {
    return new Event({
      id: r.id, title: r.title, date: r.date, time: r.time, venue: r.venue, description: r.description,
      calendarType: r.section, departmentId: r.department_id, departmentName: r.department_full, departmentShort: r.department_short,
      categoryId: r.category_id, categoryName: r.category_name || r.category, categorySlug: r.category_slug, categoryColor: r.category_color,
      schedule: r.schedule, guestName: r.guest_name, meetingAgenda: r.meeting_agenda, additionalDetails: r.additional_details,
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at
    });
  }
}

class Reminder {
  constructor({ id = null, eventId, userEmail, remindBefore = '1 day', createdAt = null }) {
    this.id = id;
    this.eventId = Number(eventId);
    this.userEmail = userEmail;
    this.remindBefore = remindBefore;
    this.createdAt = createdAt || new Date().toISOString();
  }
  validate() {
    const errors = [];
    if (!this.eventId) errors.push('eventId is required.');
    if (!this.userEmail || !/^\S+@\S+\.\S+$/.test(this.userEmail)) errors.push('A valid email address is required.');
    return errors;
  }
  toJSON() {
    return { id: this.id, eventId: this.eventId, userEmail: this.userEmail, remindBefore: this.remindBefore, createdAt: this.createdAt };
  }
}

const deptJSON = (r) => ({
  id: r.id, code: r.code, slug: r.slug, shortName: r.short_name, fullName: r.full_name,
  fileCode: r.file_code, sortOrder: r.sort_order, isActive: !!r.is_active
});
const categoryJSON = (r) => ({
  id: r.id, name: r.name, slug: r.slug, color: r.color,
  isPredefined: !!r.is_predefined, isActive: !!r.is_active,
  calendarType: r.department_id ? 'department' : 'central', departmentId: r.department_id || null
});
const userJSON = (r) => ({
  id: r.id, username: r.username, role: r.role, departmentId: r.department_id || null, isActive: !!r.is_active
});

// ---------------------------------------------------------------------------
// 4. Repositories — raw SQL, always parameterised.
// ---------------------------------------------------------------------------

// Departments are few and rarely change, so they are cached in memory and refreshed on update.
let departmentCache = null;
const departments = {
  async all(force = false) {
    if (!departmentCache || force) {
      departmentCache = (await query('SELECT * FROM departments ORDER BY sort_order, id')).map(deptJSON);
    }
    return departmentCache;
  },
  async byId(id) { return (await this.all()).find((d) => d.id === Number(id)) || null; },
  async bySlug(slug) { return (await this.all()).find((d) => d.slug === slug) || null; },
  async update(id, patch) {
    const fields = []; const params = [];
    if (patch.shortName !== undefined) { fields.push('short_name = ?'); params.push(patch.shortName); }
    if (patch.fullName !== undefined) { fields.push('full_name = ?'); params.push(patch.fullName); }
    if (patch.isActive !== undefined) { fields.push('is_active = ?'); params.push(patch.isActive ? 1 : 0); }
    if (!fields.length) return this.byId(id);
    await query(`UPDATE departments SET ${fields.join(', ')} WHERE id = ?`, [...params, Number(id)]);
    await this.all(true);
    return this.byId(id);
  }
};

const categories = {
  async listForScope(departmentId, { includeInactive = false, db = query } = {}) {
    const rows = await db(
      `SELECT * FROM event_categories WHERE IFNULL(department_id, 0) = ? ${includeInactive ? '' : 'AND is_active = 1'}
       ORDER BY is_predefined DESC, id ASC`,
      [departmentId || 0]
    );
    return rows.map(categoryJSON);
  },
  /** Categories to show as filter chips: active ones, plus deactivated ones that still have events in this scope. */
  async listForFilters(departmentId) {
    const rows = await query(
      `SELECT c.* FROM event_categories c
       WHERE IFNULL(c.department_id, 0) = ?
         AND (c.is_active = 1 OR EXISTS (SELECT 1 FROM events e WHERE e.category_id = c.id))
       ORDER BY c.is_predefined DESC, c.id ASC`,
      [departmentId || 0]
    );
    return rows.map(categoryJSON);
  },
  async findById(id, db = query) {
    const rows = await db('SELECT * FROM event_categories WHERE id = ? LIMIT 1', [Number(id)]);
    return rows.length ? categoryJSON(rows[0]) : null;
  },
  async findByName(departmentId, name, db = query) {
    const rows = await db('SELECT * FROM event_categories WHERE IFNULL(department_id, 0) = ? AND name_key = ? LIMIT 1', [departmentId || 0, nameKey(name)]);
    return rows.length ? categoryJSON(rows[0]) : null;
  },
  async findBySlugOrName(departmentId, value, db = query) {
    const rows = await db('SELECT * FROM event_categories WHERE IFNULL(department_id, 0) = ? AND (slug = ? OR name_key = ?) LIMIT 1', [departmentId || 0, String(value), nameKey(value)]);
    return rows.length ? categoryJSON(rows[0]) : null;
  },
  async insert(departmentId, name, createdBy, db = query) {
    const result = await db(
      `INSERT INTO event_categories (department_id, slug, name, name_key, color, is_predefined, is_active, created_by)
       VALUES (?, NULL, ?, ?, '#6B7280', 0, 1, ?)`,
      [departmentId || null, name, nameKey(name), createdBy]
    );
    await db('UPDATE event_categories SET color = ? WHERE id = ?', [CUSTOM_COLORS[result.insertId % CUSTOM_COLORS.length], result.insertId]);
    return this.findById(result.insertId, db);
  },
  async update(id, patch, db = query) {
    const fields = []; const params = [];
    if (patch.name !== undefined) { fields.push('name = ?', 'name_key = ?'); params.push(patch.name, nameKey(patch.name)); }
    if (patch.isActive !== undefined) { fields.push('is_active = ?'); params.push(patch.isActive ? 1 : 0); }
    if (fields.length) await db(`UPDATE event_categories SET ${fields.join(', ')} WHERE id = ?`, [...params, Number(id)]);
    return this.findById(id, db);
  }
};

/** WHERE fragment restricting events to one calendar (optionally merged with Central, read-only). */
function scopeClause(scope, a = 'e') {
  const central = `(${a}.section = 'central' AND ${a}.department_id IS NULL)`;
  if (scope.calendarType === 'central') return { sql: central, params: [] };
  const own = `(${a}.section = 'department' AND ${a}.department_id = ?)`;
  return scope.includeCentral
    ? { sql: `(${own} OR ${central})`, params: [Number(scope.departmentId)] }
    : { sql: own, params: [Number(scope.departmentId)] };
}

const EVENT_SELECT = `
  SELECT e.*, c.name AS category_name, c.color AS category_color, c.slug AS category_slug,
         d.short_name AS department_short, d.full_name AS department_full
  FROM events e
  LEFT JOIN event_categories c ON c.id = e.category_id
  LEFT JOIN departments d ON d.id = e.department_id`;

const events = {
  async list(scope, { from = null, to = null, categoryId = null, limit = null } = {}) {
    const s = scopeClause(scope);
    const where = [s.sql]; const params = [...s.params];
    if (from) { where.push('e.date >= ?'); params.push(from); }
    if (to) { where.push('e.date <= ?'); params.push(to); }
    if (categoryId) { where.push('e.category_id = ?'); params.push(Number(categoryId)); }
    let sql = `${EVENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.date ASC, e.id ASC`;
    if (limit) { sql += ' LIMIT ?'; params.push(Number(limit)); }
    return (await query(sql, params)).map(Event.fromRow).sort(compareEvents);
  },
  async findById(id, db = query) {
    const rows = await db(`${EVENT_SELECT} WHERE e.id = ? LIMIT 1`, [Number(id)]);
    return rows.length ? Event.fromRow(rows[0]) : null;
  },
  /** Same title (case-insensitive), date, calendar and category already exists? */
  async findDuplicate(inst, { excludeId = null, anyCategory = false, db = query } = {}) {
    const where = ['LOWER(e.title) = LOWER(?)', 'e.date = ?', 'e.section = ?', 'IFNULL(e.department_id, 0) = ?'];
    const params = [inst.title.trim(), inst.date, inst.calendarType, inst.departmentId || 0];
    if (!anyCategory) { where.push('e.category_id = ?'); params.push(inst.categoryId); }
    if (excludeId) { where.push('e.id <> ?'); params.push(Number(excludeId)); }
    const rows = await db(`SELECT e.id FROM events e WHERE ${where.join(' AND ')} LIMIT 1`, params);
    return rows.length > 0;
  },
  async create(inst, user, db = query) {
    const category = inst.categorySlug || inst.categoryName; // legacy `category` column keeps a readable value
    const result = await db(
      `INSERT INTO events (title, date, time, venue, description, section, department_id, category, category_id, schedule,
                           guest_name, meeting_agenda, additional_details, created_by, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [inst.title.trim(), inst.date, inst.time, inst.venue, inst.description, inst.calendarType, inst.departmentId, category, inst.categoryId,
       inst.schedule, inst.guestName, inst.meetingAgenda, inst.additionalDetails, user.username, user.id]
    );
    return this.findById(result.insertId, db);
  },
  async update(id, inst, db = query) {
    const category = inst.categorySlug || inst.categoryName;
    await db(
      `UPDATE events SET title = ?, date = ?, time = ?, venue = ?, description = ?, section = ?, department_id = ?, category = ?, category_id = ?,
              schedule = ?, guest_name = ?, meeting_agenda = ?, additional_details = ? WHERE id = ?`,
      [inst.title.trim(), inst.date, inst.time, inst.venue, inst.description, inst.calendarType, inst.departmentId, category, inst.categoryId,
       inst.schedule, inst.guestName, inst.meetingAgenda, inst.additionalDetails, Number(id)]
    );
    return this.findById(id, db);
  },
  async delete(id) {
    const result = await query('DELETE FROM events WHERE id = ?', [Number(id)]);
    return result.affectedRows > 0;
  }
};

const reminders = {
  async create(inst) {
    const d = inst.toJSON();
    const result = await query(
      'INSERT INTO reminders (event_id, user_email, remind_before) VALUES (?, ?, ?)',
      [d.eventId, d.userEmail, d.remindBefore]
    );
    inst.id = result.insertId;
    return inst;
  }
};

const users = {
  async findByUsername(username) {
    const rows = await query('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
    return rows[0] || null;
  },
  async findById(id) {
    const rows = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [Number(id)]);
    return rows[0] || null;
  },
  async list() { return (await query('SELECT * FROM users ORDER BY role, username')).map(userJSON); },
  async create({ username, hash, salt, role, departmentId }) {
    const result = await query('INSERT INTO users (username, password_hash, salt, role, department_id) VALUES (?, ?, ?, ?, ?)', [username, hash, salt, role, departmentId || null]);
    return this.findById(result.insertId);
  },
  async touchLogin(id) { await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [Number(id)]); },
  async setPassword(id, hash, salt) { await query('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [hash, salt, Number(id)]); },
  async update(id, patch) {
    const fields = []; const params = [];
    if (patch.role !== undefined) { fields.push('role = ?'); params.push(patch.role); }
    if (patch.departmentId !== undefined) { fields.push('department_id = ?'); params.push(patch.departmentId); }
    if (patch.isActive !== undefined) { fields.push('is_active = ?'); params.push(patch.isActive ? 1 : 0); }
    if (fields.length) await query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...params, Number(id)]);
    return this.findById(id);
  },
  async countActiveSuperAdmins() {
    return Number((await query("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND is_active = 1"))[0].n);
  }
};

const contacts = {
  async findAll(departmentId) {
    return query('SELECT id, email, label FROM contacts WHERE IFNULL(department_id, 0) = ? ORDER BY email ASC', [departmentId || 0]);
  },
  async create(departmentId, email, label) {
    const result = await query('INSERT INTO contacts (department_id, email, label) VALUES (?, ?, ?)', [departmentId || null, email, label || null]);
    return { id: result.insertId, email, label: label || null };
  },
  async delete(departmentId, id) {
    const result = await query('DELETE FROM contacts WHERE id = ? AND IFNULL(department_id, 0) = ?', [Number(id), departmentId || 0]);
    return result.affectedRows > 0;
  }
};

// ---------------------------------------------------------------------------
// Calendars + permissions
//   A "calendar" is Central or one department. Every authorization decision
//   below is made on the server from the session user and the target calendar.
// ---------------------------------------------------------------------------

/** Resolves 'central' or a department slug to a calendar descriptor (or null). */
async function resolveCalendar(slug) {
  if (slug === 'central') {
    return {
      type: 'central', departmentId: null, slug: 'central', base: '/central',
      shortName: 'Central', fullName: 'Central Academic Calendar', fileCode: 'Central_Academic',
      titleLine: config.centralHeading, subLine: ''
    };
  }
  const d = await departments.bySlug(String(slug || ''));
  if (!d || !d.isActive) return null;
  return {
    type: 'department', departmentId: d.id, slug: d.slug, base: `/d/${d.slug}`,
    shortName: d.shortName, fullName: d.fullName, fileCode: d.fileCode,
    titleLine: config.instituteName, subLine: d.fullName
  };
}
async function calendarForScope(calendarType, departmentId) {
  if (calendarType === 'central') return resolveCalendar('central');
  const d = await departments.byId(departmentId);
  return d ? resolveCalendar(d.slug) : null;
}
/** The calendar a signed-in user lands on. Super administrators have no fixed home. */
async function homeCalendarFor(user) {
  if (!user) return null;
  if (user.role === 'central_admin') return resolveCalendar('central');
  if (user.role === 'dept_admin') return calendarForScope('department', user.departmentId);
  return null;
}

/** May this user create/edit/delete/import into the calendar? */
function canWrite(user, calendarType, departmentId) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (calendarType === 'central') return user.role === 'central_admin';
  return user.role === 'dept_admin' && Number(user.departmentId) === Number(departmentId);
}
/** Signed-in users are confined to their own calendar; anonymous visitors only get view access when PUBLIC_READ is on. */
function canRead(user, calendarType, departmentId) {
  if (!user) return config.publicRead;
  return canWrite(user, calendarType, departmentId);
}
/** Calendars (Central + departments) this user may modify — drives the Add Event form options. */
async function writableCalendars(user) {
  if (!user) return [];
  const out = [];
  if (canWrite(user, 'central', null)) out.push({ calendarType: 'central', departmentId: null, label: 'Central', fullName: 'Central Academic Calendar' });
  for (const d of await departments.all()) {
    if (d.isActive && canWrite(user, 'department', d.id)) out.push({ calendarType: 'department', departmentId: d.id, label: d.shortName, fullName: d.fullName });
  }
  return out;
}

function assertRead(user, calendar) {
  if (!user && !config.publicRead) throw httpError(401, 'Please log in to view this calendar.');
  if (!canRead(user, calendar.type, calendar.departmentId)) throw httpError(403, 'You are not authorised to view this calendar.');
}
function assertWrite(user, calendarType, departmentId) {
  if (!user) throw httpError(401, 'Login required.');
  if (!canWrite(user, calendarType, departmentId)) throw httpError(403, 'You are not authorised to manage that calendar.');
}

// ---------------------------------------------------------------------------
// 5. Services
// ---------------------------------------------------------------------------

const categoryService = {
  validateName(raw) {
    const name = normalizeName(raw);
    const errors = [];
    if (!name) errors.push('Category name cannot be empty.');
    else if (name.length > LIMITS.categoryName) errors.push(`Category name must be ${LIMITS.categoryName} characters or fewer.`);
    else if (/[\u0000-\u001F\u007F]/.test(name)) errors.push('Category name contains invalid characters.');
    return { name, errors };
  },

  /**
   * Creates a custom category in one calendar scope. A deactivated custom category with the same name is
   * re-activated instead of duplicated; an active/predefined one is rejected with the existing record.
   * `conn` lets bulk import call this inside its transaction.
   */
  async create(user, { calendarType, departmentId }, rawName, conn = null) {
    const scopeDept = calendarType === 'central' ? null : Number(departmentId);
    if (calendarType !== 'central' && !(await departments.byId(scopeDept))) throw validationError('Unknown department.');
    assertWrite(user, calendarType, scopeDept);

    const { name, errors } = this.validateName(rawName);
    if (errors.length) throw validationError(errors);

    const db = dbFor(conn);
    const existing = await categories.findByName(scopeDept, name, db);
    if (existing) {
      if (!existing.isActive && !existing.isPredefined) {
        const revived = await categories.update(existing.id, { isActive: true, name }, db);
        return { category: revived, reused: true };
      }
      throw httpError(409, `A category named "${existing.name}" already exists in this calendar.`, { existing });
    }
    try {
      return { category: await categories.insert(scopeDept, name, user.username, db), reused: false };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'A category with that name already exists in this calendar.');
      throw err;
    }
  },

  async loadForWrite(user, id) {
    const cat = await categories.findById(id);
    // Don't reveal categories of calendars the user can't even read.
    if (!cat || !canRead(user, cat.calendarType, cat.departmentId)) throw httpError(404, 'Category not found.');
    assertWrite(user, cat.calendarType, cat.departmentId);
    return cat;
  },

  async update(user, id, patch) {
    const cat = await this.loadForWrite(user, id);
    const change = {};
    if (patch.name !== undefined) {
      if (cat.isPredefined) throw validationError('Predefined categories cannot be renamed.');
      const { name, errors } = this.validateName(patch.name);
      if (errors.length) throw validationError(errors);
      const clash = await categories.findByName(cat.departmentId, name);
      if (clash && clash.id !== cat.id) throw httpError(409, `A category named "${clash.name}" already exists in this calendar.`, { existing: clash });
      change.name = name;
    }
    if (patch.isActive !== undefined) {
      if (cat.isPredefined && !patch.isActive) throw validationError('Predefined categories cannot be deactivated.');
      change.isActive = !!patch.isActive;
    }
    try {
      // Renaming/deactivating never touches events: they reference the category by id.
      return await categories.update(cat.id, change);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'A category with that name already exists in this calendar.');
      throw err;
    }
  }
};

/**
 * Event rules shared by the Add Event form, edits and imports.
 * Returns a validated, not-yet-saved Event instance.
 */
async function buildEvent(payload, user, { existing = null, db = query } = {}) {
  const calendarType = payload.calendarType || payload.section || (existing && existing.calendarType);
  if (!['central', 'department'].includes(calendarType)) throw validationError('Calendar type must be Central or Department.');

  let departmentId = null;
  if (calendarType === 'department') {
    const hasRequested = payload.departmentId !== undefined && payload.departmentId !== null && payload.departmentId !== '';
    let requested = hasRequested ? Number(payload.departmentId) : (existing ? existing.departmentId : null);
    if (user.role === 'dept_admin') {
      if (hasRequested && requested !== Number(user.departmentId)) throw httpError(403, 'You can only manage events for your own department.');
      requested = user.departmentId;
    }
    const dept = Number.isInteger(requested) ? await departments.byId(requested) : null;
    if (!dept || !dept.isActive) throw validationError('Choose a valid department for department events.');
    departmentId = dept.id;
  }
  assertWrite(user, calendarType, departmentId);

  // Category: by id (preferred) or, for older API clients, by slug/name within the target calendar.
  let cat = null;
  if (payload.categoryId) cat = await categories.findById(payload.categoryId, db);
  else if (payload.category) cat = await categories.findBySlugOrName(departmentId, payload.category, db);
  else if (existing && existing.categoryId) cat = await categories.findById(existing.categoryId, db);
  if (!cat) throw validationError('Select a category.');
  if ((cat.departmentId || null) !== departmentId) throw validationError('That category does not belong to the selected calendar.');
  if (!cat.isActive && !(existing && existing.categoryId === cat.id)) throw validationError('That category has been deactivated.');

  const slug = cat.isPredefined ? cat.slug : null; // only predefined categories trigger the special fields
  const inst = new Event({
    ...(existing ? existing.toJSON() : {}), ...payload,
    id: existing ? existing.id : null,
    calendarType, departmentId, categoryId: cat.id, categoryName: cat.name, categorySlug: cat.slug, categoryColor: cat.color,
    schedule: (slug && RECURRING_SCHEDULE[slug]) || '', // recurrence is derived from the category, never trusted from the client
    guestName: normalizeName(payload.guestName !== undefined ? payload.guestName : (existing ? existing.guestName : '')),
    meetingAgenda: String(payload.meetingAgenda !== undefined ? payload.meetingAgenda : (existing ? existing.meetingAgenda : '')).trim(),
    additionalDetails: String(payload.additionalDetails !== undefined ? payload.additionalDetails : (existing ? existing.additionalDetails : '')).trim(),
    time: String(payload.time !== undefined ? payload.time : (existing ? existing.time : '')).trim(),
    venue: String(payload.venue !== undefined ? payload.venue : (existing ? existing.venue : '')).trim(),
    description: String(payload.description !== undefined ? payload.description : (existing ? existing.description : '')).trim()
  });

  const errors = inst.validateShape();
  if (slug && GUEST_REQUIRED.has(slug) && !inst.guestName) errors.push(`Guest Name is required for ${cat.name}.`);
  if (slug && AGENDA_REQUIRED.has(slug) && !inst.meetingAgenda) errors.push('Meeting Details/Agenda is required for Department Meetings.');
  if (errors.length) throw validationError(errors);
  return inst;
}

const eventService = {
  async create(payload, user) {
    const inst = await buildEvent(payload, user);
    if (await events.findDuplicate(inst)) throw validationError('An event with the same title, date, calendar, and category already exists.');
    return events.create(inst, user);
  },

  /** Loads an event the user is allowed to modify. Events in calendars they can't read look like "not found". */
  async loadForWrite(user, id) {
    if (!user) throw httpError(401, 'Login required.');
    const existing = await events.findById(id);
    if (!existing || !canRead(user, existing.calendarType, existing.departmentId)) throw httpError(404, 'Event not found.');
    assertWrite(user, existing.calendarType, existing.departmentId);
    return existing;
  },

  async update(id, payload, user) {
    const existing = await this.loadForWrite(user, id);
    const inst = await buildEvent(payload, user, { existing });
    if (await events.findDuplicate(inst, { excludeId: existing.id })) throw validationError('An event with the same title, date, calendar, and category already exists.');
    return events.update(existing.id, inst);
  },

  async delete(id, user) {
    const existing = await this.loadForWrite(user, id);
    return events.delete(existing.id);
  }
};

const reminderService = {
  async optIn(user, eventId, userEmail, remindBefore = '1 day') {
    const event = await events.findById(eventId);
    if (!event || !canRead(user, event.calendarType, event.departmentId)) throw httpError(404, 'Cannot set a reminder for an event that does not exist.');
    if (!user && !config.publicRead) throw httpError(401, 'Please log in first.');
    const reminder = new Reminder({ eventId, userEmail, remindBefore });
    const errors = reminder.validate();
    if (errors.length) throw validationError(errors);
    return reminders.create(reminder);
  }
};

// --- Import (PDF -> preview -> confirm) -------------------------------------

const MAX_IMPORT_ROWS = 500;

/** Row-level validation shared by preview and confirm. Returns a list of human-readable problems. */
function validateImportRow(row) {
  const errors = [];
  const title = normalizeName(row.title);
  if (!title) errors.push('Title is required.');
  else if (title.length > LIMITS.title) errors.push(`Title is longer than ${LIMITS.title} characters.`);
  if (!isValidIsoDate(row.date)) errors.push('Date is missing or not a valid calendar date.');
  if (String(row.time || '').length > LIMITS.time) errors.push(`Time is longer than ${LIMITS.time} characters.`);
  if (String(row.venue || '').length > LIMITS.venue) errors.push(`Venue is longer than ${LIMITS.venue} characters.`);
  if (String(row.description || '').length > LIMITS.longText) errors.push('Description is too long.');
  return errors;
}

/** Resolves and authorizes the import target from the request body (department users are pinned to their own department). */
async function resolveImportTarget(user, body) {
  if (!user) throw httpError(401, 'Login required.');
  const calendarType = body.calendarType;
  if (!['central', 'department'].includes(calendarType)) throw validationError('Choose where the events should be imported: Central Calendar or Department Calendar.');
  if (calendarType === 'central') {
    assertWrite(user, 'central', null);
    return calendarForScope('central', null);
  }
  let departmentId = user.role === 'dept_admin' ? Number(user.departmentId) : Number(body.departmentId);
  if (user.role === 'dept_admin' && body.departmentId && Number(body.departmentId) !== departmentId) {
    throw httpError(403, 'You can only import into your own department calendar.');
  }
  const calendar = Number.isInteger(departmentId) ? await calendarForScope('department', departmentId) : null;
  if (!calendar) throw validationError('Choose a department to import into.');
  assertWrite(user, 'department', calendar.departmentId);
  return calendar;
}

const importService = {
  async preview(user, body, fileBuffer) {
    const target = await resolveImportTarget(user, body);

    const text = await extractTextFromPdf(fileBuffer);
    if (!text || !text.trim()) {
      return { target, rows: [], total: 0, valid: 0, invalid: 0, duplicates: 0, unmatchedCategories: [], categories: await categories.listForScope(target.departmentId),
        message: 'No readable text found in that PDF. Scanned/image-only PDFs are not supported \u2014 try a text-based PDF instead.' };
    }

    const extracted = new PdfEventExtractor({ maxEvents: MAX_IMPORT_ROWS }).extract(text);
    const cats = await categories.listForScope(target.departmentId);
    const byKey = new Map(cats.map((c) => [nameKey(c.name), c]));

    const seen = new Set();
    const rows = [];
    for (let i = 0; i < extracted.length; i++) {
      const r = extracted[i];
      const errors = validateImportRow(r);
      const match = byKey.get(nameKey(r.suggestedCategory));
      const probe = { title: normalizeName(r.title), date: r.date, calendarType: target.type, departmentId: target.departmentId };
      const key = `${probe.date}::${probe.title.toLowerCase()}`;
      let duplicate = false;
      if (!errors.length) {
        duplicate = seen.has(key) || await events.findDuplicate(probe, { anyCategory: true });
        seen.add(key);
      }
      rows.push({
        index: i, title: r.title, date: r.date, time: r.time, venue: r.venue, description: r.description,
        suggestedCategory: r.suggestedCategory, categoryId: match ? match.id : null,
        errors, duplicate
      });
    }

    const unmatched = {};
    rows.forEach((r) => { if (!r.errors.length && !r.categoryId) unmatched[r.suggestedCategory] = (unmatched[r.suggestedCategory] || 0) + 1; });

    return {
      target: { type: target.type, departmentId: target.departmentId, slug: target.slug, fullName: target.fullName, shortName: target.shortName },
      rows,
      total: rows.length,
      valid: rows.filter((r) => !r.errors.length).length,
      invalid: rows.filter((r) => r.errors.length).length,
      duplicates: rows.filter((r) => r.duplicate).length,
      unmatchedCategories: Object.entries(unmatched).map(([name, count]) => ({ name, count })),
      categories: cats,
      message: rows.length ? null : 'No dated events could be found in this PDF. You can still add events manually.'
    };
  },

  /**
   * Re-validates everything server-side, then saves in ONE transaction: either every selected,
   * non-duplicate row is imported (plus any custom categories it needs) or nothing is.
   */
  async confirm(user, body) {
    const target = await resolveImportTarget(user, body);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw validationError('No events were selected to import.');
    if (rows.length > MAX_IMPORT_ROWS) throw validationError(`You can import at most ${MAX_IMPORT_ROWS} events at a time.`);

    // 1) cheap validation up front, collecting every problem so the admin can fix them in one go
    const rowErrors = [];
    rows.forEach((r, i) => {
      const errs = validateImportRow(r);
      if (!r.categoryId && !normalizeName(r.newCategoryName)) errs.push('Choose a category (or create a new one).');
      if (r.newCategoryName) errs.push(...categoryService.validateName(r.newCategoryName).errors);
      if (errs.length) rowErrors.push({ index: i, title: r.title, message: errs.join(' ') });
    });
    if (rowErrors.length) throw validationError(`${rowErrors.length} row${rowErrors.length === 1 ? '' : 's'} need attention before importing.`, { rowErrors });

    return withTransaction(async (conn) => {
      const q = dbFor(conn);
      const catCache = new Map(); // nameKey -> category (resolved or created in this import)
      const createdCategories = [];
      const created = []; const skipped = [];
      const seen = new Set();

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        let cat;
        if (r.categoryId) {
          cat = await categories.findById(r.categoryId, q);
          if (!cat || (cat.departmentId || null) !== target.departmentId) throw validationError(`Row ${i + 1}: category does not belong to the target calendar.`, { rowErrors: [{ index: i, title: r.title, message: 'Category does not belong to the target calendar.' }] });
          if (!cat.isActive) throw validationError(`Row ${i + 1}: category "${cat.name}" is deactivated.`, { rowErrors: [{ index: i, title: r.title, message: `Category "${cat.name}" is deactivated.` }] });
        } else {
          const key = nameKey(r.newCategoryName);
          cat = catCache.get(key);
          if (!cat) {
            const res = await categoryService.create(user, { calendarType: target.type, departmentId: target.departmentId }, r.newCategoryName, conn)
              .catch(async (err) => {
                if (err.status === 409 && err.existing && err.existing.isActive) return { category: err.existing, reused: true }; // already there: just use it
                throw err;
              });
            cat = res.category;
            catCache.set(key, cat);
            if (!res.reused) createdCategories.push(cat.name);
          }
        }

        const inst = new Event({
          title: normalizeName(r.title), date: r.date, time: String(r.time || '').trim(), venue: String(r.venue || '').trim(), description: String(r.description || '').trim(),
          calendarType: target.type, departmentId: target.departmentId, categoryId: cat.id, categoryName: cat.name, categorySlug: cat.slug
        });
        const dupKey = `${inst.date}::${inst.title.toLowerCase()}`;
        if (seen.has(dupKey) || await events.findDuplicate(inst, { anyCategory: true, db: q })) {
          skipped.push({ index: i, title: inst.title, reason: 'Duplicate of an existing event (same title and date).' });
          continue;
        }
        seen.add(dupKey);
        const saved = await events.create(inst, user, q);
        created.push(saved.toJSON());
      }
      return { created, skipped, categoriesCreated: createdCategories, target: { type: target.type, slug: target.slug, fullName: target.fullName } };
    });
  }
};

// --- Users / auth ---------------------------------------------------------

const USERNAME_RE = /^[A-Za-z0-9._-]{3,50}$/;
const DUMMY = hashPassword('dummy-password-for-timing'); // equalises timing for unknown usernames

const authService = {
  async login(username, password) {
    const row = typeof username === 'string' ? await users.findByUsername(username.trim()) : null;
    if (!row) { verifyPassword(String(password || ''), DUMMY.salt, DUMMY.hash); return null; }
    const ok = verifyPassword(String(password || ''), row.salt, row.password_hash);
    if (!ok || !row.is_active) return null;
    await users.touchLogin(row.id);
    return userJSON(row);
  }
};

const userService = {
  validateRoleScope(role, departmentId) {
    if (!ROLES.includes(role)) throw validationError('Role must be super_admin, central_admin or dept_admin.');
    if (role === 'dept_admin') {
      if (!Number.isInteger(Number(departmentId)) || !departmentId) throw validationError('Department administrators need a department.');
      return Number(departmentId);
    }
    return null;
  },
  async create({ username, password, role, departmentId }) {
    username = String(username || '').trim();
    if (!USERNAME_RE.test(username)) throw validationError('Username must be 3\u201350 characters: letters, numbers, dot, dash or underscore.');
    const deptId = this.validateRoleScope(role, departmentId);
    if (deptId && !(await departments.byId(deptId))) throw validationError('Unknown department.');
    let generated = null;
    if (!password) { generated = randomPassword(); password = generated; }
    if (String(password).length < 10) throw validationError('Password must be at least 10 characters.');
    const { hash, salt } = hashPassword(String(password));
    try {
      const row = await users.create({ username, hash, salt, role, departmentId: deptId });
      return { user: userJSON(row), generatedPassword: generated };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'That username already exists.');
      throw err;
    }
  },
  async update(actor, id, patch) {
    const row = await users.findById(id);
    if (!row) throw httpError(404, 'User not found.');
    const next = {};
    const role = patch.role !== undefined ? patch.role : row.role;
    const departmentId = patch.departmentId !== undefined ? patch.departmentId : row.department_id;
    if (patch.role !== undefined || patch.departmentId !== undefined) {
      next.role = role;
      next.departmentId = this.validateRoleScope(role, departmentId);
      if (next.departmentId && !(await departments.byId(next.departmentId))) throw validationError('Unknown department.');
    }
    if (patch.isActive !== undefined) next.isActive = !!patch.isActive;

    const losingSuper = row.role === 'super_admin' && row.is_active && ((next.role && next.role !== 'super_admin') || next.isActive === false);
    if (losingSuper && (Number(actor.id) === Number(row.id) || (await users.countActiveSuperAdmins()) <= 1)) {
      throw validationError('You cannot remove or deactivate the last (or your own) super administrator.');
    }
    return userJSON(await users.update(id, next));
  },
  async resetPassword(id, password) {
    const row = await users.findById(id);
    if (!row) throw httpError(404, 'User not found.');
    let generated = null;
    if (!password) { generated = randomPassword(); password = generated; }
    if (String(password).length < 10) throw validationError('Password must be at least 10 characters.');
    const { hash, salt } = hashPassword(String(password));
    await users.setPassword(id, hash, salt);
    return { generatedPassword: generated };
  }
};

// --- Mail -------------------------------------------------------------------

function getMailTransporter() {
  if (!config.mail.host || !config.mail.user || !config.mail.pass) {
    throw httpError(503, 'Email sending is not configured yet. Set MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS and MAIL_FROM in your .env file.');
  }
  return nodemailer.createTransport({
    host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
    auth: { user: config.mail.user, pass: config.mail.pass }
  });
}

async function sendPosterEmail({ recipients, subject, text, imageDataUrl, filename }) {
  const transporter = getMailTransporter();
  const match = /^data:image\/png;base64,(.+)$/.exec(imageDataUrl || '');
  if (!match) throw httpError(400, 'No valid calendar image was received to attach.');
  await transporter.sendMail({
    from: config.mail.from, to: recipients.join(', '), subject, text,
    attachments: [{ filename, content: Buffer.from(match[1], 'base64'), contentType: 'image/png' }]
  });
}

/** Builds the calendar grid cells (empty leading cells + one cell per day, each with its events attached). */
function buildCalendarCells(year, month, eventsForMonth) {
  const eventsByDate = {};
  eventsForMonth.forEach((e) => { (eventsByDate[e.date] = eventsByDate[e.date] || []).push(e); });
  const firstDow = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push({ empty: true });
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ empty: false, day: d, date: dateStr, events: eventsByDate[dateStr] || [] });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// 6. Auth middleware
//    The session only stores the user id; role and department are re-read from
//    the database on every request, so deactivating a user or changing their
//    role takes effect immediately. Nothing is trusted from the browser.
// ---------------------------------------------------------------------------

async function attachUser(req, res, next) {
  try {
    req.user = null;
    const id = req.session && req.session.userId;
    if (id) {
      const row = await users.findById(id);
      if (row && row.is_active) req.user = userJSON(row);
      else delete req.session.userId;
    }
    next();
  } catch (err) { next(err); }
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ success: false, message: 'Login required.' });
}
function requireSuperAdmin(req, res, next) {
  if (req.user && req.user.role === 'super_admin') return next();
  return res.status(req.user ? 403 : 401).json({ success: false, message: req.user ? 'Super administrator access required.' : 'Login required.' });
}

// --- login throttling (in-memory; per IP+username and per IP) ---
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function throttleKeys(req, username) {
  return [`u:${req.ip}:${String(username || '').toLowerCase()}`, `ip:${req.ip}`];
}
function isThrottled(req, username) {
  const now = Date.now();
  return throttleKeys(req, username).some((key, i) => {
    const rec = failures.get(key);
    if (!rec || now - rec.first > WINDOW_MS) return false;
    return rec.count >= (i === 0 ? 5 : 30);
  });
}
function recordFailure(req, username) {
  const now = Date.now();
  throttleKeys(req, username).forEach((key) => {
    const rec = failures.get(key);
    if (!rec || now - rec.first > WINDOW_MS) failures.set(key, { count: 1, first: now });
    else rec.count += 1;
  });
}
function clearFailures(req, username) { failures.delete(throttleKeys(req, username)[0]); }
setInterval(() => { const now = Date.now(); for (const [k, v] of failures) if (now - v.first > WINDOW_MS) failures.delete(k); }, WINDOW_MS).unref();

/** Resolves the `calendar` slug from query/body; throws 400/404 as appropriate. */
async function calendarFrom(source) {
  const slug = source && source.calendar;
  if (!slug) throw httpError(400, 'A calendar is required (calendar=central or a department slug).');
  const calendar = await resolveCalendar(String(slug));
  if (!calendar) throw httpError(404, 'Unknown calendar.');
  return calendar;
}

/** Central events may be overlaid (read-only) on a department view only for users signed in to that department. */
function mayIncludeCentral(user, calendar) {
  return calendar.type === 'department' && !!user && canRead(user, calendar.type, calendar.departmentId);
}

function asyncRoute(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch((err) => sendError(res, err));
}

function safeFilePart(s) { return String(s).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x'; }

// ---------------------------------------------------------------------------
// 7. Express app, routes, startup
// ---------------------------------------------------------------------------

// PDF uploads are kept in memory (never written to disk), capped at 10MB, PDF-only.
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    cb(new Error('Only PDF files are allowed.'));
  }
});

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'client', 'views'));
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '10mb' })); // poster images sent as base64 can be a few MB
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '..', 'client', 'public')));

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 4, httpOnly: true, sameSite: 'lax', secure: config.cookieSecure } // 4 hours
}));
app.use(attachUser);

app.use((req, res, next) => {
  res.locals.instituteName = config.instituteName;
  next();
});

// --- Pages ---

app.get('/', asyncRoute(async (req, res) => {
  const home = await homeCalendarFor(req.user);
  if (home) return res.redirect(home.base);
  const flash = req.session.flash || null;
  delete req.session.flash;
  const last = req.session.selectedCalendar ? await resolveCalendar(req.session.selectedCalendar) : null;
  res.render('select', {
    departments: (await departments.all()).filter((d) => d.isActive),
    user: req.user, flash, last,
    centralHeading: config.centralHeading
  });
}));

async function renderCalendar(req, res, calendar) {
  const user = req.user;

  if (user && !canRead(user, calendar.type, calendar.departmentId)) {
    // Signed-in users never see another calendar: send them home with a notice.
    const home = await homeCalendarFor(user);
    req.session.flash = 'You are not authorised to view that calendar.';
    return res.redirect(home ? home.base : '/');
  }
  const locked = !user && !config.publicRead;

  req.session.selectedCalendar = calendar.slug; // navigation convenience only — never used for authorization

  const now = new Date();
  let year = parseInt(req.query.year, 10);
  let month = parseInt(req.query.month, 10);
  if (!(year >= 2000 && year <= 2100)) year = now.getFullYear();
  if (!(month >= 1 && month <= 12)) month = now.getMonth() + 1;
  const selectedDate = isValidIsoDate(req.query.date) ? req.query.date : null;
  const today = now.toISOString().slice(0, 10);

  const includeCentral = req.query.central === '1' && mayIncludeCentral(user, calendar);
  const scope = { calendarType: calendar.type, departmentId: calendar.departmentId, includeCentral };

  const ownCategories = await categories.listForFilters(calendar.departmentId);
  const centralChips = includeCentral ? await categories.listForFilters(null) : [];
  const filterCategories = [...ownCategories, ...centralChips.map((c) => ({ ...c, fromCentral: true }))];

  // ?category= is "all" or a category id (older slug links are still understood)
  let category = 'all';
  let categoryId = null;
  if (req.query.category && req.query.category !== 'all') {
    const raw = String(req.query.category);
    const hit = filterCategories.find((c) => String(c.id) === raw || (c.slug && c.slug === raw));
    if (hit) { category = String(hit.id); categoryId = hit.id; }
  }

  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  let monthEvents = []; let upcoming = []; let selectedEvents = [];
  if (!locked) {
    monthEvents = await events.list(scope, { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` });
    upcoming = await events.list(scope, { from: today, limit: 6 });
    selectedEvents = selectedDate ? await events.list(scope, { from: selectedDate, to: selectedDate }) : [];
  }
  const cells = buildCalendarCells(year, month, monthEvents.map((e) => e.toJSON()));

  let prevMonth = month - 1, prevYear = year;
  if (prevMonth < 1) { prevMonth = 12; prevYear -= 1; }
  let nextMonth = month + 1, nextYear = year;
  if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }

  const canEdit = canWrite(user, calendar.type, calendar.departmentId);
  const writable = await writableCalendars(user);
  const flash = req.session.flash || null;
  delete req.session.flash;

  const state = {
    year, month, category, categoryId, selectedDate, includeCentral,
    instituteName: config.instituteName,
    calendar: { type: calendar.type, departmentId: calendar.departmentId, slug: calendar.slug, base: calendar.base, shortName: calendar.shortName, fullName: calendar.fullName, fileCode: calendar.fileCode, titleLine: calendar.titleLine, subLine: calendar.subLine },
    user: user ? { username: user.username, role: user.role, departmentId: user.departmentId } : null,
    writable,
    departments: (await departments.all()).filter((d) => d.isActive).map((d) => ({ id: d.id, slug: d.slug, shortName: d.shortName, fullName: d.fullName })),
    categories: canEdit ? await categories.listForScope(calendar.departmentId) : [],
    canEdit, locked
  };

  res.render('index', {
    calendar, year, month, category, categoryId, selectedDate, cells, upcoming: upcoming.map((e) => e.toJSON()), selectedEvents: selectedEvents.map((e) => e.toJSON()),
    prevMonth, prevYear, nextMonth, nextYear,
    user, isAdmin: canEdit, canEdit, canIncludeCentral: mayIncludeCentral(user, calendar), includeCentral,
    filterCategories, locked, flash, today, state,
    showChangeDepartment: !user || user.role === 'super_admin'
  });
}

app.get('/central', asyncRoute((req, res) => resolveCalendar('central').then((c) => renderCalendar(req, res, c))));
app.get('/d/:slug', asyncRoute(async (req, res) => {
  const calendar = await resolveCalendar(req.params.slug);
  if (!calendar) return res.status(404).send('Department not found.');
  return renderCalendar(req, res, calendar);
}));

// --- Auth API ---

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  if (isThrottled(req, username)) {
    return res.status(429).json({ success: false, message: 'Too many failed attempts. Please wait 15 minutes and try again.' });
  }
  const user = await authService.login(username, password);
  if (!user) {
    recordFailure(req, username);
    return res.status(401).json({ success: false, message: 'Incorrect username or password.' });
  }

  // The chosen department only decides where we send the user; the account's own scope decides what it may do.
  let target = null;
  if (req.body.calendar) {
    target = await resolveCalendar(String(req.body.calendar));
    if (target && user.role !== 'super_admin' && !canWrite(user, target.type, target.departmentId)) {
      return res.status(403).json({ success: false, message: `This account is not authorised for the ${target.fullName} calendar. Choose your own department to log in.` });
    }
  }
  clearFailures(req, username);
  const selected = req.session.selectedCalendar;
  req.session.regenerate((err) => { // fresh session id on privilege change (prevents session fixation)
    if (err) return sendError(res, err);
    req.session.userId = user.id;
    if (selected) req.session.selectedCalendar = selected;
    homeCalendarFor(user).then((home) => res.json({ success: true, user, redirect: target ? target.base : (home ? home.base : '/') }));
  });
}));

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ success: true }); });
});

app.get('/api/me', (req, res) => res.json({ user: req.user }));

app.get('/api/departments', asyncRoute(async (req, res) => {
  res.json((await departments.all()).filter((d) => d.isActive).map((d) => ({ id: d.id, slug: d.slug, shortName: d.shortName, fullName: d.fullName })));
}));

// --- Categories API ---

app.get('/api/categories', asyncRoute(async (req, res) => {
  const calendar = await calendarFrom(req.query);
  assertRead(req.user, calendar);
  const includeInactive = req.query.includeInactive === '1' && canWrite(req.user, calendar.type, calendar.departmentId);
  res.json(await categories.listForScope(calendar.departmentId, { includeInactive }));
}));

app.post('/api/categories', requireAuth, asyncRoute(async (req, res) => {
  const { calendarType, departmentId, name } = req.body || {};
  if (!['central', 'department'].includes(calendarType)) throw validationError('Calendar type must be Central or Department.');
  const deptId = req.user.role === 'dept_admin' ? (departmentId ? Number(departmentId) : req.user.departmentId) : departmentId;
  const result = await categoryService.create(req.user, { calendarType, departmentId: deptId }, name);
  res.status(result.reused ? 200 : 201).json({ success: true, category: result.category, reused: result.reused });
}));

app.patch('/api/categories/:id', requireAuth, asyncRoute(async (req, res) => {
  const category = await categoryService.update(req.user, req.params.id, { name: req.body.name, isActive: req.body.isActive });
  res.json({ success: true, category });
}));

// --- Events API ---

app.get('/api/events', asyncRoute(async (req, res) => {
  const calendar = await calendarFrom(req.query);
  assertRead(req.user, calendar);
  const includeCentral = req.query.central === '1' && mayIncludeCentral(req.user, calendar);
  const categoryId = req.query.category && req.query.category !== 'all' && /^\d+$/.test(String(req.query.category)) ? Number(req.query.category) : null;
  const from = isValidIsoDate(req.query.from) ? req.query.from : null;
  const to = isValidIsoDate(req.query.to) ? req.query.to : null;
  const list = await events.list({ calendarType: calendar.type, departmentId: calendar.departmentId, includeCentral }, { from, to, categoryId });
  res.json(list.map((e) => e.toJSON()));
}));

app.get('/api/events/:date', asyncRoute(async (req, res) => {
  if (!isValidIsoDate(req.params.date)) throw validationError('A valid date (YYYY-MM-DD) is required.');
  const calendar = await calendarFrom(req.query);
  assertRead(req.user, calendar);
  const includeCentral = req.query.central === '1' && mayIncludeCentral(req.user, calendar);
  const list = await events.list({ calendarType: calendar.type, departmentId: calendar.departmentId, includeCentral }, { from: req.params.date, to: req.params.date });
  res.json(list.map((e) => e.toJSON()));
}));

app.post('/api/events', requireAuth, asyncRoute(async (req, res) => {
  const event = await eventService.create(req.body || {}, req.user);
  res.status(201).json(event.toJSON());
}));

app.put('/api/events/:id', requireAuth, asyncRoute(async (req, res) => {
  const event = await eventService.update(req.params.id, req.body || {}, req.user);
  res.json(event.toJSON());
}));

app.delete('/api/events/:id', requireAuth, asyncRoute(async (req, res) => {
  res.json({ success: await eventService.delete(req.params.id, req.user) });
}));

// --- Import API (PDF -> preview -> confirm) ---

app.post('/api/import/preview', requireAuth, pdfUpload.single('pdf'), asyncRoute(async (req, res) => {
  if (!req.file) throw validationError('No PDF file was uploaded.');
  try {
    res.json({ success: true, ...(await importService.preview(req.user, req.body || {}, req.file.buffer)) });
  } catch (err) {
    if (err.status) throw err;
    console.error('PDF import failed:', err);
    throw validationError('Could not read that PDF. Make sure it is a valid, text-based PDF.');
  }
}));

app.post('/api/import/confirm', requireAuth, asyncRoute(async (req, res) => {
  res.json({ success: true, ...(await importService.confirm(req.user, req.body || {})) });
}));

// --- Excel export ---

app.get('/api/export/excel', requireAuth, asyncRoute(async (req, res) => {
  const calendar = await calendarFrom(req.query);
  // Signed-in users can only export the calendar their account belongs to (super administrators: any).
  if (!canRead(req.user, calendar.type, calendar.departmentId)) throw httpError(403, 'You are not authorised to export this calendar.');

  const mode = req.query.scope === 'year' ? 'year' : 'month';
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  if (!(year >= 2000 && year <= 2100)) throw validationError('Choose a valid year (2000\u20132100).');
  if (mode === 'month' && !(month >= 1 && month <= 12)) throw validationError('Choose a valid month.');

  const includeCentral = req.query.includeCentral === '1' && mayIncludeCentral(req.user, calendar);
  const includeList = req.query.includeList !== '0';
  const pad = (n) => String(n).padStart(2, '0');
  const from = mode === 'month' ? `${year}-${pad(month)}-01` : `${year}-01-01`;
  const to = mode === 'month' ? `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}` : `${year}-12-31`;

  const list = await events.list({ calendarType: calendar.type, departmentId: calendar.departmentId, includeCentral }, { from, to });
  const workbook = buildWorkbook({
    calendar: { type: calendar.type, departmentFullName: calendar.fullName },
    college: config.instituteName, mode, year, month, includeList, includesCentral: includeCentral,
    events: list.map((e) => e.toJSON())
  });

  const base = calendar.type === 'central' ? 'VIT_Central_Academic_Calendar' : `VIT_${safeFilePart(calendar.fileCode)}_Calendar`;
  const filename = `${base}_${mode === 'month' ? `${MONTH_NAMES[month - 1]}_` : ''}${year}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  await workbook.xlsx.write(res);
  res.end();
}));

// --- Reminders API ---

app.post('/api/reminders', asyncRoute(async (req, res) => {
  const { eventId, email, remindBefore } = req.body || {};
  const reminder = await reminderService.optIn(req.user, eventId, email, remindBefore);
  res.status(201).json({ success: true, reminder: reminder.toJSON() });
}));

// --- Mail book (saved contacts), scoped to one calendar — admins of that calendar only ---

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 255 && /^[^\s<>"'`]+@[^\s<>"'`]+\.[^\s<>"'`]+$/.test(email);
}
async function writableCalendarFrom(req, source) {
  const calendar = await calendarFrom(source);
  assertWrite(req.user, calendar.type, calendar.departmentId);
  return calendar;
}

app.get('/api/contacts', requireAuth, asyncRoute(async (req, res) => {
  const calendar = await writableCalendarFrom(req, req.query);
  res.json(await contacts.findAll(calendar.departmentId));
}));

app.post('/api/contacts', requireAuth, asyncRoute(async (req, res) => {
  const calendar = await writableCalendarFrom(req, req.body || {});
  const email = String(req.body.email || '').trim().toLowerCase();
  const label = String(req.body.label || '').trim().slice(0, 100);
  if (!isValidEmail(email)) throw validationError('A valid email address is required.');
  try {
    res.status(201).json({ success: true, contact: await contacts.create(calendar.departmentId, email, label) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'That email is already in the mail book.');
    throw err;
  }
}));

app.delete('/api/contacts/:id', requireAuth, asyncRoute(async (req, res) => {
  const calendar = await writableCalendarFrom(req, req.query);
  res.json({ success: await contacts.delete(calendar.departmentId, req.params.id) });
}));

// --- Share calendar poster by email ---

app.post('/api/share-poster', requireAuth, asyncRoute(async (req, res) => {
  const calendar = await writableCalendarFrom(req, req.body || {});
  const { recipients, subject, text, imageDataUrl, fileTag } = req.body;
  const cleanRecipients = Array.isArray(recipients) ? recipients.map((e) => String(e).trim()).filter(isValidEmail) : [];
  if (cleanRecipients.length === 0) throw validationError('Add at least one valid recipient email address.');
  const label = calendar.type === 'central' ? 'Central Academic Calendar' : `${calendar.fullName} (${calendar.shortName})`;
  const base = calendar.type === 'central' ? 'VIT_Central_Academic_Calendar' : `VIT_${safeFilePart(calendar.fileCode)}_Calendar`;
  await sendPosterEmail({
    recipients: cleanRecipients,
    subject: String(subject || `${config.instituteName} \u2014 ${label}`).slice(0, 200),
    text: String(text || `Attached is the ${label} calendar from ${config.instituteName}.`).slice(0, 2000),
    imageDataUrl,
    filename: `${base}_${safeFilePart(fileTag || 'poster')}.png`
  });
  res.json({ success: true, sentTo: cleanRecipients });
}));

// --- Super administrator: users and department configuration ---

app.get('/api/admin/users', requireSuperAdmin, asyncRoute(async (req, res) => res.json(await users.list())));

app.post('/api/admin/users', requireSuperAdmin, asyncRoute(async (req, res) => {
  const { user, generatedPassword } = await userService.create(req.body || {});
  res.status(201).json({ success: true, user, generatedPassword });
}));

app.patch('/api/admin/users/:id', requireSuperAdmin, asyncRoute(async (req, res) => {
  res.json({ success: true, user: await userService.update(req.user, req.params.id, req.body || {}) });
}));

app.post('/api/admin/users/:id/reset-password', requireSuperAdmin, asyncRoute(async (req, res) => {
  const { generatedPassword } = await userService.resetPassword(req.params.id, (req.body || {}).password);
  res.json({ success: true, generatedPassword });
}));

app.get('/api/admin/departments', requireSuperAdmin, asyncRoute(async (req, res) => res.json(await departments.all(true))));

app.patch('/api/admin/departments/:id', requireSuperAdmin, asyncRoute(async (req, res) => {
  const d = await departments.byId(req.params.id);
  if (!d) throw httpError(404, 'Department not found.');
  const patch = {};
  const b = req.body || {};
  if (b.shortName !== undefined) { patch.shortName = normalizeName(b.shortName); if (!patch.shortName || patch.shortName.length > 40) throw validationError('Abbreviation must be 1\u201340 characters.'); }
  if (b.fullName !== undefined) { patch.fullName = normalizeName(b.fullName); if (!patch.fullName || patch.fullName.length > 255) throw validationError('Full name must be 1\u2013255 characters.'); }
  if (b.isActive !== undefined) patch.isActive = !!b.isActive;
  res.json({ success: true, department: await departments.update(d.id, patch) });
}));

// --- 404 + error handling ---

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ success: false, message: 'Not found.' });
  res.status(404).send('Page not found.');
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // Multer errors (bad file type, over the 10MB limit) arrive here from the upload middleware.
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, message: 'PDF is too large (max 10MB).' });
  if (err instanceof multer.MulterError || (err && /pdf/i.test(err.message || ''))) return res.status(400).json({ success: false, message: err.message });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'Request is too large.' });
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ success: false, message: status >= 500 ? 'Internal server error.' : err.message });
});

// --- Startup ---

async function start() {
  if (isProd && config.sessionSecret === DEFAULT_SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be set to a long random value when NODE_ENV=production.');
  }
  await initDatabase();
  await departments.all(true);
  await seedAccounts();

  app.listen(config.port, () => {
    console.log(`${config.instituteName} \u2014 multi-department academic calendar`);
    console.log(`Running at http://localhost:${config.port}`);
    console.log(`Connected to MySQL database "${config.db.database}" on ${config.db.host}:${config.db.port}`);
    console.log(`Public read-only browsing: ${config.publicRead ? 'ON' : 'OFF (login required)'}`);
    if (config.sessionSecret === DEFAULT_SESSION_SECRET) console.warn('WARNING: using the built-in SESSION_SECRET. Set a random SESSION_SECRET in .env.');
  });
}

start().catch((err) => {
  console.error('Failed to start the app:', err.message);
  console.error('Check your DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME settings (see .env).');
  process.exit(1);
});
