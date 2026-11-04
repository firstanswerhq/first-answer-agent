import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { cfgFor } from './helpers.js';

const script = fs.readFileSync(path.join(cfgFor().root, 'deploy', 'cloud-init.sh'), 'utf8');

test('deploy script: apt lock wait, app-user git/npm, safe permissions, production env, no global safe.directory hack', () => {
  assert.match(script, /DPkg::Lock::Timeout "300"/);
  assert.match(script, /as_app git clone/);
  assert.match(script, /npm --prefix "\$APP_DIR" ci --omit=dev --ignore-scripts/);
  assert.match(script, /runuser -u "\$APP_USER"/);
  assert.match(script, /chmod 600 "\$ENV_FILE"/);
  assert.match(script, /UMask=0077/);
  assert.match(script, /StateDirectoryMode=0700/);
  assert.match(script, /Environment=NODE_ENV=production/);
  assert.match(script, /TRUST_PROXY=\$TRUST_PROXY/);
  assert.doesNotMatch(script, /safe\.directory/);
  assert.doesNotMatch(script, /chown -R "\$APP_USER"/);
  assert.match(script, /ufw allow 22\/tcp/, 'SSH is left as it was');
  assert.match(script, /OFFLINE RULES MODE/);
});

// Run the generated update script against a local git repo with stubbed runuser/systemctl/curl/npm.
function harness({ npmFails = false, healthFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-update-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }); };
  stub('runuser', 'shift 3; echo "runuser: $*" >> "$CALLS"; exec "$@"');
  stub('systemctl', 'echo "systemctl $*" >> "$CALLS"');
  stub('npm', `echo "npm $*" >> "$CALLS"; ${npmFails ? 'if [ -f "$APP_DIR/BREAK" ]; then exit 1; fi' : ''}`);
  stub('curl', `${healthFails ? 'if [ -f "$APP_DIR/BREAK" ]; then exit 22; fi' : ''}\nexit 0`);
  stub('sleep', 'exit 0');
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const origin = path.join(dir, 'origin'); fs.mkdirSync(origin);
  g(origin, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(origin, 'v.txt'), 'one'); fs.writeFileSync(path.join(origin, 'package-lock.json'), '{}');
  g(origin, 'add', '-A'); g(origin, 'commit', '-q', '-m', 'one');
  const app = path.join(dir, 'app');
  g(dir, 'clone', '-q', origin, app);
  // Pull the update script out of cloud-init.sh and write it to a temp path.
  const start = script.indexOf('echo "[6/7]');
  const end = script.indexOf('chmod 755 /usr/local/bin/first-answer-agent-update');
  const target = path.join(dir, 'update.sh');
  const snippet = script.slice(start, end).replaceAll('/usr/local/bin/first-answer-agent-update', target);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: log, APP_DIR: app, APP_USER: os.userInfo().username, REPO_BRANCH: 'main' };
  execFileSync('bash', ['-c', `${snippet}\nchmod 755 "${target}"`], { env: { ...env, APP_DIR: app, APP_USER: env.APP_USER, REPO_BRANCH: 'main' } });
  const run = () => spawnSync('bash', [target], { env, encoding: 'utf8' });
  const push = (text) => { fs.writeFileSync(path.join(origin, 'v.txt'), text); g(origin, 'add', '-A'); g(origin, 'commit', '-q', '-m', text); return g(origin, 'rev-parse', 'HEAD'); };
  return { dir, app, origin, log, run, push, g, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

test('update script: does nothing when up to date, otherwise fetches as the app user, installs, restarts, reports', () => {
  const h = harness();
  const first = h.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(h.calls().includes('systemctl restart'), false);
  const sha = h.push('two');
  const r = h.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`updated to ${sha}`));
  assert.equal(h.g(h.app, 'rev-parse', 'HEAD'), sha);
  assert.match(h.calls(), /runuser: env HOME=\S+ git -C .* fetch/);
  assert.match(h.calls(), /npm --prefix .* ci --omit=dev --ignore-scripts/);
  assert.match(h.calls(), /systemctl restart first-answer-agent\.service/);
});

test('update script: a failing fetch is loud (non-zero exit and an UPDATE FAILED line on stderr)', () => {
  const h = harness();
  fs.rmSync(h.origin, { recursive: true, force: true });
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /UPDATE FAILED/);
});

test('update script: a failed npm install rolls the tree back, restarts the old version and fails visibly', () => {
  const h = harness({ npmFails: true });
  const before = h.g(h.app, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(h.app, 'BREAK'), '1'); // makes the npm stub fail while present
  fs.writeFileSync(path.join(h.origin, 'BREAK'), '1');
  h.push('broken');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /npm install failed/);
  assert.match(r.stdout, /rolling back/);
  assert.equal(h.g(h.app, 'rev-parse', 'HEAD'), before);
  assert.match(h.calls(), /systemctl restart/);
});

test('update script: a failed health check after restart rolls back too', () => {
  const h = harness({ healthFails: true });
  const before = h.g(h.app, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(h.origin, 'BREAK'), '1');
  h.push('bad release');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /health check failed/);
  assert.equal(h.g(h.app, 'rev-parse', 'HEAD'), before);
});
