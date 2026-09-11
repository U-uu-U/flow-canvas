#!/usr/bin/env bash
# Flow Canvas 模型能力 CONFIG 服务 —— Linux 一键安装/升级脚本（Debian/Ubuntu、RHEL/CentOS 通用）
#
#   sudo ./install.sh                       # 用默认值安装（域名 artconfig.ravenhash.org，端口 8087）
#   sudo ./install.sh --domain artconfig.ravenhash.org --port 8087
#   sudo ./install.sh --password '你的密码'  # 指定管理密码（不指定则随机生成并打印一次）
#   sudo ./install.sh                         # 重复执行 = 升级代码并重启，数据与密码保持不变
#
# 它做这些事：
#   1. 创建系统用户 flowconfig 与目录（代码 /srv/flow-config，数据 /var/lib/flow-config）
#   2. 复制服务端代码（不含 data/ 与 node_modules/），安装 ajv
#   3. 生成管理密码哈希到 <数据目录>/admin.json（600，仅服务用户可读）
#   4. 安装 systemd 单元并启动（服务只监听 127.0.0.1:<端口>）
#
# 它不做的事：不碰任何反向代理 / 证书 —— 反代（Caddy、nginx 都行）由你自己配，
# 只需把请求转发到 127.0.0.1:<端口> 并带上 X-Forwarded-For / X-Forwarded-Proto。
#
# 停止 / 卸载用同目录的 stop.sh：
#   sudo ./stop.sh                # 停止
#   sudo ./stop.sh --disable      # 停止并取消开机自启
#   sudo ./stop.sh --uninstall    # 删除单元与代码（保留数据；加 --purge 连数据一起删）
set -euo pipefail

DOMAIN="artconfig.ravenhash.org"
PORT="8087"
APP_DIR="/srv/flow-config"
DATA_DIR="/var/lib/flow-config"
APP_USER="flowconfig"
PASSWORD=""
START_SERVICE=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --domain) DOMAIN="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --app-dir) APP_DIR="$2"; shift 2 ;;
        --data-dir) DATA_DIR="$2"; shift 2 ;;
        --user) APP_USER="$2"; shift 2 ;;
        --password) PASSWORD="$2"; shift 2 ;;
        --no-start) START_SERVICE=0; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "未知参数：$1（--help 查看用法）" >&2; exit 2 ;;
    esac
done

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "请用 root 运行（sudo $0 ...）"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[[ -f "$SRC_DIR/server.mjs" ]] || die "找不到 $SRC_DIR/server.mjs —— 请在解压出来的 configserver 目录里运行"

# ── 1. 依赖检查 ──────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "没有 node，请先装 Node.js 20+（apt install nodejs / dnf install nodejs，或用 nodesource 源）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node 版本过低（当前 $(node -v)），需要 20 及以上"
log "Node $(node -v) ✓"

# ── 2. 用户与目录 ────────────────────────────────────────────
if ! id -u "$APP_USER" >/dev/null 2>&1; then
    log "创建系统用户 $APP_USER"
    if command -v useradd >/dev/null 2>&1; then
        useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null \
            || useradd --system --no-create-home --shell /sbin/nologin "$APP_USER"
    else
        adduser --system --no-create-home --disabled-login "$APP_USER"
    fi
fi

mkdir -p "$APP_DIR" "$DATA_DIR/configs"
log "目录：代码 $APP_DIR · 数据 $DATA_DIR"

# ── 3. 复制代码（幂等：重复执行 = 升级） ─────────────────────
if [[ "$(readlink -f "$SRC_DIR")" != "$(readlink -f "$APP_DIR")" ]]; then
    log "复制服务端代码到 $APP_DIR"
    tar -C "$SRC_DIR" --exclude=./data --exclude=./node_modules --exclude=./.git -cf - . \
        | tar -C "$APP_DIR" -xf -
else
    log "已在目标目录内运行，跳过复制"
fi

# ── 4. 安装 ajv（可选依赖，装不上也能跑，只是降级为结构校验） ──
if command -v npm >/dev/null 2>&1; then
    log "安装依赖（仅 ajv）"
    ( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund >/tmp/flow-config-npm.log 2>&1 ) \
        || warn "npm install 失败（见 /tmp/flow-config-npm.log）：服务端会以降级的结构校验模式运行，建议之后手动补装"
else
    warn "没有 npm：跳过依赖安装，服务端会以降级的结构校验模式运行"
fi

# ── 5. 管理密码 ──────────────────────────────────────────────
ADMIN_FILE="$DATA_DIR/admin.json"
PLAINTEXT=""
if [[ -n "$PASSWORD" ]]; then
    PLAINTEXT="$PASSWORD"
elif [[ -f "$ADMIN_FILE" ]]; then
    log "保留已有的管理密码（$ADMIN_FILE）"
else
    PLAINTEXT="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(9).toString("base64url"))')"
    log "已随机生成管理密码"
fi

if [[ -n "$PLAINTEXT" ]]; then
    [[ ${#PLAINTEXT} -ge 8 ]] || die "管理密码至少 8 位"
    CONFIG_DATA_DIR="$DATA_DIR" CONFIG_ADMIN_PASSWORD="$PLAINTEXT" node "$APP_DIR/server.mjs" --hash-password >/dev/null
    chmod 600 "$ADMIN_FILE"
fi

# ── 6. 权限与 systemd ────────────────────────────────────────
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

ENV_FILE=/etc/default/flow-config
cat > "$ENV_FILE" <<EOF
# Flow Canvas CONFIG 服务（不含任何明文凭据；密码哈希在 $ADMIN_FILE）
# 端口 / 数据目录 / 对外域名以 systemd 单元里的 Environment= 为准，
# 需要临时覆盖时在这里加同名变量即可（EnvironmentFile 优先级更高）。
# 例：CONFIG_COOKIE_SECURE=1
EOF
chmod 644 "$ENV_FILE"

UNIT=/etc/systemd/system/flow-config.service
sed -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    -e "s|__USER__|$APP_USER|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__DOMAIN__|$DOMAIN|g" \
    "$SCRIPT_DIR/flow-config.service" > "$UNIT"
log "已写入 $UNIT"

systemctl daemon-reload
if [[ "$START_SERVICE" == "1" ]]; then
    systemctl enable --now flow-config >/dev/null
    log "服务已启动：systemctl status flow-config"
fi

# ── 7. 自检 + 下一步 ─────────────────────────────────────────
sleep 1
HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
echo
if [[ -n "$HEALTH" ]]; then
    log "本机自检通过：$HEALTH"
else
    warn "本机 /health 没通，先看日志：journalctl -u flow-config -n 50 --no-pager"
fi

cat <<EOF

──────────────────────────────── 部署完成 ────────────────────────────────

服务已在 127.0.0.1:$PORT 上运行（默认只监听本机；systemd 单元里配的 CONFIG_HOST/CONFIG_PORT）。

反向代理与证书由你自己配置，只需要把请求转发到 127.0.0.1:$PORT，并带上这两个头：
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
（前者用于登录限流计数，后者用于自动给管理会话 cookie 加 Secure；不配也能跑。）

本机验证（不经过反代）
  curl -s http://127.0.0.1:$PORT/health
  curl -s http://127.0.0.1:$PORT/config | head -c 200
  # 管理面板：http://127.0.0.1:$PORT/admin   （外网走你自己的反代域名）

管理密码：${PLAINTEXT:-（沿用已有密码，见 $ADMIN_FILE）}
$( [[ -n "$PLAINTEXT" ]] && echo "⚠️  这串密码只显示这一次，请立刻存进密码管理器。" )

常用命令
  journalctl -u flow-config -f                  # 看日志
  systemctl restart flow-config                 # 重启
  sudo ./stop.sh                                # 停止
  sudo ./stop.sh --disable                      # 停止并取消开机自启
  sudo ./stop.sh --uninstall                    # 卸载（保留数据；加 --purge 连数据一起删）
  sudo ./install.sh                             # 升级代码（数据与密码保留）
  tar czf ~/flow-config-backup-\$(date +%F).tgz -C $DATA_DIR .   # 备份版本库
EOF
