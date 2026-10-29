# VIT Multi-Department Academic Calendar

**Vishwakarma Institute of Technology** — one shared app serving five department calendars plus a Central Academic Calendar:

| Department | Abbreviation | URL |
|---|---|---|
| Computer Science and Engineering | CSE | `/d/cse` |
| Computer Science and Engineering (Artificial Intelligence) | CSE (AI) | `/d/cse-ai` |
| Information Technology | IT | `/d/it` |
| Computer Science and Engineering (Artificial Intelligence and Machine Learning) | CSE (AIML) | `/d/cse-aiml` |
| Artificial Intelligence and Data Science | AIDS | `/d/aids` |
| Vishwakarma Institute of Technology — Central Academic Calendar | Central | `/central` |

Upgraded in place from the single-department CSE (AI) calendar: same stack (Node + Express + EJS + MySQL), same look, same calendar/filters/upcoming/details/Add Event UI.

## What's new

- **Department selection screen** at `/`, then a calendar per department. The selection only decides *which calendar you look at* — it is never used as proof of authorization.
- **Roles & logins** (server-enforced, scrypt-hashed passwords):
  - `dept_admin` — manages only their own department's events, categories, imports, exports, mail book.
  - `central_admin` — manages only the Central calendar.
  - `super_admin` — everything, plus user/department management (API + CLI).
- **Blue = Central, Teal = Department** on calendar labels, upcoming list, details, import preview, legend and poster image. Excel exports use a distinct color for each event, with Central/Department tones retained on calendar dates and labels.
- **Add Event modal** (same modal): Calendar Type, Department, Guest Name, Additional Details, the nine department categories, and the recurring-schedule rules (Future Ready Saturday → *Every Saturday* + guest; Department Meetings → *Every Friday* + agenda; Guest Lecture → guest).
- **Custom categories inside the modal**: **+ Add Custom Category** beside the dropdown → inline name box → saved per calendar, auto-selected. Rename / Deactivate links appear for custom categories. Duplicates are blocked per calendar (ignoring case/extra spaces); the same name can exist independently in two departments. Old events are never touched when a category is renamed or deactivated.
- **Import Events**: asks *Where should these events be imported?* (Central / Department), then shows a preview (target, totals, valid/invalid, duplicates, per-row errors, create-or-map for unknown categories) before anything is saved. Saved in one transaction.
- **Calendar-style Excel export** (real cells, not an image): Monthly or Full-Year, Sunday–Saturday grid, multiple events per date, plus an optional *Event List* sheet.

## Project structure

```
server/server.js      routes, services, permissions, DB migration + seeding
server/excel.js       Excel workbook builder (exceljs)
server/pdf-import.js  PDF text extraction + date scanner (moved out of server.js, logic unchanged)
server/util.js        password hashing, name normalisation, time parsing
client/views/         select.ejs (department picker), index.ejs (calendar), login.ejs (login modal)
client/public/        style.css, script.js, logo, html2canvas
scripts/              manage-users.js (accounts CLI), acceptance-test.js (end-to-end tests)
database.sql          reference schema (the app also migrates/creates it automatically)
```

## Setup

Requires Node.js 18+ (20+ to run the acceptance tests) and MySQL 5.7+/8 (or MariaDB 10.2+).

```bash
npm install
cp .env.example .env      # fill in DB_* and a random SESSION_SECRET
npm start                 # http://localhost:3000
```

On first start the app creates/extends the tables, seeds the departments and categories, and **prints the generated passwords once** for:

`central_admin`, `cse_admin`, `cse_ai_admin`, `it_admin`, `cse_aiml_admin`, `aids_admin` (and `admin` as super administrator on a brand-new database).
Set `SEED_PASSWORD` in `.env` beforehand if you'd rather choose one initial password for all of them.

## Upgrading an existing single-department install

Just deploy the new code and start it. The migration is automatic and idempotent (safe to restart any number of times):

- Nothing is dropped, truncated or rewritten. New columns/tables are added; `events.updated_at` keeps each event's original timestamp.
- Existing **Central** events stay Central. Existing **department** events become **CSE (AI)** events (change with `LEGACY_DEPARTMENT_SLUG` *before* first start if they belonged elsewhere). Existing contacts move to that department's mail book.
- Every existing event is linked to a category row (`category_id`). A legacy category that isn't in the nine-item list (e.g. an old "workshop" department event) is kept as a **custom category** in that department rather than dropped.
- The old `admin` login keeps working with its existing password and becomes a **super administrator** (the old admin could manage everything). **That password is `admin123` on stock installs — change it immediately:** `npm run users -- reset-password admin`. The server warns on every start until you do. The old `admins` table is left in place (unused) and can be dropped later.
- The legacy `category` column is still written (slug or name) so nothing that reads it breaks; `category_id` is authoritative.

## Accounts

```bash
npm run users -- list
npm run users -- create <username> <super_admin|central_admin|dept_admin> [department-slug]

npm run users -- deactivate <username>     # / activate
```

Super administrators can also use the JSON API: `GET/POST /api/admin/users`, `PATCH /api/admin/users/:id`, `POST /api/admin/users/:id/reset-password`, `GET/PATCH /api/admin/departments` (rename a department or its abbreviation; deactivate one). There is intentionally no user-management screen.

## Access rules (all enforced server-side)

- Signed-in users can read/modify **only their own calendar**. Another department's events, categories, imports, exports and mail book return 403 (or 404 for individual records, so their existence isn't revealed). A signed-in user opening another department's URL is redirected home.
- The browser never decides anything: the session stores only the user id; role and department are re-read from the database on every request, so deactivating a user takes effect immediately.
- **Public viewing** (`PUBLIC_READ=true`, the default): anonymous visitors can still *view* whichever calendar they pick, read-only, exactly as the original app allowed. Set `PUBLIC_READ=false` to require login for every calendar. Excel export, import, category management, the combined view and the mail book always require login.
- **Combined view**: signed-in department users can tick *Also show Central events (read-only)* to overlay Central (blue) on their department calendar (teal). Central events can't be edited from there.
- Login attempts are throttled (5 failures per user+IP / 15 min), session ids are regenerated on login, cookies are `HttpOnly` + `SameSite=Lax` (set `COOKIE_SECURE=true` behind HTTPS), and `SESSION_SECRET` is mandatory in production.

## Importing events (PDF)

Import Events → choose **Central Calendar** or **Department Calendar** → pick the PDF → review → confirm.

- Department admins are pinned to their own department; super administrators choose one of the five; only Central/super can target Central.
- Supported format: **text-based PDFs** (the only format the project supported before; scanned/image PDFs aren't read). Extraction is the same heuristic as before — it looks for a date next to each event title, so always review the preview. Title, date, time and category are editable per row.
- The preview shows target, events detected, valid/invalid rows (with the reason), and possible duplicates (unchecked by default).
- PDFs mention categories like *Exam* or *Holiday*. If the target calendar doesn't have one, the preview asks you to **create it as a custom category or map it** to an existing one; confirm is blocked until every selected row has a category.
- Confirm re-validates everything on the server and saves in **one transaction**: if any selected row is invalid, nothing is saved. Duplicates (same title + date + calendar) are skipped, so re-importing the same file is harmless.

## Excel export

Admin toolbar → **Excel calendar** → Monthly / Full-Year, month, year, optional *Detailed Event List sheet*, optional *Include Central events* (department calendars) → **Download Excel**.

Filenames: `VIT_CSE_Calendar_2026.xlsx`, `VIT_CSE_AI_Calendar_2026.xlsx`, `VIT_IT_Calendar_2026.xlsx`, `VIT_CSE_AIML_Calendar_2026.xlsx`, `VIT_AIDS_Calendar_2026.xlsx`, `VIT_Central_Academic_Calendar_2026.xlsx` (monthly: `…_Calendar_October_2026.xlsx`).

Each month sheet has the college name, the full department name (or the Central heading), the month/year, a Sunday–Saturday grid, and the day's events listed inside its cell (several per date, each coloured blue for Central / teal for Department, with the category name in brackets). Full-Year = 12 sheets January→December. Exports only include events the signed-in user may access.

## Email sharing (optional)

Unchanged: set `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM`. The mail book is now **per calendar**, and attachment names follow the Excel naming scheme (`VIT_IT_Calendar_2026-full-year.png`).

## Testing

```bash
# On a TEST database, start the server once with a known initial password...
SEED_PASSWORD='Choose-a-test-password-1' npm start
# ...then in another terminal:
BASE_URL=http://localhost:3000 SEED_PASSWORD='Choose-a-test-password-1' npm run test:acceptance
```

The suite maps to the 23 acceptance criteria (departments and names, per-department logins, headings, isolation, imports, colours, Future Ready Saturday / Department Meetings rules, custom categories, Excel grids/filenames/colours, logout/login, unauthorized requests) plus XSS and brute-force checks. It cleans up the events it creates; custom categories can't be deleted by design, so don't point it at production. The migrated `admin` account keeps its old password — set `ADMIN_PASSWORD` if you changed it. A test PDF at `/tmp/test-calendar.pdf` enables the import tests.

Manual checklist: log in as each `<dept>_admin`, try another department's URL (expect redirect), add a *Future Ready Saturday* and a custom category from the modal, import a PDF into Central and into a department, download the monthly and full-year Excel files and open them in Excel/LibreOffice.

## Known limitations

- Sessions are in memory (as before): users are logged out when the server restarts, and you need a shared store if you run several instances.
- Recurring categories (*Every Saturday/Friday*) are a **label** on a single dated event, as before — they don't auto-generate repeat events.
- Event time is free text ("10:00 am"); sorting understands common formats but isn't validated.
- Category-vs-calendar consistency (an event's category must belong to the event's calendar) is enforced in the application inside a transaction, not by a database constraint.
- Custom categories can be deactivated but not deleted (so history can never dangle).
