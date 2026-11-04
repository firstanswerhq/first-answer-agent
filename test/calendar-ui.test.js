// The Calendar page header pieces must reach the page as HTML, not as escaped text (review 10, B1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { html, R } from '../public/tpl.js';
import { calendarBadge, calendarNotices, calendarLegend } from '../public/calnotes.js';

const ok = { calendar: { configured: true, connected: true, stale: false, unsupportedRules: 0, warnings: 0 } };
const down = { calendar: { configured: true, connected: false, notice: 'Using the demo calendar <b>now</b>.' } };

test('the html helper escapes plain strings and passes R() through', () => {
  assert.equal(html`<p>${'<i>x</i>'}</p>`, '<p>&lt;i&gt;x&lt;/i&gt;</p>');
  assert.equal(html`<p>${R('<i>x</i>')}</p>`, '<p><i>x</i></p>');
});

test('connected: badge and legend are real elements once placed in the page template', () => {
  const page = html`<div>${R(calendarBadge(ok))}${R(calendarNotices(ok))}</div><footer>${R(calendarLegend(ok))}</footer>`;
  assert.match(page, /<span class="badge" id="calBadge">Connected: Google Calendar \(read-only\)<\/span>/);
  assert.match(page, /<span style="color:#b3b8cc">● Busy \(Google Calendar, titles hidden\)<\/span>/);
  assert.ok(!page.includes('&lt;'), 'nothing is escaped into visible text');
  assert.ok(!page.includes('id="calNotice"'));
});

test('fallback: the plain notice is a real element and the event text is escaped', () => {
  const page = html`<div>${R(calendarBadge(down))}${R(calendarNotices(down))}</div>`;
  assert.match(page, /<div class="note" id="calNotice" role="status"><strong>Demo calendar in use\.<\/strong>/);
  assert.ok(!page.includes('id="calBadge"'));
  assert.ok(page.includes('&lt;b&gt;now&lt;/b&gt;'), 'server text stays escaped');
  assert.equal(calendarLegend(down), '');
});

test('not configured: nothing is added', () => {
  const none = { calendar: { configured: false, connected: false } };
  assert.equal(calendarBadge(none) + calendarNotices(none) + calendarLegend(none), '');
});

test('app.js inserts these pieces with R()', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  for (const f of ['calendarBadge', 'calendarNotices', 'calendarLegend']) assert.ok(src.includes(`R(${f}(c))`), f);
  assert.match(src, /import \{ calendarBadge, calendarNotices, calendarLegend \} from '\.\/calnotes\.js';/, 'the helpers are imported (a missing import broke the page once)');
});
