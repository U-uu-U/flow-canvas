#!/usr/bin/env bash
# Flow Canvas 模型能力 CONFIG 服务 —— 停止 / 卸载脚本
#
#   sudo ./stop.sh                     # 停止服务（systemd 或有 PID/端口可查的手工启动都能停）
#   sudo ./stop.sh --status            # 只看状态，不停
#   sudo ./stop.sh --disable           # 停止并取消开机自启
#   sudo ./stop.sh --uninstall         # 停止 + 取消自启 + 删除 systemd 单元与代码（保留数据）
#   sudo ./stop.sh --uninstall --purge # 连同数据目录（所有 CONFIG 版本与密码）一起删除
#   sudo ./stop.sh --purge --yes       # 不交互确认（给自动化用）
#
# 停止顺序：systemd 单元 → PID 文件 → 按监听端口反查进程。
# 后两种都会先核对进程命令行里是 server.mjs，绝不误杀占用同端口的其它程序。
set -euo pipefail

PORT="8087"
APP_DIR="/srv/flow-config"
DATA_DIR="/var/lib/flow-config"
APP_USER="flowconfig"
UNIT_NAME="flow-config"
UNIT_FILE="/etc/systemd/system/flow-config.service"
TIMEOUT=15
DO_STATUS=0
DO_DISABLE=0
DO_UNINSTALL=0
DO_PURGE=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        --app-dir) APP_DIR="$2"; shift 2 ;;
        --data-dir) DATA_DIR="$2"; shift 2 ;;
        --user) APP_USER="$2"; shift 2 ;;
        --unit) UNIT_NAME="$2"; UNIT_FILE="/etc/systemd/system/$2.service"; shift 2 ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        --status) DO_STATUS=1; shift ;;
        --disable) DO_DISABLE=1; shift ;;
        --uninstall) DO_UNINSTALL=1; shift ;;
        --purge) DO_PURGE=1; shift ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
        *) echo "未知参数：$1（--help 查看用法）" >&2; exit 2 ;;
    esac
done

log()  { printf '\033[1;34m[stop]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

PID_FILE="$DATA_DIR/flow-config.pid"

have_systemd() {
    command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]
}

unit_installed() {
    have_systemd && { [[ -f "$UNIT_FILE" ]] || systemctl list-unit-files "${UNIT_NAME}.service" >/dev/null 2>&1; }
}

systemd_active() {
    have_systemd && systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null
}

# 判断某个 PID 是不是我们的服务：命令行里必须出现 server.mjs
# 优先读 /proc（Linux，最可靠）；没有 /proc 时退回 ps（BSD/macOS、procfs 被 hidepid 限制的情况）。
is_our_process() {
    local pid="$1"
    [[ -n "$pid" ]] || return 1
    if [[ -r "/proc/$pid/cmdline" ]]; then
        tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'server\.mjs'
        return $?
    fi
    command -v ps >/dev/null 2>&1 || return 1
    ps -p "$pid" -o args= 2>/dev/null | grep -q 'server\.mjs'
}

pid_file_pid() {
    [[ -f "$PID_FILE" ]] || return 1
    local pid
    pid="$(tr -dc '0-9' < "$PID_FILE" || true)"
    [[ -n "$pid" ]] || return 1
    is_our_process "$pid" || return 1
    printf '%s' "$pid"
}

# 按监听端口反查 PID：ss → lsof → netstat 依次尝试
port_pid() {
    local pid=""
    if command -v ss >/dev/null 2>&1; then
        pid="$(ss -lntp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p { print $NF }' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
    fi
    if [[ -z "$pid" ]] && command -v lsof >/dev/null 2>&1; then
        pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
    fi
    if [[ -z "$pid" ]] && command -v netstat >/dev/null 2>&1; then
        pid="$(netstat -lntp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p { print $NF }' | cut -d/ -f1 | head -1 || true)"
    fi
    [[ -n "$pid" ]] || return 1
    is_our_process "$pid" || return 1
    printf '%s' "$pid"
}

terminate_pid() {
    local pid="$1" waited=0
    kill -TERM "$pid" 2>/dev/null || die "没有权限结束进程 $pid（试试 sudo）"
    while kill -0 "$pid" 2>/dev/null; do
        if [[ "$waited" -ge "$TIMEOUT" ]]; then
            warn "进程 $pid 在 ${TIMEOUT}s 内没有退出，发送 SIGKILL"
            kill -KILL "$pid" 2>/dev/null || true
            break
        fi
        sleep 1
        waited=$((waited + 1))
    done
}

show_status() {
    if unit_installed; then
        printf '  systemd：%s（%s）\n' "$(systemctl is-active "$UNIT_NAME" 2>/dev/null || echo unknown)" \
            "$(systemctl is-enabled "$UNIT_NAME" 2>/dev/null || echo -)"
    else
        printf '  systemd：未安装 %s 单元\n' "$UNIT_NAME"
    fi
    local pid
    if pid="$(pid_file_pid)"; then printf '  PID 文件：%s（%s）\n' "$PID_FILE" "$pid"
    else printf '  PID 文件：无\n'; fi
    if pid="$(port_pid)"; then printf '  端口 %s：被 server.mjs 占用（pid %s）\n' "$PORT" "$pid"
    else printf '  端口 %s：未被 server.mjs 占用\n' "$PORT"; fi
    printf '  数据目录：%s%s\n' "$DATA_DIR" "$([[ -d "$DATA_DIR" ]] && echo '' || echo '（不存在）')"
}

if [[ "$DO_STATUS" == "1" ]]; then
    log "当前状态："
    show_status
    exit 0
fi

# ── 停止 ─────────────────────────────────────────────────────
STOPPED=""
if systemd_active; then
    log "停止 systemd 服务 $UNIT_NAME"
    systemctl stop "$UNIT_NAME"
    STOPPED="systemd"
    if systemd_active; then
        die "systemctl stop 之后服务仍是 active，请看 journalctl -u $UNIT_NAME -n 50"
    fi
    log "已停止（systemd）"
else
    PID="$(pid_file_pid || true)"
    [[ -n "$PID" ]] || PID="$(port_pid || true)"
    if [[ -n "$PID" ]]; then
        log "停止进程 $PID（非 systemd 管理）"
        terminate_pid "$PID"
        STOPPED="pid:$PID"
        log "已停止（pid $PID）"
    else
        log "服务未在运行（systemd 未激活，端口 $PORT 上也没有 server.mjs）"
    fi
fi

# 清掉陈旧的 PID 文件
if [[ -f "$PID_FILE" ]] && ! pid_file_pid >/dev/null 2>&1; then
    rm -f "$PID_FILE"
fi

# ── 取消开机自启 ─────────────────────────────────────────────
if [[ "$DO_DISABLE" == "1" || "$DO_UNINSTALL" == "1" ]]; then
    if unit_installed; then
        log "取消开机自启"
        systemctl disable "$UNIT_NAME" >/dev/null 2>&1 || warn "systemctl disable 失败（可忽略）"
    fi
fi

# ── 卸载 ─────────────────────────────────────────────────────
if [[ "$DO_UNINSTALL" == "1" ]]; then
    [[ "$(id -u)" == "0" ]] || die "卸载需要 root（sudo $0 --uninstall）"
    if [[ -f "$UNIT_FILE" ]]; then
        rm -f "$UNIT_FILE"
        systemctl daemon-reload
        systemctl reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
        log "已删除 $UNIT_FILE"
    fi
    if [[ -d "$APP_DIR" ]]; then
        rm -rf "$APP_DIR"
        log "已删除代码目录 $APP_DIR"
    fi
    if [[ "$DO_PURGE" == "1" ]]; then
        if [[ -d "$DATA_DIR" ]]; then
            if [[ "$ASSUME_YES" != "1" ]]; then
                printf '\033[1;31m这会永久删除 %s（所有 CONFIG 版本、审计记录与管理密码）。\033[0m\n' "$DATA_DIR" >&2
                printf '确认请输入数据目录路径 %s：' "$DATA_DIR" >&2
                read -r answer
                [[ "$answer" == "$DATA_DIR" ]] || die "输入不匹配，已中止（数据未删除）"
            fi
            rm -rf "$DATA_DIR"
            log "已删除数据目录 $DATA_DIR"
        else
            log "数据目录不存在，无需删除"
        fi
    else
        log "数据目录保留在 $DATA_DIR（要一起删就加 --purge）"
    fi
    echo
    log "卸载完成。"
    exit 0
fi

echo
log "当前状态："
show_status
cat <<EOF

再次启动
  systemctl start $UNIT_NAME            # systemd 安装的情况
  # 手工启动（无 systemd）：cd $APP_DIR && nohup node server.mjs >/dev/null 2>&1 &
EOF
