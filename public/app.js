// First Answer Agent dashboard. Plain JS, no build step.
// Every dynamic string goes through esc(): customer text is untrusted.
import { isWorking } from './status.js';
const $ = (s, r = document) => r.querySelector(s);
import { esc, html, R } from './tpl.js';
import { calendarBadge, calendarNotices, calendarLegend } from './calnotes.js';

// Which example business this tab shows: ?profile= in the address, remembered for the tab. Empty = the server's default.
let PROFILE = new URLSearchParams(location.search).get('profile') || '';
try { if (PROFILE) sessionStorage.setItem('fa-profile', PROFILE); else PROFILE = sessionStorage.getItem('fa-profile') || ''; } catch { /* storage unavailable */ }
PROFILE = PROFILE.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
const leadHref = () => (PROFILE ? `/lead?profile=${encodeURIComponent(PROFILE)}` : '/lead');

const state = { calStart: '', calSig: '', failures: 0, cfg: null, leads: [], agent: null, today: '', filter: 'all', query: '', timer: null, tz: 'UTC', view: '' };

async function api(path, opts) {
  const prof = PROFILE ? { 'x-profile': PROFILE } : {};
  const res = await fetch(path, opts && opts.body ? { ...opts, headers: { 'Content-Type': 'application/json', ...prof }, body: JSON.stringify(opts.body) } : { ...(opts || {}), headers: { ...prof, ...((opts && opts.headers) || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Per-lead tokens live only in this browser tab's session storage.
function leadToken(id) { try { return JSON.parse(sessionStorage.getItem('fa-tokens') || '{}')[id] || ''; } catch { return ''; } }
function rememberToken(id, tok) { try { const m = JSON.parse(sessionStorage.getItem('fa-tokens') || '{}'); m[id] = tok; sessionStorage.setItem('fa-tokens', JSON.stringify(m)); } catch { /* storage unavailable */ } }

const fmtTime = (ts, secs = false) => new Intl.DateTimeFormat('en-US', { timeZone: state.tz, hour: 'numeric', minute: '2-digit', ...(secs ? { second: '2-digit' } : {}) }).format(new Date(ts));
const fmtDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d))); };
// Durations under a second are shown in milliseconds, never as "0.0 s".
const tzName = (tz) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || tz; } catch { return tz; } };
const fmtSlot = (id) => { const [d, t] = id.split('T'); const [y, m, dd] = d.split('-').map(Number); const day = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, dd))); const h = Number(t.slice(0, 2)); return `${day}, ${h % 12 || 12}:${t.slice(3, 5)} ${h >= 12 ? 'PM' : 'AM'}`; };
const secs = (n) => (n == null ? '—' : n < 1 ? 'under 1 s' : `${n.toFixed(1)} s`);
// Every reply shows its real measured time.
const replyText = (sec, mode) => (sec == null ? 'Waiting' : secs(sec));
const upper1 = (t) => String(t || '').charAt(0).toUpperCase() + String(t || '').slice(1);
const dayKey = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: state.tz }).format(new Date(ts));
// Time of day for today, and the date plus time for anything older (a 3-day-old item must not look like it is from today).
const fmtStamp = (ts) => (dayKey(ts) === state.today || !state.today ? fmtTime(ts) : new Intl.DateTimeFormat('en-US', { timeZone: state.tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ts)));
// Owner-friendly service label: an urgent inquiry that was never sorted into a service says so plainly.
const svcLabel = (l, q) => { const s = l.serviceLabel || q?.serviceLabel || ''; if (s && s !== 'Unclassified request') return s; return l.priority === 'urgent' ? 'Urgent, needs a call' : s ? 'Not sorted yet' : ''; };
const initials = (n) => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const STATUS = { new: ['New', 'new'], replied: ['Replied', 'replied'], booked: ['Booked', 'booked'], human: ['Needs a person', 'human'] };
const chip = (s) => html`<span class="chip ${STATUS[s][1]}">${STATUS[s][0]}</span>`;

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'alert'); t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------- "Switch business": the same app, a different example business ----------
async function paintSwitcher() {
  const box = $('#switchBox');
  try {
    const p = await api('/api/profiles');
    state.profiles = p;
    if (!p.switcher) { box.hidden = true; return; }
    const sel = $('#bizSwitch');
    sel.innerHTML = p.profiles.map((x) => html`<option value="${x.id}">${x.name}</option>`).join('');
    sel.value = state.cfg.profile;
    box.hidden = false;
    sel.onchange = () => {
      const id = sel.value;
      try { sessionStorage.setItem('fa-profile', id); } catch { /* ignore */ }
      location.href = `/?profile=${encodeURIComponent(id)}#/inbox`; // a full reload, so the name, colors, services and sample leads all change together
    };
  } catch { box.hidden = true; }
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
  $('#footTitle').textContent = online ? `AI model: ${a.model}` : 'Backup mode: built-in rules';
  $('#footDot').className = `live-dot ${online ? '' : 'off'}`;
  $('#footText').innerHTML = html`${online ? 'Replies come from the AI model running on Vultr.' : a.inferenceConfigured ? 'The AI model is not available right now, so built-in rules are answering.' : 'The AI model is not connected, so built-in rules are answering.'}`;
  const needs = state.leads.filter((l) => l.status === 'human' || l.status === 'new').length;
  $('#navCount').hidden = !needs;
  $('#navCount').textContent = needs;
  if (state.cfg) {
    $('#bizName').textContent = state.cfg.business.name;
    $('#leadLink').href = leadHref();
    document.documentElement.style.setProperty('--accent', state.cfg.business.accent);
    document.title = `${state.cfg.business.name} - AI front desk`;
  }
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
  return html`<tr data-id="${l.id}" class="${l.seed ? 'sample-row' : ''}" tabindex="0" role="link" aria-label="Open ${l.name}">
    <td><div class="person"><span class="initials">${initials(l.name)}</span><div><strong>${l.name}${l.priority === 'urgent' ? R('<span class="chip urgent">Urgent</span>') : ''}${l.offTopic ? R('<span class="chip scope">Outside scope</span>') : ''}</strong><small>${svcLabel(l) ? `${svcLabel(l)}${l.location ? ' · ' + l.location : ''}` : l.snippet}${l.seed ? ' · sample' : ''}</small></div></div></td>
    <td class="src">${l.source}${l.sourceSimulated ? R(' <span class="srctag" title="This source is a simulated example. The website form is the only real intake channel.">simulated source</span>') : ''}</td>
    <td>${replyText(l.replyTimeSec, l.lastRunMode)}${l.seed && l.replyTimeSec != null ? R(' <small class="dim">(simulated)</small>') : ''}</td>
    <td>${R(chip(l.status))}</td>
    <td>${fmtStamp(l.createdAt)}</td></tr>`;
}

function inboxFilterList() {
  const q = state.query.toLowerCase();
  return state.leads.filter((l) => (state.filter === 'all' || l.status === state.filter) && (!q || `${l.name} ${l.snippet} ${l.serviceLabel || ''} ${l.source}`.toLowerCase().includes(q)));
}

async function renderInbox(first) {
  if (first) {
    const sc = await api('/api/scenarios');
    $('#view').innerHTML = html`
      <div class="heading"><div><div class="eyebrow" id="today"></div><h1>Live Inbox</h1><p class="sub">Every new inquiry gets a fast, helpful first answer.</p></div>
        <div class="actions">
          <div class="menu"><button class="btn" id="simBtn" aria-haspopup="true" aria-expanded="false">+ Simulate a new inquiry</button>
            <div class="menu-list" id="simMenu" hidden role="menu">${sc.map((s) => R(html`<button role="menuitem" data-sc="${s.id}"><strong>${s.title}</strong><span>${s.blurb}</span></button>`))}</div></div>
          <a class="btn ghost" href="${leadHref()}" target="_blank" rel="noopener">Open contact form</a>
          <button class="btn ghost" id="resetBtn" title="Reload the fictional sample data. Your own conversations are kept.">Reset demo</button>
        </div></div>
      <div class="inbox-grid">
        <div class="card"><div class="card-head"><div><h2>New and active inquiries</h2><p class="sub" style="margin-top:4px" id="inboxSub"></p></div>
          <select class="btn ghost" id="statusFilter" aria-label="Filter by status"><option value="all">All statuses</option><option value="new">New</option><option value="replied">Replied</option><option value="booked">Booked</option><option value="human">Needs a person</option></select></div>
          <table class="table"><thead><tr><th>Customer</th><th>Source</th><th>Reply time</th><th>Status</th><th>Received</th></tr></thead><tbody id="rows"></tbody></table></div>
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
      try { const r = await api('/api/simulate', { method: 'POST', body: { scenario: b.dataset.sc } }); rememberToken(r.id, r.token); location.hash = `#/lead/${r.id}`; } catch (err) { toast(err.message); } finally { btn.disabled = false; }
    });
    $('#resetBtn').addEventListener('click', async () => {
      if (!window.confirm('Reload the fictional sample data? Your own conversations are kept.')) return;
      const rb = $('#resetBtn'); rb.disabled = true;
      try { await api('/api/demo/reset', { method: 'POST', body: {} }); toast('Sample data reloaded.'); await refreshLeads(); paintInbox(); } catch (err) { toast(err.message); } finally { rb.disabled = false; }
    });
    $('#rows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = `#/lead/${tr.dataset.id}`; });
    $('#rows').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = `#/lead/${tr.dataset.id}`; } });
  }
  const m = await api('/api/metrics?scope=live');
  paintInbox(m);
}

function paintInbox(m) {
  if (m) state.metrics = m; else m = state.metrics;
  const list = inboxFilterList();
  $('#today').textContent = state.today ? fmtDay(state.today) : '';
  $('#rows').innerHTML = list.length ? list.map(rowHtml).join('') : '<tr><td colspan="5" class="empty">No inquiries match.</td></tr>';
  const waiting = state.leads.filter((l) => l.status === 'new' || l.status === 'human').length;
  $('#inboxSub').textContent = `${state.leads.length} inquiries · ${waiting} need attention`;
  const a = state.agent; const t = m.today; const ms = m.measured;
  $('#sideCard').innerHTML = html`<h3>Agent activity</h3>
    <div class="agent-card"><span class="agent-orb"></span><div><strong style="font-size:14px">${state.cfg?.business?.agentName || 'Assistant'}</strong><small style="display:block">${a.label}${a.model ? ' · ' + a.model : ''}</small></div></div>
    <div class="activity"><span>Inquiries answered since the server started (all visitors)</span><strong>${t.answered}</strong></div>
    <div class="activity"><span>Typical reply time</span><strong>${ms.medianSec == null ? '—' : replyText(ms.medianSec, ms.model.answered && !ms.rules.answered ? 'model' : 'rules')}</strong></div>
    <div class="activity"><span>Booked</span><strong>${t.booked}</strong></div>
    <div class="activity"><span>Need a person</span><strong>${t.human}</strong></div>
    <div class="note">${ms.answered ? `${ms.answered} repl${ms.answered === 1 ? 'y' : 'ies'} measured${ms.model.answered ? `: ${ms.model.answered} by the AI model, ${ms.rules.answered} by built-in rules` : ', all from built-in rules (no AI model connected)'}. ` : 'No replies measured yet. Simulate an inquiry or send one from the contact form. '}Sample inquiries are fictional. No texts or emails are sent.</div>`;
}

// ---------- Lead Detail ----------
async function renderDetail(id, first) {
  const d = await api(`/api/leads/${id}`);
  state.agent = d.agent; paintShell();
  const l = d.lead;
  if (l.demoToken) rememberToken(id, l.demoToken);
  if (first || !$('#conv')) {
    $('#view').innerHTML = html`
      <a class="back" href="#/inbox">&larr; Back to Live Inbox</a>
      <div class="heading"><div><div class="eyebrow" id="dEyebrow"></div><h1>${l.name}</h1><p class="sub" id="dSub"></p></div><div id="dChips"></div></div>
      <div class="detail-grid">
        <div class="card"><div class="card-head"><div class="lead-meta"><span class="initials">${initials(l.name)}</span><div><h2>Conversation</h2><p class="sub" id="dJob"></p></div></div><span class="sub">${l.phone}</span></div>
          <div class="conversation" id="conv" tabindex="0" aria-label="Conversation"></div>
          <form class="composer" id="composer">
            <p class="hint">Try it as the customer: type a reply and the assistant will answer. Messages are simulated.</p>
            <div class="quick"><button type="button" data-q="The first one works for me.">The first one works</button><button type="button" data-q="None of those times work, anything next week?">Another day?</button><button type="button" data-q="Can I speak to a manager?">Ask for a person</button></div>
            <div class="row"><textarea id="replyText" maxlength="1000" rows="2" placeholder="Reply as ${esc(l.name.split(' ')[0])}..." aria-label="Customer reply"></textarea><button class="btn" id="sendBtn" type="submit">Send</button></div>
          </form></div>
        <div style="display:grid;gap:18px;align-content:start">
          <aside class="card"><div class="card-head"><h2>What the assistant did</h2><span class="badge" id="dBadge"></span></div><div class="timeline" id="tl"></div></aside>
          <aside class="card"><div class="card-head"><h2>Details</h2></div><dl class="facts" id="facts"></dl></aside>
        </div>
      </div>
      <p class="foot">Demo data is fictional; messages are simulated. No real texts or emails are sent.</p>`;
    $('#composer').addEventListener('submit', async (e) => {
      e.preventDefault();
      const ta = $('#replyText'); const text = ta.value.trim(); if (!text) { toast('Type a message first.'); return; }
      const tok = leadToken(id);
      if (!tok) { toast('Replying as the customer needs this inquiry\'s private link. Use a sample inquiry or one you started in this browser.'); return; }
      $('#sendBtn').disabled = true;
      try { await api(`/api/leads/${id}/customer-reply`, { method: 'POST', body: { text, token: tok } }); ta.value = ''; await renderDetail(id, false); } catch (err) { toast(err.message); } finally { $('#sendBtn').disabled = false; }
    });
    $('#composer').addEventListener('click', (e) => { const q = e.target.closest('[data-q]'); if (q) { $('#replyText').value = q.dataset.q; $('#replyText').focus(); } });
  }
  const working = isWorking(l);
  $('#dEyebrow').textContent = `Inquiry detail / ${svcLabel(l, l.qualification) || 'Not sorted yet'}`;
  $('#dSub').textContent = `${STATUS[l.status][0]} · ${l.source}${l.sourceSimulated ? ' (simulated source)' : ''} · Received ${fmtStamp(l.createdAt)}${l.seed ? ' · sample data' : ''}`;
  $('#dJob').textContent = `${svcLabel(l, l.qualification) || 'Not sorted yet'}${l.qualification?.location ? ' · ' + l.qualification.location : ''}`;
  $('#dChips').innerHTML = html`${R(chip(l.status))}${l.priority === 'urgent' ? R('<span class="chip urgent">Urgent</span>') : ''}`;
  const conv = $('#conv');
  const atEnd = conv.scrollTop + conv.clientHeight >= conv.scrollHeight - 40;
  const sig = l.messages.length + ':' + (working ? 1 : 0);
  conv.innerHTML = l.messages.map((m) => html`<div class="msg ${m.followup ? 'system' : m.from}">${m.text}<span class="time">${fmtStamp(m.ts)} · ${m.from === 'customer' ? 'Customer (demo)' : m.followup ? 'Automatic follow-up, simulated send' : m.note ? 'Demo note' : `${state.cfg?.business?.agentName || 'Assistant'}, simulated send`}</span></div>`).join('') + (working ? '<div class="msg system">The assistant is working...</div>' : '');
  if (atEnd || conv.dataset.sig !== sig) conv.scrollTop = conv.scrollHeight;
  conv.dataset.sig = sig;
  const badge = $('#dBadge'); badge.className = `badge ${working ? 'offline' : ''}`;
  badge.innerHTML = html`<i class="live-dot"></i>${working ? 'Working' : 'Completed'}`;
  paintTimeline(l.timeline);
  $('#facts').innerHTML = factsHtml(l, d.followupSpeedup);
  return working;
}

// Re-render the timeline only when it changed, and keep any "Arguments and result" box the viewer has open.
function paintTimeline(timeline) {
  const tl = $('#tl');
  const sig = timeline.length + ':' + (timeline.at(-1)?.id || '');
  if (tl.dataset.sig === sig) return;
  const open = new Set([...tl.querySelectorAll('details[open][data-step]')].map((d) => d.dataset.step));
  tl.innerHTML = timeline.length ? timeline.map((t) => timelineItem(t)).join('') : '<p class="sub">No steps yet.</p>';
  tl.querySelectorAll('details[data-step]').forEach((d) => { if (open.has(d.dataset.step)) d.open = true; });
  tl.dataset.sig = sig;
}

function timelineItem(t) {
  const cls = t.kind === 'guard' ? 'guard' : t.ok === false ? 'bad' : t.kind === 'followup' ? 'followup' : t.kind === 'function' || t.kind === 'done' ? 'done' : '';
  const modeTxt = t.mode === 'model' ? 'AI model' : t.mode === 'timer' ? 'timer' : 'built-in rules';
  const rawBox = t.fn ? html`<details class="raw" data-step="${t.id}"><summary>Technical details</summary><pre>${JSON.stringify({ function: t.fn, args: t.args, result: t.result }, null, 2)}</pre></details>` : '';
  return html`<div class="timeline-item ${cls}"><strong>${t.title}</strong>${t.fn ? R(html`<small>${t.source === 'guardrail' ? 'Done by a safety check' : t.source === 'model' ? 'Chosen by the AI model' : 'Done by the built-in rules'}</small>`) : ''}${t.detail && !t.fn ? R(html`<small>${t.detail}</small>`) : ''}${R(rawBox)}<time>+${t.sinceLeadMs < 1000 ? t.sinceLeadMs + ' ms' : (t.sinceLeadMs / 1000).toFixed(1) + ' s'} from receipt · ${fmtTime(t.ts, true)} · ${modeTxt}${t.ms ? ` · step took ${t.ms} ms` : ''}</time></div>`;
}

// Plain words for a fallback reason (a short code from the server: a rule id or an error class, never message text).
const RULE_WORDS = { booking_claim: 'booking claim', booking_change: 'claim about changing an appointment', free_offer: 'free offer', promise: 'promise', link: 'link or web address', price: 'price outside the approved range', injection: 'instruction override', contact: 'contact details', too_long: 'too long', think: 'reasoning text', reasoning: 'reasoning text', leak: 'internal wording', json: 'tool or JSON text', tool_text: 'tool names', markup: 'markup', invalid_args: 'invalid message', dangling: 'promise to look something up', no_times: 'open times missing', bad_time: 'offered a time that is not open' };
function fallbackText(code) {
  if (!code) return '';
  const [kind, detail = ''] = String(code).split(':');
  const rule = RULE_WORDS[detail] || detail.replace(/_/g, ' ');
  if (kind === 'text_rejected' || kind === 'tool_rejected') return `model reply was rejected: ${rule}`;
  if (kind === 'empty_end') return detail === 'length' ? 'model reply was cut off before any answer' : detail === 'reasoning_only' ? 'model sent reasoning but no answer' : 'model sent no usable reply';
  if (kind === 'model_timeout') return 'model call timed out';
  if (kind === 'model_error') return `model call failed: ${rule.replace(/^http /, 'HTTP ')}`;
  if (kind === 'loop_limit') return 'model did not finish';
  if (kind === 'quota') return 'hourly AI limit reached';
  if (kind === 'offline') return 'AI model switched off or not connected';
  if (kind === 'offer_pick') return 'the customer chose among times already offered';
  if (kind === 'availability_lookup') return 'availability lookup';
  if (kind === 'safety_path') return 'urgent or sensitive message handled in code';
  return '';
}

function factsHtml(l, speedup) {
  const q = l.qualification; const rows = [];
  const add = (k, v) => rows.push(html`<dt>${k}</dt><dd>${v}</dd>`);
  add('First reply', l.replyTimeSec == null ? 'Not yet' : l.seed ? `${replyText(l.replyTimeSec, l.lastRunMode)} (simulated)` : `${secs(l.replyTimeSec)} (measured)`);
  if (l.offTopic) add('Scope', R('<span class="chip scope">Outside scope</span>'));
  if (l.confirmNeeded) add('Teammate to confirm', l.confirmNeeded);
  { const by = l.answeredBy || l.lastReplyBy; const base = by === 'safety' ? 'Safety rules' : by === 'model' ? 'AI model' : by === 'rules' ? 'Built-in rules' : l.lastRunMode === 'model' ? 'AI model' : l.lastRunMode === 'offline' ? 'Built-in rules' : 'Pending';
    const why = by === 'model' ? '' : fallbackText(l.fallbackReason);
    add('Answered by', why ? `${base} (${why})` : base); }
  if (q) {
    add('Service', q.serviceLabel);
    add('Priority', l.priority === 'urgent' ? 'urgent' : q.urgency);
    if (state.cfg?.serviceArea) add('Service area', q.serviceAreaOk === true ? `In area (${q.areaMatch})` : q.serviceAreaOk === false ? `Outside area (${q.areaMatch})` : 'Not confirmed');
    if (q.urgency !== 'emergency') add('Price range we may quote', q.priceRange ? `$${q.priceRange.low.toLocaleString()}–$${q.priceRange.high.toLocaleString()}` : 'No quote, cost confirmed in person');
  }
  if (l.booking) add('Booking', `${fmtSlot(l.booking.slot_id)} · ${l.booking.kind === 'emergency_hold' ? 'priority hold' : 'confirmed'}`);
  const fu = l.followups.at(-1);
  if (fu) add('Follow-up', fu.status === 'pending' ? `Due at ${fmtTime(fu.dueAt, true)} (${fu.delayMinutes} minutes in real life, shortened to ${Math.round((fu.dueAt - fu.createdAt) / 1000)} seconds for the demo)` : fu.status === 'fired' ? `Sent at ${fmtTime(fu.firedAt, true)}` : `Cancelled (${fu.reason})`);
  if (l.humanReason) add('Why a person is needed', l.humanReason);
  return rows.join('');
}

// ---------- Calendar ----------
const ROW = 54;
async function renderCalendar(start, { quiet = false } = {}) {
  const c = await api(`/api/calendar${start ? '?start=' + start : ''}`);
  state.calStart = c.start;
  const calSig = JSON.stringify([c.days, c.calendar]);
  const gcal = c.calendar?.connected === true;
  if (quiet && state.calSig === calSig) return; // nothing changed: leave the page (and scroll position) alone
  state.calSig = calSig;
  const cols = c.days;
  const label = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(d + 'T00:00:00Z'));
  const dname = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(d + 'T00:00:00Z')).toUpperCase();
  const clock = (t) => { const h = Number(t.slice(0, 2)); return `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`; };
  const grp = { a: '', b: 'pink', c: 'green' };
  const GROUP = Object.fromEntries((state.cfg?.services || []).map((x) => [x.id, x.group]));
  const WH = state.cfg?.hours?.windowHours || 1;
  const starts0 = Object.values(state.cfg?.hours?.starts || {}).flat().map((t) => Number(t.slice(0, 2)));
  const H0 = starts0.length ? Math.min(...starts0) : 8; const H1 = starts0.length ? Math.max(...starts0) + WH : 17;
  const mm = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const overlapsBusy = (day, s) => (day.busy || []).some((b) => mm(b.start) < mm(s.end) && mm(b.end) > mm(s.start));
  const colHtml = (day) => {
    const blocks = day.slots.map((s) => {
      const top = (Number(s.start.slice(0, 2)) - H0) * ROW + 3; const h = WH * ROW - 6;
      if (s.status === 'booked') {
        const b = s.booking; const cls = b.kind === 'existing' ? 'existing' : grp[GROUP[b.service]] || '';
        const tag = b.leadId ? `<button class="event ${cls}" style="top:${top}px;height:${h}px" data-lead="${esc(b.leadId)}" aria-label="Open ${esc(b.name)}" title="${esc(b.serviceLabel)} · ${esc(b.name)} · ${clock(s.start)}">` : `<div class="event ${cls}" style="top:${top}px;height:${h}px" title="${esc(b.serviceLabel)} · ${esc(b.name)} · ${clock(s.start)}">`;
        const end = b.leadId ? '</button>' : '</div>';
        return `${tag}<strong>${esc(b.serviceLabel)}${b.kind === 'emergency_hold' ? ' (priority hold)' : ''}</strong><small>${esc(b.name)} · ${clock(s.start)}</small>${end}`;
      }
      if (s.status === 'busy') return ''; // drawn from the day's busy blocks below
      if (s.status === 'unchecked') return `<div class="open past" style="top:${top}px;height:${h}px">Calendar not checked</div>`;
      if (s.status === 'past' && overlapsBusy(day, s)) return ''; // the Busy card already covers this hour; do not stack a "Past" label under it
      return `<div class="open ${s.status === 'past' ? 'past' : ''}" style="top:${top}px;height:${h}px">${s.status === 'past' ? (s.date < c.today ? 'Past' : 'Too soon') : 'Open'} · ${clock(s.start)}</div>`;
    }).join('');
    const mins = (t) => (Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))) / 60;
    const busy = (day.busy || []).map((b) => {
      const s0 = Math.max(mins(b.start), H0); const e0 = Math.min(mins(b.end), H1);
      if (e0 <= s0) return '';
      return `<div class="event busyfeed" style="top:${(s0 - H0) * ROW + 2}px;height:${Math.max((e0 - s0) * ROW - 4, 14)}px" title="Busy (Google Calendar)"><strong>Busy</strong><small>Google Calendar</small></div>`;
    }).join('');
    const starts = day.slots.map((x) => Number(x.start.slice(0, 2)));
    let closed = '';
    for (let h = H0; h < H1; h += 1) {
      if (!starts.some((st) => h >= st && h < st + WH)) closed += `<div class="closed" style="top:${(h - H0) * ROW}px;height:${ROW}px">${day.slots.length === 0 ? (h === H0 ? 'Closed' : '') : 'Not bookable'}</div>`;
    }
    return `<div class="daycol" style="height:${(H1 - H0) * ROW}px">${closed}${busy}${blocks}</div>`;
  };
  const hours = Array.from({ length: H1 - H0 }, (_, i) => `<div class="hlabel">${clock(String(H0 + i).padStart(2, '0'))}</div>`).join('');
  const agenda = cols.map((day) => `<h3>${esc(dname(day.date))} ${esc(label(day.date))}${day.today ? ' (today)' : ''}</h3>` + (day.slots.length ? '' : '<div class="row past"><span>Closed</span><span></span></div>') + day.slots.map((s) => `<div class="row ${s.status === 'open' ? 'free' : s.status === 'past' ? 'past' : ''}"><span>${esc(clock(s.start))}–${esc(clock(s.end))}</span><span>${s.status === 'booked' ? esc(s.booking.serviceLabel + ' · ' + s.booking.name) : s.status === 'busy' ? 'Busy (Google Calendar)' : s.status === 'unchecked' ? 'Calendar not checked' : s.status === 'open' ? 'Open' : s.date < c.today ? 'Past' : 'Too soon'}</span></div>`).join('') + (day.busy || []).filter((b) => !day.slots.some((x) => mm(b.start) < mm(x.end) && mm(b.end) > mm(x.start))).map((b) => `<div class="row"><span>${esc(clock(b.start))}–${esc(b.end === '24:00' ? 'midnight' : clock(b.end))}</span><span>Busy (Google Calendar)</span></div>`).join('')).join('');
  $('#view').innerHTML = html`
    <div class="heading"><div><div class="eyebrow">Your week at a glance</div><h1>Calendar</h1><p class="sub">Booked and open appointment times from ${gcal ? 'your connected Google Calendar and the demo bookings' : 'the demo calendar'}. The assistant books only the open times shown here.</p>${R(calendarBadge(c))}${R(calendarNotices(c))}</div>
      <div class="actions"><button class="btn ghost small" data-week="${c.prev}" aria-label="Previous week">‹ Prev</button><span class="btn ghost small" style="pointer-events:none">${label(cols[0].date)} – ${label(cols[5].date)}, ${cols[0].date.slice(0, 4)}</span><button class="btn ghost small" data-week="${c.next}" aria-label="Next week">Next ›</button></div></div>
    <div class="card" style="padding:15px">
      <div class="week-wrap"><div class="week"><div></div>${R(cols.map((d) => html`<div class="dayhead ${d.today ? 'today' : ''}">${dname(d.date)}<small>${label(d.date)}</small></div>`).join(''))}
        <div class="hourcol">${R(hours)}</div>${R(cols.map(colHtml).join(''))}</div></div>
      <div class="agenda">${R(agenda)}</div>
    </div>
    <div class="legend-row"><span>● Booked by the assistant</span><span style="color:#8791b2">● Existing ${state.cfg.business.customerWord}s (sample)</span>${R(calendarLegend(c))}<span style="margin-left:auto">All times ${tzName(state.cfg.business.tz)} · Appointments are ${WH} hour${WH === 1 ? '' : 's'} · ${state.cfg.hoursText}</span></div>
    <p class="foot">Demo data is fictional; messages are simulated.</p>`;
  $('#view').onclick = (e) => {
    const w = e.target.closest('[data-week]'); if (w) { renderCalendar(w.dataset.week); return; }
    const ev = e.target.closest('[data-lead]'); if (ev) location.hash = `#/lead/${ev.dataset.lead}`;
  };
}

// ---------- Results ----------
async function renderResults(scope = 'live') {
  const m = await api(`/api/metrics?scope=${scope}`);
  const sk = m.sampleLeads; const ms = m.measured;
  const bars = chartSvg(m.chart);
  const withSample = m.scope === 'all';
  $('#view').innerHTML = html`
    <div class="heading"><div><div class="eyebrow">${withSample ? 'Live replies plus the fictional sample day' : 'Live replies only'}</div><h1>Results</h1><p class="sub">Numbers come from the inquiries stored in this app. The dashboard shows how long each reply actually took. The sample day is fictional and labeled as such.</p></div>
      <select class="btn ghost" id="scope" aria-label="Data scope"><option value="live">Live replies only (measured)</option><option value="all">Include simulated sample data</option></select></div>
    <div class="stat-grid">
      <div class="card stat"><label>Typical reply time${ms.answered ? ` (median of ${ms.answered} live repl${ms.answered === 1 ? 'y' : 'ies'})` : ''}</label><strong>${ms.medianSec == null ? '—' : replyText(ms.medianSec, ms.model.answered && !ms.rules.answered ? 'model' : 'rules')}</strong><small class="dim">${ms.answered ? `AI model: ${ms.model.answered ? secs(ms.model.medianSec) + ' (' + ms.model.answered + ')' : 'none yet'} · Built-in rules: ${ms.rules.answered ? secs(ms.rules.medianSec) + ' (' + ms.rules.answered + ')' : 'none yet'}` : 'No live replies yet'}</small></div>
      <div class="card stat"><label>Inquiries answered</label><strong>${m.answered}</strong><small class="dim">of ${m.totalLeads} received${withSample ? ' (includes the fictional sample)' : ''}</small></div>
      <div class="card stat"><label>Appointments booked</label><strong>${m.booked}</strong><small>${m.bookedRate == null ? 'No data yet' : m.bookedRate + '% of answered inquiries' + (withSample ? ' (sample is fictional)' : '')}</small></div>
      <div class="card stat"><label>Needs a person</label><strong>${m.human}</strong><small class="dim">${m.humanRate == null ? 'No data yet' : m.humanRate + '% need judgment or a follow-up call'}</small></div>
    </div>
    <div class="card chart"><div class="chart-head"><div><h2>Reply time per inquiry</h2><p class="sub" style="margin-top:4px">Time from the inquiry arriving to the first reply · latest ${m.chart.length} answered</p></div>
      <div class="legend"><span><i></i>Built-in rules</span><span><i class="l2"></i>AI model</span>${withSample ? R('<span><i class="l4"></i>Fictional sample</span>') : ''}</div></div>
      ${R(bars)}</div>
    <p class="foot">${m.liveLeads} live inquir${m.liveLeads === 1 ? 'y' : 'ies'} and ${sk} fictional sample inquir${sk === 1 ? 'y' : 'ies'} in this workspace. The sample inquiries were generated by the built-in rules on a simulated clock, so their times are not measurements. Nothing is really sent.</p>`;
  $('#scope').value = scope;
  $('#scope').addEventListener('change', (e) => renderResults(e.target.value));
}

function chartSvg(data) {
  if (!data.length) return '<div class="empty">No answered inquiries yet. Simulate one from the Live Inbox and it will appear here.</div>';
  const narrow = window.innerWidth < 600;
  const d = narrow ? data.slice(-7) : data;
  const W = 760; const H = 280; const L = 44; const T = 22; const B = 36; const iw = W - L - 10; const ih = H - T - B;
  const top = Math.max(...d.map((x) => x.sec));
  const inMs = top < 1; // all replies under a second: scale the axis in milliseconds so the bars are visible
  const max = inMs ? Math.max(0.02, Math.ceil(top * 1000 / 20) * 20 / 1000) : Math.max(5, Math.ceil(top / 5) * 5);
  const bw = Math.min(34, (iw / d.length) * 0.55);
  const y = (v) => T + ih - (v / max) * ih;
  let out = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart of reply time for the latest ${d.length} inquiries. ">`;
  for (let i = 0; i <= 4; i += 1) { const v = (max / 4) * i; out += `<line x1="${L}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" stroke="#ffffff14"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${inMs ? Math.round(v * 1000) + ' ms' : Number.isInteger(v) ? v : v.toFixed(1)}</text>`; }
  d.forEach((x, i) => {
    const cx = L + (iw / d.length) * (i + 0.5); const live = x.mode === 'model'; const sim = x.seed;
    out += `<defs><linearGradient id="g${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sim ? '#8791b2' : live ? '#77cfff' : '#d575ff'}"/><stop offset="1" stop-color="${sim ? '#5a6486' : live ? '#4778df' : '#7652e9'}"/></linearGradient></defs>`;
    out += `<rect x="${cx - bw / 2}" y="${y(x.sec)}" width="${bw}" height="${T + ih - y(x.sec)}" rx="5" fill="url(#g${i})"><title>${esc(x.name)}: ${x.sec} s${sim ? ' (simulated sample)' : ''}</title></rect>`;
    out += `<text class="val" x="${cx}" y="${y(x.sec) - 6}" text-anchor="middle">${x.sec < 1 ? Math.round(x.sec * 1000) + ' ms' : x.sec.toFixed(1)}</text><text x="${cx}" y="${H - 14}" text-anchor="middle">${esc(x.name.slice(0, 9))}</text>`;
  });
  out += '</svg>';
  return out;
}

// ---------- Guardrails ----------
function renderGuardrails() {
  const c = state.cfg;
  const priced = c.services.filter((x) => x.price);
  const quote = c.services.filter((x) => !x.price).map((x) => x.label);
  $('#view').innerHTML = html`
    <div class="heading"><div><div class="eyebrow">Safety</div><h1>Guardrails</h1><p class="sub">These checks run in software for ${c.business.name}, so they still apply if the AI model gets something wrong. Customer text is treated as data, never as instructions.</p></div></div>
    <div class="grid2">
      <div class="card"><div class="card-head"><h2>What the assistant is blocked from doing</h2></div><div class="card-body"><ul class="rules">
        <li><b>Book outside business hours.</b> ${c.hoursText}. Times come only from the demo calendar.</li>
        <li><b>Double book.</b> A taken time is refused at write time.</li>
        <li><b>Quote a price outside the approved range.</b> Any dollar amount outside the range set for the service is blocked; otherwise the assistant gives the range or says the cost is confirmed in person.</li>
        <li><b>Promise discounts, refunds, guarantees or free work,</b> or send links.</li>
        <li><b>Follow instructions hidden in a customer message.</b> If a message tells the assistant to ignore its rules (a "prompt injection"), it is flagged and handed to a person.</li></ul></div></div>
      <div class="card"><div class="card-head"><h2>Always handed to a person</h2></div><div class="card-body"><ul class="rules">
        <li><b>${c.urgency.label}:</b> flagged urgent for a person to call. The customer is told: "${c.urgency.safetyNote}"</li>
        <li><b>Possible medical emergencies</b> in any business: the customer is told to call 911, and the inquiry is flagged for a person.</li>
        <li><b>Complaints and angry ${c.business.customerWord}s.</b></li>
        ${c.alwaysHuman.map((t) => R(html`<li><b>${upper1(t.replace(/\.$/, ''))}.</b></li>`))}
        <li><b>Schedule changes</b> to an existing booking, or anyone asking for a person.</li>
        <li><b>Out of scope${c.serviceArea ? ' or out of area' : ''}</b> requests, and unclear requests after two questions.</li>
        <li><b>If the AI repeatedly tries something not allowed.</b></li></ul></div></div>
      ${c.serviceArea ? R(html`<div class="card"><div class="card-head"><h2>Service area</h2></div><div class="card-body"><div class="pillbox">${c.serviceArea.cities.map((x) => R(html`<span>${x}</span>`))}</div></div></div>`) : ''}
      <div class="card"><div class="card-head"><h2>Approved price ranges</h2></div><div class="card-body" style="padding:0"><table class="table"><thead><tr><th>Service</th><th>Price range</th></tr></thead><tbody>${priced.map((p) => R(html`<tr><td>${p.label}</td><td>$${p.price.low.toLocaleString()}–$${p.price.high.toLocaleString()}</td></tr>`))}</tbody></table><p class="sub" style="padding:12px 16px">${quote.length ? `No price quoted by the assistant for: ${quote.join(', ')}. ${c.wording.noQuote}` : 'Every service has a configured range.'}</p></div></div>
    </div>
    <p class="foot">Demo data is fictional; messages are simulated. Follow-ups normally wait 30 minutes; the demo shortens that to ${Math.max(1, Math.round(1800 / c.followupSpeedup))} seconds so you can watch one. All of this comes from the business profile "${c.profile}".</p>`;
}

// ---------- router ----------
async function route() {
  clearTimeout(state.timer);
  const [, name = 'inbox', arg] = location.hash.split('/');
  const view = `${name}/${arg || ''}`;
  const first = state.view !== view; state.view = view;
  setNav(name === 'lead' ? 'inbox' : name);
  $('#crumb').textContent = { inbox: 'Live Inbox', lead: 'Inquiry Detail', calendar: 'Calendar', results: 'Results', guardrails: 'Guardrails' }[name] || 'Live Inbox';
  $('.search').hidden = name !== 'inbox';
  let again = 3000;
  try {
    if (!state.cfg) { state.cfg = await api('/api/config'); state.tz = state.cfg.business.tz; await paintSwitcher(); }
    // The detail page polls only its own lead; the inbox list is fetched when you are on a page that shows it.
    if (!(name === 'lead' && arg) && name !== 'calendar') await refreshLeads();
    else if (first || !state.agent) await refreshLeads();
    if (name === 'lead' && arg) { const working = await renderDetail(arg, first); again = working ? 1200 : 3000; }
    else if (name === 'calendar') { await renderCalendar(first ? undefined : state.calStart, { quiet: !first }); again = 8000; }
    else if (name === 'results') { if (first) await renderResults(); again = 0; }
    else if (name === 'guardrails') { renderGuardrails(); again = 0; }
    else { await renderInbox(first); again = 2500; }
    state.failures = 0;
  } catch (err) {
    if (/Unknown business profile/.test(err.message)) { try { sessionStorage.removeItem('fa-profile'); } catch { /* ignore */ } location.replace('/'); return; }
    if (name === 'lead') { $('#view').innerHTML = html`<a class="back" href="#/inbox">&larr; Back to Live Inbox</a><div class="card empty">${err.message}</div>`; again = 0; }
    else toast(err.message);
    state.failures += 1;
  }
  if (again) {
    // Back off: slower when the tab is hidden and after errors (for example "Too many requests"), so polling never trips the limit.
    if (document.hidden) again = Math.max(again * 5, 15000);
    if (state.failures > 0) again = Math.min(60000, again * 2 ** Math.min(state.failures, 5));
  }
  if (again) state.timer = setTimeout(() => { if (state.view === view) route(); }, again);
}

$('#search').addEventListener('input', (e) => { state.query = e.target.value; if (state.view.startsWith('inbox') && $('#rows')) paintInbox(); });
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden) route(); });
route();
