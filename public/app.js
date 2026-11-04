// First Answer Agent dashboard. Plain JS, no build step.
// Every dynamic string goes through esc(): customer text is untrusted.
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const html = (strings, ...vals) => strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i] instanceof Raw ? vals[i].s : Array.isArray(vals[i]) ? vals[i].map((x) => (x instanceof Raw ? x.s : esc(x))).join('') : esc(vals[i])) : ''), '');
const R = (s) => raw(s);

const state = { cfg: null, leads: [], agent: null, today: '', filter: 'all', query: '', timer: null, tz: 'America/Chicago', view: '' };

async function api(path, opts) {
  const res = await fetch(path, opts && opts.body ? { ...opts, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const fmtTime = (ts, secs = false) => new Intl.DateTimeFormat('en-US', { timeZone: state.tz, hour: 'numeric', minute: '2-digit', ...(secs ? { second: '2-digit' } : {}) }).format(new Date(ts));
const fmtDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d))); };
const secs = (n) => (n == null ? '—' : `${n.toFixed(1)} s`);
const initials = (n) => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const STATUS = { new: ['New', 'new'], replied: ['Replied', 'replied'], booked: ['Booked', 'booked'], human: ['Needs a Human', 'human'] };
const chip = (s) => html`<span class="chip ${STATUS[s][1]}">${STATUS[s][0]}</span>`;

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'alert'); t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------- shell ----------
function paintShell() {
  const a = state.agent;
  if (!a) return;
  const badge = $('#modeBadge');
  const online = a.mode === 'model';
  const down = a.inferenceConfigured && !online;
  badge.className = `badge ${online ? '' : down ? 'down' : 'offline'}`;
  badge.innerHTML = html`<i class="live-dot"></i><span>${a.label}${a.model ? ` · ${a.model}` : ''}</span>`;
  $('#footTitle').textContent = online ? 'Agent is live' : 'Agent is live (offline rules)';
  $('#footText').innerHTML = html`${a.model ? `Model: ${a.model}` : 'No inference key, deterministic rules'}<br>Nashville, TN`;
  const needs = state.leads.filter((l) => l.status === 'human' || l.status === 'new').length;
  $('#navCount').hidden = !needs;
  $('#navCount').textContent = needs;
  if (state.cfg) $('#bizName').textContent = state.cfg.business.name;
}

function setNav(name) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === name;
    a.classList.toggle('selected', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

async function refreshLeads() {
  const d = await api('/api/leads');
  state.leads = d.leads; state.agent = d.agent; state.today = d.today;
  paintShell();
  return d;
}

// ---------- Live Inbox ----------
function rowHtml(l) {
  return html`<tr data-id="${l.id}" tabindex="0" role="link" aria-label="Open ${l.name}">
    <td><div class="person"><span class="initials">${initials(l.name)}</span><div><strong>${l.name}${l.priority === 'urgent' ? R('<span class="chip urgent">Urgent</span>') : ''}</strong><small>${l.jobLabel ? `${l.jobLabel}${l.location ? ' · ' + l.location : ''}` : l.snippet}${l.seed ? ' · sample' : ''}</small></div></div></td>
    <td class="src">${l.source}</td>
    <td>${l.replyTimeSec == null ? 'Waiting' : secs(l.replyTimeSec)}</td>
    <td>${R(chip(l.status))}</td>
    <td>${fmtTime(l.createdAt)}</td></tr>`;
}

function inboxFilterList() {
  const q = state.query.toLowerCase();
  return state.leads.filter((l) => (state.filter === 'all' || l.status === state.filter) && (!q || `${l.name} ${l.snippet} ${l.jobLabel || ''} ${l.source}`.toLowerCase().includes(q)));
}

async function renderInbox(first) {
  if (first) {
    const sc = await api('/api/scenarios');
    $('#view').innerHTML = html`
      <div class="heading"><div><div class="eyebrow" id="today"></div><h1>Live Inbox</h1><p class="sub">Every new lead gets a fast, helpful first answer.</p></div>
        <div class="actions">
          <div class="menu"><button class="btn" id="simBtn" aria-haspopup="true" aria-expanded="false">+ Simulate a new lead</button>
            <div class="menu-list" id="simMenu" hidden role="menu">${sc.map((s) => R(html`<button role="menuitem" data-sc="${s.id}"><strong>${s.title}</strong><span>${s.blurb}</span></button>`))}</div></div>
          <a class="btn ghost" href="/lead" target="_blank" rel="noopener">Open lead form</a>
        </div></div>
      <div class="inbox-grid">
        <div class="card"><div class="card-head"><div><h2>New and active leads</h2><p class="sub" style="margin-top:4px" id="inboxSub"></p></div>
          <select class="btn ghost" id="statusFilter" aria-label="Filter by status"><option value="all">All statuses</option><option value="new">New</option><option value="replied">Replied</option><option value="booked">Booked</option><option value="human">Needs a Human</option></select></div>
          <table class="table"><thead><tr><th>Lead</th><th>Source</th><th>Reply time</th><th>Status</th><th>Received</th></tr></thead><tbody id="rows"></tbody></table></div>
        <aside class="card side-card" id="sideCard"></aside>
      </div>
      <p class="foot">Demo data is fictional; messages are simulated. No real texts or emails are sent.</p>`;
    $('#statusFilter').value = state.filter;
    $('#statusFilter').addEventListener('change', (e) => { state.filter = e.target.value; paintInbox(); });
    const btn = $('#simBtn'); const menu = $('#simMenu');
    btn.addEventListener('click', () => { menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
    document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    menu.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-sc]'); if (!b) return;
      menu.hidden = true; btn.disabled = true;
      try { const r = await api('/api/simulate', { method: 'POST', body: { scenario: b.dataset.sc } }); location.hash = `#/lead/${r.id}`; } catch (err) { toast(err.message); } finally { btn.disabled = false; }
    });
    $('#rows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = `#/lead/${tr.dataset.id}`; });
    $('#rows').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = `#/lead/${tr.dataset.id}`; } });
  }
  const m = await api('/api/metrics?scope=all');
  paintInbox(m);
}

function paintInbox(m) {
  if (m) state.metrics = m; else m = state.metrics;
  const list = inboxFilterList();
  $('#today').textContent = state.today ? fmtDay(state.today) : '';
  $('#rows').innerHTML = list.length ? list.map(rowHtml).join('') : '<tr><td colspan="5" class="empty">No leads match.</td></tr>';
  const waiting = state.leads.filter((l) => l.status === 'new' || l.status === 'human').length;
  $('#inboxSub').textContent = `${state.leads.length} leads · ${waiting} need attention`;
  const a = state.agent; const t = m.today;
  const goal = 15;
  const pct = t.avgReplySec == null ? 0 : Math.min(100, Math.round((t.avgReplySec / goal) * 100));
  $('#sideCard').innerHTML = html`<h3>Agent activity</h3>
    <div class="agent-card"><span class="agent-orb"></span><div><strong style="font-size:14px">Answer Agent</strong><small style="display:block">${a.label}${a.model ? ' · ' + a.model : ''}</small></div></div>
    <div class="activity"><span>Leads answered today</span><strong>${t.answered}</strong></div>
    <div class="activity"><span>Average reply</span><strong>${t.avgReplySec == null ? '—' : secs(t.avgReplySec)}</strong></div>
    <div class="activity"><span>Booked today</span><strong>${t.booked}</strong></div>
    <div class="activity"><span>Handed to team</span><strong>${t.human}</strong></div>
    <div style="margin-top:18px;color:#c3c9de;font-size:12px">Reply-time goal <strong style="float:right;color:#fff">Under ${goal} sec</strong><div class="barline"><i style="width:${pct}%"></i></div></div>
    <div class="note">Demo data is fictional; messages are simulated.${a.mode !== 'model' ? ' Running in offline rules mode: same path, deterministic rules instead of a model.' : ''}</div>`;
}

// ---------- Lead Detail ----------
async function renderDetail(id, first) {
  const d = await api(`/api/leads/${id}`);
  state.agent = d.agent; paintShell();
  const l = d.lead;
  if (first || !$('#conv')) {
    $('#view').innerHTML = html`
      <a class="back" href="#/inbox">&larr; Back to Live Inbox</a>
      <div class="heading"><div><div class="eyebrow" id="dEyebrow"></div><h1>${l.name}</h1><p class="sub" id="dSub"></p></div><div id="dChips"></div></div>
      <div class="detail-grid">
        <div class="card"><div class="card-head"><div class="lead-meta"><span class="initials">${initials(l.name)}</span><div><h2>Conversation</h2><p class="sub" id="dJob"></p></div></div><span class="sub">${l.phone}</span></div>
          <div class="conversation" id="conv" tabindex="0" aria-label="Conversation"></div>
          <form class="composer" id="composer">
            <p class="hint">Role-play the customer: type a reply and the agent will answer. Messages are simulated.</p>
            <div class="quick"><button type="button" data-q="The first one works for me.">The first one works</button><button type="button" data-q="None of those times work, anything next week?">Another day?</button><button type="button" data-q="Can I speak to a manager?">Ask for a human</button></div>
            <div class="row"><textarea id="replyText" maxlength="1000" rows="2" placeholder="Reply as ${esc(l.name.split(' ')[0])}…" aria-label="Customer reply"></textarea><button class="btn" id="sendBtn" type="submit">Send</button></div>
          </form></div>
        <div style="display:grid;gap:18px;align-content:start">
          <aside class="card"><div class="card-head"><h2>What the agent did</h2><span class="badge" id="dBadge"></span></div><div class="timeline" id="tl"></div></aside>
          <aside class="card"><div class="card-head"><h2>Lead facts</h2></div><dl class="facts" id="facts"></dl></aside>
        </div>
      </div>
      <p class="foot">Demo data is fictional; messages are simulated. No real texts or emails are sent.</p>`;
    $('#composer').addEventListener('submit', async (e) => {
      e.preventDefault();
      const ta = $('#replyText'); const text = ta.value.trim(); if (!text) return;
      $('#sendBtn').disabled = true;
      try { await api(`/api/leads/${id}/customer-reply`, { method: 'POST', body: { text } }); ta.value = ''; await renderDetail(id, false); } catch (err) { toast(err.message); } finally { $('#sendBtn').disabled = false; }
    });
    $('#composer').addEventListener('click', (e) => { const q = e.target.closest('[data-q]'); if (q) { $('#replyText').value = q.dataset.q; $('#replyText').focus(); } });
  }
  const working = l.status === 'new' || (l.timeline.length && l.timeline.at(-1).kind !== 'done' && l.timeline.at(-1).kind !== 'followup' && l.timeline.at(-1).kind !== 'info');
  $('#dEyebrow').textContent = `Lead detail / ${l.qualification?.jobLabel || 'Not yet qualified'}`;
  $('#dSub').textContent = `${STATUS[l.status][0]} · ${l.source} · Received ${fmtTime(l.createdAt)}${l.seed ? ' · sample data' : ''}`;
  $('#dJob').textContent = `${l.qualification?.jobLabel || 'Unclassified'}${l.qualification?.location ? ' · ' + l.qualification.location : ''}`;
  $('#dChips').innerHTML = html`${R(chip(l.status))}${l.priority === 'urgent' ? R('<span class="chip urgent">Urgent</span>') : ''}`;
  const conv = $('#conv');
  const atEnd = conv.scrollTop + conv.clientHeight >= conv.scrollHeight - 40;
  const sig = l.messages.length + ':' + (working ? 1 : 0);
  conv.innerHTML = l.messages.map((m) => html`<div class="msg ${m.followup ? 'system' : m.from}">${m.text}<span class="time">${fmtTime(m.ts)} · ${m.from === 'customer' ? 'Customer (role-play)' : m.followup ? 'Automatic follow-up, simulated send' : 'Answer Agent, simulated send'}</span></div>`).join('') + (working ? '<div class="msg system">Agent is working…</div>' : '');
  if (atEnd || conv.dataset.sig !== sig) conv.scrollTop = conv.scrollHeight;
  conv.dataset.sig = sig;
  const badge = $('#dBadge'); badge.className = `badge ${working ? 'offline' : ''}`;
  badge.innerHTML = html`<i class="live-dot"></i>${working ? 'Working' : 'Completed'}`;
  $('#tl').innerHTML = l.timeline.length ? l.timeline.map((t) => timelineItem(t)).join('') : '<p class="sub">No steps yet.</p>';
  $('#facts').innerHTML = factsHtml(l, d.followupSpeedup);
  return working;
}

function timelineItem(t) {
  const cls = t.kind === 'guard' ? 'guard' : t.ok === false ? 'bad' : t.kind === 'followup' ? 'followup' : t.kind === 'function' || t.kind === 'done' ? 'done' : '';
  const modeTxt = t.mode === 'model' ? 'model' : t.mode === 'timer' ? 'timer' : 'rules';
  const rawBox = t.fn ? html`<details class="raw"><summary>Arguments and result</summary><pre>${JSON.stringify({ args: t.args, result: t.result }, null, 2)}</pre></details>` : '';
  return html`<div class="timeline-item ${cls}"><strong>${t.title}</strong>${t.fn ? R(html`<small><span class="fn">${t.fn}()</span>${t.source === 'guardrail' ? 'by guardrail' : t.source === 'model' ? 'chosen by model' : 'rules engine'}</small>`) : ''}${t.detail && !t.fn ? R(html`<small>${t.detail}</small>`) : ''}${R(rawBox)}<time>+${t.sinceLeadMs < 1000 ? t.sinceLeadMs + ' ms' : (t.sinceLeadMs / 1000).toFixed(1) + ' s'} from receipt · ${fmtTime(t.ts, true)} · ${modeTxt}${t.ms ? ` · step took ${t.ms} ms` : ''}</time></div>`;
}

function factsHtml(l, speedup) {
  const q = l.qualification; const rows = [];
  const add = (k, v) => rows.push(html`<dt>${k}</dt><dd>${v}</dd>`);
  add('First reply', l.replyTimeSec == null ? 'Not yet' : `${secs(l.replyTimeSec)} (measured)`);
  add('Run mode', l.lastRunMode === 'model' ? 'Live model' : l.lastRunMode === 'offline' ? 'Offline rules' : 'Pending');
  if (q) {
    add('Job', `${q.jobLabel}, ${q.urgency}${q.size !== 'unknown' ? ', ' + q.size : ''}`);
    add('Service area', q.serviceAreaOk === true ? `In area (${q.areaMatch})` : q.serviceAreaOk === false ? `Outside area (${q.areaMatch})` : 'Not confirmed');
    add('Price book range', q.priceRange ? `$${q.priceRange.low.toLocaleString()}–$${q.priceRange.high.toLocaleString()}` : 'No quote, free on-site estimate');
  }
  if (l.booking) add('Booking', `${l.booking.slot_id.replace('T', ' ')} · ${l.booking.kind === 'emergency_hold' ? 'emergency hold' : 'confirmed'}`);
  const fu = l.followups.at(-1);
  if (fu) add('Follow-up', fu.status === 'pending' ? `Pending, fires at ${fmtTime(fu.dueAt, true)} (demo clock ${speedup}x: ${fu.delayMinutes} min → ${Math.round((fu.dueAt - fu.createdAt) / 1000)} s)` : fu.status === 'fired' ? `Fired at ${fmtTime(fu.firedAt, true)}` : `Cancelled (${fu.reason})`);
  if (l.humanReason) add('Why a human', l.humanReason);
  return rows.join('');
}

// ---------- Calendar ----------
const H0 = 8; const H1 = 17; const ROW = 54;
async function renderCalendar(start) {
  const c = await api(`/api/calendar${start ? '?start=' + start : ''}`);
  const cols = c.days;
  const label = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(d + 'T00:00:00Z'));
  const dname = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(d + 'T00:00:00Z')).toUpperCase();
  const clock = (t) => { const h = Number(t.slice(0, 2)); return `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`; };
  const grp = { roof: '', plumb: 'pink', clean: 'green', other: '' };
  const JOBGROUP = { roof_leak: 'roof', roof_repair: 'roof', roof_replacement: 'roof', gutter_cleaning: 'roof', gutter_repair: 'roof', house_cleaning: 'clean', deep_cleaning: 'clean', move_out_cleaning: 'clean', plumbing_leak: 'plumb', drain_clog: 'plumb', water_heater: 'plumb' };
  const colHtml = (day) => {
    const blocks = day.slots.map((s) => {
      const top = (Number(s.start.slice(0, 2)) - H0) * ROW + 3; const h = 2 * ROW - 6;
      if (s.status === 'booked') {
        const b = s.booking; const cls = b.kind === 'existing' ? 'existing' : grp[JOBGROUP[b.job_type]] || '';
        const tag = b.leadId ? `<button class="event ${cls}" style="top:${top}px;height:${h}px" data-lead="${esc(b.leadId)}" aria-label="Open ${esc(b.name)}">` : `<div class="event ${cls}" style="top:${top}px;height:${h}px">`;
        const end = b.leadId ? '</button>' : '</div>';
        return `${tag}<strong>${esc(b.jobLabel)}${b.kind === 'emergency_hold' ? ' (priority hold)' : ''}</strong><small>${esc(b.name)} · ${clock(s.start)}</small>${end}`;
      }
      return `<div class="open ${s.status === 'past' ? 'past' : ''}" style="top:${top}px;height:${h}px">${s.status === 'past' ? 'Past' : 'Open'} · ${clock(s.start)}</div>`;
    }).join('');
    const starts = day.slots.map((x) => Number(x.start.slice(0, 2)));
    let closed = '';
    for (let h = H0; h < H1; h += 1) {
      if (!starts.some((st) => h >= st && h < st + 2)) closed += `<div class="closed" style="top:${(h - H0) * ROW}px;height:${ROW}px">${day.slots.length === 0 ? (h === H0 ? 'Closed' : '') : h === 12 ? 'Lunch / closed' : ''}</div>`;
    }
    return `<div class="daycol" style="height:${(H1 - H0) * ROW}px">${closed}${blocks}</div>`;
  };
  const hours = Array.from({ length: H1 - H0 }, (_, i) => `<div class="hlabel">${clock(String(H0 + i).padStart(2, '0'))}</div>`).join('');
  const agenda = cols.map((day) => `<h3>${esc(dname(day.date))} ${esc(label(day.date))}${day.today ? ' (today)' : ''}</h3>` + day.slots.map((s) => `<div class="row ${s.status === 'open' ? 'free' : s.status === 'past' ? 'past' : ''}"><span>${esc(clock(s.start))}–${esc(clock(s.end))}</span><span>${s.status === 'booked' ? esc(s.booking.jobLabel + ' · ' + s.booking.name) : s.status === 'open' ? 'Open' : 'Past'}</span></div>`).join('')).join('');
  $('#view').innerHTML = html`
    <div class="heading"><div><div class="eyebrow">Your week at a glance</div><h1>Calendar</h1><p class="sub">Real bookings and open visit windows. The agent can only book what you see here.</p></div>
      <div class="actions"><button class="btn ghost small" data-week="${c.prev}" aria-label="Previous week">‹ Prev</button><span class="btn ghost small" style="pointer-events:none">${label(cols[0].date)} – ${label(cols[5].date)}, ${cols[0].date.slice(0, 4)}</span><button class="btn ghost small" data-week="${c.next}" aria-label="Next week">Next ›</button></div></div>
    <div class="card" style="padding:15px">
      <div class="week-wrap"><div class="week"><div></div>${R(cols.map((d) => html`<div class="dayhead ${d.today ? 'today' : ''}">${dname(d.date)}<small>${label(d.date)}</small></div>`).join(''))}
        <div class="hourcol">${R(hours)}</div>${R(cols.map(colHtml).join(''))}</div></div>
      <div class="agenda">${R(agenda)}</div>
    </div>
    <div class="legend-row"><span>● Roof &amp; exterior</span><span style="color:#e985dc">● Plumbing</span><span style="color:#72dfbe">● Cleaning</span><span style="color:#8791b2">● Existing customers (sample)</span><span style="margin-left:auto">All times Central · Visit windows are 2 hours · Closed Sunday</span></div>
    <p class="foot">Demo data is fictional; messages are simulated.</p>`;
  $('#view').onclick = (e) => {
    const w = e.target.closest('[data-week]'); if (w) { renderCalendar(w.dataset.week); return; }
    const ev = e.target.closest('[data-lead]'); if (ev) location.hash = `#/lead/${ev.dataset.lead}`;
  };
}

// ---------- Results ----------
async function renderResults(scope = 'all') {
  const m = await api(`/api/metrics?scope=${scope}`);
  const sk = m.sampleLeads;
  const bars = chartSvg(m.chart);
  $('#view').innerHTML = html`
    <div class="heading"><div><div class="eyebrow">${m.scope === 'live' ? 'Live agent runs only' : 'All leads in this workspace'}</div><h1>Results</h1><p class="sub">See how quickly new opportunities turn into booked work. Every number below is computed from the leads stored in this app.</p></div>
      <select class="btn ghost" id="scope" aria-label="Data scope"><option value="all">All data (sample + live)</option><option value="live">Live agent runs only</option></select></div>
    <div class="stat-grid">
      <div class="card stat"><label>Average reply time</label><strong>${m.avgReplySec == null ? '—' : secs(m.avgReplySec)}</strong><small class="dim">${m.fastestSec == null ? 'No replies yet' : `fastest ${secs(m.fastestSec)} · slowest ${secs(m.slowestSec)}`}</small></div>
      <div class="card stat"><label>Leads answered</label><strong>${m.answered}</strong><small class="dim">of ${m.totalLeads} received</small></div>
      <div class="card stat"><label>Jobs booked</label><strong>${m.booked}</strong><small>${m.bookedRate == null ? 'No data yet' : m.bookedRate + '% of answered leads'}</small></div>
      <div class="card stat"><label>Handed to a human</label><strong>${m.human}</strong><small class="dim">${m.humanRate == null ? 'No data yet' : m.humanRate + '% for judgment or follow-up'}</small></div>
    </div>
    <div class="card chart"><div class="chart-head"><div><h2>Reply time per lead</h2><p class="sub" style="margin-top:4px">Seconds from the lead arriving to the agent's first reply · latest ${m.chart.length} answered leads</p></div>
      <div class="legend"><span><i></i>Offline rules</span><span><i class="l2"></i>Live model</span><span><i class="l3"></i>Average</span></div></div>
      ${R(bars)}</div>
    <p class="foot">${m.liveLeads} live lead${m.liveLeads === 1 ? '' : 's'} and ${sk} sample lead${sk === 1 ? '' : 's'} in this workspace. Sample leads were generated by the offline rules engine on a simulated clock; live leads are timed by the server clock. Demo data is fictional; messages are simulated.</p>`;
  $('#scope').value = scope;
  $('#scope').addEventListener('change', (e) => renderResults(e.target.value));
}

function chartSvg(data) {
  if (!data.length) return '<div class="empty">No answered leads yet. Simulate a lead from the Live Inbox and it will appear here.</div>';
  const narrow = window.innerWidth < 600;
  const d = narrow ? data.slice(-7) : data;
  const W = 760; const H = 280; const L = 44; const T = 22; const B = 36; const iw = W - L - 10; const ih = H - T - B;
  const max = Math.max(5, Math.ceil(Math.max(...d.map((x) => x.sec)) / 5) * 5);
  const avg = d.reduce((a, b) => a + b.sec, 0) / d.length;
  const bw = Math.min(34, (iw / d.length) * 0.55);
  const y = (v) => T + ih - (v / max) * ih;
  let out = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart of reply time in seconds for the latest ${d.length} leads. Average ${avg.toFixed(1)} seconds.">`;
  for (let i = 0; i <= 4; i += 1) { const v = (max / 4) * i; out += `<line x1="${L}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" stroke="#ffffff14"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${Number.isInteger(v) ? v : v.toFixed(1)}</text>`; }
  d.forEach((x, i) => {
    const cx = L + (iw / d.length) * (i + 0.5); const live = x.mode === 'model';
    out += `<defs><linearGradient id="g${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${live ? '#77cfff' : '#d575ff'}"/><stop offset="1" stop-color="${live ? '#4778df' : '#7652e9'}"/></linearGradient></defs>`;
    out += `<rect x="${cx - bw / 2}" y="${y(x.sec)}" width="${bw}" height="${T + ih - y(x.sec)}" rx="5" fill="url(#g${i})"><title>${esc(x.name)}: ${x.sec} s</title></rect>`;
    out += `<text class="val" x="${cx}" y="${y(x.sec) - 6}" text-anchor="middle">${x.sec < 1 ? Math.round(x.sec * 1000) + ' ms' : x.sec.toFixed(1)}</text><text x="${cx}" y="${H - 14}" text-anchor="middle">${esc(x.name.slice(0, 9))}</text>`;
  });
  out += `<line x1="${L}" x2="${W - 10}" y1="${y(avg)}" y2="${y(avg)}" stroke="#69e2bd" stroke-dasharray="5 5"/></svg>`;
  return out;
}

// ---------- Guardrails ----------
function renderGuardrails() {
  const c = state.cfg;
  $('#view').innerHTML = html`
    <div class="heading"><div><div class="eyebrow">Safety</div><h1>Guardrails</h1><p class="sub">Enforced in code before and after every model call. A model cannot talk its way past them.</p></div></div>
    <div class="grid2">
      <div class="card"><div class="card-head"><h2>What the agent can never do</h2></div><div class="card-body"><ul class="rules">
        <li><b>Book outside business hours.</b> ${c.hours}. Slots come only from the calendar store.</li>
        <li><b>Double book.</b> A taken slot is refused at write time.</li>
        <li><b>Quote beyond the price book.</b> Any dollar amount outside the configured range is blocked; otherwise it offers a range or a free on-site estimate.</li>
        <li><b>Promise discounts, refunds, guarantees or free work,</b> or send links.</li>
        <li><b>Follow instructions inside customer text.</b> Customer messages are data. Injection attempts are flagged and handed to a human.</li></ul></div></div>
      <div class="card"><div class="card-head"><h2>Always handed to a human</h2></div><div class="card-body"><ul class="rules">
        <li><b>Emergencies:</b> active leak, flooding, gas, fire, structural damage. Priority flag, 911 reminder, earliest window held.</li>
        <li><b>Complaints and angry customers.</b></li>
        <li><b>Insurance claims, contracts, schedule changes,</b> or anyone asking for a person.</li>
        <li><b>Out of scope or out of area</b> requests, and unclear leads after two questions.</li>
        <li><b>Repeated guardrail violations</b> by the model.</li></ul></div></div>
      <div class="card"><div class="card-head"><h2>Service area</h2></div><div class="card-body"><div class="pillbox">${c.serviceArea.map((x) => R(html`<span>${x}</span>`))}</div></div></div>
      <div class="card"><div class="card-head"><h2>Price book</h2></div><div class="card-body" style="padding:0"><table class="table"><thead><tr><th>Job</th><th>Small</th><th>Medium</th><th>Large</th></tr></thead><tbody>${c.priceBook.map((p) => R(html`<tr><td>${p.label}</td>${['small', 'medium', 'large'].map((s) => R(html`<td>$${p.sizes[s].low.toLocaleString()}–$${p.sizes[s].high.toLocaleString()}</td>`))}</tr>`))}</tbody></table><p class="sub" style="padding:12px 16px">No quote from the agent: ${c.noQuoteJobs.join(', ')}. It offers a free on-site estimate.</p></div></div>
    </div>
    <p class="foot">Demo data is fictional; messages are simulated. Follow-up timers run on a ${c.followupSpeedup}x demo clock so you can watch one fire.</p>`;
}

// ---------- router ----------
async function route() {
  clearTimeout(state.timer);
  const [, name = 'inbox', arg] = location.hash.split('/');
  const view = `${name}/${arg || ''}`;
  const first = state.view !== view; state.view = view;
  setNav(name === 'lead' ? 'inbox' : name);
  $('#crumb').textContent = { inbox: 'Live Inbox', lead: 'Lead Detail', calendar: 'Calendar', results: 'Results', guardrails: 'Guardrails' }[name] || 'Live Inbox';
  $('.search').style.visibility = name === 'inbox' ? 'visible' : 'hidden';
  let again = 3000;
  try {
    if (!state.cfg) { state.cfg = await api('/api/config'); state.tz = state.cfg.business.tz; }
    await refreshLeads();
    if (name === 'lead' && arg) { const working = await renderDetail(arg, first); again = working ? 900 : 2500; }
    else if (name === 'calendar') { if (first) await renderCalendar(); again = 8000; }
    else if (name === 'results') { if (first) await renderResults(); again = 0; }
    else if (name === 'guardrails') { renderGuardrails(); again = 0; }
    else { await renderInbox(first); again = 2500; }
  } catch (err) {
    if (name === 'lead') { $('#view').innerHTML = html`<a class="back" href="#/inbox">&larr; Back to Live Inbox</a><div class="card empty">${err.message}</div>`; again = 0; }
    else toast(err.message);
  }
  if (again) state.timer = setTimeout(() => { if (state.view === view) route(); }, again);
}

$('#search').addEventListener('input', (e) => { state.query = e.target.value; if (state.view.startsWith('inbox') && $('#rows')) paintInbox(); });
window.addEventListener('hashchange', route);
route();
