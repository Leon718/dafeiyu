#!/bin/bash
# 大肥鱼 · 一键安装
#
# 它住在 WorkBuddy 里，运行引擎用 WorkBuddy 自带的那一份 ——
# 所以这个脚本**不装任何东西**，只做三件事：
#   ① 确认前置条件  ② 确认 WorkBuddy 在（没有就直接报错退出）  ③ 把事件桥装进去
#
# 不写系统目录、不用 sudo、不碰 agent 的其它配置（只并 hooks 键，且先备份）。
#
# 用法：
#   bash install.sh
#
# 环境变量：
#   DAFEIYU_HOST_DIR  宿主配置目录，默认 ~/.workbuddy（换成别的 agent 时才需要）
#   DAFEIYU_HOME      她的人格放在别处时指定（默认 <userData>/persona）
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

say() { printf '%s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

# ---- 1. 前置 ----
say '① 检查前置条件'
[ -f package.json ] || die "请在仓库根目录运行（找不到 package.json）"

# 安装器本身只要 python3：读 settings.json、复制桥脚本、写 env。不需要 pip，不需要 npm。
if ! command -v python3 >/dev/null 2>&1; then
  die "没找到 python3。macOS 上执行 xcode-select --install 即可（或用系统自带版本）"
fi
say "   python3 $(python3 -V 2>&1 | awk '{print $2}')"

# 事件桥用 curl 往本地端口发事件（macOS / 主流 Linux 都自带）
if ! command -v curl >/dev/null 2>&1; then
  die "没找到 curl。事件桥靠它给桌宠投递事件，装一个再来（macOS 自带）"
fi

# node 只有跑测试和调试工具才需要。装她不需要，所以缺了只提示不拦。
if command -v node >/dev/null 2>&1; then
  say "   node    $(node -v)  （仅调试/测试用）"
else
  say "   node    未装 —— 不影响安装，只有 npm test / npm start 需要"
fi

# ---- 2. 宿主必须在 ----
# 这一步是这个项目的前提，不是「建议」。没有 WorkBuddy 就没有运行引擎，
# 项目不下载、不降级 —— 所以直接停下，别让人装到最后才发现跑不起来。
say ''
say '② 确认 WorkBuddy 在'
HOST_DIR="${DAFEIYU_HOST_DIR:-$HOME/.workbuddy}"

if [ ! -f "$HOST_DIR/settings.json" ]; then
  cat >&2 <<EOF

✗ 您没有安装 WorkBuddy（或缺 $HOST_DIR/settings.json）

  这个桌宠是住在 WorkBuddy 里的，运行引擎用的是 WorkBuddy 自带的那一份，
  项目本身不带运行引擎、也不做降级 —— 没有宿主它没有存在的意义。

  请先：
    1) 安装 WorkBuddy：https://www.workbuddy.cn/
    2) 启动它至少一次（让它把运行时和配置准备好）
    3) 再回来跑 bash install.sh

  如果你的宿主不是 WorkBuddy，指过去再跑：
    DAFEIYU_HOST_DIR=/path/to/its/config bash install.sh
EOF
  exit 1
fi
say "   host    $HOST_DIR"

# 找运行引擎。找不到同样直接停 —— 不给「去装个 Electron」这种旁门。
ELECTRON_BIN="$(python3 host/install-hooks.py which-electron 2>/dev/null)" || ELECTRON_BIN=""
[ -n "$ELECTRON_BIN" ] || die "没检测到 WorkBuddy 自带的运行引擎
  已确认 $HOST_DIR/settings.json 存在，但 $HOST_DIR/binaries 下没有找到。
  常见原因：WorkBuddy 装好后没启动过（运行时是首次启动才备好的）。
  启动一次再回来跑。仍然不行就把这条的输出发出来：
    python3 host/install-hooks.py status"
say "   engine  $ELECTRON_BIN"

# ---- 3. 装 hook ----
say ''
say '③ 把事件桥装进 WorkBuddy'
python3 host/install-hooks.py install || die "安装 hook 失败（上面的提示通常已经说明原因）"

say ''
say '装完了。接下来：'
say '  · 重启 WorkBuddy（已经开着的会话不会热加载 hook）'
say '  · 然后正常干活，她会自己出现'
say ''
say '验证：python3 host/install-hooks.py status'
say '卸载：python3 host/install-hooks.py uninstall'
