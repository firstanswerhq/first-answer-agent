#!/usr/bin/env bash
# First Answer Agent: Vultr startup script for Ubuntu 24.04 (also valid as cloud-init user-data
# when the first line stays "#!/usr/bin/env bash").
#
# Paste into Vultr: Products > Startup Scripts > Add, then pick it when you deploy a Cloud Compute VM.
# Set the variables below (or export them before running by hand). NOTHING secret lives in the repo:
# the script writes secrets to /etc/first-answer-agent.env (root:agent, mode 640) at install time.
#
# Result: Node 22, the app as a systemd service on port 80, firewall allowing only 22 and 80,
# and a systemd timer that git-pulls and restarts every 2 minutes (redeploy by pushing).
set -euo pipefail

# ---- variables (edit here or pass in the environment) -------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/firstanswerhq/first-answer-agent}"
REPO_BRANCH="${REPO_BRANCH:-main}"
VULTR_INFERENCE_KEY="${VULTR_INFERENCE_KEY:-}"            # leave empty to run in offline rules mode
VULTR_INFERENCE_URL="${VULTR_INFERENCE_URL:-https://api.vultrinference.com/v1}"
VULTR_INFERENCE_MODEL="${VULTR_INFERENCE_MODEL:-glm-5.3-flash}"
BUSINESS_NAME="${BUSINESS_NAME:-Harbor Lane Home Services}"
FOLLOWUP_SPEEDUP="${FOLLOWUP_SPEEDUP:-60}"                 # demo clock for follow-up timers (1 = real time)
# --------------------------------------------------------------------------------------------------

APP_USER=agent
APP_DIR=/opt/first-answer-agent
ENV_FILE=/etc/first-answer-agent.env
export DEBIAN_FRONTEND=noninteractive

echo "[1/7] Installing packages"
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
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "[4/7] Writing $ENV_FILE (secrets come from the variables above, never from the repo)"
q() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
umask 077
cat > "$ENV_FILE" <<ENV
PORT=80
HOST=0.0.0.0
DATA_FILE=/var/lib/first-answer-agent/state.json
VULTR_INFERENCE_KEY="$(q "$VULTR_INFERENCE_KEY")"
VULTR_INFERENCE_URL="$(q "$VULTR_INFERENCE_URL")"
VULTR_INFERENCE_MODEL="$(q "$VULTR_INFERENCE_MODEL")"
BUSINESS_NAME="$(q "$BUSINESS_NAME")"
FOLLOWUP_SPEEDUP=$FOLLOWUP_SPEEDUP
ENV
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
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
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
StateDirectory=first-answer-agent
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

echo "[6/7] Installing the 2-minute git-pull timer"
cat > /usr/local/bin/first-answer-agent-update <<UPDATE
#!/usr/bin/env bash
set -euo pipefail
cd $APP_DIR
git config --global --add safe.directory $APP_DIR >/dev/null 2>&1 || true
git fetch --quiet origin $REPO_BRANCH
LOCAL=\$(git rev-parse HEAD)
REMOTE=\$(git rev-parse origin/$REPO_BRANCH)
if [ "\$LOCAL" != "\$REMOTE" ]; then
  git reset --hard origin/$REPO_BRANCH
  if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
  chown -R $APP_USER:$APP_USER $APP_DIR
  systemctl restart first-answer-agent.service
  echo "Updated to \$REMOTE"
fi
UPDATE
chmod 755 /usr/local/bin/first-answer-agent-update

cat > /etc/systemd/system/first-answer-agent-update.service <<UNIT
[Unit]
Description=Pull and restart First Answer Agent when the repo changes

[Service]
Type=oneshot
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

echo "[7/7] Firewall (22 and 80 only) and start"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw --force enable

systemctl daemon-reload
systemctl enable --now first-answer-agent.service
systemctl enable --now first-answer-agent-update.timer

sleep 3
curl -fsS http://127.0.0.1/api/health && echo && echo "First Answer Agent is up on port 80."
