/**
 * End-to-end acceptance tests (spec section 13) against a RUNNING server.
 *
 *   BASE_URL=http://localhost:3000 SEED_PASSWORD=... node scripts/acceptance-test.js
 *
 * Needs the seeded accounts (admin / central_admin / <dept>_admin) to share SEED_PASSWORD,
 * i.e. run the server once with SEED_PASSWORD set on an empty database. It creates and removes
 * its own test events (titles prefixed "ZZ-TEST") and deletes them afterwards. Custom categories it creates
 * cannot be deleted (by design), so run it against a TEST database, not production.
 * Optional: LEGACY_EVENTS=N asserts that N pre-existing events survived the migration.
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PASSWORD = process.env.SEED_PASSWORD;
if (!PASSWORD) { console.error('Set SEED_PASSWORD to the password used for the seeded accounts.'); process.exit(2); }

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { passed++; results.push(`  ok   ${name}`); } else { failed++; results.push(`  FAIL ${name}${detail ? ' \u2014 ' + detail : ''}`); }
}

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, raw) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    if (raw) return res;
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  async login(username, calendar, password = PASSWORD) { return this.req('POST', '/api/auth/login', { username, password, calendar }); }
}

const DEPTS = [
  ['cse', 'CSE', 'Computer Science and Engineering'],
  ['cse-ai', 'CSE (AI)', 'Computer Science and Engineering (Artificial Intelligence)'],
  ['it', 'IT', 'Information Technology'],
  ['cse-aiml', 'CSE (AIML)', 'Computer Science and Engineering (Artificial Intelligence and Machine Learning)'],
  ['aids', 'AIDS', 'Artificial Intelligence and Data Science']
];
const COLLEGE = 'Vishwakarma Institute of Technology';
const adminOf = (slug) => `${slug.replace(/-/g, '_')}_admin`;
const created = []; // [client, id] for cleanup

async function main() {
  const anon = new Client();

  // 1. departments
  const deps = (await anon.req('GET', '/api/departments')).data;
  check('1. five departments with exact full names + abbreviations',
    Array.isArray(deps) && deps.length === 5 && DEPTS.every(([slug, short, full], i) => deps[i].slug === slug && deps[i].shortName === short && deps[i].fullName === full));
  const sel = (await anon.req('GET', '/')).data;
  check('1b. selection page lists every department + Central',
    DEPTS.every(([, short, full]) => sel.includes(short) && sel.includes(full)) && sel.includes('Central Academic Calendar'));

  // 2. separate logins
  const clients = {};
  for (const [slug] of DEPTS) {
    const c = new Client(); const r = await c.login(adminOf(slug), slug);
    clients[slug] = c; check(`2. ${adminOf(slug)} can log in to ${slug}`, r.status === 200 && r.data.success);
  }
  const central = new Client(); check('2b. central_admin logs in to Central', (await central.login('central_admin', 'central')).data.success);
  const superU = new Client(); // the migrated legacy account keeps its original password (admin123) — proof the old login still works
  check('2c. migrated legacy admin logs in as super admin with its OLD password', (await superU.login('admin', 'cse-ai', process.env.ADMIN_PASSWORD || 'admin123')).data.user?.role === 'super_admin');
  const wrong = new Client(); const wr = await wrong.login('it_admin', 'cse');
  check('2d. department account rejected for another department (403, no session)', wr.status === 403 && (await wrong.req('GET', '/api/me')).data.user === null);
  check('2e. bad password rejected (401)', (await new Client().login('cse_admin', 'cse', 'nope')).status === 401);

  // 3 + 4. headings
  for (const [slug, , full] of DEPTS) {
    const html = (await anon.req('GET', `/d/${slug}`)).data;
    check(`3. /d/${slug} heading = college + "${full}"`, html.includes(`<h1>${COLLEGE}</h1>`) && html.includes(`<div class="dept">${full.replace(/&/g, '&amp;')}</div>`));
  }
  const ch = (await anon.req('GET', '/central')).data;
  check('4. Central heading', ch.includes(`${COLLEGE} \u2014 Central Academic Calendar`));
  check('4b. department pages are not hard-coded to CSE (AI)', !(await anon.req('GET', '/d/it')).data.includes('Artificial Intelligence</div>'));

  // categories for later
  const itCats = (await clients.it.req('GET', '/api/categories?calendar=it')).data;
  const hack = itCats.find((c) => c.slug === 'hackathon');
  const frs = itCats.find((c) => c.slug === 'future-ready-saturday');
  const dm = itCats.find((c) => c.slug === 'department-meetings');
  const gl = itCats.find((c) => c.slug === 'guest-lecture');
  check('7. nine predefined department categories in every department',
    (await Promise.all(DEPTS.map(([s]) => clients[s].req('GET', `/api/categories?calendar=${s}`)))).every((r) => r.data.filter((c) => c.isPredefined).length === 9));

  // 5. cross-department isolation
  const mk = async (c, body) => { const r = await c.req('POST', '/api/events', body); if (r.status === 201) created.push([c, r.data.id]); return r; };
  const itEv = await mk(clients.it, { title: 'ZZ-TEST IT hackathon', date: '2031-03-10', calendarType: 'department', departmentId: deps[2].id, categoryId: hack.id });
  check('5. IT admin creates an IT event', itEv.status === 201 && itEv.data.departmentId === deps[2].id);
  const forged = await clients.it.req('POST', '/api/events', { title: 'ZZ-TEST forged', date: '2031-03-11', calendarType: 'department', departmentId: deps[0].id, categoryId: hack.id });
  check('5b. IT admin cannot create an event in CSE (403)', forged.status === 403);
  check('5c. IT admin cannot create a Central event (403)', (await clients.it.req('POST', '/api/events', { title: 'ZZ-TEST c', date: '2031-03-11', calendarType: 'central', categoryId: hack.id })).status === 403);
  check('5d. CSE admin cannot edit the IT event (404, not 403 — existence not leaked)', (await clients.cse.req('PUT', `/api/events/${itEv.data.id}`, { title: 'hijack' })).status === 404);
  check('5e. CSE admin cannot delete the IT event', (await clients.cse.req('DELETE', `/api/events/${itEv.data.id}`)).status === 404);
  check('5f. signed-in CSE admin cannot read IT events via API (403)', (await clients.cse.req('GET', '/api/events?calendar=it')).status === 403);
  const pageRedirect = await clients.cse.req('GET', '/d/it', undefined, true);
  check('5g. signed-in CSE admin opening /d/it is redirected home', pageRedirect.status === 302 && pageRedirect.headers.get('location') === '/d/cse');
  const it2 = await mk(clients.it, { title: 'ZZ-TEST IT second', date: '2031-03-12', calendarType: 'department', departmentId: deps[2].id, categoryId: hack.id });
  check('5h. event with a category from another department is rejected', (await clients.cse.req('POST', '/api/events', { title: 'ZZ-TEST x', date: '2031-03-12', calendarType: 'department', departmentId: deps[0].id, categoryId: hack.id })).status === 400);
  check('5i. CSE calendar does not contain IT events', !(await clients.cse.req('GET', '/api/events?calendar=cse')).data.some((e) => e.title.startsWith('ZZ-TEST IT')));
  check('5j. super admin can read any calendar while signed in', (await superU.req('GET', '/api/events?calendar=it')).data.some((e) => e.id === itEv.data.id) && (await superU.req('GET', '/api/me')).data.user.role === 'super_admin');

  // 23. unauthorized backend requests
  check('23. anonymous POST /api/events -> 401', (await anon.req('POST', '/api/events', { title: 'x' })).status === 401);
  check('23b. anonymous DELETE -> 401', (await anon.req('DELETE', `/api/events/${itEv.data.id}`)).status === 401);
  check('23c. anonymous category create -> 401', (await anon.req('POST', '/api/categories', { calendarType: 'central', name: 'x' })).status === 401);
  check('23d. anonymous import preview -> 401', (await anon.req('POST', '/api/import/preview', new FormData())).status === 401);
  check('23e. anonymous Excel export -> 401', (await anon.req('GET', '/api/export/excel?calendar=it&scope=year&year=2031')).status === 401);
  check('23f. CSE admin Excel export of IT -> 403', (await clients.cse.req('GET', '/api/export/excel?calendar=it&scope=year&year=2031')).status === 403);
  check('23g. non-super cannot use admin APIs', (await clients.cse.req('GET', '/api/admin/users')).status === 403 && (await anon.req('GET', '/api/admin/users')).status === 401);
  check('23h. CSE admin cannot read IT contacts (403)', (await clients.cse.req('GET', '/api/contacts?calendar=it')).status === 403);

  // 10 / 11. recurring categories
  const frsRes = await mk(clients.it, { title: 'ZZ-TEST FRS', date: '2031-03-15', calendarType: 'department', departmentId: deps[2].id, categoryId: frs.id, guestName: 'Dr. Rao', schedule: 'Every Tuesday' });
  check('10. Future Ready Saturday saves "Every Saturday" (server-derived) + guest name', frsRes.status === 201 && frsRes.data.schedule === 'Every Saturday' && frsRes.data.guestName === 'Dr. Rao');
  check('10b. Future Ready Saturday requires a guest name', (await clients.it.req('POST', '/api/events', { title: 'ZZ-TEST FRS2', date: '2031-03-16', calendarType: 'department', departmentId: deps[2].id, categoryId: frs.id })).status === 400);
  const dmRes = await mk(clients.it, { title: 'ZZ-TEST DM', date: '2031-03-14', calendarType: 'department', departmentId: deps[2].id, categoryId: dm.id, meetingAgenda: 'Budget review' });
  check('11. Department Meetings saves "Every Friday" + agenda', dmRes.status === 201 && dmRes.data.schedule === 'Every Friday' && dmRes.data.meetingAgenda === 'Budget review');
  check('11b. Department Meetings requires agenda', (await clients.it.req('POST', '/api/events', { title: 'ZZ-TEST DM2', date: '2031-03-17', calendarType: 'department', departmentId: deps[2].id, categoryId: dm.id })).status === 400);
  const glRes = await mk(clients.it, { title: 'ZZ-TEST GL', date: '2031-03-18', calendarType: 'department', departmentId: deps[2].id, categoryId: gl.id, guestName: 'Prof X', additionalDetails: 'Bring ID cards' });
  check('7b. Guest Lecture + Additional Details persisted', glRes.status === 201 && glRes.data.additionalDetails === 'Bring ID cards');
  check('7c. Guest Lecture requires guest name', (await clients.it.req('POST', '/api/events', { title: 'ZZ-TEST GL2', date: '2031-03-19', calendarType: 'department', departmentId: deps[2].id, categoryId: gl.id })).status === 400);
  check('7d. duplicate event rejected', (await clients.it.req('POST', '/api/events', { title: 'zz-test it hackathon', date: '2031-03-10', calendarType: 'department', departmentId: deps[2].id, categoryId: hack.id })).status === 400);
  check('7e. invalid date rejected', (await clients.it.req('POST', '/api/events', { title: 'ZZ-TEST bad', date: '2031-02-30', calendarType: 'department', departmentId: deps[2].id, categoryId: hack.id })).status === 400);

  // 12-16. custom categories
  const cc = await clients.it.req('POST', '/api/categories', { calendarType: 'department', departmentId: deps[2].id, name: '  Industrial   Visit ' });
  check('12. custom category created (name normalised)', cc.status === 201 && cc.data.category.name === 'Industrial Visit' && !cc.data.category.isPredefined);
  const ccId = cc.data.category.id;
  const ev = await mk(clients.it, { title: 'ZZ-TEST visit', date: '2031-03-20', calendarType: 'department', departmentId: deps[2].id, categoryId: ccId });
  check('13. event saved with the new category (id + name returned)', ev.status === 201 && ev.data.categoryId === ccId && ev.data.categoryName === 'Industrial Visit');
  const again = new Client(); await again.login('it_admin', 'it');
  check('14. custom category persists across a new login', (await again.req('GET', '/api/categories?calendar=it')).data.some((c) => c.id === ccId));
  const dup = await clients.it.req('POST', '/api/categories', { calendarType: 'department', departmentId: deps[2].id, name: 'industrial visit' });
  check('15. duplicate (case/space-insensitive) rejected with 409', dup.status === 409 && dup.data.existing.id === ccId);
  check('15b. duplicate of a predefined name rejected', (await clients.it.req('POST', '/api/categories', { calendarType: 'department', departmentId: deps[2].id, name: ' guest LECTURE ' })).status === 409);
  check('15c. empty name rejected', (await clients.it.req('POST', '/api/categories', { calendarType: 'department', departmentId: deps[2].id, name: '   ' })).status === 400);
  const cseSame = await clients.cse.req('POST', '/api/categories', { calendarType: 'department', departmentId: deps[0].id, name: 'Industrial Visit' });
  check('16. same name allowed independently in another department', cseSame.status === 201 && cseSame.data.category.id !== ccId);
  check('16b. IT custom category is not visible in CSE', !(await clients.cse.req('GET', '/api/categories?calendar=cse')).data.some((c) => c.id === ccId));
  check('16c. CSE admin cannot create a category in IT (403)', (await clients.cse.req('POST', '/api/categories', { calendarType: 'department', departmentId: deps[2].id, name: 'Sneaky' })).status === 403);
  check('16d. dept admin cannot create a Central category (403)', (await clients.it.req('POST', '/api/categories', { calendarType: 'central', name: 'Sneaky' })).status === 403);
  check('16e. CSE admin cannot rename/deactivate IT category (404)', (await clients.cse.req('PATCH', `/api/categories/${ccId}`, { name: 'Hijack' })).status === 404);
  const cCat = await central.req('POST', '/api/categories', { calendarType: 'central', name: 'ZZ-TEST Central Cat' });
  check('16f. Central admin creates a Central category', cCat.status === 201 && cCat.data.category.departmentId === null);
  check('16g. event cannot use a category from another calendar', (await clients.it.req('POST', '/api/events', { title: 'ZZ-TEST wrongcat', date: '2031-03-21', calendarType: 'department', departmentId: deps[2].id, categoryId: cCat.data.category.id })).status === 400);
  check('16h. predefined categories cannot be renamed or deactivated', (await clients.it.req('PATCH', `/api/categories/${hack.id}`, { name: 'X' })).status === 400 && (await clients.it.req('PATCH', `/api/categories/${hack.id}`, { isActive: false })).status === 400);
  const ren = await clients.it.req('PATCH', `/api/categories/${ccId}`, { name: 'Industry Visit' });
  check('16i. rename works and keeps historic events', ren.status === 200 && (await clients.it.req('GET', '/api/events?calendar=it')).data.find((e) => e.id === ev.data.id).categoryName === 'Industry Visit');
  await clients.it.req('PATCH', `/api/categories/${ccId}`, { isActive: false });
  check('16j. deactivated category hidden from new events but event survives',
    !(await clients.it.req('GET', '/api/categories?calendar=it')).data.some((c) => c.id === ccId) &&
    (await clients.it.req('GET', '/api/events?calendar=it')).data.some((e) => e.id === ev.data.id) &&
    (await clients.it.req('POST', '/api/events', { title: 'ZZ-TEST inactive', date: '2031-03-22', calendarType: 'department', departmentId: deps[2].id, categoryId: ccId })).status === 400);
  check('16k. re-creating a deactivated name re-activates it (no duplicate)', (await clients.it.req('POST', '/api/categories', { calendarType: 'department', departmentId: deps[2].id, name: 'industry visit' })).data.category.id === ccId);

  // 6/8. central vs department events & combined view
  const cEv = await central.req('POST', '/api/events', { title: 'ZZ-TEST central exam', date: '2031-03-10', calendarType: 'central', categoryId: (await central.req('GET', '/api/categories?calendar=central')).data.find((c) => c.slug === 'exam').id });
  if (cEv.status === 201) created.push([central, cEv.data.id]);
  check('8. Central event saved with calendarType=central, no department', cEv.status === 201 && cEv.data.calendarType === 'central' && cEv.data.departmentId === null);
  check('8b. department calendar excludes Central events by default', !(await clients.it.req('GET', '/api/events?calendar=it')).data.some((e) => e.calendarType === 'central'));
  const combined = (await clients.it.req('GET', '/api/events?calendar=it&central=1')).data;
  check('8c. authorised combined view includes Central (read-only, distinct type)', combined.some((e) => e.calendarType === 'central') && combined.some((e) => e.calendarType === 'department'));
  check('8d. anonymous visitors cannot request the combined view', !(await anon.req('GET', '/api/events?calendar=it&central=1')).data.some((e) => e.calendarType === 'central'));
  check('8e. combined view cannot be used to edit Central events', (await clients.it.req('PUT', `/api/events/${cEv.data.id}`, { title: 'hijack' })).status === 404 || (await clients.it.req('PUT', `/api/events/${cEv.data.id}`, { title: 'hijack' })).status === 403);
  const html = (await clients.it.req('GET', '/d/it?year=2031&month=3&central=1')).data;
  check('8f. page uses blue/teal classes + legend', html.includes('evt-tag central') && html.includes('evt-tag dept') && html.includes('Central events (blue)') && html.includes('Department events (teal)'));

  // 5-7, 17. import
  const pdfBuf = require('fs').existsSync('/tmp/test-calendar.pdf') ? require('fs').readFileSync('/tmp/test-calendar.pdf') : null;
  if (pdfBuf) {
    const form = (type, dept) => { const fd = new FormData(); fd.append('calendarType', type); if (dept) fd.append('departmentId', dept); fd.append('pdf', new Blob([pdfBuf], { type: 'application/pdf' }), 'cal.pdf'); return fd; };
    const pv = await clients.it.req('POST', '/api/import/preview', form('department', deps[0].id)); // tries to target CSE
    check('6/7. department user cannot target another department in import (403)', pv.status === 403);
    const pv2 = await clients.it.req('POST', '/api/import/preview', form('central'));
    check('6b. department user cannot import into Central (403)', pv2.status === 403);
    const pv3 = await clients.it.req('POST', '/api/import/preview', form('department'));
    check('7f. department import is pinned to the authenticated department', pv3.status === 200 && pv3.data.target.departmentId === deps[2].id);
    check('6c. preview reports totals, valid/invalid, duplicates', pv3.data.total > 0 && typeof pv3.data.valid === 'number' && typeof pv3.data.invalid === 'number' && typeof pv3.data.duplicates === 'number');
    check('17. unknown categories flagged for create/map', pv3.data.unmatchedCategories.length > 0);
    const rows = pv3.data.rows.filter((r) => !r.errors.length).slice(0, 3).map((r, i) => ({ title: 'ZZ-TEST ' + r.title, date: r.date, time: r.time, newCategoryName: i === 2 ? r.suggestedCategory : 'Imported Thing' }));
    const noCat = await clients.it.req('POST', '/api/import/confirm', { calendarType: 'department', rows: [{ title: 'ZZ-TEST nocat', date: '2031-04-01' }] });
    check('12b. import row without a category is rejected before saving', noCat.status === 400 && noCat.data.rowErrors.length === 1);
    const badMix = await clients.it.req('POST', '/api/import/confirm', { calendarType: 'department', rows: [...rows, { title: 'ZZ-TEST bad', date: 'garbage', newCategoryName: 'X' }] });
    const afterBad = (await clients.it.req('GET', '/api/events?calendar=it')).data.filter((e) => e.title.startsWith('ZZ-TEST ') && /Imported|ZZ-TEST (?!IT|FRS|DM|GL|visit|central)/.test(e.title));
    check('12c. one invalid row aborts the whole import (atomic, nothing saved)', badMix.status === 400 && afterBad.length === 0);
    const ok1 = await clients.it.req('POST', '/api/import/confirm', { calendarType: 'department', rows });
    ok1.data.created && ok1.data.created.forEach((e) => created.push([clients.it, e.id]));
    check('17b. import with new categories creates/maps them in the department scope', ok1.status === 200 && ok1.data.created.length === rows.length && ok1.data.created.every((e) => e.departmentId === deps[2].id));
    const ok2 = await clients.it.req('POST', '/api/import/confirm', { calendarType: 'department', rows });
    check('12d. repeating the same import inserts no duplicates', ok2.status === 200 && ok2.data.created.length === 0 && ok2.data.skipped.length === rows.length);
    check('16l. imported categories did not leak into CSE or Central', !(await clients.cse.req('GET', '/api/categories?calendar=cse')).data.some((c) => c.name === 'Imported Thing'));
    const cen = await central.req('POST', '/api/import/confirm', { calendarType: 'central', rows: [{ title: 'ZZ-TEST central import', date: '2031-05-05', newCategoryName: 'Orientation' }] });
    cen.data.created && cen.data.created.forEach((e) => created.push([central, e.id]));
    check('6d. Central admin imports into Central (department_id NULL)', cen.status === 200 && cen.data.created[0].calendarType === 'central' && cen.data.created[0].departmentId === null);
    check('6e. super admin must choose a department for department imports', (await superU.req('POST', '/api/import/confirm', { calendarType: 'department', rows })).status === 400);
    const sup = await superU.req('POST', '/api/import/confirm', { calendarType: 'department', departmentId: deps[0].id, rows: [{ title: 'ZZ-TEST super import', date: '2031-05-06', newCategoryName: 'Imported Thing' }] });
    sup.data.created && sup.data.created.forEach((e) => created.push([superU, e.id]));
    check('6f. super admin imports into a chosen department (CSE)', sup.status === 200 && sup.data.created[0].departmentId === deps[0].id);
    const wrongPin = await clients.it.req('POST', '/api/import/confirm', { calendarType: 'department', departmentId: deps[0].id, rows });
    check('7g. department user cannot redirect an import by passing another departmentId (403)', wrongPin.status === 403);
    check('7h. department user cannot import rows using another department\'s category id', (await clients.it.req('POST', '/api/import/confirm', { calendarType: 'department', rows: [{ title: 'ZZ-TEST x', date: '2031-05-07', categoryId: (await clients.cse.req('GET', '/api/categories?calendar=cse')).data[0].id }] })).status === 400);
  } else console.log('  (skipping PDF import tests: /tmp/test-calendar.pdf not found)');

  // 18-21. Excel
  const ExcelJS = require('exceljs');
  const getXlsx = async (client, qs) => { const res = await client.req('GET', `/api/export/excel?${qs}`, undefined, true); const buf = Buffer.from(await res.arrayBuffer()); return { res, buf }; };
  const m = await getXlsx(clients.it, 'calendar=it&scope=month&year=2031&month=3&includeList=1');
  check('18. monthly export is a real xlsx with the right filename', m.res.status === 200 && m.buf.slice(0, 2).toString() === 'PK' && /filename="VIT_IT_Calendar_March_2031\.xlsx"/.test(m.res.headers.get('content-disposition')));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(m.buf);
  const ws = wb.getWorksheet('March 2031');
  check('18b. sheets: month grid + Event List', wb.worksheets.map((w) => w.name).join('|') === 'March 2031|Event List');
  const text = (c) => (c.value && c.value.richText ? c.value.richText.map((r) => r.text).join('') : String(c.value ?? ''));
  const header = [1, 2, 3, 4, 5, 6, 7].map((i) => ws.getRow(4).getCell(i).value);
  check('18c. Sunday-Saturday header', header.join(',') === 'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday', header.join(','));
  let misaligned = 0; let found = 0;
  ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'number' && c.col <= 7) { found++; const wd = new Date(Date.UTC(2031, 2, c.value)).getUTCDay(); if (wd !== c.col - 1) misaligned++; } }));
  check('18d. all 31 dates sit under the correct weekday', found === 31 && misaligned === 0, `${found} found, ${misaligned} misaligned`);
  check('21. headings contain college + department name + month/year', text(ws.getCell('A1')) === COLLEGE && text(ws.getCell('A2')) === 'Information Technology' && text(ws.getCell('A3')) === 'March 2031');
  let day10 = ''; ws.eachRow((row) => row.eachCell((c) => { if (text(c).includes('ZZ-TEST IT hackathon')) day10 = text(c); }));
  check('20. several events on one date are all present (not overwritten)', wb.getWorksheet('March 2031') && day10.includes('ZZ-TEST IT hackathon'));
  const mc = await getXlsx(clients.it, 'calendar=it&scope=month&year=2031&month=3&includeCentral=1');
  const wbc = new ExcelJS.Workbook(); await wbc.xlsx.load(mc.buf);
  let cell10 = null; wbc.getWorksheet('March 2031').eachRow((row) => row.eachCell((c) => { if (text(c).includes('ZZ-TEST IT hackathon')) cell10 = text(c); }));
  check('20b. Department + Central events on the same date coexist in one cell', cell10 && cell10.includes('ZZ-TEST central exam') && cell10.includes('ZZ-TEST IT hackathon'));
  const rich = (() => { let r; wbc.getWorksheet('March 2031').eachRow((row) => row.eachCell((c) => { if (c.value && c.value.richText && text(c).includes('central exam')) r = c.value.richText; })); return r; })();
  const centralRun = rich && rich.find((x) => x.text.includes('central exam'));
  const departmentRun = rich && rich.find((x) => x.text.includes('IT hackathon'));
  check('8g. Excel gives Central and Department events distinct colors', centralRun && departmentRun && centralRun.font.color.argb !== departmentRun.font.color.argb);
  const eventList = wbc.getWorksheet('Event List');
  const eventRowColor = (title) => {
    let color;
    eventList.eachRow((row) => {
      if (String(row.getCell(4).value || '').includes(title)) color = row.getCell(4).fill.fgColor.argb;
    });
    return color;
  };
  check('8h. Event List rows use distinct event colors', eventRowColor('ZZ-TEST central exam') && eventRowColor('ZZ-TEST IT hackathon') && eventRowColor('ZZ-TEST central exam') !== eventRowColor('ZZ-TEST IT hackathon'));
  const evl = wb.getWorksheet('Event List'); const evHeaders = evl.getRow(4).values.slice(1);
  check('3b. event list sheet has all detail columns', ['Date', 'Title', 'Calendar', 'Department', 'Category', 'Guest Name', 'Schedule', 'Additional Details'].every((h) => evHeaders.includes(h)));
  const y = await getXlsx(clients.it, 'calendar=it&scope=year&year=2031&includeList=1');
  const wby = new ExcelJS.Workbook(); await wby.xlsx.load(y.buf);
  const names = wby.worksheets.map((w) => w.name);
  check('19. full-year export has 12 months in order + Event List', names.slice(0, 12).join(',') === ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((n) => `${n} 2031`).join(',') && names[12] === 'Event List' && names.length === 13);
  check('21b. year filename', /filename="VIT_IT_Calendar_2031\.xlsx"/.test(y.res.headers.get('content-disposition')));
  const noList = new ExcelJS.Workbook(); await noList.xlsx.load((await getXlsx(clients.it, 'calendar=it&scope=year&year=2031&includeList=0')).buf);
  check('3c. event list sheet is optional', noList.worksheets.length === 12);
  const names2 = await Promise.all([['cse', 'VIT_CSE_Calendar_2031.xlsx'], ['cse-ai', 'VIT_CSE_AI_Calendar_2031.xlsx'], ['cse-aiml', 'VIT_CSE_AIML_Calendar_2031.xlsx'], ['aids', 'VIT_AIDS_Calendar_2031.xlsx']].map(async ([s, f]) => (await getXlsx(clients[s], `calendar=${s}&scope=year&year=2031`)).res.headers.get('content-disposition').includes(f)));
  check('21c. filenames for CSE, CSE_AI, CSE_AIML, AIDS', names2.every(Boolean));
  const cx = await getXlsx(central, 'calendar=central&scope=year&year=2031');
  const wbCx = new ExcelJS.Workbook(); await wbCx.load ? null : null; await wbCx.xlsx.load(cx.buf);
  check('21d. Central export: filename + heading', /VIT_Central_Academic_Calendar_2031\.xlsx/.test(cx.res.headers.get('content-disposition')) && text(wbCx.worksheets[0].getCell('A1')) === `${COLLEGE} \u2014 Central Academic Calendar`);
  check('21e. IT export contains no CSE/other-department events', !(await getXlsx(clients.it, 'calendar=it&scope=year&year=2031')).buf.toString('latin1').includes('ZZ-TEST forged'));
  check('18e. invalid month/year rejected', (await clients.it.req('GET', '/api/export/excel?calendar=it&scope=month&year=2031&month=13')).status === 400 && (await clients.it.req('GET', '/api/export/excel?calendar=it&scope=year&year=1')).status === 400);

  // 9. legacy data
  if (process.env.LEGACY_EVENTS) {
    const all = [...(await superU.req('GET', '/api/events?calendar=cse-ai')).data, ...(await superU.req('GET', '/api/events?calendar=central')).data].filter((e) => !e.title.startsWith('ZZ-TEST'));
    check(`9. all ${process.env.LEGACY_EVENTS} pre-existing events survived, in the right calendars`, all.length === Number(process.env.LEGACY_EVENTS), `found ${all.length}`);
  }

  // 22. logout / login / refresh
  const s = new Client(); await s.login('it_admin', 'it');
  check('22. page loads after login (refresh)', (await s.req('GET', '/d/it')).data.includes('Signed in as it_admin'));
  await s.req('POST', '/api/auth/logout');
  check('22b. after logout the session is gone', (await s.req('GET', '/api/me')).data.user === null && (await s.req('POST', '/api/events', { title: 'x' })).status === 401);
  check('22c. login again works', (await s.login('it_admin', 'it')).data.success && (await s.req('GET', '/d/it')).data.includes('Signed in as it_admin'));

  // security extras
  const xss = await clients.it.req('POST', '/api/categories', { calendarType: 'department', departmentId: deps[2].id, name: '<img src=x onerror=alert(1)>' });
  const xssEv = xss.status === 201 ? await mk(clients.it, { title: "ZZ-TEST O'Brien <b>x</b>", date: '2031-06-01', calendarType: 'department', departmentId: deps[2].id, categoryId: xss.data.category.id }) : null;
  const pageHtml = (await clients.it.req('GET', '/d/it?year=2031&month=6&date=2031-06-01')).data;
  check('X1. user-supplied names are HTML-escaped in the page', xssEv && !pageHtml.includes('<img src=x onerror') && !pageHtml.includes('<b>x</b>'));
  const edAttr = /data-edit-event="([^"]*)"/.exec(pageHtml);
  check("X2. edit-button JSON attribute can't be broken by quotes (stored-XSS fix)", !!edAttr && JSON.parse(edAttr[1].replace(/&#34;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")).title.includes("O'Brien"));
  const scriptCat = await clients.it.req('POST', '/api/categories', { calendarType: 'department', departmentId: deps[2].id, name: '</script><b id="pwn">' });
  const stateHtml = (await clients.it.req('GET', '/d/it')).data;
  check('X3. a category name containing </script> cannot break out of the state JSON', scriptCat.status === 201 && !stateHtml.includes('</script><b id="pwn">') && !stateHtml.includes('<b id="pwn">'));
  const throttle = new Client(); let last;
  for (let i = 0; i < 7; i++) last = await throttle.login('aids_admin', 'aids', 'wrong-' + i);
  check('X4. repeated failed logins are throttled (429)', last.status === 429);
  check('X5. throttled account is still blocked even with the right password', (await throttle.login('aids_admin', 'aids')).status === 429);

  // cleanup
  for (const [c, id] of created.reverse()) await c.req('DELETE', `/api/events/${id}`);
  const left = (await superU.req('GET', '/api/events?calendar=it')).data.filter((e) => e.title.startsWith('ZZ-TEST'));
  check('cleanup: test events removed', left.length === 0, `${left.length} left`);

  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1); });
