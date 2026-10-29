(function () {
  const state = window.__CAL_STATE__;
  const cal = state.calendar;

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  /** Tiny DOM builder. Text always goes through textContent, never innerHTML (category names are user-created). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach((c) => { if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return el;
  }
  function show(el, on) { if (el) el.hidden = !on; }
  function flag(el, msg) { if (!el) return; el.textContent = msg; el.classList.add('show'); }
  function unflag(el) { if (el) el.classList.remove('show'); }

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  function navigate(base, params) {
    const url = new URL(window.location.origin + base);
    Object.entries(params || {}).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v); });
    window.location.href = url.toString();
  }
  function reloadWith(params) {
    navigate(cal.base, { year: state.year, month: state.month, category: state.category, date: state.selectedDate, central: state.includeCentral ? 1 : '', ...params });
  }

  const COLOR = { central: '#1F6FD1', department: '#14A0A0' }; // keep in sync with --central / --dept in style.css

  /* ---------------- Login / logout ---------------- */
  const loginOverlay = qs('#loginOverlay');
  const loginBtn = qs('#loginBtn');
  const logoutBtn = qs('#logoutBtn');
  if (loginBtn) loginBtn.addEventListener('click', () => loginOverlay.classList.add('show'));
  if (state.locked && loginOverlay) loginOverlay.classList.add('show');
  const loginCancelBtn = qs('#loginCancelBtn');
  if (loginCancelBtn) loginCancelBtn.addEventListener('click', () => loginOverlay.classList.remove('show'));
  const loginSubmitBtn = qs('#loginSubmitBtn');
  async function doLogin() {
    const username = qs('#loginUser').value.trim();
    const password = qs('#loginPass').value;
    // The calendar only decides where we go next; the server decides what the account may do.
    const { data } = await api('POST', '/api/auth/login', { username, password, calendar: cal.slug });
    if (data.success) window.location.href = data.redirect || cal.base;
    else flag(qs('#loginError'), data.message || 'Incorrect username or password.');
  }
  if (loginSubmitBtn) loginSubmitBtn.addEventListener('click', doLogin);
  if (qs('#loginPass')) qs('#loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  if (logoutBtn) logoutBtn.addEventListener('click', async () => { await api('POST', '/api/auth/logout'); window.location.href = '/'; });

  const centralToggle = qs('#centralToggle');
  if (centralToggle) centralToggle.addEventListener('change', () => reloadWith({ central: centralToggle.checked ? 1 : '', date: state.selectedDate }));

  /* ---------------- Add / Edit event modal ---------------- */
  const eventOverlay = qs('#eventOverlay');
  const writable = state.writable || [];
  const categoryCache = {}; // "central:0" / "department:<id>" -> category[]
  const scopeKey = (type, deptId) => `${type}:${type === 'central' ? 0 : deptId}`;
  if (state.canEdit) categoryCache[scopeKey(cal.type, cal.departmentId)] = state.categories.slice();

  const RECURRING = { 'future-ready-saturday': 'Every Saturday', 'department-meetings': 'Every Friday' };
  const NEEDS_GUEST = new Set(['guest-lecture', 'future-ready-saturday']);
  const NEEDS_AGENDA = new Set(['department-meetings']);

  function currentScope() {
    const type = qs('#fSection').value;
    return { type, deptId: type === 'department' ? Number(qs('#fDepartment').value) : null };
  }
  function slugFor(type, deptId) {
    if (type === 'central') return 'central';
    const d = state.departments.find((x) => x.id === Number(deptId));
    return d ? d.slug : null;
  }
  function baseFor(type, deptId) { return type === 'central' ? '/central' : `/d/${slugFor(type, deptId)}`; }

  async function loadCategories(type, deptId, force) {
    const key = scopeKey(type, deptId);
    if (!force && categoryCache[key]) return categoryCache[key];
    const { ok, data } = await api('GET', `/api/categories?calendar=${encodeURIComponent(slugFor(type, deptId))}`);
    categoryCache[key] = ok && Array.isArray(data) ? data : [];
    return categoryCache[key];
  }
  function selectedCategory() {
    const { type, deptId } = currentScope();
    const list = categoryCache[scopeKey(type, deptId)] || [];
    return list.find((c) => String(c.id) === qs('#fCategory').value) || null;
  }

  function fillScopeSelects() {
    const typeSel = qs('#fSection');
    typeSel.replaceChildren();
    const types = [...new Set(writable.map((w) => w.calendarType))];
    types.forEach((t) => typeSel.append(h('option', { value: t }, t === 'central' ? 'Central' : 'Department')));
    const deptSel = qs('#fDepartment');
    deptSel.replaceChildren();
    writable.filter((w) => w.calendarType === 'department').forEach((w) => deptSel.append(h('option', { value: w.departmentId }, `${w.fullName} (${w.label})`)));
    deptSel.disabled = deptSel.options.length <= 1; // department admins: fixed to their own department
    typeSel.disabled = typeSel.options.length <= 1;
  }
  function syncDepartmentVisibility() { show(qs('#fDepartmentField'), qs('#fSection').value === 'department'); }

  function updateConditionalFields() {
    const cat = selectedCategory();
    const slug = cat && cat.isPredefined ? cat.slug : null;
    const schedule = (slug && RECURRING[slug]) || '';
    const needsGuest = !!(slug && NEEDS_GUEST.has(slug));
    const needsAgenda = !!(slug && NEEDS_AGENDA.has(slug));
    show(qs('#fScheduleField'), !!schedule);
    qs('#fSchedule').value = schedule;
    show(qs('#fGuestNameField'), needsGuest);
    qs('#fGuestName').required = needsGuest;
    if (!needsGuest) qs('#fGuestName').value = '';
    show(qs('#fMeetingAgendaField'), needsAgenda);
    qs('#fMeetingAgenda').required = needsAgenda;
    if (!needsAgenda) qs('#fMeetingAgenda').value = '';
    show(qs('#catManage'), !!cat && !cat.isPredefined);
  }

  async function refreshCategoryOptions(selectId, extraCategory) {
    const { type, deptId } = currentScope();
    let list = (await loadCategories(type, deptId)).slice();
    if (extraCategory && !list.some((c) => c.id === extraCategory.id)) list.push(extraCategory); // e.g. editing an event whose category was deactivated
    const sel = qs('#fCategory');
    sel.replaceChildren(...list.map((c) => h('option', { value: c.id }, c.name + (c.isActive === false ? ' (inactive)' : ''))));
    if (selectId && list.some((c) => c.id === Number(selectId))) sel.value = String(selectId);
    else if (list.length) sel.selectedIndex = 0;
    updateConditionalFields();
  }

  function closeCustomBox() { show(qs('#customCatBox'), false); qs('#customCatName').value = ''; show(qs('#customCatError'), false); }

  function openEventModal(mode, eventData, presetDate) {
    unflag(qs('#eventError'));
    closeCustomBox();
    qs('#eventModalTitle').textContent = mode === 'add' ? 'Add event' : 'Edit event';
    qs('#eventModalSub').textContent = mode === 'add' ? `adds an event to ${cal.type === 'central' ? 'the Central Academic Calendar' : cal.shortName}` : `editing "${eventData.title}"`;
    qs('#eventSubmitBtn').textContent = mode === 'add' ? 'Save event' : 'Save changes';
    qs('#eventSubmitBtn').dataset.mode = mode;
    qs('#fId').value = eventData ? eventData.id : '';
    qs('#fTitle').value = eventData ? eventData.title : '';
    qs('#fDate').value = eventData ? eventData.date : (presetDate || state.selectedDate || new Date().toISOString().slice(0, 10));
    qs('#fTime').value = eventData ? eventData.time : '';

    fillScopeSelects();
    const startType = eventData ? eventData.calendarType : (writable.some((w) => w.calendarType === cal.type) ? cal.type : writable[0].calendarType);
    qs('#fSection').value = startType;
    const startDept = eventData ? eventData.departmentId : (cal.departmentId || (writable.find((w) => w.calendarType === 'department') || {}).departmentId);
    if (startType === 'department' && startDept) qs('#fDepartment').value = String(startDept);
    syncDepartmentVisibility();

    qs('#fGuestName').value = eventData ? eventData.guestName || '' : '';
    qs('#fMeetingAgenda').value = eventData ? eventData.meetingAgenda || '' : '';
    qs('#fVenue').value = eventData ? eventData.venue : '';
    qs('#fDesc').value = eventData ? eventData.description : '';
    qs('#fAdditional').value = eventData ? eventData.additionalDetails || '' : '';

    const extra = eventData ? { id: eventData.categoryId, name: eventData.categoryName, isActive: true, isPredefined: false } : null;
    refreshCategoryOptions(eventData ? eventData.categoryId : null, extra).then(() => {
      // restore guest/agenda that updateConditionalFields may have cleared before the category list loaded
      if (eventData) { qs('#fGuestName').value = eventData.guestName || ''; qs('#fMeetingAgenda').value = eventData.meetingAgenda || ''; }
    });
    eventOverlay.classList.add('show');
  }

  if (state.canEdit) {
    qs('#fSection').addEventListener('change', () => { syncDepartmentVisibility(); closeCustomBox(); refreshCategoryOptions(); });
    qs('#fDepartment').addEventListener('change', () => { closeCustomBox(); refreshCategoryOptions(); });
    qs('#fCategory').addEventListener('change', updateConditionalFields);

    /* --- custom categories, inline in the modal --- */
    let customMode = 'create'; // 'create' | 'rename'
    qs('#addCategoryBtn').addEventListener('click', () => {
      customMode = 'create';
      qs('#customCatLabel').textContent = 'Custom Category Name';
      qs('#customCatName').value = '';
      show(qs('#customCatError'), false);
      show(qs('#customCatBox'), true);
      qs('#customCatName').focus();
    });
    qs('#renameCategoryBtn').addEventListener('click', () => {
      const cat = selectedCategory();
      if (!cat) return;
      customMode = 'rename';
      qs('#customCatLabel').textContent = `Rename “${cat.name}”`;
      qs('#customCatName').value = cat.name;
      show(qs('#customCatError'), false);
      show(qs('#customCatBox'), true);
      qs('#customCatName').focus();
    });
    qs('#customCatCancel').addEventListener('click', closeCustomBox);
    qs('#customCatName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); qs('#customCatSave').click(); } });

    qs('#customCatSave').addEventListener('click', async () => {
      const errEl = qs('#customCatError');
      const name = qs('#customCatName').value.replace(/\s+/g, ' ').trim();
      if (!name) { errEl.textContent = 'Category name cannot be empty.'; show(errEl, true); return; }
      const { type, deptId } = currentScope();
      let result;
      if (customMode === 'create') {
        result = await api('POST', '/api/categories', { calendarType: type, departmentId: deptId, name });
      } else {
        result = await api('PATCH', `/api/categories/${selectedCategory().id}`, { name });
      }
      if (!result.ok) { errEl.textContent = result.data.message || 'Could not save the category.'; show(errEl, true); return; }
      await loadCategories(type, deptId, true);
      closeCustomBox();
      await refreshCategoryOptions(result.data.category.id); // new/renamed category becomes the selected one
    });

    qs('#deactivateCategoryBtn').addEventListener('click', async () => {
      const cat = selectedCategory();
      if (!cat || !confirm(`Deactivate “${cat.name}”? Existing events keep it; it just won’t be offered for new events.`)) return;
      const { type, deptId } = currentScope();
      const { ok, data } = await api('PATCH', `/api/categories/${cat.id}`, { isActive: false });
      if (!ok) { flag(qs('#eventError'), data.message || 'Could not deactivate the category.'); return; }
      await loadCategories(type, deptId, true);
      await refreshCategoryOptions();
    });

    const panelAddBtn = qs('#panelAddBtn');
    if (panelAddBtn) panelAddBtn.addEventListener('click', () => openEventModal('add', null, panelAddBtn.dataset.date));
    qsa('.quick-add').forEach((btn) => btn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); openEventModal('add', null, btn.dataset.date); }));
    qsa('[data-edit-event]').forEach((btn) => btn.addEventListener('click', () => openEventModal('edit', JSON.parse(btn.dataset.editEvent))));
    qsa('[data-delete-event]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      const { ok, data } = await api('DELETE', `/api/events/${btn.dataset.deleteEvent}`);
      if (!ok) { alert(data.message || 'Could not delete the event.'); return; }
      reloadWith({ date: state.selectedDate });
    }));
    qs('#eventCancelBtn').addEventListener('click', () => eventOverlay.classList.remove('show'));

    qs('#eventSubmitBtn').addEventListener('click', async () => {
      const mode = qs('#eventSubmitBtn').dataset.mode;
      const { type, deptId } = currentScope();
      const cat = selectedCategory();
      const payload = {
        title: qs('#fTitle').value.trim(), date: qs('#fDate').value, time: qs('#fTime').value.trim(),
        calendarType: type, departmentId: deptId, categoryId: cat ? cat.id : null,
        guestName: qs('#fGuestName').value.trim(), meetingAgenda: qs('#fMeetingAgenda').value.trim(),
        venue: qs('#fVenue').value.trim(), description: qs('#fDesc').value.trim(), additionalDetails: qs('#fAdditional').value.trim()
      };
      if (!payload.title || !payload.date || !cat ||
          (qs('#fGuestName').required && !payload.guestName) ||
          (qs('#fMeetingAgenda').required && !payload.meetingAgenda)) {
        flag(qs('#eventError'), 'Fill in the required event details before saving.');
        return;
      }
      const id = qs('#fId').value;
      const { ok, data } = await api(mode === 'add' ? 'POST' : 'PUT', mode === 'add' ? '/api/events' : `/api/events/${id}`, payload);
      if (!ok) { flag(qs('#eventError'), data.message || 'Something went wrong.'); return; }
      eventOverlay.classList.remove('show');
      const d = payload.date;
      // go to the calendar the event actually lives in (a super administrator may have saved it elsewhere)
      navigate(baseFor(type, deptId), { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), date: d, central: state.includeCentral && baseFor(type, deptId) === cal.base ? 1 : '' });
    });
  }

  /* ---------------- Reminders ---------------- */
  qsa('.rem-checkbox').forEach((cb) => cb.addEventListener('change', () => qs(`#rem-email-${cb.dataset.eventId}`).classList.toggle('show', cb.checked)));
  qsa('[data-send-reminder]').forEach((btn) => btn.addEventListener('click', async () => {
    const eventId = btn.dataset.sendReminder;
    const input = qs(`#rem-input-${eventId}`);
    const email = input.value.trim();
    if (!email || !email.includes('@')) { input.style.borderColor = '#D5493F'; return; }
    const { data } = await api('POST', '/api/reminders', { eventId, email });
    if (data.success) qs(`#rem-confirm-${eventId}`).classList.add('show');
  }));

  /* ---------------- Calendar poster (Year/Sem/Custom download + share) ---------------- */
  const posterYearSelect = qs('#posterYear');
  const posterScopeSelect = qs('#posterScope');
  const downloadPosterBtn = qs('#downloadPosterBtn');
  const customRangeFields = qs('#customRangeFields');
  const customFromMonth = qs('#customFromMonth');
  const customFromYear = qs('#customFromYear');
  const customToMonth = qs('#customToMonth');
  const customToYear = qs('#customToYear');
  const customLabelInput = qs('#customLabel');
  const posterAddEventBtn = qs('#posterAddEventBtn');

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const centerYear = state.year || new Date().getFullYear();

  function fillYearSelect(sel, selectedYear) {
    for (let y = centerYear - 2; y <= centerYear + 2; y++) sel.append(h('option', { value: y, selected: y === selectedYear }, y));
  }
  function fillMonthSelect(sel, selectedMonth) {
    MONTH_NAMES.forEach((name, i) => sel.append(h('option', { value: i + 1, selected: i + 1 === selectedMonth }, name)));
  }
  if (posterYearSelect) fillYearSelect(posterYearSelect, centerYear);
  if (customFromMonth) {
    fillMonthSelect(customFromMonth, 1); fillYearSelect(customFromYear, centerYear);
    fillMonthSelect(customToMonth, 12); fillYearSelect(customToYear, centerYear);
  }
  function updatePosterScopeVisibility() {
    if (!posterScopeSelect) return;
    const isCustom = posterScopeSelect.value === 'custom';
    if (posterYearSelect) posterYearSelect.style.display = isCustom ? 'none' : '';
    if (customRangeFields) customRangeFields.style.display = isCustom ? 'inline-flex' : 'none';
  }
  if (posterScopeSelect) { posterScopeSelect.addEventListener('change', updatePosterScopeVisibility); updatePosterScopeVisibility(); }

  function getSelectedPeriods() {
    const scope = posterScopeSelect.value;
    if (scope === 'custom') {
      const fy = Number(customFromYear.value), fm = Number(customFromMonth.value);
      const ty = Number(customToYear.value), tm = Number(customToMonth.value);
      const periods = [];
      let y = fy, m = fm, safety = 0;
      while ((y < ty || (y === ty && m <= tm)) && safety < 60) { periods.push({ year: y, month: m }); m += 1; if (m > 12) { m = 1; y += 1; } safety += 1; }
      if (periods.length === 0) periods.push({ year: fy, month: fm });
      const customLabel = (customLabelInput.value || '').trim();
      return { periods, label: customLabel || `${MONTH_SHORT[fm - 1]} ${fy} \u2013 ${MONTH_SHORT[tm - 1]} ${ty}`, fileTag: `custom-${fy}${String(fm).padStart(2, '0')}-${ty}${String(tm).padStart(2, '0')}` };
    }
    const year = Number(posterYearSelect.value);
    if (scope === 'sem-odd') return { periods: [7, 8, 9, 10, 11, 12].map((month) => ({ year, month })), label: `${year} \u00b7 Odd Semester (Jul\u2013Dec)`, fileTag: `${year}-odd-sem` };
    if (scope === 'sem-even') return { periods: [1, 2, 3, 4, 5, 6].map((month) => ({ year, month })), label: `${year} \u00b7 Even Semester (Jan\u2013Jun)`, fileTag: `${year}-even-sem` };
    return { periods: Array.from({ length: 12 }, (_, i) => ({ year, month: i + 1 })), label: `${year} \u00b7 Full Year`, fileTag: `${year}-full-year` };
  }

  /** Day cell colour by calendar type: Central blue, Department teal, both = split. */
  function dayBackground(dayEvents) {
    const hasC = dayEvents.some((e) => e.calendarType === 'central');
    const hasD = dayEvents.some((e) => e.calendarType !== 'central');
    if (hasC && hasD) return `linear-gradient(135deg, ${COLOR.central} 50%, ${COLOR.department} 50%)`;
    return hasC ? COLOR.central : COLOR.department;
  }

  function buildMonthCell(year, monthNum, eventsByDate) {
    const wrap = h('div', { class: 'poster-month' }, h('h3', {}, `${MONTH_SHORT[monthNum - 1]} ${year}`));
    const grid = h('div', { class: 'poster-month-grid' });
    DOW_SHORT.forEach((d) => grid.append(h('div', { class: 'pdow' }, d)));
    const firstDow = new Date(year, monthNum - 1, 1).getDay();
    const daysInMonth = new Date(year, monthNum, 0).getDate();
    for (let i = 0; i < firstDow; i++) grid.append(h('div'));
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(monthNum).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const cell = h('div', { class: 'pday' }, d);
      const dayEvents = eventsByDate[dateStr];
      if (dayEvents && dayEvents.length) { cell.classList.add('has-event'); cell.style.background = dayBackground(dayEvents); }
      grid.append(cell);
    }
    wrap.append(grid);
    return wrap;
  }

  async function buildPoster(periods, label) {
    const periodKeys = new Set(periods.map((p) => `${p.year}-${String(p.month).padStart(2, '0')}`));
    const { ok, data } = await api('GET', `/api/events?calendar=${encodeURIComponent(cal.slug)}&category=all${state.includeCentral ? '&central=1' : ''}`);
    if (!ok) throw new Error(data.message || 'Could not load events.');
    const filtered = data.filter((e) => periodKeys.has(e.date.slice(0, 7))).sort((a, b) => a.date.localeCompare(b.date));
    const eventsByDate = {};
    filtered.forEach((e) => { (eventsByDate[e.date] = eventsByDate[e.date] || []).push(e); });

    const root = qs('#posterRoot');
    root.replaceChildren();
    const poster = h('div', { class: 'poster' });
    poster.append(h('div', { class: 'poster-header' },
      h('img', { src: '/logo.jpg', alt: 'logo' }),
      h('div', {}, h('h1', {}, cal.titleLine), cal.subLine ? h('div', { class: 'poster-sub' }, cal.subLine) : null),
      h('div', { class: 'poster-scope' }, label)
    ));

    const monthRows = Math.ceil(periods.length / 3);
    const sideCapacity = monthRows * 6;
    const listBelow = filtered.length > sideCapacity;
    const listCols = filtered.length > 60 ? 4 : (filtered.length > 24 ? 3 : 2);
    const body = h('div', { class: 'poster-body' + (listBelow ? ' list-below' : '') + (listBelow && periods.length > 6 ? ' cols-4' : '') });
    const monthsGrid = h('div', { class: 'poster-months' });
    periods.forEach((p) => monthsGrid.append(buildMonthCell(p.year, p.month, eventsByDate)));
    body.append(monthsGrid);

    const itemsWrap = h('div', { class: 'poster-list-items' });
    if (listBelow) itemsWrap.style.columnCount = String(listCols);
    if (filtered.length === 0) itemsWrap.append(h('div', { class: 'poster-list-empty' }, 'No events scheduled in this period.'));
    else {
      const multiYear = periods.some((p) => p.year !== periods[0].year);
      filtered.forEach((e) => {
        const [ey, em, ed] = e.date.split('-').map(Number);
        itemsWrap.append(h('div', { class: 'poster-list-item' },
          h('span', { class: 'swatch', style: `background:${e.calendarType === 'central' ? COLOR.central : COLOR.department}` }),
          h('span', { class: 'pd' }, `${MONTH_SHORT[em - 1]} ${ed}${multiYear ? ' ' + ey : ''}`),
          h('span', { class: 'pt' }, e.title)
        ));
      });
    }
    body.append(h('div', { class: 'poster-list' }, h('h3', {}, `All events (${filtered.length})`), itemsWrap));
    poster.append(body);

    const footerBits = [`Generated from the ${cal.type === 'central' ? 'Central Academic' : cal.fullName} calendar`];
    poster.append(h('div', { class: 'poster-footer' }, footerBits.join(' '),
      h('span', { style: 'margin-left:14px' }, h('span', { class: 'swatch', style: `display:inline-block;width:10px;height:10px;border-radius:2px;background:${COLOR.central};margin-right:4px` }), 'Central'),
      h('span', { style: 'margin-left:10px' }, h('span', { class: 'swatch', style: `display:inline-block;width:10px;height:10px;border-radius:2px;background:${COLOR.department};margin-right:4px` }), 'Department')));
    root.append(poster);
    return poster;
  }

  async function renderPosterCanvas() {
    const { periods, label, fileTag } = getSelectedPeriods();
    const posterEl = await buildPoster(periods, label);
    const canvas = await html2canvas(posterEl, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
    qs('#posterRoot').replaceChildren();
    return { canvas, label, fileTag };
  }

  const fileBase = () => (cal.type === 'central' ? 'VIT_Central_Academic_Calendar' : `VIT_${cal.fileCode}_Calendar`);

  if (downloadPosterBtn) {
    downloadPosterBtn.addEventListener('click', async () => {
      const originalText = downloadPosterBtn.textContent;
      downloadPosterBtn.textContent = 'Generating\u2026';
      downloadPosterBtn.disabled = true;
      try {
        const { canvas, fileTag } = await renderPosterCanvas();
        const link = document.createElement('a');
        link.download = `${fileBase()}_${fileTag}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
      } catch (err) {
        console.error('Failed to generate poster image:', err);
        alert('Sorry, something went wrong generating the image.');
      } finally {
        downloadPosterBtn.textContent = originalText;
        downloadPosterBtn.disabled = false;
      }
    });
  }
  if (posterAddEventBtn) posterAddEventBtn.addEventListener('click', () => openEventModal('add', null, null));

  /* ---------------- Excel calendar export ---------------- */
  const excelBtn = qs('#excelBtn');
  if (excelBtn) {
    fillMonthSelect(qs('#excelMonth'), state.month);
    fillYearSelect(qs('#excelYear'), state.year);
    const syncExcel = () => { qs('#excelMonth').style.display = qs('#excelScope').value === 'month' ? '' : 'none'; };
    qs('#excelScope').addEventListener('change', syncExcel);
    syncExcel();
    excelBtn.addEventListener('click', async () => {
      const original = excelBtn.textContent;
      excelBtn.textContent = 'Preparing\u2026';
      excelBtn.disabled = true;
      try {
        const params = new URLSearchParams({
          calendar: cal.slug, scope: qs('#excelScope').value, year: qs('#excelYear').value, month: qs('#excelMonth').value,
          includeList: qs('#excelList').checked ? '1' : '0', includeCentral: qs('#excelCentral') && qs('#excelCentral').checked ? '1' : '0'
        });
        const res = await fetch(`/api/export/excel?${params}`, { credentials: 'same-origin' });
        if (!res.ok) {
          let msg = 'Could not generate the Excel file.';
          try { msg = (await res.json()).message || msg; } catch (e) { /* keep default */ }
          throw new Error(msg);
        }
        const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
        const url = URL.createObjectURL(await res.blob());
        const a = h('a', { href: url, download: match ? match[1] : 'calendar.xlsx' });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) {
        alert(err.message);
      } finally {
        excelBtn.textContent = original;
        excelBtn.disabled = false;
      }
    });
  }

  /* ---------------- Share calendar poster by email ---------------- */
  const shareOverlay = qs('#shareOverlay');
  const shareBtn = qs('#shareBtn');
  const shareError = qs('#shareError');
  const shareSuccess = qs('#shareSuccess');
  const shareEmailInput = qs('#shareEmailInput');
  const shareRecipientsEl = qs('#shareRecipients');
  const mailBookList = qs('#mailBookList');
  let shareRecipients = [];
  const isValidEmailClient = (email) => /^[^\s<>"'`]+@[^\s<>"'`]+\.[^\s<>"'`]+$/.test(email);

  function renderRecipients() {
    if (!shareRecipientsEl) return;
    shareRecipientsEl.replaceChildren(...shareRecipients.map((email) =>
      h('span', { class: 'share-chip' }, email, h('span', { class: 'x', 'data-email': email }, '\u2715'))));
  }
  function addRecipient(email) {
    const clean = (email || '').trim().toLowerCase();
    if (!clean) return false;
    if (!isValidEmailClient(clean)) { flag(shareError, 'That doesn\u2019t look like a valid email address.'); return false; }
    if (!shareRecipients.includes(clean)) shareRecipients.push(clean);
    renderRecipients();
    return true;
  }
  async function loadMailBook() {
    mailBookList.replaceChildren(h('div', { class: 'mailbook-empty' }, 'Loading\u2026'));
    const { ok, data } = await api('GET', `/api/contacts?calendar=${encodeURIComponent(cal.slug)}`);
    if (!ok || !Array.isArray(data)) { mailBookList.replaceChildren(h('div', { class: 'mailbook-empty' }, 'Couldn\u2019t load the mail book.')); return; }
    if (!data.length) { mailBookList.replaceChildren(h('div', { class: 'mailbook-empty' }, 'No saved addresses yet.')); return; }
    mailBookList.replaceChildren(...data.map((c) => {
      const rm = h('span', { class: 'rm' }, 'Remove');
      const row = h('div', { class: 'mailbook-item', onclick: (e) => { if (e.target !== rm) addRecipient(c.email); } },
        h('span', {}, c.email + (c.label ? ' \u2013 ' + c.label : '')), rm);
      rm.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api('DELETE', `/api/contacts/${c.id}?calendar=${encodeURIComponent(cal.slug)}`);
        loadMailBook();
      });
      return row;
    }));
  }

  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      shareRecipients = []; renderRecipients(); shareEmailInput.value = '';
      unflag(shareError); unflag(shareSuccess); mailBookList.classList.remove('show');
      shareOverlay.classList.add('show');
    });
    qs('#shareCancelBtn').addEventListener('click', () => shareOverlay.classList.remove('show'));
    shareRecipientsEl.addEventListener('click', (e) => {
      const x = e.target.closest('.x');
      if (!x) return;
      shareRecipients = shareRecipients.filter((email) => email !== x.dataset.email);
      renderRecipients();
    });
    qs('#shareAddBtn').addEventListener('click', () => { if (addRecipient(shareEmailInput.value)) { unflag(shareError); shareEmailInput.value = ''; } });
    shareEmailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); qs('#shareAddBtn').click(); } });
    qs('#shareSaveContactBtn').addEventListener('click', async () => {
      const email = (shareEmailInput.value || '').trim().toLowerCase();
      if (!isValidEmailClient(email)) { flag(shareError, 'Enter a valid email before saving it to the mail book.'); return; }
      const { ok, data } = await api('POST', '/api/contacts', { calendar: cal.slug, email });
      if (!ok) { flag(shareError, data.message || 'Could not save contact.'); return; }
      unflag(shareError); addRecipient(email);
      if (mailBookList.classList.contains('show')) loadMailBook();
    });
    qs('#shareMailBookBtn').addEventListener('click', () => {
      const willShow = !mailBookList.classList.contains('show');
      mailBookList.classList.toggle('show', willShow);
      if (willShow) loadMailBook();
    });
    qs('#shareSendBtn').addEventListener('click', async () => {
      const sendBtn = qs('#shareSendBtn');
      unflag(shareError); unflag(shareSuccess);
      if (shareRecipients.length === 0) { flag(shareError, 'Add at least one recipient first.'); return; }
      const originalText = sendBtn.textContent;
      sendBtn.textContent = 'Sending\u2026'; sendBtn.disabled = true;
      try {
        const { canvas, label, fileTag } = await renderPosterCanvas();
        const heading = cal.type === 'central' ? 'Central Academic Calendar' : cal.fullName;
        const { ok, data } = await api('POST', '/api/share-poster', {
          calendar: cal.slug, recipients: shareRecipients, fileTag,
          subject: `${state.instituteName} \u2014 ${heading} \u2014 ${label}`,
          text: `Attached is the ${heading} calendar (${label}) from ${state.instituteName}.`,
          imageDataUrl: canvas.toDataURL('image/png')
        });
        if (!ok) throw new Error(data.message || 'Could not send the email.');
        shareSuccess.textContent = `\u2713 Sent to ${data.sentTo.length} recipient${data.sentTo.length === 1 ? '' : 's'}.`;
        shareSuccess.classList.add('show');
      } catch (err) {
        flag(shareError, err.message);
      } finally {
        sendBtn.textContent = originalText; sendBtn.disabled = false;
      }
    });
  }

  /* ---------------- Import Events (target calendar -> preview -> confirm) ---------------- */
  const importBtn = qs('#importBtn');
  if (importBtn && qs('#importOverlay')) {
    const overlay = qs('#importOverlay');
    const steps = { target: qs('#impStepTarget'), preview: qs('#impStepPreview'), result: qs('#impStepResult') };
    const err = qs('#importError');
    const canCentral = writable.some((w) => w.calendarType === 'central');
    const deptOptions = writable.filter((w) => w.calendarType === 'department');
    const pinnedDept = state.user && state.user.role === 'dept_admin';
    let model = null; // { target, rows, categories, mapping }

    function showStep(name) { Object.entries(steps).forEach(([k, el]) => show(el, k === name)); unflag(err); }
    function selectedTarget() { const r = qs('input[name="impTarget"]:checked'); return r ? r.value : null; }
    function syncDeptField() {
      show(qs('#impDeptField'), selectedTarget() === 'department' && !pinnedDept && deptOptions.length > 1);
    }

    function openImport() {
      showStep('target');
      qs('#impFile').value = '';
      qs('#impDept').replaceChildren(...deptOptions.map((w) => h('option', { value: w.departmentId }, `${w.fullName} (${w.label})`)));
      const optCentral = qs('#optCentral'), optDept = qs('#optDept');
      qs('input', optCentral).disabled = !canCentral; optCentral.classList.toggle('disabled', !canCentral);
      qs('input', optDept).disabled = deptOptions.length === 0; optDept.classList.toggle('disabled', deptOptions.length === 0);
      qs('#optDeptHint').textContent = pinnedDept && deptOptions[0] ? `Your department: ${deptOptions[0].fullName} (${deptOptions[0].label})` : 'Department events (shown in teal)';
      const preferred = cal.type === 'central' && canCentral ? 'central' : (deptOptions.length ? 'department' : 'central');
      qsa('input[name="impTarget"]').forEach((r) => { r.checked = r.value === preferred; });
      if (cal.type === 'department' && qs('#impDept').querySelector(`option[value="${cal.departmentId}"]`)) qs('#impDept').value = String(cal.departmentId);
      syncDeptField();
      overlay.classList.add('show');
    }
    importBtn.addEventListener('click', openImport);
    qsa('input[name="impTarget"]').forEach((r) => r.addEventListener('change', syncDeptField));
    qs('#impCancelBtn').addEventListener('click', () => overlay.classList.remove('show'));
    qs('#impBackBtn').addEventListener('click', () => { model = null; overlay.classList.remove('show'); });

    qs('#impExtractBtn').addEventListener('click', async () => {
      unflag(err);
      const target = selectedTarget();
      const file = qs('#impFile').files[0];
      if (!target) { flag(err, 'Choose where these events should be imported.'); return; }
      if (!file) { flag(err, 'Choose a PDF file first.'); return; }
      const btn = qs('#impExtractBtn'); const original = btn.textContent;
      btn.textContent = 'Reading PDF\u2026'; btn.disabled = true;
      try {
        const fd = new FormData(); // fields first, file last
        fd.append('calendarType', target);
        if (target === 'department') fd.append('departmentId', pinnedDept ? deptOptions[0].departmentId : qs('#impDept').value);
        fd.append('pdf', file);
        const { ok, data } = await api('POST', '/api/import/preview', fd);
        if (!ok) throw new Error(data.message || 'Could not read that PDF.');
        if (!data.rows.length) throw new Error(data.message || 'No events found in that PDF.');
        model = { target: data.target, rows: data.rows.map((r) => ({ ...r, include: !r.errors.length && !r.duplicate, selection: r.categoryId ? String(r.categoryId) : '' })), categories: data.categories, unmatched: data.unmatchedCategories, stats: data };
        renderPreview();
        showStep('preview');
      } catch (e) {
        flag(err, e.message);
      } finally {
        btn.textContent = original; btn.disabled = false;
      }
    });

    function categorySelect(row, onChange) {
      const sel = h('select', { class: 'imp-cat' }, h('option', { value: '' }, 'Choose category\u2026'),
        ...model.categories.map((c) => h('option', { value: String(c.id) }, c.name)));
      const unmatched = !row.categoryId && row.suggestedCategory;
      if (unmatched) sel.append(h('option', { value: 'new:' + row.suggestedCategory }, `+ Create \u201c${row.suggestedCategory}\u201d`));
      sel.value = row.selection;
      sel.addEventListener('change', () => { row.selection = sel.value; onChange && onChange(); });
      return sel;
    }

    function renderPreview() {
      const { target, rows, stats } = model;
      const banner = qs('#impBanner');
      banner.className = 'target-banner ' + (target.type === 'central' ? 'central' : 'dept');
      banner.textContent = target.type === 'central' ? 'Importing into: Central Calendar \u2014 Central Academic Calendar' : `Importing into: Department Calendar \u2014 ${target.fullName} (${target.shortName})`;

      qs('#impStats').replaceChildren(
        h('div', { class: 'stat' }, h('b', {}, stats.total), 'events detected'),
        h('div', { class: 'stat' }, h('b', {}, stats.valid), 'valid rows'),
        h('div', { class: 'stat bad' }, h('b', {}, stats.invalid), 'invalid rows'),
        h('div', { class: 'stat warn' }, h('b', {}, stats.duplicates), 'possible duplicates')
      );

      // Categories the PDF mentions that don't exist in the target calendar: create or map before confirming.
      const mapBox = qs('#impMapBox');
      if (model.unmatched.length) {
        mapBox.replaceChildren(h('h4', {}, 'Some categories don\u2019t exist in this calendar yet \u2014 create or map them:'),
          ...model.unmatched.map((u) => {
            const sel = h('select', {}, h('option', { value: '' }, 'Choose\u2026'),
              h('option', { value: 'new:' + u.name }, `Create custom category \u201c${u.name}\u201d`),
              ...model.categories.map((c) => h('option', { value: String(c.id) }, `Map to \u201c${c.name}\u201d`)));
            sel.addEventListener('change', () => {
              model.rows.forEach((r) => { if (!r.categoryId && r.suggestedCategory === u.name) r.selection = sel.value; });
              renderRows();
            });
            return h('div', { class: 'map-line' }, h('strong', {}, `\u201c${u.name}\u201d`), `(${u.count} row${u.count === 1 ? '' : 's'}) \u2192`, sel);
          }));
        show(mapBox, true);
      } else show(mapBox, false);
      renderRows();
    }

    function renderRows() {
      const list = qs('#impRows');
      list.replaceChildren(...model.rows.map((r) => {
        const invalid = r.errors.length > 0;
        const check = h('input', { type: 'checkbox', checked: r.include && !invalid, disabled: invalid });
        check.addEventListener('change', () => { r.include = check.checked; });
        const title = h('input', { type: 'text', value: r.title, maxlength: 255, class: 'imp-title' });
        title.addEventListener('input', () => { r.title = title.value; });
        const date = h('input', { type: 'date', value: r.date || '' });
        date.addEventListener('input', () => { r.date = date.value; });
        const time = h('input', { type: 'text', value: r.time || '', placeholder: 'time', maxlength: 50, style: 'width:80px' });
        time.addEventListener('input', () => { r.time = time.value; });
        return h('div', { class: 'pdf-row' + (invalid ? ' is-invalid' : (r.duplicate ? ' is-dup' : '')) },
          check,
          h('div', { style: 'flex:1;min-width:0' },
            h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, title, date, time, categorySelect(r)),
            invalid ? h('div', { class: 'row-flag bad' }, r.errors.join(' ')) : null,
            !invalid && r.duplicate ? h('div', { class: 'row-flag dup' }, 'Possible duplicate \u2014 an event with this title and date already exists (unchecked by default).') : null));
      }));
    }

    qs('#impConfirmBtn').addEventListener('click', async () => {
      unflag(err);
      const chosen = model.rows.filter((r) => r.include && !r.errors.length);
      if (!chosen.length) { flag(err, 'Select at least one event to import.'); return; }
      const missing = chosen.filter((r) => !r.selection);
      if (missing.length) { flag(err, `Choose or create a category for ${missing.length} selected event${missing.length === 1 ? '' : 's'} before confirming.`); return; }
      const payloadRows = chosen.map((r) => {
        const base = { title: r.title, date: r.date, time: r.time, venue: r.venue, description: r.description };
        return r.selection.startsWith('new:') ? { ...base, newCategoryName: r.selection.slice(4) } : { ...base, categoryId: Number(r.selection) };
      });
      const btn = qs('#impConfirmBtn'); const original = btn.textContent;
      btn.textContent = 'Importing\u2026'; btn.disabled = true;
      try {
        const body = { calendarType: model.target.type, rows: payloadRows };
        if (model.target.type === 'department') body.departmentId = model.target.departmentId;
        const { ok, data } = await api('POST', '/api/import/confirm', body);
        if (!ok) {
          const detail = (data.rowErrors || []).slice(0, 5).map((e) => `Row ${e.index + 1} (${e.title || 'untitled'}): ${e.message}`).join(' \u2022 ');
          throw new Error(`${data.message || 'Import failed.'} ${detail} Nothing was saved.`.trim());
        }
        showResult(data);
      } catch (e) {
        flag(err, e.message);
      } finally {
        btn.textContent = original; btn.disabled = false;
      }
    });

    function showResult(data) {
      const created = data.created.length, skipped = data.skipped.length;
      qs('#impResultSummary').textContent = `Imported ${created} event${created === 1 ? '' : 's'}` +
        (skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : '') +
        (data.categoriesCreated.length ? `. New categories created: ${data.categoriesCreated.join(', ')}` : '') + '.';
      qs('#impResultList').replaceChildren(...data.skipped.map((s) => h('div', { class: 'pdf-row' }, h('div', {}, `${s.title} \u2014 ${s.reason}`))));
      showStep('result');
      const first = data.created[0];
      qs('#impDoneBtn').onclick = () => {
        const base = data.target.type === 'central' ? '/central' : `/d/${data.target.slug}`;
        if (first) navigate(base, { year: Number(first.date.slice(0, 4)), month: Number(first.date.slice(5, 7)) });
        else window.location.reload();
      };
    }
  }
})();
