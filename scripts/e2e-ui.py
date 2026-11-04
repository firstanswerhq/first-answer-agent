"""Drives the real UI: simulate a lead from the dashboard, role-play the customer, submit the public form."""
import sys
from playwright.sync_api import sync_playwright
base = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
out = sys.argv[2] if len(sys.argv) > 2 else '/tmp'
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(base + '/#/inbox'); pg.wait_for_selector('#rows tr')
    pg.click('#simBtn'); pg.click('[data-sc=gutter_quote]')
    pg.wait_for_selector('#conv .msg.agent'); pg.wait_for_timeout(1200)
    pg.fill('#replyText', 'The first one works for me'); pg.click('#sendBtn')
    pg.wait_for_selector('.chip.booked', timeout=8000); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{out}/e2e-detail-booked.png')
    pg2 = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=1)
    pg2.on('pageerror', lambda e: errs.append(str(e)))
    pg2.goto(base + '/lead')
    pg2.fill('#name', 'Casey Fictional'); pg2.fill('#phone', '(615) 555-0155')
    pg2.fill('#message', 'Roof leak after the storm, 37206 East Nashville. Active leak, water in the hallway!')
    pg2.click('#submit'); pg2.wait_for_selector('#conv .msg.agent'); pg2.wait_for_timeout(600)
    pg2.screenshot(path=f'{out}/e2e-public-thread.png', full_page=True)
    print('status line:', pg2.inner_text('#status'))
    print('errors:', errs)
    b.close()
