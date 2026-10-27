// 大肥鱼 · 工作观察（她看得见什么）
//
// 问题：她以前只会说「又熬夜了」，因为台词里只有 {n} 失败次数和钟点。
// 她不知道他在干什么，所以只能放空话。
//
// 解法不是接模型（每句 1 积分 + 3 秒，而且她并没有他的上下文），
// 而是**读动作**。PreToolUse 的 payload 里就有：
//   cwd（哪个项目）、tool_name（什么工具）、tool_input（改哪个文件 / 跑什么命令）
// PostToolUse 带 exitCode（成没成）。
// 这些全是零成本的，抓一次 0 毫秒、0 token。
//
// 为什么只观察动作、不试图理解代码 —— 这是第一性原理，不是偷懒：
//   1. 她真读懂代码需要模型推理，每句一次冷启动，而且并发不出「第几次」这种事实；
//   2. 「同一个文件改第三遍」不需要懂代码就能下判断，而这恰恰是人最在意的；
//   3. 装懂会翻车：说错一句，她这个人就废了。只看行为，永远不会说错。
// 她点评的是「你怎么干活」，不是「你这段逻辑对不对」。前者她有资格，后者她没有。

const fs = require('fs');

const DEFAULT_WATCH = {
  enabled: true,
  editWindowMs: 30 * 60 * 1000,   // 同一文件的改动，半小时内累计
  editTiers: [3, 5, 8],           // 第 3 / 5 / 8 次各说一句，中间不念
  cmdWindowMs: 20 * 60 * 1000,
  cmdTiers: [3, 5],               // 同一条命令跑到第 3 次才开口
  blastFiles: 6,                  // 一轮里动了这么多文件，算横扫
  noVerifyFiles: 4,               // 改了这么多文件却一次都没跑过 —— 比横扫更早、也更该说
  sameCueGapMs: 20 * 60 * 1000,   // 同一类观察，这么久之内不重复

  // ── 下面四组是「不看数量看形状」的维度 ─────────────────────
  // 前面几项（grind/guess/blast）数的都是「多少」，是同构的。
  // 这几项数的是「怎么变」，它们才让她像个坐在旁边的人。
  loopCycles: 3,                  // 改→跑→改→跑 交替到第 3 轮（动作序列，不是计数）
  readOnlyStreak: 12,             // 连续这么多次只读不写
  readOnlyFiles: 4,               // 且碰过这么多「不同的地方」——只看一个文件是专注，不是迷路
  readOnlySpanMs: 3 * 60 * 1000,  // 且这一串看了这么久（秒翻十几个地方是正常的浏览）
  rushMs: 15000,                  // 失败后这么快就重跑同一条命令 = 没看结果
  stallMs: 5 * 60 * 1000,         // 单条命令挂这么久（区别于整轮 longRun）
  flipWindowMs: 15 * 60 * 1000,   // 换错只在这个间隔内算「同一个问题往前走了」

  // 各类观察的去重间隔不一样：原地打转要给递进留空间（3→5 次之间能再开口），
  // 横扫和认错错都稀有，说了就够。
  cueGapMs: {
    grind: 8 * 60 * 1000,
    guess: 20 * 60 * 1000,
    blast: 60 * 60 * 1000,
    noVerify: 30 * 60 * 1000,
    errKnown: 20 * 60 * 1000,
    danger: 5 * 60 * 1000,        // 同一个危险动作 5 分钟不重念（换一条命令各自计时）
    flip: 10 * 60 * 1000,
    rush: 20 * 60 * 1000,
    loop: 20 * 60 * 1000,
    searchOnly: 40 * 60 * 1000,
    stall: 30 * 60 * 1000,
  },
  maxCmdLen: 24,
  // 「它此刻在干什么」的新鲜度。只服务动画：她跳出来说话时，播的动作要跟它手上的活儿对得上
  // （写文件时播「写代码」，删/挪文件时播「清点归档」）。
  // 90 秒是折中：太短会因为中间夹了一次读而落空，太长会拿它十分钟前干的活配现在的话。
  actionFreshMs: 90 * 1000,
};

// ── 危险动作：她唯一有资格「喊停」的时刻 ────────────────────────
//
// 判据不是「看起来危险」，而是**「这一步做完，有些东西就再也回不来了」**。
// 必须极窄：误报一次（他删 node_modules 也被念），她这个人就废了。
//
// 能重建的一律不说：node_modules / dist / __pycache__ / .venv / target ……
// 删这些是正常工作，说了就是叨叨。
const REBUILDABLE = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|target|coverage|__pycache__|\.venv|venv|\.cache|\.pytest_cache|\.mypy_cache|\.ruff_cache|tmp|temp|logs?|\.DS_Store)(\/|$)/i;

const DANGER_RULES = {
  // git：会吃掉「还没提交的东西」。只在**段首是 git** 时判，
  // 否则 `grep "git reset --hard" docs/` 这种查文档的也会被当成要执行
  git: [
    ['git-dirty', /\breset\s+--hard\b|\bcheckout\s+(?:--\s+)?\.(?:\s|$)|\brestore\s+\.(?:\s|$)/],
    ['git-clean', /\bclean\s+-[a-zA-Z]*[fdmx]/],
    ['git-force', /\bpush\s+.*(?:--force\b|-f\b|\s\+\S+)/],
    ['git-stash', /\bstash\s+(?:drop|clear)\b/],
  ],
  sql: [
    ['sql-drop', /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i],
    ['sql-delete', /\bdelete\s+from\s+[\w."`]+\s*;?\s*$/i],   // 没有 where
  ],
};

// 真正连着数据库的那些客户端。只有从它们嘴里出来的 SQL 才算数
const SQL_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'clickhouse-client', 'redis-cli']);

/**
 * 识别「回不去」的命令。认得才返回，认不得返回 null（她闭嘴）。
 *
 * 判据有两层，缺一不可：
 *   1. **它真的会被执行** —— 段首就是那条命令。`echo "rm -rf ~"` 是在聊天，不是在删东西
 *   2. **做完就回不去** —— 删能重建的东西、正常操作，一律不吭声
 *
 * 误报一次（他清 node_modules 被念「停」），她这个人就废了。所以宁可漏。
 */
function dangerOf(cmd) {
  const s = String(cmd || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // 按执行段切开；每段只看它自己的第一个词
  for (const rawSeg of s.split(/&&|\|\||;|\n/)) {
    const seg = rawSeg.trim().replace(/^(?:sudo|command|time|nohup|exec)\s+/i, '');
    if (!seg) continue;
    const head = (seg.split(' ')[0] || '').replace(/^.*\//, '').toLowerCase();

    // ── git ──
    if (head === 'git') {
      for (const [kind, re] of DANGER_RULES.git) if (re.test(seg)) return { kind };
      continue;
    }

    // ── rm 递归强删 ──
    if (head === 'rm') {
      const m = seg.match(/^rm\s+((?:-{1,2}[a-zA-Z-]+\s+)*)(.+)$/);
      if (!m) continue;
      const flags = m[1] || '';
      if (!(/r/i.test(flags) && /f/i.test(flags))) continue;   // 只认 -rf / -fr / -r -f
      const targets = m[2].split(/\s+/).filter((t) => t && !t.startsWith('-'));
      for (const raw of targets) {
        const t = raw.replace(/^['"]|['"]$/g, '');
        if (!t) continue;
        if (REBUILDABLE.test(t)) continue;         // 删构建产物，不吭声
        const wild = /\*/.test(t);
        const rootish = t === '/' || t === '/*' || t === '~' || t === '~/' || t === '$HOME'
          || t === '$HOME/' || /^\.\.(\/|$)/.test(t) || t.includes('/..');
        const secret = /(^|\/)\.(git|env|ssh)(\/|$)/.test(t);
        if (wild || rootish || secret) {
          return { kind: wild ? 'rm-wild' : secret ? 'rm-secret' : 'rm-root', target: baseName(t) || t };
        }
      }
      continue;
    }

    // ── 数据库：只认客户端的 -c / -e 里带出来的语句 ──
    if (SQL_CLIENTS.has(head)) {
      for (const [kind, re] of DANGER_RULES.sql) if (re.test(seg)) return { kind };
      continue;
    }

    // ── 直接以 SQL 语句开头（少数人这么跑）──
    for (const [kind, re] of DANGER_RULES.sql) {
      if (re.test(seg) && /^(?:drop|delete|truncate)\b/i.test(seg)) return { kind };
    }
  }
  return null;
}

// 只在「写」类工具上计数。反复 Read / Grep 同一个文件是正常的（他在翻资料），
// 那不算原地打转 —— 这条区分很重要，否则她会在人正常查代码时开口骂人。
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'StrReplace', 'insert_edit_into_file']);

// 「看」类工具。反复看是正常的（他在翻资料），只有一直在看、一行没写时才值得开口。
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'ListDir']);

const CMD_KINDS = [
  ['test', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bjest\b|\bvitest\b|\bgo test\b|\bcargo test\b|node\s+--test/],
  ['build', /\b(npm|pnpm|yarn|bun)\s+run\s+build|\btsc\b|\bvite\s+build|\bcargo\s+build\b|\bmake\b|\bwebpack\b/],
  ['install', /\b(npm|pnpm|yarn|bun)\s+(i|add|install)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcargo\s+add\b/],
  ['git', /\bgit\s+/],
  ['lint', /\b(eslint|prettier|ruff|flake8|mypy)\b/],
  ['search', /^\s*(grep|rg|ag|find|fd|ls)\b/],
];

const ERR_KINDS = [
  ['missing_module', /ModuleNotFoundError|No module named|Cannot find module|Cannot find package|ImportError/],
  ['syntax', /SyntaxError|Unexpected token|Unexpected end of|IndentationError/],
  ['port', /EADDRINUSE|address already in use/],
  ['perm', /EACCES|Permission denied|Operation not permitted/],
  ['notfound', /command not found|: not found\b/],
  ['timeout', /timed out|ETIMEDOUT|\btimeout\b/i],
  ['testfail', /AssertionError|\bFAILED\b|\d+ failed|Tests? failed/],
  ['runtime', /TypeError|AttributeError|KeyError|IndexError|ValueError|UnhandledPromiseRejection/],
];

// 错误类型用她嘴里的说法。只用于「换错了」时点出前后是哪两种 ——
// 她认得出错的名字，但不判断代码，所以只报名字。
const KIND_CN = {
  missing_module: '找不到模块',
  syntax: '语法错',
  port: '端口被占',
  perm: '权限',
  notfound: '命令不存在',
  timeout: '超时',
  testfail: '测试挂',
  runtime: '运行时错',
};

function baseName(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  const b = s.split('/').filter(Boolean).pop() || '';
  return b.length > 26 ? b.slice(0, 25) + '…' : b;
}

/**
 * 命令只留「人会说出口的那几个词」：
 *   `npm test -- --watch` → `npm test`（选项是噪音，她不会念）
 *   `git commit -m "x"`   → `git commit`
 *   `python3 -c "..."`    → `python3`
 */
function cmdHead(cmd, maxLen = 24) {
  const s = String(cmd || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const head = s.split(' && ')[0].split(' || ')[0].split(' | ')[0].split(';')[0].trim();
  // 选项是噪音；引号里是参数内容，她不会念；长路径只留末段
  // （她说「run.py」，不说「data-center/run.py」，更别说被截成「data-center/run.…」）
  const keep = [];
  const words = head.split(' ');
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    if (/^['"]/.test(w)) break;
    if (w.startsWith('-')) continue;
    keep.push(i > 0 && w.includes('/') ? w.split('/').filter(Boolean).pop() || w : w);
  }
  const out = keep.join(' ').trim() || head.split(' ')[0] || head;
  return out.length > maxLen ? out.slice(0, maxLen) + '…' : out;
}

function classifyCmd(cmd) {
  const s = String(cmd || '');
  for (const [kind, re] of CMD_KINDS) if (re.test(s)) return kind;
  return 'other';
}

function errorKind(text) {
  const s = String(text || '');
  if (!s) return null;
  for (const [kind, re] of ERR_KINDS) if (re.test(s)) return kind;
  return null;
}

/** 读文件尾部若干字节。工具输出可能很长，只关心结尾的报错。 */
function readTail(file, bytes = 32768) {
  if (!file) return '';
  try {
    const st = fs.statSync(file);
    const len = Math.min(bytes, st.size);
    if (len <= 0) return '';
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** 从转录尾部找最后一条工具结果的正文（只有真要判错误类型时才读，不是每步都读） */
function lastToolOutput(transcriptPath) {
  const raw = readTail(transcriptPath, 32768);
  if (!raw) return '';
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'function_call_result' && d.type !== 'tool_result') continue;
    const out = d.output;
    if (typeof out === 'string') return out;
    if (out && typeof out.text === 'string') return out.text;
    if (Array.isArray(d.content)) {
      return d.content.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n');
    }
  }
  return '';
}

class WorkWatcher {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULT_WATCH, ...(opts.watch || {}) };
    this.projects = opts.projects || {};       // {目录名: 中文叫法}；值为 '' 表示别提这个项目
    this._now = opts.now || (() => Date.now());
    this.reset();
  }

  reset() {
    this.edits = new Map();     // 文件全路径 → {n, at}
    this.cmds = new Map();      // 命令 → {n, at, fails}
    this.turnFiles = new Set();
    // 本轮跑过几次命令。跟 cmds 不是一回事：cmds 跨轮累积（带时间窗），
    // 这个是「这一轮它到底验证过没有」的凭据。
    this.turnRuns = 0;
    this.lastCueAt = Object.create(null);
    this.lastFile = '';         // 最近一次写的文件名（basename，用于台词槽位）
    this.lastCmd = '';          // 最近一次跑的完整命令
    this.lastKind = 'other';    // 最近一次命令的类别
    this.lastOk = true;         // 最近一次工具是否成功
    // 它此刻在干什么：write / delete / move / read / run。
    // 只给动画用，不参与任何判断 —— 判定逻辑全靠上面那些具体维度。
    this.lastAction = null;
    this.lastActionAt = 0;

    // ── 下面这些不是计数器，是「形状」────
    this.seq = [];              // 动作序列，只收 W(写) / C(跑)。读是噪声，收进来会打断节奏
    this.readStreak = 0;        // 连着看了多少次，一次没写
    this.readFiles = new Set(); // 这一串「只看」里碰过的不同地方
    this.readSince = 0;         // 这一串从什么时候开始
    this.cmdStartAt = 0;        // 当前这条命令什么时候开的（0 = 没在跑）
    this.cmdStartLine = '';
    this.prevErr = null;        // 上一次认出来的错 {kind, at, project}
    this.fails = [];            // 最近几次失败 [{at, cmd, kind}]，用来算「他看没看结果」

    // ── 他不在的时候，这里发生过什么 ──────────────────────
    // 等待场景里他不在屏幕前：她当时喊的话他听不见，只有等他回来再说。
    // 这本账从「他上次提问」记到「他下次提问」，正好是一整个等待周期。
    // 没有它，「你走了 20 分钟，它中间卡了三次」这句就说不出来 —— 那是她最值钱的一句。
    this.ledger = this._newLedger(this._now());
    this.pendingDanger = null;  // 刚喊停的危险命令，等 PostToolUse 来补「到底跑没跑」

    // 动作时间线。规则只需要计数，但「深想」时模型需要看顺序和间隔 ——
    // 谁先谁后、隔了几秒，是人判断「他慌了 / 他在查 / 他在赌」的唯一依据。
    // 上限 16：够模型看出形状，又不至于把 prompt 撑大。
    this.history = [];          // [{at, kind:'W'|'C'|'R'|'S', target, ok}]
  }

  /** 记一笔动作。kind：W 写 / C 跑 / R 读 / S 搜 */
  _pushAction(kind, target, now) {
    const t = this.history[this.history.length - 1];
    // 同一个文件连着改三次只留最新一笔的计数，但三笔都要在 —— 间隔本身是信息。
    // 这里不做合并，只在超过上限时挤掉最旧的。
    this.history.push({ at: now, kind, target: String(target || '').slice(0, 160), ok: null });
    if (this.history.length > 16) this.history.shift();
    return t;
  }

  /** 他按了回车，新的一轮开始 —— 本轮文件清单清空 */
  newTurn() {
    this.turnFiles = new Set();
    this.turnRuns = 0;
  }

  _newLedger(now) {
    return {
      since: now,        // 这本账从什么时候开始记
      acts: 0,           // 写了多少个文件（按次，不按去重）
      writes: new Set(), // 碰过哪些不同文件
      runs: 0,           // 跑了几次命令
      fails: 0,          // 红过几次
      dangers: [],       // 它想干过什么回不去的 [{kind, target, cmd, at, ran}]
      errKinds: [],      // 出现过哪些错
    };
  }

  /**
   * 他又一次开口了 —— 结算上一本账，同时开一本新的。
   *
   * 为什么必须在这里结算：他提问的那一刻，上一轮「他不在」的周期才算结束。
   * 这里只做减法（读数 + 开新账），不做判断（该不该说由 mapper 决定）。
   */
  closeLedger(now) {
    const L = this.ledger;
    // since 为 0 表示这是应用启动后的第一个周期，之前没有「他不在」可言
    const sum = {
      since: L.since,
      ms: L.since ? now - L.since : 0,
      acts: L.acts,
      writes: L.writes.size,
      runs: L.runs,
      fails: L.fails,
      dangers: L.dangers.slice(),
      errKinds: Array.from(new Set(L.errKinds)),
    };
    this.ledger = this._newLedger(now);
    this.pendingDanger = null;
    return sum;
  }

  /** 危险动作留痕。她喊不喊得出来是一回事，记不记得住是另一回事 */
  _noteDanger(rec) {
    this.ledger.dangers.push(rec);
    if (this.ledger.dangers.length > 6) this.ledger.dangers.shift();
    // 等下一条 PostToolUse 来补「它到底跑成了没有」——
    // 她能看见 exitCode，所以回来说「它真跑了」还是「没跑成」，都不算猜。
    this.pendingDanger = rec;
  }

  /** 目录名 → 她嘴里怎么称呼这个项目 */
  projectOf(cwd) {
    const b = baseName(cwd);
    if (!b) return '';
    if (Object.prototype.hasOwnProperty.call(this.projects, b)) {
      return this.projects[b] || '';
    }
    // 日期式目录名（2026-10-25-09-24-16）念出来像乱码，宁可不提
    if (/^\d{4}-\d{2}-\d{2}/.test(b)) return '';
    if (b.length > 18) return '';
    return b;
  }

  /**
   * 这个观察该不该报。
   *
   * 关键：这里**只查不记**。真正记账在 commit()，由外面确认「她真的说出口了」之后调用。
   * 踩过的坑：原来一发现就写 lastCueAt，于是被闸门拦掉的那次（冷却中 / 预算用完 / 这一轮已说三句）
   * 也算「说过了」—— 他接下来 20 分钟再犯同样的错，她一个字都不会提。
   * 屏幕上看就是「她明明看见了却不吭声」，而日志里查不出任何原因。
   */
  _cue(moment, vars, tier, now, keyHint) {
    const gap = (this.cfg.cueGapMs && this.cfg.cueGapMs[moment]) || this.cfg.sameCueGapMs;
    // 区分符：同一文件 / 同一条命令 / 同一种错，各自独立计时。
    // 不区分的话，他换个文件犯同一个错就被判成「刚说过」，她再也开不了口。
    const key = `${moment}:${keyHint !== undefined ? keyHint : (vars.f || vars.err || vars.c || '')}`;
    if (this.lastCueAt[key] && now - this.lastCueAt[key] < gap) return null;
    return { moment, vars, tier: tier ?? null, key, gap };
  }

  /** 她真的说出口了，这次观察才算「用掉」 */
  commit(cue, now = this._now()) {
    if (!cue || !cue.key) return;
    this.lastCueAt[cue.key] = now;
  }

  /**
   * 记下「它此刻在干什么」。只给动画用。
   *
   * 为什么需要它：她会说「它改了 6 个文件，一次都没试过能不能用」，
   * 而画面上它正在写文件 —— 播「思考冒泡」就白搭了，观众看到的是「她在想」。
   * 播「写代码」，动作和话才互相印证。对不上的动作等于没动作。
   *
   * 只认五个值，不做更细的分类：动画就这么多，分得再细也没有片子可播。
   */
  _noteAction(isWrite, isRead, isCmd, cmd, now) {
    let a = null;
    if (isWrite) a = 'write';
    else if (isRead) a = 'read';
    else if (isCmd) {
      if (/^\s*(rm|rmdir|unlink|trash|del)\b|\s-delete\b/.test(cmd)) a = 'delete';
      else if (/^\s*(mv|move)\b/.test(cmd)) a = 'move';
      else a = 'run';
    }
    if (!a) return;
    this.lastAction = a;
    this.lastActionAt = now;
  }

  /** 它现在在干什么（可能已经是很久以前的事，那就返回 null） */
  action(now = this._now()) {
    if (!this.lastAction) return null;
    const fresh = this.cfg.actionFreshMs || 90000;
    if (now - this.lastActionAt > fresh) return null;
    return this.lastAction;
  }

  /**
   * 每一步都调用。返回 { cues: [{moment, vars, tier}] }，cues 空就代表她没话说。
   * 纯内存，零 IO（读转录只发生在失败后，且只读尾部 32KB）。
   */
  observe(payload) {
    const now = this._now();
    const out = { cues: [], facts: null };
    if (!this.cfg.enabled || !payload || typeof payload !== 'object') return out;

    const ev = payload.hook_event_name;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const project = this.projectOf(cwd);
    const tool = String(payload.tool_name || '');

    // ── 结果侧：只记成败，不开口 ──────────────────────────
    if (ev === 'PostToolUse' || ev === 'PostToolUseFailure') {
      const tr = payload.tool_response || {};
      const bad = ev === 'PostToolUseFailure' || (tr.exitCode !== undefined && tr.exitCode !== 0);
      this.lastOk = !bad;
      // 她刚才喊停的那条危险命令，到底跑成了没有。她看得见 exitCode，
      // 所以回来说「它真跑了」还是「没跑成」都不是猜的 —— 这两句的分量完全不同。
      if (this.pendingDanger) {
        this.pendingDanger.ran = !bad;
        this.pendingDanger = null;
      }
      if (bad) this.ledger.fails += 1;
      // 把「成没成」写回时间线：模型判断「他是不是在赌」全靠这个，
      // 一串 W→C(红)→W→C(红) 和 W→C(绿) 是两种人。
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i].ok === null) { this.history[i].ok = !bad; break; }
      }
      // 这条结果是不是「命令」的结果。Write 失败不能拿去跟上次命令的失败比间隔，
      // 否则「改文件失败」会被误判成「秒重跑了刚才那条命令」。
      const postTool = String(payload.tool_name || '');
      const postIsCmd = postTool === 'Bash' || postTool === 'shell' || postTool === 'run_command';

      // 命令回来了。它挂了多久 —— 这个数只有跑完才知道
      const ranMs = this.cmdStartAt ? now - this.cmdStartAt : 0;
      const ranLine = this.cmdStartLine;
      this.cmdStartAt = 0;
      this.cmdStartLine = '';

      if (bad) {
        const rec = this.lastCmd ? this.cmds.get(this.lastCmd) : null;
        if (rec) rec.fails += 1;
        // 他失败的时候，她最该说的话是「我认得这个错」。
        // 错误正文不在 payload 里，只有这时才去读转录尾部 —— 一次 32KB，1 毫秒。
        const text = lastToolOutput(payload.transcript_path);
        const kind = errorKind(text);

        // 「上一次失败到这一次」隔了多久，是「他到底看没看结果」的唯一证据。
        // 这不是猜，是两次 payload 的时间差。
        const prev = this.fails.length ? this.fails[this.fails.length - 1] : null;
        const gap = prev ? now - prev.at : Infinity;
        const sameCmd = prev && this.lastCmd && prev.cmd === this.lastCmd;

        this.fails.push({ at: now, cmd: this.lastCmd || '', kind: kind || '' });
        if (this.fails.length > 8) this.fails.shift();
        if (kind) this.ledger.errKinds.push(kind);

        if (postIsCmd && prev && sameCmd && gap <= this.cfg.rushMs) {
          // 同一条命令、十几秒内、又红了 → 他根本没看上一屏。
          // 这句比「又一个 ModuleNotFound」更狠也更真，所以优先，且不再认错（认错就成了复读）。
          const cue = this._cue('rush', { c: cmdHead(this.lastCmd, this.cfg.maxCmdLen), s: Math.max(1, Math.round(gap / 1000)), p: project }, null, now, 'rush');
          if (cue) out.cues.push(cue);
        } else if (kind) {
          // 换错了：上一次是另一种错。他绕过了第一个坑，掉进下一个 ——
          // 这是「同一个问题在往前爬」的铁证，比认得这个错有信息量得多
          const flip = this.prevErr && kind !== this.prevErr.kind
            && now - this.prevErr.at <= this.cfg.flipWindowMs
            && (!this.prevErr.project || !project || this.prevErr.project === project);
          if (flip) {
            const cue = this._cue('flip', { a: KIND_CN[this.prevErr.kind] || '', b: KIND_CN[kind] || '', p: project, f: this.lastFile }, null, now, `${this.prevErr.kind}>${kind}`);
            if (cue) out.cues.push(cue);
          } else {
            // 键必须带错误类型：同一个文件里换了另一种错，是新的信息，不该被上一句压住。
            // 原来只按文件名分键，于是他修掉缺包、又撞上类型错，她 20 分钟都不吭声。
            const cue = this._cue('errKnown', { err: kind, p: project, f: this.lastFile, c: cmdHead(this.lastCmd, this.cfg.maxCmdLen) }, null, now, `${kind}:${this.lastFile}`);
            if (cue) out.cues.push(cue);
          }
        }
        if (kind) this.prevErr = { kind, at: now, project };
      }

      // 一条命令挂太久。跟「整轮坐了二十分钟」不是一回事：
      // 那是他在想，这是脚本卡死了他还在等。
      if (postIsCmd && ranMs > this.cfg.stallMs) {
        const cue = this._cue('stall', { m: Math.round(ranMs / 60000), c: ranLine, p: project }, null, now, `stall:${ranLine}`);
        if (cue) out.cues.push(cue);
      }

      out.facts = this.facts(project);
      return out;
    }

    if (ev !== 'PreToolUse') return out;

    const ti = payload.tool_input || {};
    const isWrite = WRITE_TOOLS.has(tool);
    const isCmd = tool === 'Bash' || tool === 'shell' || tool === 'run_command';
    const isRead = READ_TOOLS.has(tool);
    const cmdRaw = isCmd ? String(ti.command || '') : '';
    const cmdKey = cmdRaw.replace(/\s+/g, ' ').trim();

    // 先记「在干什么」，再判别的 —— 危险动作也属于「在干什么」的一种
    this._noteAction(isWrite, isRead, isCmd, cmdKey, now);

    // ── 0. 危险动作。先判它，别的都靠后 ────────────────────
    // 这是她唯一有资格喊停的时刻，也是他说的「纠正」。
    // 判据窄到只认「回不去的」：误报一次她这个人就废了。
    if (isCmd && cmdKey) {
      const d = dangerOf(cmdKey);
      if (d) {
        // 不管这一句喊不喊得出来（冷却、去重都可能吞掉它），先记下来。
        // 他可能根本不在屏幕前，那一声「停」白喊了 —— 那就等他回来再说一遍。
        this._noteDanger({
          kind: d.kind,
          target: d.target || '',
          cmd: cmdHead(cmdKey, this.cfg.maxCmdLen),
          at: now,
          ran: null,
        });
        const cue = this._cue('danger',
          { k: d.kind, t: d.target || '', c: cmdHead(cmdKey, this.cfg.maxCmdLen), p: project, f: this.lastFile },
          null, now, `${d.kind}:${d.target || ''}`);
        if (cue) out.cues.push(cue);
      }
    }

    // ── 1. 动作的形状 ──────────────────────────────────────
    // 只收「写」和「跑」两种。读是噪声，混进来会把「改跑改跑」的节奏打断，
    // 反而认不出循环 —— 而循环才是真·原地打转，比「同一个文件改三次」准。
    if (isWrite) {
      this._endLook();
      this.seq.push('W');
      const wname = baseName(String(ti.file_path || ti.path || ''));
      this._pushAction('W', wname, now);
      this.ledger.acts += 1;
      if (wname) this.ledger.writes.add(wname);
    } else if (isCmd && cmdKey) {
      this.cmdStartAt = now;
      this.cmdStartLine = cmdHead(cmdKey, this.cfg.maxCmdLen);
      if (classifyCmd(cmdKey) === 'search') {
        this._markRead(now, cmdKey);   // 用命令翻东西，还是在找，不算「跑了」
        this._pushAction('S', cmdHead(cmdKey, this.cfg.maxCmdLen), now);
        this.ledger.acts += 1;
      } else {
        this._endLook();
        this.seq.push('C');
        this._pushAction('C', cmdHead(cmdKey, this.cfg.maxCmdLen), now);
        this.ledger.acts += 1;
        this.ledger.runs += 1;
      }
    } else if (isRead) {
      const where = String(ti.file_path || ti.path || ti.pattern || ti.glob || '').trim() || tool;
      this._markRead(now, where);
      this._pushAction('R', baseName(where), now);
    }
    if (this.seq.length > 24) this.seq.shift();

    const cycles = this._loopCycles();
    if (cycles >= this.cfg.loopCycles) {
      const cue = this._cue('loop', { n: cycles, c: cmdHead(this.lastCmd, this.cfg.maxCmdLen), p: project }, null, now, 'loop');
      if (cue) out.cues.push(cue);
    }

    // ── 写文件：数「同一个文件第几次」 ────────────────────
    if (WRITE_TOOLS.has(tool)) {
      const file = String((payload.tool_input || {}).file_path || (payload.tool_input || {}).path || '');
      const name = baseName(file);
      if (file) {
        const rec = this.edits.get(file) || { n: 0, at: now };
        if (now - rec.at > this.cfg.editWindowMs) rec.n = 0;   // 隔久了重新数
        rec.n += 1;
        rec.at = now;
        this.edits.set(file, rec);
        this.turnFiles.add(file);
        this.lastFile = name;

        const tier = this.cfg.editTiers.find((t) => rec.n === t);
        if (tier) {
          // 去重键必须带档位。不带的话第 3 次说出口就把键占住了，
          // 第 5 / 8 次全被自己挡掉 —— 配置里写的递进等于没有（实测发现）。
          const cue = this._cue('grind', { f: name, n: rec.n, p: project }, tier, now, `${name}#${rec.n}`);
          if (cue) out.cues.push(cue);
        }
        if (this.turnFiles.size === this.cfg.blastFiles) {
          const cue = this._cue('blast', { n: this.turnFiles.size, p: project }, null, now);
          if (cue) out.cues.push(cue);
        }
        // ── 一直在写，一次没跑 ─────────────────────────────
        // 这条数的也是「缺席」，跟 searchOnly 是同一类：不看它做了多少，看它没做什么。
        // 界面上只看得到它在动（文件一个一个冒出来），看不出它从没验证过任何一个 ——
        // 而闷头写不跑，是最容易交付出一堆没跑通过的东西的做法。
        // 阈值比 blast 低：改到第 4 个还没跑一次就该说，等到 6 个（blast 阈值）就晚了。
        if (this.turnFiles.size >= this.cfg.noVerifyFiles && this.turnRuns === 0) {
          // 键里带文件数：4 个说一次，5、6 个还会再说，不会说完一次就哑掉
          const cue = this._cue('noVerify', { n: this.turnFiles.size, p: project }, null, now, `noVerify@${this.turnFiles.size}`);
          if (cue) out.cues.push(cue);
        }
      }
    }

    // ── 跑命令：数「同一条命令第几次」 ────────────────────
    if (tool === 'Bash' || tool === 'shell' || tool === 'run_command') {
      const cmd = String((payload.tool_input || {}).command || '');
      if (cmd) {
        // 判重要忽略行尾的 --watch、重定向这类噪声，否则同一条命令会被当成不同的
        const key = cmd.replace(/\s+/g, ' ').trim();
        const rec = this.cmds.get(key) || { n: 0, at: now, fails: 0 };
        if (now - rec.at > this.cfg.cmdWindowMs) rec.n = 0;
        rec.n += 1;
        rec.at = now;
        this.cmds.set(key, rec);
        this.lastCmd = key;
        this.lastKind = classifyCmd(key);
        this.turnRuns += 1;

        const tier = this.cfg.cmdTiers.find((t) => rec.n === t);
        if (tier) {
          const cue = this._cue('guess', { c: cmdHead(key, this.cfg.maxCmdLen), n: rec.n, p: project }, tier, now, `${key}#${rec.n}`);
          if (cue) out.cues.push(cue);
        }
      }
    }

    // ── 只看不写：翻了半天，一个字没动 ─────────────────────
    // 前面所有维度数的都是「动作多少」，这一条数的是「动作的缺席」。
    // 他连着翻十几处却一行没写，说明他自己都不知道在找什么 —— 这句最刺人，也最真。
    if (this.readStreak >= this.cfg.readOnlyStreak
      && this.readFiles.size >= this.cfg.readOnlyFiles
      && now - this.readSince >= this.cfg.readOnlySpanMs) {
      const cue = this._cue('searchOnly', { n: this.readStreak, k: this.readFiles.size, p: project }, null, now, 'searchOnly');
      if (cue) out.cues.push(cue);
    }

    out.facts = this.facts(project);
    return out;
  }

  /** 一次「只看」：记次数、记又去了哪个地方、记起点 */
  _markRead(now, where) {
    if (!this.readStreak) this.readSince = now;
    this.readStreak += 1;
    const w = String(where || '').trim();
    if (w) this.readFiles.add(w);
  }

  /** 他动手了 —— 这一串「只看」结束，下次重新算 */
  _endLook() {
    this.readStreak = 0;
    this.readFiles = new Set();
  }

  /** 末尾有几个「改→跑」交替。3 轮才算循环，中途混进读操作不影响判定（读早被剔掉了） */
  _loopCycles() {
    const n = this.cfg.loopCycles * 2;
    if (this.seq.length < n) return 0;
    const tail = this.seq.slice(-n);
    for (let i = 0; i < n; i++) if (tail[i] !== (i % 2 ? 'C' : 'W')) return 0;
    return this.cfg.loopCycles;
  }

  /** 事实卡：外面看调试或者以后扩展台词都能用 */
  facts(project) {
    return {
      project: project || '',
      file: this.lastFile,
      cmd: cmdHead(this.lastCmd, this.cfg.maxCmdLen),
      kind: this.lastKind,
      ok: this.lastOk,
      filesThisTurn: this.turnFiles.size,
      readStreak: this.readStreak,
      seq: this.seq.join(''),
    };
  }

  /**
   * 动作时间线，旧→新。给「深想」的事实卡用。
   * 中间那列是「跟上一步隔了几秒」—— 这是规则数不出来、模型才用得上的东西：
   * 失败后 8 秒重跑和失败后坐了 5 分钟，是两种完全不同的状态。
   */
  historyList(n = 12, now = this._now()) {
    const tail = this.history.slice(-n);
    let prev = null;
    return tail.map((a) => {
      const gap = prev === null ? null : Math.max(1, Math.round((a.at - prev) / 1000));
      prev = a.at;
      return {
        agoS: Math.max(0, Math.round((now - a.at) / 1000)),
        gapS: gap,
        kind: a.kind,
        target: a.target,
        ok: a.ok,
      };
    });
  }

  snapshot() {
    return {
      ...this.facts(''),
      edits: this.edits.size,
      cmds: this.cmds.size,
      trackedFiles: [...this.turnFiles].map(baseName),
    };
  }
}

module.exports = {
  WorkWatcher,
  DEFAULT_WATCH,
  WRITE_TOOLS,
  READ_TOOLS,
  DANGER_RULES,
  KIND_CN,
  baseName,
  cmdHead,
  classifyCmd,
  errorKind,
  dangerOf,
  lastToolOutput,
  readTail,
};
