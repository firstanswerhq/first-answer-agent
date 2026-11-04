"""Playwright screenshots of every screen at 1440x900 and 390 wide. Usage: python3 scripts/screenshots.py OUT_DIR [BASE_URL]"""
import os, sys
from playwright.sync_api import sync_playwright

out = sys.argv[1]
base = sys.argv[2] if len(sys.argv) > 2 else 'http://localhost:3111'
os.makedirs(out, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, (w, h) in {'desktop': (1440, 900), 'mobile': (390, 844)}.items():
        pg = b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=1)
        errs = []
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        full = name == 'mobile'
        pg.goto(base + '/#/inbox'); pg.wait_for_selector('#rows tr'); pg.wait_for_timeout(400)
        pg.screenshot(path=f'{out}/{name}-1-inbox.png', full_page=full)
        pg.click('#rows tr:nth-child(1)'); pg.wait_for_selector('.timeline-item'); pg.wait_for_timeout(400)
        pg.screenshot(path=f'{out}/{name}-2-detail.png', full_page=full)
        pg.goto(base + '/#/calendar'); pg.wait_for_selector('.legend-row'); pg.wait_for_timeout(500)
        pg.screenshot(path=f'{out}/{name}-3-calendar.png', full_page=full)
        pg.goto(base + '/#/results'); pg.wait_for_selector('.chart-svg'); pg.wait_for_timeout(400)
        pg.screenshot(path=f'{out}/{name}-4-results.png', full_page=full)
        pg.goto(base + '/#/guardrails'); pg.wait_for_timeout(500)
        pg.screenshot(path=f'{out}/{name}-5-guardrails.png', full_page=full)
        pg.goto(base + '/lead'); pg.wait_for_timeout(400)
        pg.screenshot(path=f'{out}/{name}-6-leadform.png', full_page=full)
        print(name, 'console errors:', errs)
    b.close()
