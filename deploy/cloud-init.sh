#!/usr/bin/env bash
# First Answer Agent: Vultr startup script for Ubuntu 24.04 (also valid as cloud-init user-data
# when the first line stays "#!/usr/bin/env bash").
#
# Paste into Vultr: Products > Startup Scripts > Add, then pick it when you deploy a Cloud Compute VM.
# Set the variables below (or export them before running by hand). NOTHING secret lives in the repo:
# the script writes secrets to /etc/first-answer-agent.env (root:root, mode 600) at install time.
# systemd reads that file as root, so the app user never needs read access to it.
#
# Result: Node 22, the app as a systemd service on port 80, firewall allowing only 22 (rate limited) and 80,
# and a systemd timer that git-pulls and restarts every 2 minutes (redeploy by pushing). While judges are using the
# demo, freeze it: AUTO_UPDATE=0 at install, or later `systemctl disable --now first-answer-agent-update.timer`, or pin a
# release with REPO_PIN=<tag or commit> (see "Freeze the demo" in the README).
set -euo pipefail
# Vultr may run this from a directory the service user cannot enter (for example /root); start from /.
cd /

# ---- variables (edit here or pass in the environment) -------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/firstanswerhq/first-answer-agent}"
REPO_BRANCH="${REPO_BRANCH:-main}"
VULTR_INFERENCE_KEY="${VULTR_INFERENCE_KEY:-}"            # leave empty to run in offline rules mode
VULTR_INFERENCE_URL="${VULTR_INFERENCE_URL:-https://api.vultrinference.com/v1}"
VULTR_INFERENCE_MODEL="${VULTR_INFERENCE_MODEL:-glm-5.3-flash}"
BUSINESS_PROFILE="${BUSINESS_PROFILE:-dental}"                # a file name in config/profiles (dental, salon, accounting, or your own)
BUSINESS_NAME="${BUSINESS_NAME:-}"                          # optional override of the name in the profile
TRUST_PROXY="${TRUST_PROXY:-}"                              # set to 1 only if you put Caddy/nginx in front (see README); forced to 1 when DOMAIN is set
DOMAIN="${DOMAIN:-}"                                        # optional host name for automatic HTTPS via Caddy, e.g. 155-138-206-164.sslip.io (see README)
NTFY_TOPIC="${NTFY_TOPIC:-}"                                # optional ntfy topic for owner phone alerts (empty = no alerts)
DASHBOARD_URL="${DASHBOARD_URL:-}"                          # optional link included in the owner alert
FOLLOWUP_SPEEDUP="${FOLLOWUP_SPEEDUP:-60}"                 # demo clock for follow-up timers (1 = real time)
AUTO_UPDATE="${AUTO_UPDATE:-1}"                             # 0 = install the update timer but leave it switched off
REPO_PIN="${REPO_PIN:-}"                                    # optional tag or commit to stay on; the update timer then never moves off it
# --------------------------------------------------------------------------------------------------

# A key pasted into a web form often carries a trailing newline or spaces; keys never contain whitespace.
VULTR_INFERENCE_KEY="$(printf '%s' "$VULTR_INFERENCE_KEY" | tr -d '[:space:]')"

# Without DOMAIN the app itself listens on port 80 (plain HTTP). With DOMAIN, Caddy owns 80/443 and the app listens
# on loopback only, so the one public way in is HTTPS.
if [ -n "$DOMAIN" ]; then
  APP_PORT=8080; APP_HOST=127.0.0.1; TRUST_PROXY=1
  LOCAL_HEALTH_URL="http://127.0.0.1:8080/api/health"
else
  APP_PORT=80; APP_HOST=0.0.0.0
  LOCAL_HEALTH_URL="http://127.0.0.1/api/health"
fi

APP_USER=agent
APP_DIR=/opt/first-answer-agent
ENV_FILE=/etc/first-answer-agent.env
export DEBIAN_FRONTEND=noninteractive

echo "[1/7] Installing packages"
# On a fresh Ubuntu image unattended-upgrades often holds the dpkg lock for a minute or two. Make every apt call
# (including the ones inside the NodeSource setup script) wait up to 5 minutes for it instead of aborting.
cat > /etc/apt/apt.conf.d/99first-answer-lock-timeout <<'APTCONF'
DPkg::Lock::Timeout "300";
APTCONF
apt-get update -y
apt-get install -y curl git ufw ca-certificates gnupg

echo "[2/7] Installing Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "[3/7] Creating service user and cloning the repo"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
# The repo and node_modules are owned by the app user, and every git/npm command below runs AS that user, so git never
# reports "dubious ownership" and dependency install scripts never run as root.
as_app() { runuser -u "$APP_USER" -- env HOME="$APP_DIR" "$@"; }
mkdir -p "$APP_DIR"
chown "$APP_USER":"$APP_USER" "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  as_app git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
fi
if [ -n "$REPO_PIN" ]; then
  as_app git -C "$APP_DIR" fetch --quiet --tags origin
  as_app git -C "$APP_DIR" checkout --quiet --detach "$REPO_PIN"
  printf '%s\n' "$REPO_PIN" > /etc/first-answer-agent.pin
fi
if [ -f "$APP_DIR/package-lock.json" ]; then
  as_app npm --prefix "$APP_DIR" ci --omit=dev --ignore-scripts
else
  as_app npm --prefix "$APP_DIR" install --omit=dev --ignore-scripts
fi

echo "[4/7] Writing $ENV_FILE (secrets come from the variables above, never from the repo)"
q() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
umask 077
cat > "$ENV_FILE" <<ENV
PORT=$APP_PORT
HOST=$APP_HOST
DATA_FILE=/var/lib/first-answer-agent/state.json
VULTR_INFERENCE_KEY="$(q "$VULTR_INFERENCE_KEY")"
VULTR_INFERENCE_URL="$(q "$VULTR_INFERENCE_URL")"
VULTR_INFERENCE_MODEL="$(q "$VULTR_INFERENCE_MODEL")"
BUSINESS_PROFILE="$(q "$BUSINESS_PROFILE")"
BUSINESS_NAME="$(q "$BUSINESS_NAME")"
NTFY_TOPIC="$(q "$NTFY_TOPIC")"
DASHBOARD_URL="$(q "$DASHBOARD_URL")"
FOLLOWUP_SPEEDUP=$FOLLOWUP_SPEEDUP
TRUST_PROXY=$TRUST_PROXY
ENV
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"
umask 022

echo "[5/7] Installing the systemd service"
cat > /etc/systemd/system/first-answer-agent.service <<UNIT
[Unit]
Description=First Answer Agent
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
StateDirectory=first-answer-agent
StateDirectoryMode=0700
UMask=0077
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=600M

[Install]
WantedBy=multi-user.target
UNIT

echo "[6/7] Installing the 2-minute git-pull timer"
# Runs as root from systemd, but every git/npm command is executed as the app user (runuser), so there is no
# "dubious ownership" error and no root-run npm. A failed update is rolled back, logged loudly and makes the unit fail.
cat > /usr/local/bin/first-answer-agent-update <<UPDATE
#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR="$APP_DIR"
APP_USER="$APP_USER"
BRANCH="$REPO_BRANCH"
HEALTH_URL="$LOCAL_HEALTH_URL"
UPDATE
cat >> /usr/local/bin/first-answer-agent-update <<'UPDATE'
cd /
# To freeze the demo: put a tag or commit in this file (echo v1.0 | sudo tee /etc/first-answer-agent.pin). Remove the file to follow the branch again.
PIN_FILE="${PIN_FILE:-/etc/first-answer-agent.pin}"
PIN=""
if [ -f "$PIN_FILE" ]; then PIN="$(tr -d '[:space:]' < "$PIN_FILE")"; fi
as_app() { runuser -u "$APP_USER" -- env HOME="$APP_DIR" "$@"; }
say() { echo "first-answer-agent-update: $*"; }
trap 'echo "first-answer-agent-update: UPDATE FAILED at line $LINENO (see lines above); the running version was left in place or rolled back" >&2' ERR
install_deps() {
  if [ -f "$APP_DIR/package-lock.json" ]; then as_app npm --prefix "$APP_DIR" ci --omit=dev --ignore-scripts
  else as_app npm --prefix "$APP_DIR" install --omit=dev --ignore-scripts; fi
}
healthy() {
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
rollback() {
  say "rolling back to $LOCAL"
  as_app git -C "$APP_DIR" reset --hard "$LOCAL" || true
  install_deps || true
  systemctl restart first-answer-agent.service || true
}

as_app git -C "$APP_DIR" fetch --quiet --tags origin "$BRANCH"
LOCAL=$(as_app git -C "$APP_DIR" rev-parse HEAD)
if [ -n "$PIN" ]; then REMOTE=$(as_app git -C "$APP_DIR" rev-parse "$PIN^{commit}"); else REMOTE=$(as_app git -C "$APP_DIR" rev-parse "origin/$BRANCH"); fi
if [ "$LOCAL" = "$REMOTE" ]; then exit 0; fi

say "updating $LOCAL -> $REMOTE"
as_app git -C "$APP_DIR" reset --hard "$REMOTE"
if ! install_deps; then
  say "npm install failed for $REMOTE" >&2
  rollback
  exit 1
fi
systemctl restart first-answer-agent.service
if ! healthy; then
  say "health check failed after restart on $REMOTE" >&2
  rollback
  exit 1
fi
say "updated to $REMOTE"
UPDATE
chmod 755 /usr/local/bin/first-answer-agent-update

cat > /etc/systemd/system/first-answer-agent-update.service <<UNIT
[Unit]
Description=Pull and restart First Answer Agent when the repo changes

[Service]
Type=oneshot
SyslogIdentifier=first-answer-agent-update
ExecStart=/usr/local/bin/first-answer-agent-update
UNIT

cat > /etc/systemd/system/first-answer-agent-update.timer <<UNIT
[Unit]
Description=Check for First Answer Agent updates every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
Unit=first-answer-agent-update.service

[Install]
WantedBy=timers.target
UNIT

echo "[7/7] Firewall (22 rate limited, and 80${DOMAIN:+, 443}) and start"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp
ufw allow 80/tcp
if [ -n "$DOMAIN" ]; then ufw allow 443/tcp; fi
ufw --force enable

systemctl daemon-reload
systemctl enable --now first-answer-agent.service

if [ -n "$DOMAIN" ]; then
  echo "DOMAIN=$DOMAIN: installing Caddy (official apt repo) for automatic HTTPS"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
  mkdir -p /etc/caddy
  # Caddy gets a Let's Encrypt certificate for DOMAIN by itself and redirects http to https.
  cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
	reverse_proxy 127.0.0.1:$APP_PORT
}
CADDY
  # Start order: the app first, then Caddy. Restarting only the app (the update script does this) never touches Caddy.
  mkdir -p /etc/systemd/system/caddy.service.d
  cat > /etc/systemd/system/caddy.service.d/10-first-answer-agent.conf <<DROPIN
[Unit]
After=first-answer-agent.service
Wants=first-answer-agent.service
DROPIN
  systemctl daemon-reload
  systemctl enable caddy
  systemctl restart caddy
fi
if [ "$AUTO_UPDATE" = "0" ]; then
  echo "AUTO_UPDATE=0: the update timer is installed but switched off. Turn it on with: systemctl enable --now first-answer-agent-update.timer"
else
  systemctl enable --now first-answer-agent-update.timer
fi

# Wait for the app (the first start loads the sample data, which can take a moment on a small VM).
HEALTH=""
for _ in $(seq 1 45); do
  if HEALTH=$(curl -fsS --max-time 3 "$LOCAL_HEALTH_URL" 2>/dev/null); then break; fi
  HEALTH=""; sleep 2
done
if [ -z "$HEALTH" ]; then
  echo "WARNING: the app did not answer on port $APP_PORT within 90 seconds. Check: journalctl -u first-answer-agent" >&2
  exit 1
fi
echo "$HEALTH"
echo "First Answer Agent is up on port $APP_PORT."
if [ -n "$DOMAIN" ]; then
  # The first certificate takes a moment (DNS lookup, ACME challenge on port 80). Retry for up to 5 minutes.
  PUBLIC_OK=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1; then PUBLIC_OK=1; break; fi
    sleep 5
  done
  if [ "$PUBLIC_OK" = 1 ]; then
    echo "HTTPS OK: https://$DOMAIN/api/health answered with a valid certificate."
  else
    echo "WARNING: https://$DOMAIN/api/health did not answer within 5 minutes (certificate still pending?). The app itself is healthy at $LOCAL_HEALTH_URL. Check: journalctl -u caddy" >&2
  fi
fi
if [ -z "$VULTR_INFERENCE_KEY" ]; then
  echo "WARNING: no VULTR_INFERENCE_KEY was set, so this VM runs in OFFLINE RULES MODE, not the live model." >&2
else
  # A key being present proves nothing. The app makes one tiny test call to the model at start-up and reports the result
  # in /api/health: modelVerified is true only after a real, successful call.
  VERIFIED=0
  for _ in $(seq 1 20); do
    H=$(curl -fsS --max-time 3 "$LOCAL_HEALTH_URL" 2>/dev/null || true)
    if printf '%s' "$H" | grep -q '"modelVerified":true'; then VERIFIED=1; break; fi
    if printf '%s' "$H" | grep -q '"modelVerified":false'; then break; fi
    sleep 2
  done
  if [ "$VERIFIED" = 1 ]; then
    echo "MODEL VERIFIED: the Vultr inference endpoint answered a test call."
  else
    echo "WARNING: the inference key is set, but the model did not answer a test call, so the demo runs in offline rules mode." >&2
    echo "         Last error: $(printf '%s' "${H:-}" | sed -n 's/.*"lastError":"\([^"]*\)".*/\1/p')  (check the key, the model name and 'journalctl -u first-answer-agent')" >&2
  fi
fi
echo "Update log: journalctl -u first-answer-agent-update"
