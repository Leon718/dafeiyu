"""端到端验证：向桌宠 /hook 推送真实事件序列，逐步截图。"""
import json, os, subprocess, sys, time, urllib.request

# userData 目录。macOS 是 ~/Library/Application Support/<app 名>。
# 换平台或换目录时用 DAFEIYU_USERDATA 覆盖（安装器写的 dafeiyu.env 里就有这个变量）
UD = os.environ.get('DAFEIYU_USERDATA') or os.path.expanduser(
    '~/Library/Application Support/dafeiyu')
PORT_FILE = os.path.join(UD, 'pet-port.txt')
port = open(PORT_FILE).read().strip()
BASE = 'http://127.0.0.1:%s' % port
SID = 'e2e-session'


def post(path, obj, timeout=4):
    req = urllib.request.Request(BASE + path, data=json.dumps(obj).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    try:
        return urllib.request.urlopen(req, timeout=timeout).read().decode()
    except Exception as e:
        return 'ERR %s' % e


def shot(name, wait=2.6):
    time.sleep(wait)
    try:
        data = urllib.request.urlopen(BASE + '/snapshot', timeout=6).read()
        p = '/tmp/e2e_%s.png' % name
        open(p, 'wb').write(data)
        print('   shot -> %s (%d KB)' % (p, len(data) // 1024))
    except Exception as e:
        print('   shot FAIL', e)


def ev(name, **kw):
    payload = {'hook_event_name': name, 'session_id': SID, 'cwd': os.getcwd()}
    payload.update(kw)
    print('>>', name, kw.get('tool_name', ''))
    print('   resp:', post('/hook', payload)[:80])


print('port =', port)
print('=== 0. 复位 ===')
ev('SessionEnd', reason='other')
time.sleep(0.4)

print('\n=== 1. 新会话 ===')
ev('SessionStart', source='startup')
shot('1_idle')

print('\n=== 2. 用户提问 ===')
ev('UserPromptSubmit', prompt='帮我看下这个 bug')
shot('2_thinking')

print('\n=== 3. 开始读文件 ===')
ev('PreToolUse', tool_name='Read', tool_input={'file_path': '/tmp/x.py'})
shot('3_working')

print('\n=== 4. 需要确认 ===')
ev('Notification', message='需要授权', notification_type='permission_prompt')
shot('4_waiting')

print('\n=== 5. 工具失败 ===')
ev('PreToolUse', tool_name='Bash', tool_input={'command': 'ls'})
time.sleep(0.3)
ev('PostToolUseFailure', tool_name='Bash', error='command not found')
shot('5_error')

print('\n=== 6. 这一轮结束 ===')
ev('UserPromptSubmit', prompt='再来')
time.sleep(0.3)
ev('Stop', stop_hook_active=False)
shot('6_success')

print('\n=== 最终状态 ===')
print(urllib.request.urlopen(BASE + '/hook-state', timeout=4).read().decode())
