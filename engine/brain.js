'use strict';
/**
 * 大肥鱼 · 深思（唯一会花钱的那一层）
 *
 * 前情：她原来的感知全在本地上跑 —— 数次数、认错误类型、看间隔，零成本、零延迟。
 * 那是她的**直觉**。但直觉有个天花板：它只会数，不会读。
 * 她永远说不出「它在第 42 行说 None，你上面那个 get 是空的」，
 * 因为那需要真的读一遍报文 —— 而读数不是规则能干的活。
 *
 * 所以这里补的是**深思**，不是替换直觉。分工划得很死：
 *
 *   规则决定「要不要开口」 —— 所以她的打扰频率一点没变。
 *   模型决定「这一句能说多深」 —— 所以只有少数几句会变深。
 *
 * 这个划法不是省钱的妥协，是必须：让模型来判「该不该说话」，
 * 等于每一千次工具调用问她一千次，既贵又慢，还会把她的节奏搞乱。
 *
 * 三道闸，任何一道不过就**静默退回规则那句**（那句已经在播了，什么都不用做）：
 *   闸一 提示词：只许说卡里写着的
 *   闸二 guard：输出里每个代码形状的东西都必须在卡里出现过 —— 这是可测的，不是感觉
 *   闸三 体裁：超过 25 字、带感叹号、带「建议/你可以试试」、带代码块 → 一律作废
 *
 * 宁可一次都不说，也不能说错一句。她这个人设值钱的地方只有一点：说的一定是真的。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const DEFAULT_BRAIN = {
  enabled: true,
  provider: 'claude',        // claude | openai | off
  model: 'haiku',
  timeoutMs: 15000,
  // 软超时：这么久还一个字没吐，就别等了。实测首句 5.6~6.9 秒是常态，
  // 超过 11 秒基本是它卡住了 —— 再等下去他早就走神了，不如让她安静地走开。
  softTimeoutMs: 11000,
  maxPerHour: 3,             // 一小时最多深思三次
  minGapMs: 100 * 1000,      // 两次深思至少隔这么久（她刚说完一句，不该马上又来）
  sameAnchorHours: 12,       // 同一件事（同文件/同错）这么久之内不再深想
  maxOutputChars: 40,        // 气泡装得下的长度
  minErrChars: 160,          // 报错正文短于这个就别读了，读不出东西
  minDigActions: 3,          // 时间线至少这么多步才值得看形状（1~2 步看不出拍子）
  deepDelayMs: 850,          // 第一拍说出去多久后接第二拍
  baseUrl: '',               // provider=openai 时必填
  apiKey: '',
  claudePath: '',            // 留空自动找
};

// ── 哪些时刻值得动模型 ─────────────────────────────────────
// 判据不是「重要」，而是**规则做不了、而卡里恰好有素材**。
// 缺一条就退回去 —— 那不是遗憾，那是正确的节省。
//
// 反过来，这些永远不深思（写在这里是为了防止以后有人好心加进来）：
//   danger  救命的话不能拖 0.8 秒，也不能被一句「深思」冲淡
//   stall   事实只有「还在转」，模型也说不出别的
//   招呼类  零成本就够，花钱买「你回来了」是傻
const DEEP_SPEC = {
  readErr: {
    anim: '工作状态-思考冒泡',
    when: '他刚跑的命令失败了，而且报错正文够长（短报错看不出东西）',
    ask: '卡里有这一次的报错原文。只许指出报文里真的出现过的东西：哪一行、哪个名字、哪一类崩法。'
      + '没看出具体位置，就说这一层看不到的东西 —— 比如它是跑到最后一步才崩的，或者它连入口都没进去。'
      + '绝不许猜他没写的代码里有什么。',
  },
  seeDiff: {
    anim: '工作状态-思考冒泡',
    when: '他改了不止一遍，而且工作区里真有未提交的改动',
    ask: '卡里有它自己改的、还没提交的 diff。说你在这几行里看见了什么：它动了哪个判断、加了什么、拿掉了什么。'
      + '不判对错 —— 你只看到片段。唯一的例外是片段本身自相矛盾（同一个东西刚被当成空的、又当成有内容的），那才许点出来。',
  },
  dig: {
    anim: '工作状态-原地踱步张望',
    when: '他没换招：改跑改跑转到第三轮、或者一轮坐了太久',
    ask: '看那些间隔秒数。说这个循环本身 —— 它每一步隔多久、是不是连试的方向都没变。'
      + '不要说「你该换个思路」，那是废话；说你在时间线上看见的形状。',
  },
  plan: {
    anim: '东张西望',
    when: '他一轮里铺开动了很多文件，或者翻了半天一个字没写',
    ask: '看这些文件名和命令，猜它在把什么改成什么。只许从文件名和命令推，'
      + '措辞要留退路（「像是」「大概」）。猜不出就只说你在哪儿看见他停手了。',
  },
};

/**
 * 同时满足时的取舍：能读到具体东西的 > 有专门路径的 > 只能看形状的。
 * plan 排在 dig 前面：放宽后的 dig 几乎放行所有观察时刻，
 * 不这样的话 blast / searchOnly 会被 dig 抢走 —— 而「猜它在把什么改成什么」
 * 比「看拍子」更贴切那两个时刻。
 */
const DEEP_ORDER = ['readErr', 'seeDiff', 'plan', 'dig'];

/**
 * 「它在干活」的时刻 —— 只有这些时刻的时间线才值得花钱看形状。
 * 深夜、他回来了、打招呼、自言自语这些陪伴类没有形状可看，
 * 让模型去想只会买回一句「它在动」。
 */
const OBSERVE_MOMENTS = new Set([
  'flip', 'rush', 'loop', 'grind', 'guess', 'blast', 'noVerify',
  'errKnown', 'searchOnly', 'stall', 'repeatedFailure', 'longRun',
]);

/**
 * 这一刻值不值得花钱。纯函数，好测。
 * @returns {string|null} readErr | seeDiff | dig | plan | null
 */
function chooseDeep({ moment, tier, card, cfg = {} }) {
  if (!card) return null;
  const minErr = cfg.minErrChars ?? DEFAULT_BRAIN.minErrChars;
  const hasErr = String(card.errText || '').length >= minErr;
  const hasDiff = !!(card.diff && card.diff.body);
  const t = Number(tier) || 0;
  // 时间线是卡里唯一「永远不空」的素材：errText 要等报错、diff 要有未提交改动，
  // 而动作时间线只要他动过就有。早先 dig 只放行 loop/longRun 两个时刻 —— 实测 9 种
  // not-worth-it 全是 grind，等于这条路在他真实使用里根本走不到。
  const acts = Array.isArray(card.actions) ? card.actions.length : 0;
  const canDig = acts >= (cfg.minDigActions ?? DEFAULT_BRAIN.minDigActions);

  const fits = {
    readErr: (moment === 'errKnown' || moment === 'flip') && hasErr,
    // 第 3 次就深想太急：那时候他还在正常迭代。到第 5 次才值得看一眼他改了什么
    seeDiff: ((moment === 'grind' && t >= 5) || moment === 'flip' || moment === 'rush'
      || moment === 'errKnown') && hasDiff,
    // 看形状不挑时刻，只看时间线够不够长。陪伴类时刻（深夜/他回来了）除外 ——
    // 那些时刻没有「它在干活」的形状可看，花钱只会买回一句废话。
    dig: canDig && OBSERVE_MOMENTS.has(moment),
    plan: moment === 'blast' || moment === 'searchOnly',
  };
  for (const k of DEEP_ORDER) if (fits[k]) return k;
  return null;
}

// ── 提示词 ─────────────────────────────────────────────────
// 人格只写必要的那几行：说多了模型会开始表演，说少了它退化成助理。
const SYSTEM = [
  '你是「大肥鱼」，一只待在他电脑桌角的鱼。你认识他很久，见过他干活，不客气，也不安慰。',
  '你现在刚看见他做的事，要说一句 —— 只一句。',
  '',
  '规矩：',
  '1. 只能说卡里写着的。卡里没有的文件名、函数名、变量名、行号，一个都不许编。编错一次你就不可信了。',
  '2. 不复述他做了什么，不解释原理，不给建议，不说「你可以试试」。',
  '3. 不用感叹号，不用语气词（呀、啦、哦、呢、嘛），不提 AI / 助手 / 建议。',
  '4. 不超过 25 个字。可以是两个短句，用句号断开。',
  '5. 语气：看得久了、有点不耐烦，但站在他这边。像同行叹口气，不像客服鼓劲。',
  '6. 只输出那句话本身。不要引号，不要解释，不要分行。',
  '7. 主语：干活的是「它」（正在替他干活的那个 agent），不是他 —— 他只是坐在旁边等。',
  '   说它做的动作和结果，用「它」；只有跟他说话（他在等、他回来了）才用「你」。',
  '   弄错主语，话就说给了错的人：他明明什么都没做，你却在点评他的操作。',
  '',
  '她的口气长这样（照这个调，别照抄）：',
  '「agent.py 第三遍。」「它不是在改，是在试。」',
  '「找不到模块。」「它装到别处去了。」',
  '「8 秒。」「它没看上一屏。」',
  '「它改了四个。」「一次都没跑。」',
].join('\n');

function buildPrompt({ kind, card, cardText }) {
  const spec = DEEP_SPEC[kind] || {};
  const user = [
    '他刚才的情况：',
    cardText,
    '',
    '你这次要看的是：' + (spec.ask || '说一句你确实看出来的事。'),
    '',
    '只输出那一句话。',
  ].join('\n');
  return { system: SYSTEM, user };
}

// ── 闸二：guard ────────────────────────────────────────────
// 「装懂」在文本上是可测的：它一定会出现卡里没有的名词。
// 所以不需要另一个模型来当裁判 —— 一个正则就够，而且便宜一亿倍。
const CODEISH = /[A-Za-z_][A-Za-z0-9_]*(?:[._][A-Za-z0-9_]+)+|[A-Za-z0-9_./-]+\.(?:py|js|ts|tsx|jsx|json|jsonl|md|txt|ya?ml|toml|ini|cfg|conf|sh|bash|zsh|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|rb|sql|html|css|scss|vue|env|lock|csv|parquet)\b/g;
const BANNED = /作为|建议|你可以|试试|加油|辛苦|别灰心|抱抱|亲爱的|我理解|不要放弃|哈哈|其实呢|希望对你有帮助|AI|助手|大肥鱼/g;
const OK_TOKENS = new Set(['e.g', 'i.e', 'vs', 'etc', 'git']);

/**
 * 三道闸的第二、三道。返回 {ok, text, reason}。
 * reason 会被记进审计日志 —— 他以后想知道「她为什么那几次哑了」时看这个。
 */
function guard(text, card, cfg = {}) {
  const maxChars = cfg.maxOutputChars ?? DEFAULT_BRAIN.maxOutputChars;
  let t = String(text || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/^[「『"'\s]+|[」』"'\s]+$/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();

  if (!t) return { ok: false, reason: 'empty' };
  if (!/[\u4e00-\u9fa5]/.test(t)) return { ok: false, reason: 'no-chinese' };
  if (t.length > maxChars) return { ok: false, reason: `too-long:${t.length}` };
  if (/[!！]/.test(t)) return { ok: false, reason: 'exclamation' };
  if (/[`]/.test(t)) return { ok: false, reason: 'code-fence' };
  const bad = t.match(BANNED);
  if (bad) return { ok: false, reason: 'banned:' + bad[0] };
  if ((t.match(/[。？]/g) || []).length > 2) return { ok: false, reason: 'too-many-sentences' };
  // 她不会用括号解释自己，也不会自称
  if (/[（(]/.test(t)) return { ok: false, reason: 'parenthetical' };

  // 标识符：一个都不许凭空出现
  const allow = String(card.allowText || card.cardText || '').toLowerCase();
  const tokens = t.match(CODEISH) || [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (OK_TOKENS.has(low)) continue;
    if (allow.includes(low)) continue;
    return { ok: false, reason: 'unknown-symbol:' + tok };
  }

  // 数字：大数（行号、次数）必须在卡里出现过。小的数（三次、两遍）是她自己的数法，放过 ——
  // 否则「第 3 遍」会被自己的规则拦死，而卡里明明就只有三次。
  for (const num of (t.match(/\d+/g) || [])) {
    if (num.length <= 1) continue;
    if (allow.includes(num)) continue;
    return { ok: false, reason: 'unknown-number:' + num };
  }
  return { ok: true, text: t };
}

// ── 预算与缓存 ─────────────────────────────────────────────
class Brain {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULT_BRAIN, ...(opts.cfg || {}) };
    // 兜底目录。正常运行时 main.js 会传 app.getPath('userData')，走不到这里；
    // 单测和独立调用才会。别写死 macOS 的 Application Support —— 那是老的路径约定，
    // 换个平台就落到一个不存在的目录里，还静默失败。
    this.dir = opts.dir || path.join(os.homedir(), '.dafeiyu');
    this.logPath = path.join(this.dir, 'brain-log.jsonl');
    this.cachePath = path.join(this.dir, 'brain-cache.json');
    this.calls = [];          // 最近一小时的调用时刻
    this.lastAt = 0;
    this.cache = this._loadCache();
    this.dayStats = { day: '', n: 0, blocked: 0, ms: 0 };
  }

  _loadCache() {
    try {
      const o = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      return o && typeof o === 'object' ? o : {};
    } catch {
      return {};
    }
  }

  _saveCache() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache), 'utf8');
    } catch { /* 记不住不影响说话 */ }
  }

  /** 现在能不能花钱。三个闸：开关 / 每小时次数 / 最小间隔 */
  canCall(now = Date.now()) {
    if (!this.cfg.enabled || this.cfg.provider === 'off') return { ok: false, reason: 'off' };
    this.calls = this.calls.filter((t) => now - t < 3600 * 1000);
    if (this.calls.length >= this.cfg.maxPerHour) return { ok: false, reason: 'hour-budget' };
    if (this.lastAt && now - this.lastAt < this.cfg.minGapMs) return { ok: false, reason: 'gap' };
    return { ok: true };
  }

  /** 同一件事说过就不再花钱 */
  fresh(anchor, now = Date.now()) {
    const rec = this.cache[anchor];
    if (!rec) return true;
    return now - (rec.at || 0) > this.cfg.sameAnchorHours * 3600 * 1000;
  }

  mark(anchor, now = Date.now()) {
    this.lastAt = now;
    this.calls.push(now);
    const d = new Date(now);
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (this.dayStats.day !== day) this.dayStats = { day, n: 0, blocked: 0, ms: 0 };
    this.dayStats.n += 1;
  }

  remember(anchor, text, now = Date.now()) {
    this.cache[anchor] = { at: now, text };
    // 缓存别长成肿瘤：超过 300 条砍掉最老的
    const keys = Object.keys(this.cache);
    if (keys.length > 300) {
      keys.sort((a, b) => (this.cache[a].at || 0) - (this.cache[b].at || 0));
      for (const k of keys.slice(0, keys.length - 300)) delete this.cache[k];
    }
    this._saveCache();
  }

  /** 审计：他以后想知道钱买到什么、哪几次被拦了、为什么 */
  audit(rec) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(rec) + '\n', 'utf8');
    } catch { /* 日志写不进去不能影响说话 */ }
  }

  stats(now = Date.now()) {
    return {
      ...this.dayStats,
      callsLastHour: this.calls.filter((t) => now - t < 3600 * 1000).length,
      maxPerHour: this.cfg.maxPerHour,
      provider: this.cfg.provider,
      model: this.cfg.model,
      enabled: !!this.cfg.enabled,
    };
  }
}

// ── 干活：把提示词送到模型嘴里 ───────────────────────────────
function findClaude(configured) {
  const cands = [configured, process.env.CLAUDE_BIN,
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].filter(Boolean);
  for (const c of cands) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* 下一个 */ }
  }
  return '';
}

function cleanOutput(raw) {
  const lines = String(raw || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(⚠|✗|Tip:|Note:|\$)/.test(l));
  return lines.length ? lines[lines.length - 1] : '';
}

// ── 流式：她要的只是第一句，不该等整段想完 ──────────────────
//
// 实测（同一台机、同一张卡）：
//   等整段返回  6.7 ~ 48 秒（方差极大）
//   流式首字节  3.2 秒
// 差出来的这几秒正好卡在他注意力还在刚才那件事上的窗口里。
// 她要说的本来就只有一两句，所以「第一句到就说」比「全想好再说」正确得多 ——
// 后者在她身上等于把一句感叹变成一段汇报。
const SENT_END = /[。？！?]/;

/** 从累积文本里切出已完成的句子。返回 [已完成的行, 剩下的尾巴] */
function takeSentences(buf, max) {
  const out = [];
  let rest = buf;
  for (;;) {
    const m = rest.match(SENT_END);
    if (!m) break;
    const i = m.index + 1;
    const line = rest.slice(0, i).trim();
    rest = rest.slice(i);
    if (line) out.push(line);
    if (out.length >= max) { rest = ''; break; }
  }
  return [out, rest];
}

function callClaude({ system, user, model, timeoutMs, softTimeoutMs, bin, onLine }) {
  return new Promise((resolve) => {
    const exe = findClaude(bin);
    if (!exe) { resolve({ ok: false, reason: 'no-claude' }); return; }

    const args = [
      '-p', user,
      '--system-prompt', system,
      '--model', model,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--disallowed-tools', 'Bash,Read,Write,Edit,MultiEdit,Grep,Glob,WebFetch,WebSearch,Task,NotebookEdit',
    ];

    // 用 spawn 而不是 execFile，只为一个理由：**把 stdin 关掉**。
    // 踩过的坑：execFile 给子进程一个永远不关的 stdin 管道，claude 会先干等 3 秒
    //（stderr: "no stdin data received in 3s"）才开始干活。
    // 每次调用白烧 3 秒 —— 对她来说就是从「等 6 秒」变成「等 9 秒」。
    const cp = spawn(exe, args, {
      // 在中立目录里跑：别让它把某个项目的 CLAUDE.md 顺进来
      cwd: os.tmpdir(),
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const t0 = Date.now();
    let ttfb = 0;
    let full = '';        // 模型说过的全部
    let pending = '';     // 还没切成句的尾巴
    let spoken = 0;
    const lines = [];
    let errText = '';
    let finished = false;

    cp.stderr.on('data', (b) => {
      // 只留最后几行，够判断「没登录 / 参数不认 / 超时」就行
      errText = (errText + b.toString('utf8')).slice(-800);
    });

    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(soft);
      clearTimeout(hard);
      const tail = pending.trim();
      if (tail && spoken === 0) emit(tail);
      if (spoken === 0 && reason) {
        const hint = String(errText || '').replace(/\u001b\[[0-9;]*m/g, '').trim()
          .split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 160);
        resolve({ ok: false, reason, stderr: hint });
        return;
      }
      resolve({ ok: true, text: full.trim(), ttfb, ms: Date.now() - t0 });
    };

    cp.on('error', (e) => finish('spawn:' + (e.code || e.message)));
    // exit 之后 close 一般紧跟，但 stdout 管道偶尔会拖住 close。
    // 兜一下：进程都退了 400 毫秒还没收尾，就自己收尾 —— 不然调用方的 promise 永远挂着。
    cp.on('exit', () => { setTimeout(() => finish(''), 400); });
    cp.on('close', (code, signal) => finish(code === 0 || spoken > 0 ? '' : 'exec:exit-' + (code ?? signal)));

    // 一个字都还没吐出来的等待，是最没意义的等待
    const soft = setTimeout(() => {
      if (!ttfb && !spoken) { try { cp.kill('SIGTERM'); } catch { /* 已经死了 */ } }
    }, softTimeoutMs || timeoutMs);
    // 硬上限：已经开始说了也总得有个头，不然一个卡住的进程会一直挂在那儿
    const hard = setTimeout(() => {
      try { cp.kill('SIGKILL'); } catch { /* 已经死了 */ }
    }, timeoutMs || 15000);

    const emit = (line) => {
      spoken += 1;
      lines.push(line);
      onLine && onLine(line, spoken);
    };

    let buf = '';
    cp.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const rows = buf.split('\n');
      buf = rows.pop() || '';
      for (const row of rows) {
        const s = row.trim();
        if (!s) continue;
        let d;
        try { d = JSON.parse(s); } catch { continue; }
        // 两种事件都要看：增量（快）和最终结果（兜底）
        let delta = '';
        if (d.type === 'stream_event' && d.event) {
          const e = d.event;
          if (e.type === 'content_block_delta' && e.delta && typeof e.delta.text === 'string') delta = e.delta.text;
        } else if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
          // 没有增量时（旧版 CLI），整块一次到
          const t = d.message.content.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('');
          if (t && t.length > full.length) delta = t.slice(full.length);
        }
        if (!delta) continue;
        if (!ttfb) ttfb = Date.now() - t0;
        full += delta;
        pending += delta;
        // 一到句子边界就交出去：她的话本来就该一句一句蹦出来
        if (SENT_END.test(pending)) {
          const [done, rest] = takeSentences(pending, 2);
          pending = rest;
          for (const line of done) if (spoken < 2) emit(line);
        }
      }
    });
  });
}

function callOpenAI({ system, user, model, timeoutMs, baseUrl, apiKey, onLine }) {
  const url = String(baseUrl || '').replace(/\/+$/, '');
  if (!url || !apiKey) return Promise.resolve({ ok: false, reason: 'no-endpoint' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  return fetch(url + '/chat/completions', {
    method: 'POST',
    signal: ctrl.signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 96,
      temperature: 0.85,
      stream: true,
    }),
  }).then(async (r) => {
    if (!r.ok || !r.body) throw new Error('http:' + r.status);
    let full = '';
    let ttfb = 0;
    let buf = '';
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      const rows = buf.split('\n');
      buf = rows.pop() || '';
      for (const row of rows) {
        const s = row.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let d;
        try { d = JSON.parse(payload); } catch { continue; }
        const t = d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content;
        if (!t) continue;
        if (!ttfb) ttfb = Date.now() - t0;
        full += t;
        if (onLine && /[。？！?]/.test(t)) onLine(t);
      }
    }
    return { ok: true, text: full.trim(), ttfb, ms: Date.now() - t0 };
  })
    .catch((e) => ({ ok: false, reason: e.name === 'AbortError' ? 'timeout' : String(e.message || e) }))
    .finally(() => clearTimeout(timer));
}

/**
 * 一次完整的深思：提示词 → 模型（流式）→ 每句过闸 → 一句一句交出去。
 * 任何一步失败都返回 {ok:false}，调用方什么都不做（规则那句已经在播了）。
 *
 * onLine(text, n)：每有一句过关就回调一次。第 n 句通常是第二拍。
 */
async function think({ kind, card, cardText, cfg = {}, onLine, maxBeats = 2 }) {
  const c = { ...DEFAULT_BRAIN, ...cfg };
  // 卡片的渲染文本本身就是最权威的「她看见过什么」。
  // guard 拿它兜底：模型引用卡里的数字（间隔几秒、第几行）不该被误拦。
  const cardRef = { ...(card || {}), cardText };
  const { system, user } = buildPrompt({ kind, card: cardRef, cardText });
  const t0 = Date.now();

  const beats = [];
  const rejected = [];
  const push = (line) => {
    const g = guard(line, cardRef, c);
    if (!g.ok) { rejected.push(g.reason); return; }
    if (beats.includes(g.text)) return;
    if (beats.length >= maxBeats) return;
    beats.push(g.text);
    if (onLine) onLine(g.text, beats.length);
  };

  const r = c.provider === 'openai'
    ? await callOpenAI({ system, user, model: c.model, timeoutMs: c.timeoutMs, baseUrl: c.baseUrl, apiKey: c.apiKey, onLine: push })
    : await callClaude({ system, user, model: c.model, timeoutMs: c.timeoutMs, softTimeoutMs: c.softTimeoutMs, bin: c.claudePath, onLine: push });

  const ms = Date.now() - t0;
  if (!r.ok) return { ok: false, reason: r.reason, stderr: r.stderr, ms, kind };
  return {
    ok: beats.length > 0,
    beats,
    text: beats.join(''),
    rejected,
    raw: r.text,
    ttfb: r.ttfb,
    ms,
    kind,
  };
}

module.exports = {
  DEFAULT_BRAIN,
  DEEP_SPEC,
  SYSTEM,
  Brain,
  chooseDeep,
  buildPrompt,
  guard,
  think,
  findClaude,
  cleanOutput,
  OBSERVE_MOMENTS,
};
