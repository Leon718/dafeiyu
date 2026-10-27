#!/usr/bin/env python3
"""把桌宠的事件桥装进 agent 的 hooks。

做三件事：
  1. 找到宿主自带的运行引擎，和仓库位置、userData 路径一起写进 dafeiyu.env
  2. 把 hook-bridge.sh 复制到 hooks 目录（脚本自己不含任何绝对路径，全靠 env）
  3. 往 settings.json 的 `hooks` 里并进 13 个事件

**这个项目不自带运行引擎，也不做降级。** 产品定位是「住在 WorkBuddy 里」，
没有宿主就没有意义，所以找不到宿主就直接报错退出，而不是去下载一份自己的。

只动 settings.json 的 `hooks` 键，其余字段原样保留；每次写入前都备份。

用法：
  python3 host/install-hooks.py install          # 安装（幂等）
  python3 host/install-hooks.py uninstall        # 卸载
  python3 host/install-hooks.py status           # 查看当前状态
  python3 host/install-hooks.py which-electron   # 打印运行引擎路径（给 npm start 用）

目前只实现了 macOS / Linux 的路径约定。Windows 的 userData 在 %APPDATA%，
运行引擎是 .exe —— 逻辑都在 user_data_dir() 和 find_electron() 两个函数里，
要支持 Windows 只需要改这两处。
"""
import glob
import json
import os
import shutil
import sys
import time

HOME = os.path.expanduser('~')
# 宿主的配置目录。默认 WorkBuddy；接别的 agent 时设 DAFEIYU_HOST_DIR 指过去，
# 再把下面的 EVENTS 换成那个宿主的事件名即可 —— hook-bridge.sh 一行都不用改
HOST_DIR = os.path.expanduser(os.environ.get('DAFEIYU_HOST_DIR') or os.path.join(HOME, '.workbuddy'))
SETTINGS = os.path.join(HOST_DIR, 'settings.json')
HOOKS_DIR = os.path.join(HOST_DIR, 'hooks')
TARGET = os.path.join(HOOKS_DIR, 'pet-hook.sh')
ENV_FILE = os.path.join(HOOKS_DIR, 'dafeiyu.env')

# 仓库根 = host/ 的上一级
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'host', 'hook-bridge.sh')

# 必须和 package.json 的 name 一致：Electron 用 app.getName() 决定 userData 目录，
# 两处对不上就会出现「桌宠写 A 目录、桥去 B 目录找端口」的死循环
APP_NAME = 'dafeiyu'

# 覆盖「提问 → 干活 → 等确认 → 出错 → 收工」全流程
EVENTS = [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop',
    'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd',
]


def user_data_dir():
    """Electron 的 userData 目录。规则同 Electron 在三个平台上的默认值。"""
    if sys.platform == 'darwin':
        return os.path.join(HOME, 'Library', 'Application Support', APP_NAME)
    if os.name == 'nt':
        return os.path.join(os.environ.get('APPDATA') or HOME, APP_NAME)
    return os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.join(HOME, '.config'), APP_NAME)


def _exe_rel():
    """运行引擎可执行文件相对于 electron/dist 的路径。"""
    if sys.platform == 'darwin':
        return ('Electron.app', 'Contents', 'MacOS', 'Electron')
    if os.name == 'nt':
        return ('Electron.exe',)
    return ('electron',)


def _usable(path):
    return bool(path) and os.path.isfile(path) and os.access(path, os.X_OK)


def _scan_electron(base, rel, max_depth=7):
    """在 base 下找 electron/dist 里的可执行文件。

    宿主升级可能改布局，所以不能只赌一条写死的路径。但也不能无脑递归：
    binaries 目录实测 1.3G、里面好几个 npm 包，全走一遍要好几秒。
    这里一见到 node_modules 就只放行名为 electron 的那一支，其余整枝剪掉。
    """
    base = os.path.abspath(base)
    if not os.path.isdir(base):
        return None
    for root, dirs, _files in os.walk(base):
        if root[len(base):].count(os.sep) >= max_depth:
            dirs[:] = []
            continue
        if os.path.basename(root) == 'node_modules':
            # node_modules 底下成百上千个包，只有 electron 这一支有用
            dirs[:] = [d for d in dirs if d == 'electron']
        else:
            dirs[:] = [d for d in dirs if d not in ('envs', '.git', '__pycache__')]
        if os.path.basename(root) == 'electron' and os.path.isdir(os.path.join(root, 'dist')):
            p = os.path.join(root, 'dist', *rel)
            if _usable(p):
                return p
            dirs[:] = []
    return None


def find_electron():
    """找宿主自带的运行引擎。找不到就返回 None —— 不下载、不降级。

    项目定位是「住在 WorkBuddy 里」，所以运行引擎从宿主借，仓库里不装一份。
    好处是 clone 下来零依赖；代价是依赖宿主的内部布局（不属于公开契约），
    所以这里分三档找，最后还有一档限深扫描兜底。

    DAFEIYU_ELECTRON 只为开发调试留一个显式闸门 —— 它不能跳过「宿主必须存在」
    这个前提，因为 SETTINGS 的检查在 cmd_install 里更早发生。
    """
    override = os.environ.get('DAFEIYU_ELECTRON')
    if _usable(override):
        return override

    rel = _exe_rel()
    binaries = os.path.join(HOST_DIR, 'binaries')

    # 档 1：宿主当前布局。`node` 是 runtime 名，`workspace` 是它装 npm 包的地方
    direct = os.path.join(binaries, 'node', 'workspace', 'node_modules', 'electron', 'dist', *rel)
    if _usable(direct):
        return direct

    # 档 2：runtime 名变了（node → 别的名字），其余布局没变
    for p in sorted(glob.glob(os.path.join(
            binaries, '*', 'workspace', 'node_modules', 'electron', 'dist', *rel))):
        if _usable(p):
            return p

    # 档 3：限深扫描，布局大改也能找到
    return _scan_electron(binaries, rel)


def write_env(electron):
    """把安装结果写成 shell 能直接 source 的键值对。

    为什么不是 JSON：这个文件每步工具调用前都会被 source 一次，
    JSON 得 fork 一个 python/jq 去解析，白白拖慢 agent。
    """
    os.makedirs(HOOKS_DIR, exist_ok=True)
    lines = [
        '# 由 host/install-hooks.py 生成，卸载时会删掉。',
        '# 手改这个文件等于手改安装结果 —— 装完就别动了。',
        '#',
        '# 每行都带 export：hook-bridge.sh 是把 Electron 当子进程拉起来的，',
        '# 只有 export 过的变量才会被继承。少一个 export，她就会「换家失忆」',
        '# （人格目录回落、日记写到别处），而且不报任何错。',
        'export DAFEIYU_ROOT="%s"' % ROOT,
        'export DAFEIYU_ELECTRON="%s"' % electron,
        'export DAFEIYU_USERDATA="%s"' % user_data_dir(),
        'export DAFEIYU_HOOKS_DIR="%s"' % HOOKS_DIR,
        'export DAFEIYU_PORT="%s"' % os.environ.get('DAFEIYU_PORT', '47823'),
    ]
    # 老用户升级时把原来的家带过来：没有这一行，她会读出厂人格、
    # 把日记写进 content/ —— 人还是那个人，记忆全丢
    persona = os.environ.get('DAFEIYU_HOME')
    if persona:
        lines.append('export DAFEIYU_HOME="%s"' % os.path.expanduser(persona))
    with open(ENV_FILE, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    return ENV_FILE


def desired_hooks():
    return {
        ev: [{'matcher': '', 'hooks': [{'type': 'command',
                                        'command': TARGET,
                                        'timeout': 5}]}]
        for ev in EVENTS
    }


def _is_ours(group):
    """这个 hook 组是不是桌宠装的（用于只动自己的、不碰别人的）"""
    for hk in (group or {}).get('hooks', []):
        if hk.get('command') == TARGET:
            return True
    return False


def merge_hooks(cur, want):
    """把我们的事件组并进去，保留用户自己的 hooks。

    原来这里是 d['hooks'] = want —— 整块覆盖。哪天用户/别的插件往
    settings.json 加了自己的 hook，装桌宠就会把它们静默清掉，且不可撤销。
    """
    merged = dict(cur or {})
    for ev, groups in want.items():
        existing = merged.get(ev) or []
        kept = [g for g in existing if not _is_ours(g)]
        merged[ev] = kept + groups
    return merged


def load_settings():
    with open(SETTINGS, encoding='utf-8') as f:
        return json.load(f)


def save_settings(d):
    tmp = SETTINGS + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    shutil.move(tmp, SETTINGS)


def ensure_script():
    os.makedirs(HOOKS_DIR, exist_ok=True)
    if not os.path.exists(SOURCE):
        print('找不到源脚本: %s' % SOURCE)
        return False
    shutil.copy2(SOURCE, TARGET)
    os.chmod(TARGET, 0o755)
    return True


def die_no_host(reason):
    print('✗ %s' % reason)
    print()
    print('  这个桌宠是住在 WorkBuddy 里的，运行引擎用的是 WorkBuddy 自带的那一份，')
    print('  项目本身不带运行引擎、也不做降级 —— 没有宿主它没有存在的意义。')
    print()
    print('  请先：')
    print('    1) 安装 WorkBuddy：https://www.workbuddy.cn/')
    print('    2) 启动它至少一次（让它把运行时和配置准备好）')
    print('    3) 再回来跑 bash install.sh')
    print()
    print('  已经装了、但还是看到这段？把下面两条命令的输出发出来：')
    print('    ls %s' % os.path.join(HOST_DIR, 'binaries'))
    print('    python3 host/install-hooks.py status')
    return 1


def cmd_install():
    if not os.path.exists(SETTINGS):
        return die_no_host('没检测到 WorkBuddy（缺 %s）' % SETTINGS)
    if not ensure_script():
        return 1

    electron = find_electron()
    if not electron:
        return die_no_host('没检测到 WorkBuddy 自带的运行引擎（%s 下没有找到）'
                           % os.path.join(HOST_DIR, 'binaries'))
    env_path = write_env(electron)

    d = load_settings()
    cur = d.get('hooks') or {}
    merged = merge_hooks(cur, desired_hooks())
    if merged == cur:
        print('hooks 已是最新，无需改动')
        print('electron: %s' % electron)
        return 0

    bak = '%s.bak-dafeiyu-%d' % (SETTINGS, int(time.time()))
    shutil.copy2(SETTINGS, bak)
    d['hooks'] = merged
    save_settings(d)
    print('已安装 %d 个事件的 hook' % len(EVENTS))
    print('脚本    : %s' % TARGET)
    print('配置    : %s' % env_path)
    print('electron: %s' % electron)
    print('备份    : %s' % bak)
    print('\n新会话或重启 agent 后生效（当前已开的会话可能不会热加载）。')
    return 0


def cmd_uninstall():
    removed = 0
    if os.path.exists(SETTINGS):
        d = load_settings()
        cur = d.get('hooks') or {}
        remaining = {}
        for ev, groups in cur.items():
            kept = [g for g in groups if not _is_ours(g)]
            removed += len(groups) - len(kept)
            if kept:
                remaining[ev] = kept
        if removed:
            bak = '%s.bak-dafeiyu-%d' % (SETTINGS, int(time.time()))
            shutil.copy2(SETTINGS, bak)
            if remaining:
                d['hooks'] = remaining
            else:
                d.pop('hooks', None)
            save_settings(d)
            print('已移除 %d 个 hook（备份: %s）' % (removed, bak))

    # 配置和脚本也一起清掉：留着会让下次 install 看起来「已经装过」
    for f in (ENV_FILE, TARGET, os.path.join(HOOKS_DIR, 'pet-enabled')):
        try:
            os.remove(f)
            print('已删除: %s' % f)
        except FileNotFoundError:
            pass

    if not removed:
        print('没有找到桌宠装的 hooks')
    return 0


def cmd_status():
    print('仓库     : %s' % ROOT)
    print('settings : %s %s' % (SETTINGS, '✓' if os.path.exists(SETTINGS) else '✗ 缺失'))
    print('脚本     : %s %s' % (TARGET, '✓' if os.path.exists(TARGET) else '✗ 缺失'))

    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    print('  %s' % line)
    else:
        print('配置     : ✗ 未生成（还没 install 过）')

    flag = os.path.join(HOOKS_DIR, 'pet-enabled')
    print('开关文件 : %s' % ('✓ 桌宠运行中' if os.path.exists(flag) else '（桌宠未运行）'))

    if not os.path.exists(SETTINGS):
        return 0
    h = load_settings().get('hooks')
    if not h:
        print('hooks    : 未安装')
        return 0
    ok = 0
    print('hooks    :')
    for ev in EVENTS:
        got = h.get(ev)
        mark = '✓' if got and got[0]['hooks'][0]['command'] == TARGET else '✗'
        ok += mark == '✓'
        print('  %s %s' % (mark, ev))
    print('  %d/%d 个事件已装' % (ok, len(EVENTS)))
    return 0


def cmd_which_electron():
    """只打印路径，供 `npm start` 用。

    失败时走 stderr 并返回非零 —— 因为这个函数的 stdout 会被 shell 的
    `$(...)` 当成命令去执行，往 stdout 里写一段人话会被当成程序名跑。
    """
    e = find_electron()
    if not e:
        print('没检测到 WorkBuddy 自带的运行引擎（先跑 bash install.sh）', file=sys.stderr)
        return 1
    print(e)
    return 0


if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'status'
    fn = {
        'install': cmd_install,
        'uninstall': cmd_uninstall,
        'status': cmd_status,
        'which-electron': cmd_which_electron,
    }.get(action)
    if not fn:
        print('用法: install-hooks.py [install|uninstall|status|which-electron]')
        sys.exit(2)
    sys.exit(fn())
