#!/usr/bin/env node
/**
 * Account management from the command line (uses the same .env / database as the app).
 *
 *   node scripts/manage-users.js list
 *   node scripts/manage-users.js create <username> <super_admin|central_admin|dept_admin> [department-slug]
 *   node scripts/manage-users.js reset-password <username>
 *   node scripts/manage-users.js deactivate <username>
 *   node scripts/manage-users.js activate <username>
 *
 * Passwords are generated and printed once unless you pass NEW_PASSWORD=... (min 10 characters).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const { hashPassword, randomPassword } = require('../server/util');

const [cmd, a, b, c] = process.argv.slice(2);
const ROLES = ['super_admin', 'central_admin', 'dept_admin'];

(async () => {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'vit_cse_ai_calendar'
  });
  const q = async (sql, p) => (await db.query(sql, p))[0];
  const pw = () => { const p = process.env.NEW_PASSWORD || randomPassword(); if (p.length < 10) throw new Error('Password must be at least 10 characters.'); return p; };

  try {
    if (cmd === 'list') {
      const rows = await q('SELECT u.username, u.role, d.short_name AS department, u.is_active, u.last_login_at FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.role, u.username');
      console.table(rows.map((r) => ({ username: r.username, role: r.role, department: r.department || '-', active: !!r.is_active, lastLogin: r.last_login_at || 'never' })));
    } else if (cmd === 'create') {
      if (!a || !ROLES.includes(b)) throw new Error('Usage: create <username> <super_admin|central_admin|dept_admin> [department-slug]');
      if (!/^[A-Za-z0-9._-]{3,50}$/.test(a)) throw new Error('Username must be 3-50 characters: letters, numbers, dot, dash, underscore.');
      let deptId = null;
      if (b === 'dept_admin') {
        const d = (await q('SELECT id FROM departments WHERE slug = ?', [c || '']))[0];
        if (!d) throw new Error(`dept_admin needs a valid department slug (cse, cse-ai, it, cse-aiml, aids). Got "${c || ''}".`);
        deptId = d.id;
      } else if (c) throw new Error(`${b} accounts are not tied to a department.`);
      const password = pw(); const { hash, salt } = hashPassword(password);
      await q('INSERT INTO users (username, password_hash, salt, role, department_id) VALUES (?, ?, ?, ?, ?)', [a, hash, salt, b, deptId]);
      console.log(`Created ${b} "${a}". Password (shown once): ${password}`);
    } else if (cmd === 'reset-password') {
      if (!a) throw new Error('Usage: reset-password <username>');
      const password = pw(); const { hash, salt } = hashPassword(password);
      const r = await q('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?', [hash, salt, a]);
      if (!r.affectedRows) throw new Error(`No such user: ${a}`);
      console.log(`Password for "${a}" reset. New password (shown once): ${password}`);
    } else if (cmd === 'deactivate' || cmd === 'activate') {
      if (!a) throw new Error(`Usage: ${cmd} <username>`);
      if (cmd === 'deactivate') {
        const u = (await q('SELECT role, is_active FROM users WHERE username = ?', [a]))[0];
        const supers = Number((await q("SELECT COUNT(*) n FROM users WHERE role = 'super_admin' AND is_active = 1"))[0].n);
        if (u && u.role === 'super_admin' && u.is_active && supers <= 1) throw new Error('Refusing to deactivate the last active super administrator.');
      }
      const r = await q('UPDATE users SET is_active = ? WHERE username = ?', [cmd === 'activate' ? 1 : 0, a]);
      if (!r.affectedRows) throw new Error(`No such user: ${a}`);
      console.log(`${cmd}d "${a}".`);
    } else {
      console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
      process.exitCode = 1;
    }
  } finally { await db.end(); }
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
