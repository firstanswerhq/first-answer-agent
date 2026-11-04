const $ = (s) => document.querySelector(s);
let agentName = 'Booking assistant'; let bizName = 'our team'; let leadId = null; let token = null; let timer = null;
try { const saved = JSON.parse(sessionStorage.getItem('fa-lead') || 'null'); if (saved) { leadId = saved.id; token = saved.token; } } catch { /* storage unavailable */ }

const fmt = (ts) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(ts));
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

$('#leadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target); $('#err').textContent = ''; $('#submit').disabled = true;
  e.target.querySelectorAll('input,textarea').forEach((el) => el.removeAttribute('aria-invalid'));
  try {
    const r = await post('/api/leads', Object.fromEntries(f));
    leadId = r.id; token = r.token;
    try { sessionStorage.setItem('fa-lead', JSON.stringify({ id: leadId, token })); } catch { /* ignore */ }
    show();
  } catch (err) {
    $('#err').textContent = err.message;
    // Mark the field that needs attention.
    const bad = /name/i.test(err.message) && !/phone/i.test(err.message) ? '#name' : /phone/i.test(err.message) ? '#phone' : /message/i.test(err.message) ? '#message' : null;
    if (bad) { $(bad).setAttribute('aria-invalid', 'true'); $(bad).focus(); }
  } finally { $('#submit').disabled = false; }
});

$('#replyForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const ta = $('#replyText'); const text = ta.value.trim(); if (!text) return;
  $('#err2').textContent = '';
  try { await post(`/api/public/leads/${leadId}/messages`, { token, text }); ta.value = ''; poll(true); } catch (err) { $('#err2').textContent = err.message; }
});

function show() { $('#formView').hidden = true; $('#threadView').hidden = false; poll(true); }

async function poll(now) {
  clearTimeout(timer);
  try {
    const res = await fetch(`/api/public/leads/${leadId}?token=${encodeURIComponent(token)}`);
    if (res.status === 404) {
      // The conversation is gone (for example the demo data was reloaded). Say so instead of silently showing a blank form.
      sessionStorage.removeItem('fa-lead');
      leadId = null; token = null;
      $('#threadView').hidden = true; $('#formView').hidden = false;
      $('#err').textContent = 'That conversation is no longer available. The demo data may have been reloaded. You can start a new one below.';
      return;
    }
    if (!res.ok) { timer = setTimeout(poll, 6000); return; }
    const d = await res.json();
    const conv = $('#conv'); conv.textContent = '';
    for (const m of d.messages) {
      const div = document.createElement('div'); div.className = `msg ${m.from === 'customer' ? 'customer' : 'agent'}`;
      div.append(document.createTextNode(m.text));
      const t = document.createElement('span'); t.className = 'time'; t.textContent = `${fmt(m.ts)} · ${m.from === 'customer' ? 'You' : `${agentName}, simulated`}`; div.append(t); conv.append(div);
    }
    // Customer-facing wording only: no timings, no internal modes.
    $('#status').textContent = d.replyTimeSec == null ? 'Waiting for the first reply...' : d.handedToHuman ? `We got your message. A person from ${bizName} will follow up.` : d.booked ? 'Your appointment is booked.' : 'You have a reply below.';
    $('#mode').textContent = 'Demo';
    conv.scrollTop = conv.scrollHeight;
    timer = setTimeout(poll, d.replyTimeSec == null ? 800 : 3000);
  } catch { timer = setTimeout(poll, 4000); }
  void now;
}
fetch('/api/config').then((r) => r.json()).then((c) => {
  agentName = c.business.agentName; bizName = c.business.name;
  document.documentElement.style.setProperty('--accent', c.business.accent);
  document.title = `${c.business.name} - Contact us`;
  $('#biz').textContent = c.business.name;
  const small = document.createElement('small'); small.textContent = c.business.tagline; $('#biz').append(small);
  $('#formEyebrow').textContent = c.wording.formEyebrow; $('#formTitle').textContent = c.wording.formTitle; $('#formIntro').textContent = c.wording.formIntro;
  $('#message').placeholder = c.wording.formPlaceholder;
}).catch(() => { /* the form still works with its default wording */ });
if (leadId && token) show();
