#!/usr/bin/env bash
# 一键部署到 Ubuntu / Debian 云服务器（root 执行）
#   bash install.sh                 # 只用 IP:8099 访问
#   bash install.sh demo.example.com  # 顺带配 Caddy 自动 HTTPS（域名需先解析到本机）
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/zhxy-clone
SVC=zhxy-clone
PORT=8099

echo "==> 1/6 安装基础依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates ufw >/dev/null

echo "==> 2/6 安装 Node.js 24"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

echo "==> 3/6 部署代码到 $APP_DIR"
mkdir -p "$APP_DIR/data"
# 若当前目录就是项目目录，直接同步；否则提示手动上传
if [ -f ./server.js ] && [ -d ./public ]; then
  cp -r ./server.js ./package.json ./package-lock.json ./public "$APP_DIR/" 2>/dev/null || true
else
  echo "!! 未在当前目录找到 server.js/public，请先把项目文件放到 $APP_DIR 后重跑"
fi
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true
chown -R www-data:www-data "$APP_DIR" 2>/dev/null || useradd -r -s /bin/false zhxy && chown -R zhxy:zhxy "$APP_DIR"

echo "==> 4/6 生成访问口令并写 systemd 服务"
CODE="$(head -c 6 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 8)"
cat >/etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=Zhxy Clone Demo
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=DATA_DIR=$APP_DIR/data
Environment=NODE_ENV=production
Environment=SHOW_DEV_CODE=1
Environment=ACCESS_CODE=$CODE
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now $SVC
sleep 2
systemctl --no-pager --lines=5 status $SVC || true

echo "==> 5/6 防火墙"
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw allow $PORT/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

if [ -n "$DOMAIN" ]; then
  echo "==> 6/6 配置 Caddy 自动 HTTPS（$DOMAIN）"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  cat >/etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}
}
EOF
  systemctl reload caddy || systemctl restart caddy
  URL="https://$DOMAIN"
else
  echo "==> 6/6 跳过 HTTPS（未给域名）"
  IP="$(curl -s --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
  URL="http://$IP:$PORT"
fi

echo
echo "============ 部署完成 ============"
echo "  地址：     $URL"
echo "  访问口令： $CODE"
echo "  账号：     admin / Admin@2026    teacher1 / Teach@2026    root / Root@2026"
echo "  数据目录： $APP_DIR/data/data.db"
echo "  查看日志： journalctl -u $SVC -f"
echo "  重启服务： systemctl restart $SVC"
echo "=================================="
