-- VIT Multi-Department Academic Calendar — full schema (reference).
--
-- server.js creates/extends all of this automatically on startup and migrates an existing
-- single-department database in place (it only ever CREATEs / ADDs — never drops or truncates).
-- Running this file by hand is optional: it is the target schema for a brand-new database.
-- Requires MySQL 5.7+/8 or MariaDB 10.2+ (stored generated columns).

CREATE DATABASE IF NOT EXISTS vit_cse_ai_calendar CHARACTER SET utf8mb4;
USE vit_cse_ai_calendar;

-- Legacy single-admin table. No longer read by the app; kept so old data is never lost
-- (its rows are copied into `users` on first start). Safe to drop once you've upgraded.
CREATE TABLE IF NOT EXISTS admins (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  salt          VARCHAR(255) NOT NULL,
  UNIQUE KEY uq_admins_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The five departments. Names/abbreviations live here, not in code: edit a row to rename one.
CREATE TABLE IF NOT EXISTS departments (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(30)  NOT NULL,
  slug        VARCHAR(40)  NOT NULL,            -- used in URLs: /d/<slug>
  short_name  VARCHAR(40)  NOT NULL,            -- e.g. CSE (AI)
  full_name   VARCHAR(255) NOT NULL,            -- e.g. Computer Science and Engineering (Artificial Intelligence)
  file_code   VARCHAR(40)  NOT NULL,            -- used in export filenames, e.g. CSE_AI
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_departments_code (code),
  UNIQUE KEY uq_departments_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Login accounts. super_admin and central_admin have no department; dept_admin must have one.
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,          -- scrypt
  salt          VARCHAR(255) NOT NULL,
  role          ENUM('super_admin','central_admin','dept_admin') NOT NULL,
  department_id INT NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL,
  UNIQUE KEY uq_users_username (username),
  KEY idx_users_department (department_id),
  CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments (id),
  CONSTRAINT ck_users_role_scope CHECK ((role = 'dept_admin' AND department_id IS NOT NULL) OR (role <> 'dept_admin' AND department_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Predefined + custom categories. department_id NULL = Central calendar.
-- scope_key folds NULL into 0 so "unique per calendar" also works for Central
-- (UNIQUE ignores NULLs). The same name may exist once per calendar, independently.
-- Custom categories have slug NULL; only predefined ones carry a slug (it drives the
-- Future Ready Saturday / Department Meetings / Guest Lecture form behaviour).
CREATE TABLE IF NOT EXISTS event_categories (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  department_id INT NULL,
  slug          VARCHAR(100) NULL,
  name          VARCHAR(100) NOT NULL,
  name_key      VARCHAR(100) NOT NULL,          -- lower-cased, whitespace-collapsed name for duplicate checks
  color         VARCHAR(9) NOT NULL DEFAULT '#6B7280',
  is_predefined TINYINT(1) NOT NULL DEFAULT 0,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,  -- deactivating hides it from new events; old events keep it
  created_by    VARCHAR(100) DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  scope_key     INT GENERATED ALWAYS AS (IFNULL(department_id, 0)) STORED,
  UNIQUE KEY uq_categories_scope_name (scope_key, name_key),
  UNIQUE KEY uq_categories_scope_slug (scope_key, slug),
  KEY idx_categories_department (department_id),
  CONSTRAINT fk_categories_department FOREIGN KEY (department_id) REFERENCES departments (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Events. `section` holds the calendar type ('central' | 'department').
-- Central events have department_id NULL; department events always have one (ck_events_scope).
-- `category` is the original text column, still written (slug or name) for backwards compatibility;
-- category_id is authoritative.
CREATE TABLE IF NOT EXISTS events (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  title              VARCHAR(255) NOT NULL,
  date               DATE NOT NULL,
  time               VARCHAR(50) DEFAULT '',
  venue              VARCHAR(255) DEFAULT '',
  description        TEXT,
  section            VARCHAR(20) NOT NULL DEFAULT 'central',
  department_id      INT NULL,
  category           VARCHAR(100) NOT NULL,
  category_id        INT NULL,
  schedule           VARCHAR(100) DEFAULT '',   -- recurrence label: 'Every Saturday' / 'Every Friday' / ''
  guest_name         VARCHAR(255) DEFAULT '',
  meeting_agenda     TEXT,
  additional_details TEXT,
  created_by         VARCHAR(100) DEFAULT NULL,
  created_by_user_id INT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_events_date (date),
  KEY idx_events_category (category),
  KEY idx_events_category_id (category_id),
  KEY idx_events_scope_date (department_id, date),
  CONSTRAINT fk_events_category   FOREIGN KEY (category_id)   REFERENCES event_categories (id),
  CONSTRAINT fk_events_department FOREIGN KEY (department_id) REFERENCES departments (id),
  CONSTRAINT ck_events_scope CHECK ((section = 'central' AND department_id IS NULL) OR (section = 'department' AND department_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reminders (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  event_id      INT NOT NULL,
  user_email    VARCHAR(255) NOT NULL,
  remind_before VARCHAR(50) DEFAULT '1 day',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_reminders_event (event_id),
  CONSTRAINT fk_reminders_event FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mail book, one per calendar (department_id NULL = Central).
CREATE TABLE IF NOT EXISTS contacts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  label         VARCHAR(100) DEFAULT NULL,
  department_id INT NULL,
  scope_key     INT GENERATED ALWAYS AS (IFNULL(department_id, 0)) STORED,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contacts_scope_email (scope_key, email),
  CONSTRAINT fk_contacts_department FOREIGN KEY (department_id) REFERENCES departments (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
