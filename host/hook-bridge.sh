#!/bin/bash
# 大肥鱼 · 宿主事件桥（源文件；由 host/install-hooks.py 装进 agent 的 hooks 目录）
#
# 唯一职责：把 stdin 里的 JSON 转给桌宠；桌宠没在跑就顺手拉起它，并把这条事件补投进去。
#
# 三条铁律（每条都是踩出来的）：
#   1. 必须 exit 0 —— 非零会阻断工具调用。她的存在不该让 agent 变坏
#   2. 必须够快 —— 这个脚本串在 agent 每一步前面**同步**执行
#   3. 事件不能丢 —— 她冷启动要几秒，这段时间的事件必须排队补投
#
# 这个文件里**没有任何机器相关的常量**。路径全部来自同目录的 dafeiyu.env（安装时生成）：
#   DAFEIYU_ROOT      仓库根（含 package.json）
#   DAFEIYU_ELECTRON  Electron 可执行文件
#   DAFEIYU_USERDATA  Electron 的 userData 目录（端口文件在这儿）
#   DAFEIYU_PORT      HTTP 端口
#
# 没装适配器时这个脚本应该什么都不做 —— 直接 exit 0，不报错、不刷日志。

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SELF_DIR/dafeiyu.env"

[ -f "$ENV_FILE" ] || exit 0
# shellcheck disable=SC1090
. "$ENV_FILE"

[ -n "$DAFEIYU_ROOT" ] && [ -n "$DAFEIYU_ELECTRON" ] || exit 0
[ -d "$DAFEIYU_ROOT" ] && [ -x "$DAFEIYU_ELECTRON" ] || exit 0

FLAG="$SELF_DIR/pet-enabled"
PORT_FILE="$DAFEIYU_USERDATA/pet-port.txt"
LOCK="$DAFEIYU_USERDATA/launching"

# 读 stdin。用 read 内建而不是 $(cat)：省一次 fork，这一步串在 agent 每步前面
PAYLOAD=""
IFS= read -r -d '' PAYLOAD 2>/dev/null
[ -n "$PAYLOAD" ] || exit 0
# 超长 payload（大段工具输出）桌宠也用不上，省掉传输
[ ${#PAYLOAD} -gt 100000 ] && exit 0

# 排障日志：只有手动建了 pet-debug 文件才写，平时零开销
if [ -f "$SELF_DIR/pet-debug" ]; then
  printf '%s\t%s\n' "$(date '+%H:%M:%S')" "$PAYLOAD" >> "$SELF_DIR/pet-events.log" 2>/dev/null
fi

read_port() {
  PORT=""
  read -r PORT 2>/dev/null < "$PORT_FILE"
  # 端口文件理论上带换行，但历史版本可能没有，兜底清一下空白
  PORT="$(printf '%s' "$PORT" | tr -d '[:space:]')"
}

deliver() {
  # --noproxy '*' 不是可选的：机器上设了 HTTP_PROXY 的话，curl 会把 127.0.0.1 也
  # 送去代理，而多数代理拒绝 POST 回环地址 —— 表现是「她活着但一句话都听不见」，
  # 且不报错。本地回环永远不该走代理。
  curl -s -f -m 1 --noproxy '*' -X POST "http://127.0.0.1:$1/hook" \
    -H 'Content-Type: application/json' \
    --data-binary "$PAYLOAD" >/dev/null 2>&1
}

read_port

if [ -z "$PORT" ]; then
  # ── 她不在（或正在冷启动）────────────────────────────
  # 拉起她
  NEED_LAUNCH=1
  if [ -f "$LOCK" ]; then
    # stat 的 -f（BSD/macOS）和 -c（GNU/Linux）不通用，两个都试
    AGE=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || echo 0) ))
    [ "$AGE" -lt 12 ] && NEED_LAUNCH=0   # 刚拉过，别重复拉
  fi
  if [ "$NEED_LAUNCH" = "1" ]; then
    mkdir -p "$DAFEIYU_USERDATA" 2>/dev/null
    touch "$LOCK" 2>/dev/null
    # 异常退出（强杀/断电）会留下 Singleton* 残骸，Electron 拿不到锁会起不来 —— 启动前清掉
    rm -f "$DAFEIYU_USERDATA/SingletonLock" "$DAFEIYU_USERDATA/SingletonCookie" "$DAFEIYU_USERDATA/SingletonSocket" 2>/dev/null
    (
      # ELECTRON_RUN_AS_NODE 会让 Electron 退化成一个纯 node，窗口起不来 —— 必须摘掉
      env -u ELECTRON_RUN_AS_NODE "$DAFEIYU_ELECTRON" "$DAFEIYU_ROOT" >/dev/null 2>&1 &
    )
  fi
  # 这条事件不能丢：Electron 冷启动要几秒，等端口写出来再补投（后台，不阻塞 agent）。
  # 踩过的坑：原来这里直接 exit 0 —— 于是他在她家说的第一句话永远召唤不出她，
  # 而「第一句话」恰恰是这个产品最主要的入口。
  (
    i=0
    while [ $i -lt 60 ]; do
      [ -s "$PORT_FILE" ] && break
      sleep 0.2
      i=$((i + 1))
    done
    P=""
    read -r P 2>/dev/null < "$PORT_FILE"
    P="$(printf '%s' "$P" | tr -d '[:space:]')"
    [ -n "$P" ] && deliver "$P"
  ) &
  exit 0
fi

# ── 端口在：她应该在跑 ────────────────────────────────
# 端口在但开关没了：她已经退出了，别白送
[ -f "$FLAG" ] || exit 0

# 放后台：不占 agent 的时间，桌宠侧也会先回包再处理。
# 顺带自愈：投递失败说明她其实已经死了（强杀/崩溃留下僵尸端口文件），
# 清掉残留文件，下一条事件就会走「拉起」分支 —— 否则她会永久消失。
(
  deliver "$PORT" || {
    curl -s -m 1 --noproxy '*' "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || {
      rm -f "$PORT_FILE" "$FLAG" 2>/dev/null
    }
  }
) &

exit 0
