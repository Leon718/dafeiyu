// 大肥鱼 · 主进程
// 职责：透明置顶窗、拖拽、右键菜单、接收 WorkBuddy hook 事件（走感知闸门）、带他回她家
const { app, BrowserWindow, ipcMain, Menu, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { MomentDetector, resolveLine } = require('./hook-mapper');
const ledger = require('./ledger');
const thoughts = require('./thoughts');
const echo = require('./echo');
const journal = require('./journal');
const { Brain, chooseDeep, think, DEEP_SPEC } = require('./brain');
const { buildCard, renderCard, anchorOf } = require('./context');
const paths = require('./paths');
const calendar = require('./calendar');

const ROOT = __dirname;
// 测试/并行实例用：独立 userData（避开异常退出残留的 SingletonSocket）与端口
if (process.env.PET_USER_DATA_DIR) app.setPath('userData', process.env.PET_USER_DATA_DIR);
// 受限环境（如沙箱内）Chromium GPU 沙箱无法初始化会直接崩溃，降级为软件渲染
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

// 出厂默认 + 用户覆盖。用户那份写在 userData：升级引擎不会冲掉他的设置，
// 卸载也只需要删一个目录，不用去仓库里翻。
// 用 paths.mergeDeep 而不是展开符 —— 理由见那个函数（浅合并会吞掉 life.pool）
const CONFIG = paths.mergeDeep(
  paths.readJson(path.join(ROOT, 'config.default.json')) || {},
  paths.readJson(path.join(app.getPath('userData'), 'config.json')) || {}
);
const STATE_FILE = path.join(app.getPath('userData'), 'pet-window-state.json');
const PORT_FILE = path.join(app.getPath('userData'), 'pet-port.txt');
const HER_SESSION_FILE = path.join(app.getPath('userData'), 'her-session.txt');
// 用户偏好（停留时长等）跟窗口位置一样属于本机状态，不进代码库
const PREFS_FILE = path.join(app.getPath('userData'), 'pet-prefs.json');

// 她出场后停留多久，由用户在右键菜单里定。默认 20 秒 —— 她说完就走，不是挂件
const DWELL_OPTIONS = [
  { label: '5 秒', ms: 5000 },
  { label: '10 秒', ms: 10000 },
  { label: '20 秒', ms: 20000 },
  { label: '1 分钟', ms: 60000 },
  { label: '3 分钟', ms: 180000 },
];
// activity：她「自己跳出来」的频率，静默 / 标准 / 高 —— 见下面的 ACTIVITY_LEVELS。
// reducedMotion 已经不在菜单里了（那个位置让给了活跃度）。这项仍然生效：
// 手改 pet-prefs.json 里 reducedMotion:true 就是「只说话、不做动作」，省眼睛也省电。
const DEFAULT_PREFS = { dwellMs: 20000, sizeFactor: 1, reducedMotion: false, activity: 'normal' };
let prefs = { ...DEFAULT_PREFS };
try {
  Object.assign(prefs, JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')));
} catch { /* 第一次运行没有偏好文件 */ }
if (!DWELL_OPTIONS.some((o) => o.ms === prefs.dwellMs)) prefs.dwellMs = DEFAULT_PREFS.dwellMs;

function savePrefs() {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch { /* 存不下也不影响本次会话 */ }
}

/** 改停留时长。右键菜单和 HTTP 调试口都走这里，行为不会分叉 */
function setDwell(ms) {
  if (!DWELL_OPTIONS.some((o) => o.ms === ms)) return false;
  prefs.dwellMs = ms;
  PRESENCE.hideAfterMs = ms;
  savePrefs();
  // 正在场上的话立刻按新时长重算，不用等她下次出场
  if (onStage) armPresenceTimers();
  return true;
}

// 她的人格目录：台词、日记都在这儿，桌宠只是她的脸。
// 规则见 paths.js —— DAFEIYU_HOME → <userData>/persona → content/
const HOME_DIR = paths.personaDir(app.getPath('userData'));
// 待说清单跟着她家走：纸条放在她自己目录里，换角色/换家一起搬走
thoughts.configure(HOME_DIR);
// 素材索引：动画名 → file:// URL。自有美术覆盖同名第三方（见 paths.assetIndex）
const ASSETS = paths.assetIndex();

// 她复读自己在聊天窗口说过的话（见 echo.js）。config.json 可关掉/调长度
const ECHO = CONFIG.echo || {};
// 她记账：他这一轮说了什么，由桌宠抄进日记（见 journal.js）。
// 不走模型、不调工具，因此**不给他的回复加任何等待时间**。
const JOURNAL = CONFIG.journal || {};

// 深思（见 brain.js）：唯一会花钱的一层。
// 规则决定「要不要开口」——所以她的打扰频率一点没变；
// 模型只决定「这一句能说多深」——所以只有少数几句会变成只有当时才成立的话。
const BRAIN = CONFIG.brain || {};
const brain = new Brain({ cfg: BRAIN, dir: app.getPath('userData') });

// 台词：先看她家的，再看出厂示例集。
// 开源仓库只带示例集（够跑、每个时刻都有话说），完整人格是授权内容 ——
// 所以这里读不到完整版不能算错，只能安静降级
const VOICE_FILE = path.join(HOME_DIR, 'voices.json');
const VOICE_SAMPLE = path.join(paths.CONTENT_DIR, 'voices.sample.json');
const VOICES = paths.readJson(VOICE_FILE) || paths.readJson(VOICE_SAMPLE) || {};
if (!Object.keys(VOICES).length) {
  console.error('[voices] 没有可用的台词（找过 ' + VOICE_FILE + ' 和 ' + VOICE_SAMPLE + '）：她会一直不说话');
}

// hook 侧用的开关文件：桌宠活着才存在，桌宠退出立刻删掉 —— 不在时 hook 零开销。
// 目录由安装器写进 DAFEIYU_HOOKS_DIR：不同宿主的目录结构不一样，引擎自己不该猜。
// 没装 hook 适配时它是空的，这时不写开关文件 —— 手动启动照样能用
const HOOKS_DIR = paths.hooksDir();
const ENABLED_FLAG = HOOKS_DIR ? path.join(HOOKS_DIR, 'pet-enabled') : '';
// 端口：桥（hook-bridge.sh）传 DAFEIYU_PORT，PET_PORT 是旧名字，留着兼容
// 两个名字任一都认 —— 少认一个，两端就会各说各的端口，事件全部静默丢失
const PORT_PREF = parseInt(process.env.DAFEIYU_PORT || process.env.PET_PORT || '47823', 10);

// ---- 出场 / 退场 ----
// 她不该一直挂在桌面上晃。只有两种时刻她才在：
//   1. 他在她家跟她说话
//   2. 她自己觉得值得开口
// 之后没人理她，她就淡出消失 —— 陪伴是她来，不是她赖着。
const PRESENCE = {
  hideAfterMs: prefs.dwellMs,     // 用户可调（右键「停留时间」）
  quitAfterMs: 20 * 60 * 1000,    // 再没人理，进程也退掉（不常驻占资源）
  fadeInMs: 420,
  fadeOutMs: 720,
  ...(CONFIG.presence || {}),
};
// 偏好优先于配置文件：他手点的那一下，比 json 里的默认值更权威
PRESENCE.hideAfterMs = prefs.dwellMs;
// 环境变量覆盖只给验证用：不然「三分钟后退场」得真等三分钟才能测一次
if (process.env.PET_HIDE_AFTER_MS) PRESENCE.hideAfterMs = parseInt(process.env.PET_HIDE_AFTER_MS, 10);
if (process.env.PET_QUIT_AFTER_MS) PRESENCE.quitAfterMs = parseInt(process.env.PET_QUIT_AFTER_MS, 10);

let win = null;
let stateServer = null;
let statePort = 0;
let reducedMotion = !!prefs.reducedMotion;
let idleTimer = null;

let onStage = false;        // 她此刻是否在桌面上
let hideTimer = null;
let quitTimer = null;
let lastInteractAt = 0;

/** 出场：把她放到桌面上 */
function present(opts) {
  lastInteractAt = Date.now();
  // 生活动作（她自己出来做件跟工作无关的事）不该重置「没事件就退出」的计时。
  // 那是「不常驻、不吃内存」这条承诺的支点：一旦重置，她每 12–25 分钟自己续一次命，
  // 一两个小时都退不出去，「20 分钟后自己退出」就成了假话。
  armPresenceTimers(0, !!(opts && opts.keepQuit));
  if (!win || win.isDestroyed()) return;
  if (!onStage) {
    onStage = true;
    win.showInactive();
    win.setAlwaysOnTop(true, 'floating');
    win.webContents.send('presence', { state: 'enter', fadeMs: PRESENCE.fadeInMs });
  }
}

/** 退场：淡出，然后彻底隐藏窗口（不是缩到角落，是真的不见） */
function dismiss() {
  if (!onStage) return;
  onStage = false;
  win?.webContents.send('presence', { state: 'leave', fadeMs: PRESENCE.fadeOutMs });
  setTimeout(() => {
    if (!onStage && win && !win.isDestroyed()) {
      win.hide();
      // 藏起来之后还继续解码 VP9 动画就是白烧 CPU —— 让渲染层停手
      win.webContents.send('presence', { state: 'hidden' });
    }
  }, PRESENCE.fadeOutMs + 80);
}

/** 每次「他还在这儿」都要重新计时，否则她会在他正聊着的时候消失 */
function armPresenceTimers(extraMs = 0, keepQuit = false) {
  clearTimeout(hideTimer);
  // keepQuit：只重置「待多久就走」，不动「多久没人理就退出进程」
  if (!keepQuit) {
    clearTimeout(quitTimer);
    if (PRESENCE.quitAfterMs > 0) {
      quitTimer = setTimeout(() => app.quit(), PRESENCE.quitAfterMs);
    }
    quitTimer?.unref?.();
  }
  // extraMs 是「她正在说话」的补偿：别在她话说到一半时把人撤走
  hideTimer = setTimeout(dismiss, PRESENCE.hideAfterMs + Math.max(0, extraMs));
  hideTimer.unref?.();
}

function loadWindowState(width, height) {
  const corner = () => {
    const area = screen.getPrimaryDisplay().workAreaSize;
    return { x: area.width - width - 40, y: area.height - height - 20 };
  };
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* 首次运行无记录 */ }
  if (!s || typeof s.x !== 'number' || typeof s.y !== 'number') return corner();

  // 上次那个坐标现在还落在某块屏幕上吗。
  // 拔掉外接屏、改过分辨率、换过显示器排列之后，她会留在一个不存在的坐标上 ——
  // 桌面上看不见她，而菜单也点不到（菜单在她身上）。
  // 以前靠右键「回到右下角」手动救；自动发现比留个按钮可靠，所以按钮撤了，这段留下。
  const MIN = 60;   // 至少要有这么大一块露在屏幕里，否则等于没有
  const onSomeScreen = screen.getAllDisplays().some(({ workArea: a }) => (
    s.x < a.x + a.width - MIN && s.x + width > a.x + MIN &&
    s.y < a.y + a.height - MIN && s.y + height > a.y + MIN
  ));
  return onSomeScreen ? s : corner();
}

function saveWindowState() {
  if (!win) return;
  const [x, y] = win.getPosition();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ x, y }));
  } catch { /* 忽略写入失败 */ }
}

function configSnapshot() {
  return { ...CONFIG, home: HOME_DIR, voices: VOICES, assets: ASSETS, reducedMotion, sizeFactor, dwellMs: PRESENCE.hideAfterMs };
}

function createWindow() {
  const width = Math.round(CONFIG.window.width * sizeFactor);
  const height = Math.round(CONFIG.window.height * sizeFactor);
  const pos = loadWindowState(width, height);

  win = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  const reveal = () => {
    if (!win || win.isDestroyed()) return;
    // 不再自动露面：她等被召唤才出现。启动后窗口是隐藏的，桌面上什么都没有
    win.webContents.send('config', configSnapshot());
    // 关键：冷启动时「召唤」可能比页面加载更早到（hook 补投在端口一写出来就发，
    // 而 did-finish-load 还要再等一会儿）。这时 onStage 已经是 true，
    // 这里再无条件发一次 leave 就会把刚出场她按回全透明 ——
    // 窗口 visible:true 但整屏空白，是最难查的那种 bug（踩过）。
    if (onStage) {
      win.webContents.send('presence', { state: 'enter', fadeMs: 0 });
      return;
    }
    win.webContents.send('presence', { state: 'leave', fadeMs: 0 });
    // 透明度 0 只是看不见，窗口还在原地挡点击 —— 必须整个藏掉
    win.hide();
    win.webContents.send('presence', { state: 'hidden' });
  };
  // ready-to-show 对 transparent 窗口不可靠，双保险
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', () => setTimeout(reveal, 120));

  // 自检：仅调试用
  if (process.env.PET_DEBUG) {
    setTimeout(async () => {
      try {
        console.log('[selfcheck] visible=' + win.isVisible() + ' bounds=' + JSON.stringify(win.getBounds()) + ' opacity=' + win.getOpacity());
        const img = await win.webContents.capturePage();
        // 用系统临时目录，别写死 /tmp（Windows 上没有这个路径，异常还会被下面吞成 FAIL）
        const shot = path.join(require('node:os').tmpdir(), 'pet_self.png');
        fs.writeFileSync(shot, img.toPNG());
        console.log('[selfcheck] screenshot -> ' + shot + ' size=' + JSON.stringify(img.getSize()));
      } catch (e) {
        console.log('[selfcheck] FAIL ' + e.message);
      }
    }, 4000);
  }

  win.on('moved', saveWindowState);
  win.on('closed', () => { win = null; });

  win.webContents.on('console-message', (...args) => {
    const msg = args
      .map((a) => (typeof a === 'string' ? a : (a && (a.message || a.lineNumber)) || ''))
      .filter(Boolean)
      .join(' ');
    if (process.env.PET_DEBUG && msg && !/Security Warning/.test(msg)) {
      console.log('[renderer] ' + msg);
    }
  });
}

// ---- 积分账本 ----
// 她的消耗记在 WorkBuddy 的库里（session_usage.credit_json）。只在这里读，缓 30 秒。
let ledgerCache = null;
let ledgerAt = 0;

function refreshLedger(force = false) {
  const now = Date.now();
  if (!force && ledgerCache && now - ledgerAt < 30 * 1000) return ledgerCache;
  ledgerCache = ledger.read(HOME_DIR);
  ledgerAt = now;
  return ledgerCache;
}

function showLedger() {
  const d = refreshLedger(true);
  present();      // 他点了菜单，那就是想看见她
  if (!d.ok || !d.her.msgs) {
    // 读不到账本就说实话，别编一个好看的数字
    pushState({
      moment: 'ledgerMiss',
      text: d.ok ? '我还没吃过积分。' : '账本打不开。',
      anim: '东张西望',
    });
    return;
  }
  win?.webContents.send('ledger', d);
}

// ---- 右键菜单 ----
// 菜单只留他真会去点的：她多久走、多活跃、多大、花了多少、跟她说句话、退出。
// 撤掉的三个（「打开 WorkBuddy」「回到右下角」、以及「减少动态」那个勾）都不是「设置她」，
// 而是「绕过她」：前者双击她就能回去，后者改成了启动时自动找回，
// 「减少动态」换成了更直白的一个词 —— 活跃度。
function showContextMenu() {
  const led = refreshLedger();
  const template = [
    {
      label: '活跃度',
      submenu: ACTIVITY_LEVELS.map((a) => ({
        label: a.label,
        type: 'radio',
        checked: prefs.activity === a.id,
        click: () => setActivity(a.id),
      })),
    },
    {
      label: '停留时间',
      submenu: DWELL_OPTIONS.map((o) => ({
        label: o.label,
        type: 'radio',
        checked: prefs.dwellMs === o.ms,
        click: () => setDwell(o.ms),
      })),
    },
    {
      label: '大小',
      submenu: [
        { label: '小', type: 'radio', checked: sizeFactor === 0.8, click: () => resizeWindow(0.8) },
        { label: '标准', type: 'radio', checked: sizeFactor === 1, click: () => resizeWindow(1) },
        { label: '大', type: 'radio', checked: sizeFactor === 1.25, click: () => resizeWindow(1.25) },
      ],
    },
    { type: 'separator' },
    { label: ledger.label(led), click: showLedger },
    { label: '跟她聊聊', click: () => ipcMain.emit('open-home') },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
}

let sizeFactor = prefs.sizeFactor || 1;
function resizeWindow(factor) {
  if (!win) return;
  sizeFactor = factor;
  prefs.sizeFactor = factor;
  savePrefs();
  const w = Math.round(CONFIG.window.width * factor);
  const h = Math.round(CONFIG.window.height * factor);
  const [x, y] = win.getPosition();
  win.setBounds({ x, y, width: w, height: h });
  win.webContents.send('resize', factor);
  saveWindowState();
}

// ---- 感知闸门 ----
// 旧版是每个 hook 事件都换一次表情；现在默认一句话都不说，只在「时刻」到了才演一下
const detector = new MomentDetector({
  voices: VOICES,
  home: HOME_DIR,
  gate: CONFIG.gate || {},
  watch: CONFIG.watch || {},
  projects: (CONFIG.watch && CONFIG.watch.projects) || {},
  play: (CONFIG.play && CONFIG.play.enabled !== false && CONFIG.play.cues) || [],
});
// 她攒着想说的话：在 WorkBuddy 会话里想好、写成纸条，桌宠只负责在对的时机念出来。
// 规则生不出见地 —— 见地必须来自她真的读过上下文，而且这样不额外烧一分钱。
detector.setThoughts(
  () => { try { return thoughts.pick(); } catch { return null; } },
  (id) => { try { thoughts.consume(id); } catch { /* 划不掉下次重复，不致命 */ } },
);
let lastHookAt = 0;
let savedHerSession = '';

// ---- 活跃度 ----
// 一个词决定「她自己跳出来的频率」。它同时拧三个旋钮：
//   ① 主动开口的小时预算与冷却（点播、打招呼这类「你叫她」的不受限制）
//   ② 深思的小时预算（唯一花钱的一层，跟着一起收放）
//   ③ 她自己的日子还演不演（吃喝、节日、玩耍）
//
// 静默不是「小声点」。她的沉默指的是：**不再自己跳出来**。
// 你戳她、拖她、双击她、说一句「跳个舞」、坐下来跟她聊 —— 她照样回应，
// 那不是她跳出来，那是你叫她。
const ACTIVITY_LEVELS = [
  { id: 'quiet', label: '静默', budget: 0, cooldown: 1, deep: 0, life: false },
  { id: 'normal', label: '标准', budget: 1, cooldown: 1, deep: 1, life: true },
  { id: 'high', label: '高', budget: 2, cooldown: 0.5, deep: 2, life: true },
];
if (!ACTIVITY_LEVELS.some((a) => a.id === prefs.activity)) prefs.activity = 'normal';

function activityLevel() {
  return ACTIVITY_LEVELS.find((a) => a.id === prefs.activity) || ACTIVITY_LEVELS[1];
}
/** 她自己跳出来说话 / 做自己的事，现在允许吗 */
function autoActive() {
  return activityLevel().life;
}

/**
 * 把当前活跃度落到各处。
 * 预算和冷却都是「config.json 的出厂值 × 系数」—— 他手改过的闸门参数不该被这个菜单抹掉。
 */
function applyActivity() {
  const a = activityLevel();
  const gateCfg = CONFIG.gate || {};
  detector.gate.maxPerHour = Math.round((gateCfg.maxPerHour || 12) * a.budget);
  detector.gate.globalCooldownMs = Math.round((gateCfg.globalCooldownMs || 60000) * a.cooldown);
  // 静默时她连「自己想说的话」（待说清单）也不主动念 —— 见 hook-mapper 的 muted
  detector.muted = !a.life;
  brain.cfg.maxPerHour = Math.round((BRAIN.maxPerHour || 3) * a.deep);
}

function setActivity(id) {
  if (!ACTIVITY_LEVELS.some((a) => a.id === id)) return false;
  prefs.activity = id;
  savePrefs();
  applyActivity();
  return true;
}
applyActivity();   // 启动就按上次的档位来，别等第一次右键才生效

try {
  const s = fs.readFileSync(HER_SESSION_FILE, 'utf8').trim();
  if (s) { detector.herSession = s; savedHerSession = s; }
} catch { /* 第一次还没认出来 */ }

let lastShown = null;   // 最近一次推给渲染层的东西，/last 用来验证「她到底说了什么」
// ---- 开口审计：她到底说了哪一句 ----
//
// 改台词不能凭印象。凭印象两头都看走眼：以为「你其实想推倒重写」这种好句子常见，
// 实际可能一年轮不上一次；以为「来了」只是偶尔一句，实际念了三百遍。
// 所以每说一句落一行：时刻 + 台词 id + 时间。
//
// 另外两个字段是专门为「他在等的时候她都在说什么」准备的：
//   sincePromptMs —— 距他提问过了多久（他等了多久她才开口）
//   turnTools     —— 那是本轮第几个动作（她是刚抬头，还是已经盯了半天）
// 没有这两个，日志只能回答「说了几次」，回答不了「说在他等的哪一分钟」。
const SPOKEN_LOG = path.join(app.getPath('userData'), 'spoken-log.jsonl');
const SPOKEN_KEEP = 4000;      // 只留最近这些行
let spokenWrites = 0;

function logSpoken(payload) {
  try {
    const now = Date.now();
    const t = detector && detector.turn;
    const row = {
      at: now,
      moment: payload.moment || null,
      lineId: payload.lineId || null,
      text: payload.text || null,
      beats: payload.beats || null,
      anim: payload.anim || null,
      source: payload.deep ? 'deep' : 'rule',
      sincePromptMs: t && t.start ? now - t.start : null,
      turnTools: t ? t.tools : null,
      turnSpoke: t ? t.spoke : null,
    };
    fs.appendFileSync(SPOKEN_LOG, JSON.stringify(row) + '\n');
    // 每 500 条裁一次尾巴：每次都读一遍太贵，不裁又会跟着她一直长下去
    if (++spokenWrites % 500 === 0) {
      const lines = fs.readFileSync(SPOKEN_LOG, 'utf8').trim().split('\n');
      if (lines.length > SPOKEN_KEEP) {
        fs.writeFileSync(SPOKEN_LOG, lines.slice(-SPOKEN_KEEP).join('\n') + '\n');
      }
    }
  } catch { /* 记账失败不许影响她说话 */ }
}

function pushState(payload) {
  // hold/release 是内部调度信号，不是「她说过的话」。
  // 早先它们也写进 lastShown，于是 /last 永远返回 {holdMs:9000} —— 排查时看不到台词，
  // 会误判成「气泡没出」。
  if (!payload.holdMs && !payload.releaseHold) {
    lastShown = { ...payload, at: Date.now() };
    logSpoken(payload);
  }
  win?.webContents.send('external-state', payload);
}

// ---- 深思：规则那句说完之后，隔几秒补一句只有此刻才成立的话 ----
//
// 为什么是「补一句」而不是「换一句」：
//   模型实测要 6~8 秒（流式第一句 3~7 秒）。让气泡等这 6 秒 = 她已经错过了他抬头的那一刻。
//   所以顺序是 —— 直觉立刻说（「停。」「8 秒。」），深思稍后补（「get 回来的是 None。」）。
//   这不是工程妥协：人就是这样说话的。先甩一句，顿一下，再补一句更狠的。
//
// 这一段无论怎么坏都不许影响她说话：规则那句已经发出去了，
// 下面的失败一律只记日志、不弹错、不补话。
// 能深思的时刻：都是「它在干活」的观察类。陪伴类（深夜/他回来了/打招呼）不在内 ——
// 那些时刻她本来就说得挺好，花钱只会买回一句废话。
const DEEP_MOMENTS = new Set([
  'errKnown', 'flip', 'rush', 'grind', 'loop', 'blast', 'searchOnly', 'longRun', 'repeatedFailure',
  'guess', 'noVerify', 'stall',
]);
const deepBusy = { on: false, until: 0 };

/**
 * 上一次深思是不是还占着。
 *
 * 这里必须带超时兜底：早先只有 `on: true/false`，一旦某次 think() 的 promise
 * 因为进程卡死没 resolve，finally 就没机会执行 —— 于是**她从此再也不深想**，
 * 而日志里连一行都不留（跳过发生在记账之前）。静默地永远坏掉，是最坏的失败方式。
 */
function deepBusyNow() {
  if (!deepBusy.on) return false;
  if (Date.now() < deepBusy.until) return true;
  deepBusy.on = false;
  return false;
}

function brainCfg() {
  return { ...BRAIN, timeoutMs: BRAIN.timeoutMs || 12000 };
}

/**
 * 深想那一句进气泡的**唯一**通路。
 *
 * 单独抽出来是因为调试口子（/deep-demo）也必须走这里 —— 如果调试路径自己再拼一遍
 * pushState，那验证的是「调试路径通不通」，不是「她那句话到底有没有出现在气泡里」。
 * 早先就是这么被骗过一次：日志写着 ok:true、台词也挑出来了，画面上却什么都没有。
 */
function announceDeep(kind, line, animName) {
  present();
  pushState({ moment: 'deep', kind, text: line, beats: [line], deep: true, anim: animName || null });
}

// ── 她自己的日子 ────────────────────────────────────────────────
// 吃喝、节日、玩耍这些动画不传递工作信息，作用是让她像有自己的生活，
// 而不是一个只在出错时才亮的状态灯。什么时候能播由 engine/calendar.js 决定：
// 晚饭那个点才吃晚饭，冬天才堆雪人，中秋才吃月饼。
let lifeTimer = null;

function pickWeighted(pool) {
  const total = pool.reduce((s, it) => s + (it.weight || 1), 0);
  let r = Math.random() * total;
  for (const it of pool) {
    r -= (it.weight || 1);
    if (r <= 0) return it.name;
  }
  return pool[pool.length - 1].name;
}

function announceLife() {
  const life = CONFIG.life || {};
  if (life.enabled === false) return;
  // 不在屏幕上时：静默档不叫她出来，autoShow=false 也不叫 —— 那两件事是同一个意思
  if (!onStage && (!autoActive() || life.autoShow === false)) return;
  // 她正在说正事 / 正在深想 / 刚有动静：生活动作可以等，正事不能断
  if (deepBusyNow()) return;
  if (Date.now() - lastInteractAt < 20000) return;
  const pool = calendar.available(life.pool, new Date());
  if (!pool.length) return;
  // keepQuit：她演完这一段，退出计时不该被重新拨回 20 分钟
  present({ keepQuit: true });
  // 只有动画、没有说话 —— 她在旁边做自己的事，不需要开口。
  // 不带 text 就不会进 lastShown / 开口日志：这不是「她说了什么」。
  pushState({ moment: 'life', anim: pickWeighted(pool), life: true });
}

function armLifeTimer() {
  clearTimeout(lifeTimer);
  const life = CONFIG.life || {};
  // 只看 enabled。autoShow 决定的是「要不要主动把她叫出来」，
  // 不是「演不演」—— 这个判断在 announceLife 里做。
  // 以前这里也判了 autoShow，于是 autoShow=false 变成「永远不演」，
  // 而文档写的是「她已经在屏幕上时才演」，两回事。
  if (life.enabled === false) return;
  const [min, max] = life.interval || [720, 1500];
  const wait = (min + Math.random() * (max - min)) * 1000;
  lifeTimer = setTimeout(() => {
    try { announceLife(); } catch (e) { console.error('[life] ' + e.message); }
    armLifeTimer();
  }, wait);
  lifeTimer.unref?.();
}

/**
 * 第一拍说出去之后调用。要么补一句，要么什么都不做。
 * @param {{moment:string, tier?:number, vars?:object, project?:string}} next
 * @param {object} payload 原始 hook payload（里面才有 cwd / transcript_path）
 */
async function maybeDeep(next, payload) {
  const t0 = Date.now();
  if (!BRAIN.enabled || BRAIN.provider === 'off') return;
  if (!next || !DEEP_MOMENTS.has(next.moment)) return;
  if (deepBusyNow()) {
    brain.audit({ at: t0, moment: next.moment, skip: 'busy' });   // 上一次还在想，别叠着花第二份钱
    return;
  }

  const gate = brain.canCall(t0);
  if (!gate.ok) {
    brain.audit({ at: t0, moment: next.moment, skip: gate.reason });
    return;
  }

  deepBusy.on = true;
  // 兜底时间：think() 自己的硬超时 + 2 秒。超过这个还占着，一定是它卡住了
  deepBusy.until = t0 + (BRAIN.timeoutMs || 15000) + 2000;
  let kind = null;
  let anchor = '';
  try {
    // 事实卡：本地动作时间线 + 报错正文 + git diff + 他最近说的话 + 她家日记
    const card = await buildCard({
      cue: next.vars || {},
      watch: detector.watcher,
      payload,
      home: HOME_DIR,
      project: next.project || '',
      now: t0,
    });
    kind = chooseDeep({ moment: next.moment, tier: next.tier, card, cfg: BRAIN });
    if (!kind) {
      // 记下「为什么这次不值得花钱」。没有这几个数，事后只能猜
      brain.audit({
        at: t0, moment: next.moment, tier: next.tier || null, skip: 'not-worth-it',
        file: card.file, errLen: (card.errText || '').length, diffLen: (card.diff.body || '').length,
      });
      return;
    }

    anchor = anchorOf({ kind, cue: next.vars || {}, file: card.file });
    if (!brain.fresh(anchor, t0)) {
      brain.audit({ at: t0, moment: next.moment, kind, skip: 'said-before' });
      return;
    }

    const cardText = renderCard(card, { now: t0 });
    // 她如果要开口，就别在这几秒里淡出 —— 让他看见她正站在那儿想
    present();
    pushState({ holdMs: BRAIN.holdMs || 9000 });   // 只延长待机，不改气泡

    brain.mark(anchor, t0);
    const r = await think({
      kind,
      card,
      cardText,
      cfg: brainCfg(),
      // 一整次开口最多三句。规则那句已经说了两拍的话，深思就只补一句 ——
      // 否则她一次要念四句，那不是她这个人，是一段播报。
      maxBeats: (next.beats && next.beats.length > 1) ? 1 : 2,
      onLine: (line, n) => announceDeep(kind, line, n === 1 ? (DEEP_SPEC[kind] && DEEP_SPEC[kind].anim) : null),
    });

    if (r.ok) brain.remember(anchor, r.beats.join(' '), Date.now());
    brain.audit({
      at: t0,
      moment: next.moment,
      kind,
      anchor: anchor.slice(0, 90),
      ok: !!r.ok,
      reason: r.ok ? undefined : (r.reason || (r.rejected || []).join(',') || 'nothing-passed'),
      text: r.beats,
      raw: (r.raw || '').slice(0, 120),
      stderr: r.stderr,
      ms: r.ms,
      ttfb: r.ttfb,
      cardChars: cardText.length,
    });
    if (r.ok) console.log(`[brain] ${kind} ${r.ms}ms 首句 ${r.ttfb || '-'}ms → ${r.beats.join(' / ')}`);
    else console.log(`[brain] ${kind} 没说出来：${r.reason || (r.rejected || []).join(',')}`);
  } catch (e) {
    brain.audit({ at: t0, moment: next.moment, kind, error: e.message });
    console.error('[brain] ' + e.message);
  } finally {
    deepBusy.on = false;
    deepBusy.until = 0;
    // 不管成没成，都把「她可以回去了」的等待放掉，别让她一直站在桌上
    setTimeout(() => { if (!deepBusy.on) pushState({ releaseHold: true }); }, 1200);
  }
}

// 她家的会话认出来就记下来：下次点她能直接带他回去
function rememberHerSession() {
  const sid = detector.herSession;
  if (!sid || sid === savedHerSession) return;
  savedHerSession = sid;
  try { fs.writeFileSync(HER_SESSION_FILE, sid); } catch { /* 忽略 */ }
}

function startStateServer() {
  const handler = (req, res) => {
    // 调试用：直接让她演一下 body: {"anim":"东张西望","text":"……"}
    if (req.method === 'POST' && req.url === '/state') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          // 要演出就先让她出场，否则窗口是隐藏的，截图/气泡全落空
          if (payload.text || payload.anim || payload.beats) present();
          pushState(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch {
          res.writeHead(400).end('{"ok":false}');
        }
      });
      return;
    }

    // WorkBuddy hooks 的事件入口：原始 payload 直接转发过来
    if (req.method === 'POST' && req.url === '/hook') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1024 * 1024) { req.destroy(); }
      });
      req.on('end', () => {
        // 先回包，再处理 —— hook 是同步阻塞 agent 的，这一行能省掉几十毫秒
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '11' });
        res.end('{"ok":true}');
        setImmediate(() => {
          lastHookAt = Date.now();
          let payload = null;
          try { payload = JSON.parse(body || '{}'); } catch { /* 忽略坏数据 */ }
          let next = detector.handle(payload);

          // ── 她在聊天窗口刚说完一句：让桌面上的她再说一遍 ─────────────
          // 这里原来什么都没有，只有 atHome 那「10 分钟一次」的「来了。说吧。」，
          // 于是他跟她正经聊了十轮，桌面上一个气泡都没有 —— 看起来就是坏了。
          // 现在读她自己刚写完的回复（本地转录，零积分），按她的换行拆成几拍，
          // 气泡一句一句蹦出来。她说什么，桌面上那只鱼就说什么。
          const ev = payload && payload.hook_event_name;
          const cwd = (payload && payload.cwd) || '';
          const atHome = !!HOME_DIR && (cwd === HOME_DIR || cwd.startsWith(HOME_DIR + '/'));
          if (ev === 'Stop' && atHome && ECHO.enabled !== false) {
            const said = echo.fromTranscript(payload.transcript_path, {
              maxBeats: ECHO.maxBeats,
              maxChars: ECHO.maxChars,
              anim: ECHO.anim,
            });
            if (said) next = said;
          }

          // ── 替她记账：他这一轮说了什么，抄进今天的日记 ─────────────
          // 放在这里而不是让她自己去写，是因为「让她写」= 一次工具调用
          // = 一次额外的模型往返 = 他的回话要多等 2~5 秒。
          // 抄写不需要思考，桌宠干活，她只管说话。
          if (ev === 'Stop' && atHome && JOURNAL.enabled !== false) {
            try {
              const r = journal.appendTurn({
                transcriptPath: payload.transcript_path,
                homeDir: HOME_DIR,
                maxChars: JOURNAL.maxChars,
              });
              if (r.ok) console.log('[journal] ' + r.line);
            } catch (e) {
              console.error('[journal] 记账失败：' + e.message);
            }
          }

          if (next) {
            // 他在她家说话：她露面陪着。别插嘴 —— 那个 session 里回复他的就是她本人，
            // 桌宠再替她编一句就成了自言自语
            if (next.home) present();
            if (next.text || next.anim) { present(); pushState(next); }
            // 规则那句已经在路上了，这里再决定要不要补一句更深的（花钱、慢，所以只挑几处）
            if (next.text && !next.home) maybeDeep(next, payload);
          }
          rememberHerSession();
        });
      });
      return;
    }

    // 最近一次推给渲染层的东西。验证台词时机器读这个，比截图快一百倍
    if (req.url === '/last') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(lastShown));
      return;
    }

    // 自检：她现在还调得通模型吗。
    // 这条路要花一次钱，所以它只在你想知道「她是不是哑了」的时候手动打一次。
    // 返回里带 stderr，因为「调不通」的三种原因（没登录 / 超时 / 参数不认）全在那一行。
    if (req.url === '/brain-test') {
      const demo = {
        project: 'selftest',
        file: 'selftest.py',
        actions: [],
        errText: 'Traceback (most recent call last):\n  File "selftest.py", line 42, in <module>\n    total = total + row\nTypeError: unsupported operand type(s) for +: int and NoneType',
        diff: { body: '', stat: '' },
        words: [],
        diary: [],
      };
      const demoText = renderCard(demo);
      think({ kind: 'readErr', card: demo, cardText: demoText, cfg: brainCfg() }).then((r) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: r.ok, ms: r.ms, ttfb: r.ttfb, beats: r.beats,
          reason: r.reason, stderr: r.stderr, rejected: r.rejected,
          raw: (r.raw || '').slice(0, 160),
        }, null, 1));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
      return;
    }

    // 最后一百米：那一句到底有没有进气泡。
    // /brain-test 只证明「模型调得通」；它不碰渲染层，所以就算气泡坏了它也照样 ok:true。
    // 这条会真的让她站到桌上、真的把话推给渲染层，跟正式通路共用 announceDeep。
    if (req.method === 'POST' && req.url === '/deep-demo') {
      const demo = {
        project: 'selftest',
        file: 'selftest.py',
        actions: [],
        errText: 'Traceback (most recent call last):\n  File "selftest.py", line 42, in <module>\n    total = total + row\nTypeError: unsupported operand type(s) for +: int and NoneType',
        diff: { body: '', stat: '' },
        words: [],
        diary: [],
      };
      const demoText = renderCard(demo);
      present();
      pushState({ holdMs: BRAIN.holdMs || 9000 });
      think({
        kind: 'readErr',
        card: demo,
        cardText: demoText,
        cfg: brainCfg(),
        maxBeats: 1,
        onLine: (line, n) => announceDeep('readErr', line, n === 1 ? (DEEP_SPEC.readErr && DEEP_SPEC.readErr.anim) : null),
      }).then((r) => {
        // lastShown 一起回：如果 beats 有内容、lastShown 却不是 deep，那就是推的路上断了
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: r.ok, ms: r.ms, ttfb: r.ttfb, beats: r.beats,
          reason: r.reason, rejected: r.rejected, stderr: r.stderr,
          lastShown,
        }, null, 1));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
      return;
    }

    // 她说过什么。按时刻 / 按台词 id 分别计数 —— 优化台词先看这个：
    // 哪一句真被念出来过、念了几次，一眼看见。distinctLines 是「这么多句话里，
    // 实际用过的有多少种」：要是它远小于总句数，说明大半台词是写了从没说过的死词。
    if (req.url === '/spoken' || req.url.startsWith('/spoken?')) {
      let n = 40;
      try { n = Number(new URL(req.url, 'http://x').searchParams.get('n')) || 40; } catch { /* 用默认 */ }
      let rows = [];
      try {
        rows = fs.readFileSync(SPOKEN_LOG, 'utf8').trim().split('\n')
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { /* 还没说过话就是空 */ }
      const byMoment = {};
      const byLine = {};
      for (const r of rows) {
        if (r.moment) byMoment[r.moment] = (byMoment[r.moment] || 0) + 1;
        if (r.lineId) byLine[r.lineId] = (byLine[r.lineId] || 0) + 1;
      }
      const desc = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total: rows.length,
        distinctLines: Object.keys(byLine).length,
        byMoment: desc(byMoment),
        // 念得最多的句子附上原文：优化时直接看这里，不用拿着 id 去 voices.json 里数
        topLines: Object.entries(byLine).sort((a, b) => b[1] - a[1]).slice(0, 20)
          .map(([id, n2]) => ({ id, n: n2, line: (resolveLine(VOICES, id) || []).join(' / ') })),
        recent: rows.slice(-n),
      }, null, 1));
      return;
    }

    // 她花了多少钱、买到什么、哪几次被自己的规矩拦了。
    // 接了模型之后这个必须能看见 —— 不然「她偶尔说句挺聪明的话」就成了玄学。
    if (req.url === '/brain') {
      let recent = [];
      try {
        const raw = fs.readFileSync(brain.logPath, 'utf8').trim().split('\n').slice(-12);
        recent = raw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { /* 还没调过就是空 */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stats: brain.stats(), recent }, null, 1));
      return;
    }

    if (req.url === '/hook-state') {      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...detector.snapshot(),
        home: HOME_DIR,
        activity: prefs.activity,
        lastHookAgoMs: lastHookAt ? Date.now() - lastHookAt : null,
        dwellMs: PRESENCE.hideAfterMs,
        thoughtsWaiting: (() => { try { return thoughts.count(); } catch { return -1; } })(),
      }));
      return;
    }

    // 账本数据（只读，不演出）
    if (req.url === '/ledger') {
      const d = refreshLedger(true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d));
      return;
    }
    // 让他看账本（跟右键菜单点「积分累计使用」同一条路径）
    if (req.method === 'POST' && req.url === '/ledger-show') {
      showLedger();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    // 往她的待说清单里塞一张纸条（测试/外部脚本用）
    if (req.method === 'POST' && req.url === '/thought') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        try {
          const o = JSON.parse(body || '{}');
          const text = String(o.text || '').trim();
          if (!text) throw new Error('empty');
          fs.mkdirSync(path.dirname(thoughts.file()), { recursive: true });
          fs.appendFileSync(thoughts.file(), JSON.stringify({ text, at: Date.now() }) + '\n', 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, waiting: thoughts.count() }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, err: String(e.message || e) }));
        }
      });
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: statePort, onStage, visible: win ? win.isVisible() : null }));
      return;
    }
    // 调试/测试：改活跃度（跟右键菜单同一条代码路径）
    if (req.method === 'POST' && req.url === '/activity') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let ok = false;
        try { ok = setActivity(String(JSON.parse(body || '{}').id || '')); } catch { /* 坏请求 */ }
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok, activity: prefs.activity, maxPerHour: detector.gate.maxPerHour }));
      });
      return;
    }
    // 调试/测试：改停留时长（跟右键菜单同一条代码路径）
    if (req.method === 'POST' && req.url === '/dwell') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let ok = false;
        try { ok = setDwell(parseInt(JSON.parse(body || '{}').ms, 10)); } catch { /* 坏请求 */ }
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok, dwellMs: PRESENCE.hideAfterMs }));
      });
      return;
    }
    // 调试/测试：手动叫她出来 / 让她退下
    if (req.method === 'POST' && req.url === '/present') {
      present();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"presented":true}');
      return;
    }
    if (req.method === 'POST' && req.url === '/dismiss') {
      dismiss();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"dismissed":true}');
      return;
    }
    // 调试/测试：改完代码要重起。
    // 没有这个口子就只能去活动监视器里点，或者 pkill 猜进程名 —— 两条都容易误杀别的东西。
    if (req.method === 'POST' && req.url === '/quit') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"quitting":true}');
      setTimeout(() => app.quit(), 80);
      return;
    }

    // 气泡此刻到底长什么样 —— 直接问渲染层。
    // 截图要看运气（帧率、退场、窗口刚显示还没画），lastShown 只能证明「推出去了」，
    // 证明不了「画出来了」。验收「看得见」只能用这个。
    if (req.url === '/bubble') {
      const js = `(() => {
        const b = document.getElementById('bubble');
        if (!b) return { missing: true };
        const cs = getComputedStyle(b);
        const r = b.getBoundingClientRect();
        // 视频有没有真的拿到帧：气泡能画出来不代表动画能播。
        // readyState >= 2 才算「有当前帧」，黑窗口最简单就被这一项抓出来
        const vids = [...document.querySelectorAll('video')].map((v) => ({
          clip: decodeURIComponent((v.currentSrc || '').split('/').pop() || ''),
          ready: v.readyState,
          visible: v.classList.contains('visible'),
        }));
        return {
          text: b.textContent,
          on: b.classList.contains('show'),
          opacity: cs.opacity,
          w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
          videos: vids,
        };
      })()`;
      if (!win || win.isDestroyed()) { res.writeHead(503).end('{"error":"no-window"}'); return; }
      win.webContents.executeJavaScript(js).then((v) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(v));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      });
      return;
    }

    if (req.url === '/snapshot') {
      win?.webContents.capturePage().then((img) => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(img.toPNG());
      }).catch(() => res.writeHead(500).end());
      return;
    }
    res.writeHead(404).end();
  };

  // 端口尽量固定：hook 脚本读的是端口文件，端口漂移会让刚启动那几秒的推送打空
  const onListening = () => {
    statePort = stateServer.address().port;
    // 带上结尾换行：hook 脚本用 bash read 读它，无换行会读到 EOF 返回非 0
    try { fs.writeFileSync(PORT_FILE, statePort + '\n'); } catch { /* 忽略 */ }
  };

  const boot = (port, allowFallback) => {
    stateServer = http.createServer(handler);
    stateServer.once('error', (err) => {
      if (allowFallback && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
        try { stateServer.close(); } catch { /* 忽略 */ }
        boot(0, false);
      } else {
        console.error('[stateServer] ' + err.message);
      }
    });
    stateServer.listen(port, '127.0.0.1', onListening);
  };

  boot(PORT_PREF, true);
}

// ---- IPC ----
ipcMain.handle('get-config', () => configSnapshot());
// 她说了一串话：这段时间别撤场。上限 30 秒，防止渲染层算出个离谱的时长把她钉在屏幕上
ipcMain.on('speech-busy', (_e, ms) => {
  const d = Math.min(30000, Math.max(0, Number(ms) || 0));
  if (onStage) armPresenceTimers(d + 1200);
});
ipcMain.on('context-menu', () => showContextMenu());
ipcMain.on('pet-poke', () => present());
ipcMain.on('quit', () => app.quit());

// 双击她 / 菜单「跟她聊聊」：认出她的会话就直接带他回去，认不出就把她的家打开
ipcMain.on('open-home', () => {
  const sid = detector.herSession || savedHerSession;
  if (sid) {
    shell.openExternal(`workbuddy://chat/${sid}`);
    return;
  }
  // 还没在她的目录里说过话，她不知道自己在哪个窗口
  pushState({ moment: 'noSession', text: detector.say('noSession'), anim: null });
  shell.openPath(HOME_DIR);
});

// 拖动：偏移量只在一次拖动期间有效。
// 用 null 表示「没有正在进行的拖动」—— 收到 drag-move 就照着旧偏移挪窗口，
// 是她变成「磁铁」的另一半原因：残留或重复的一条消息，也能把窗口拽走。
let dragOffset = null;
ipcMain.on('drag-start', () => {
  present();   // 他在动她，那就是还想看见她
  // 记录按下时的鼠标与窗口原点偏移，供 drag-move 计算
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragOffset = { dx: cursor.x - wx, dy: cursor.y - wy };
});
ipcMain.on('drag-move', () => {
  if (!win || !dragOffset) return;
  const cursor = screen.getCursorScreenPoint();
  win.setPosition(cursor.x - dragOffset.dx, cursor.y - dragOffset.dy);
});
ipcMain.on('drag-end', () => {
  if (!dragOffset) return;
  dragOffset = null;
  saveWindowState();
});

// 单实例：双击两次会起两个桌宠，第二个会抢走端口让第一个收不到事件
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户又点了一次启动器：那就是想见她
    present();
  });

  app.whenReady().then(() => {
    if (app.dock) app.dock.hide();
    createWindow();
    startStateServer();

    // 他很久没动静时，她自己冒出来一句（闸门内部还有 15 分钟静默门槛 + 小时预算）
    idleTimer = setInterval(() => {
      const r = detector.idleTick();
      if (r) { present(); pushState(r); }
    }, 60000);
    idleTimer.unref?.();

    // 没人召唤她的话，到点自己收拾东西走人（hook 下次会再把她叫起来）
    armPresenceTimers();

    // 她自己的日子：隔十几分钟出来做一件跟工作无关的事（吃口东西、玩一把），
    // 播完就回去。这些动画不传递任何工作信息，作用是让她像有自己的生活，
    // 而不是一个只在出错时才亮的状态灯。什么时候能播由 engine/calendar.js 决定。
    armLifeTimer();

    // 打开 hook 开关：桌宠活着，hook 才有意义
    if (ENABLED_FLAG) {
      try {
        fs.mkdirSync(HOOKS_DIR, { recursive: true });
        fs.writeFileSync(ENABLED_FLAG, String(Date.now()));
      } catch { /* 忽略 */ }
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    saveWindowState();
    stateServer?.close();
    if (idleTimer) clearInterval(idleTimer);
    clearTimeout(hideTimer);
    clearTimeout(quitTimer);
    // 关掉 hook 开关：下次 agent 干活时 hook 脚本第一行就 return，不做任何事
    if (ENABLED_FLAG) { try { fs.unlinkSync(ENABLED_FLAG); } catch { /* 忽略 */ } }
    try { fs.unlinkSync(PORT_FILE); } catch { /* 忽略 */ }
  });
}
