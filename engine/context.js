'use strict';
/**
 * 大肥鱼 · 事实卡
 *
 * 「深想」的那一句，凭什么比规则那句更值钱？只可能因为**她手上多了东西**。
 * 所以这个文件只做一件事：把 hook payload 之外、但完全在本机的东西凑齐 ——
 *
 *   动作时间线（含间隔秒数）   规则数不出来：失败后 8 秒重跑 ≠ 失败后坐了 5 分钟
 *   这一次的报错原文            规则只认得 8 类，模型能看见第几行、哪个变量
 *   git diff（他没提交的改动）  从「你改了几次」跨到「你改了什么」，这是质的差别
 *   他最近说的话                他是想试一下，还是认定能过 —— 这句决定她该不该挖苦
 *   她家日记里相关的一行        上周也在这卡过，这是她唯一的记忆优势
 *
 * 全是本地文件 + 本地 git，0 网络、0 积分。唯一花在模型上的钱，只买「怎么说」。
 *
 * 两条硬约束，谁改这个文件都得守住：
 *   1. 每个字段都有长度上限。prompt 撑大 = 每次都多花钱、还更慢。
 *   2. 拿不到就是拿不到（不是 git 仓库、没有 diff、转录读不了）—— 直接省略该段，
 *      绝不用「大概是……」去填。她宁可少说，不能说错。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { baseName, readTail, lastToolOutput } = require('./watch');
const journal = require('./journal');

const LIMITS = {
  error: 1600,        // 报错正文：够看清最后几层调用栈
  diff: 2600,         // diff：够看两三处改动，再多也不该她来读
  words: 240,         // 他最近说的话
  diary: 900,         // 日记里相关行
  actions: 12,        // 时间线长度
  total: 4000,        // 整张卡的硬上限
};

// ── 本地 git ────────────────────────────────────────────────
// 只用来回答一个问题：他到底改了什么。
// 任何异常（不是 git 仓库 / 没装 git / 超时）都返回空串 —— 那是「不知道」，不是错误。
//
// 这里刻意用异步：主进程在跑一个 Electron 窗口，同步等 git 会让她卡住不动。
// 80 毫秒的一次阻塞，对他来说就是「拖不动了」。
function sh(cwd, args, maxBytes = 262144) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout: 1500,
      maxBuffer: maxBytes,
      encoding: 'utf8',
    }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

/** 他还没提交的改动。工作区优先，其次暂存区（他可能 git add 过再跑） */
async function gitDiff(cwd, file, maxChars = LIMITS.diff) {
  if (!cwd) return { body: '', stat: '' };
  const base = ['--no-pager', 'diff', '--no-color', '--no-ext-diff', '--unified=2'];
  const tail = file ? ['--', file] : [];
  let body = await sh(cwd, [...base, ...tail]);
  if (!body.trim()) body = await sh(cwd, [...base, '--cached', ...tail]);
  if (!body.trim()) return { body: '', stat: '' };

  const stat = (await sh(cwd, ['--no-pager', 'diff', '--no-color', '--shortstat', ...tail])).trim();
  const clipped = clip(body, maxChars, ['diff', 'index', '---', '+++', '@@']);
  return { body: clipped, stat };
}

/** diff 太长时砍中间，保留每一处改动的开头 —— 光留尾部会丢最早那处 */
function clip(text, max, dropPrefixes) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const lines = s.split('\n').filter((l) => l && !dropPrefixes.some((p) => l.startsWith(p)));
  const out = [];
  let n = 0;
  for (const l of lines) {
    if (n + l.length > max) break;
    out.push(l);
    n += l.length + 1;
  }
  return out.join('\n') + '\n（后面还有，截断了）';
}

// ── 转录：他最近说了什么 ─────────────────────────────────────
/**
 * 最后 n 条他本人输入（只认 <user_query>，automation 推送不算他说的）。
 * 读文件尾部 96KB：一整天的转录可能几十兆，不该为了两句话全读。
 */
function recentUserTurns(transcriptPath, n = 2) {
  if (!transcriptPath) return [];
  const raw = readTail(transcriptPath, 96 * 1024);
  if (!raw) return [];
  const out = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d.message && d.message.role ? d.message : d;
    if ((m.role || d.role) !== 'user') continue;
    const c = m.content !== undefined ? m.content : d.content;
    let text = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n') : '');
    if (!text) continue;
    const hit = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
    if (!hit) continue;
    const t = hit[1].replace(/\s+/g, ' ').trim();
    if (t.length < 2) continue;
    out.unshift(journal.shorten(t, 110));   // unshift：保持旧→新
  }
  return out;
}

// ── 她家日记：上周是不是也在这卡过 ────────────────────────────
/**
 * 只挑「跟当前这件事有关」的行。判据很土但有效：日记行里出现了当前文件名或命令词。
 * 没命中就返回空 —— 不加进去，避免模型拿无关的话硬凑「你上次也这样」。
 */
function diaryHits(homeDir, keys, { now = Date.now(), days = 3, max = 6 } = {}) {
  if (!homeDir || !keys.length) return [];
  const wants = keys.filter((k) => k && k.length >= 3).map((k) => k.toLowerCase());
  if (!wants.length) return [];
  const out = [];
  for (let i = 0; i < days; i++) {
    const f = journal.diaryPath(homeDir, now - i * 86400000);
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('-')) continue;
      const low = s.toLowerCase();
      if (!wants.some((w) => low.includes(w))) continue;
      out.push(s.replace(/^-\s*/, ''));
      if (out.length >= max) return out;
    }
  }
  return out;
}

// ── 组装 ────────────────────────────────────────────────────
const KIND_CN = { W: '改', C: '跑', R: '看', S: '搜' };

/**
 * 一张事实卡。字段全部可空 —— 空就是「她不知道」，渲染时整段省略。
 * @param {{kind:string, cue?:object, watch?:object, payload?:object, home?:string, project?:string, now?:number, limits?:object}} o
 */
async function buildCard(o = {}) {
  const {
    kind, cue = {}, watch, payload = {}, home = '',
    project = '', now = Date.now(), limits = LIMITS,
  } = o;

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const file = String(cue.f || (watch && watch.lastFile) || '');
  const cmd = String(cue.c || '');
  const errKind = String(cue.err || cue.b || '');

  const actions = watch && typeof watch.historyList === 'function'
    ? watch.historyList(limits.actions, now)
    : [];

  const errText = (() => {
    if (!payload.transcript_path) return '';
    const t = String(lastToolOutput(payload.transcript_path) || '').trim();
    return t.length > limits.error ? t.slice(-limits.error) : t;
  })();

  // diff 的范围：能确定是哪个文件就只看那个文件，确定不了就看整个工作区。
  // 后者更粗，但「他改了六处，两处是 .env」这种话只有整体 diff 才看得出来。
  const target = diffTarget(cwd, file, payload);
  const diff = await gitDiff(cwd, target, limits.diff);

  const words = recentUserTurns(payload.transcript_path, 2).map((w) =>
    w.length > limits.words ? w.slice(0, limits.words) + '…' : w);

  const diary = diaryHits(home, [file, baseName(cmd).replace(/\s.*$/, '')].filter(Boolean), { now });

  return {
    kind,
    project,
    file,
    cmd,
    errKind,
    actions,
    errText,
    diff,
    words,
    diary,
    // 给 guard 用：所有「卡里出现过的事实」。输出里任何代码形状的 token 必须能在这找到。
    // 间隔秒数也算事实 —— 她说「15 秒改一次，42 秒跑一次」是在复述时间线，不该被当成编造。
    allowText: [project, file, cmd, errKind, errText, diff.body, diff.stat, ...words, ...diary,
      ...actions.map((a) => a.target),
      ...actions.map((a) => a.gapS).filter((v) => v !== null && v !== undefined),
      ...actions.map((a) => a.agoS)].join('\n'),
  };
}

/**
 * 用哪个范围取 diff。
 * 只有当「payload 里的路径」和「她记着的文件名」确实指同一个文件时才收窄，
 * 否则拿错文件的 diff = 让她对着别人的代码发表意见，比不说更糟。
 */
function diffTarget(cwd, name, payload) {
  if (!name) return '';
  const ti = payload.tool_input || {};
  const p = String(ti.file_path || ti.path || '');
  if (!p) return '';
  if (baseName(p) !== name) return '';
  return p;
}

/**
 * 把卡渲染成模型读的那段文字。
 * 格式刻意像「便签」而不是 JSON：JSON 会让它开始分析字段，便签会让它说话。
 */
function renderCard(card, { now = Date.now() } = {}) {
  const L = [];
  if (card.project) L.push(`项目：${card.project}`);
  if (card.file) L.push(`他手上这个文件：${card.file}`);

  if (card.actions.length) {
    L.push('', '他刚才的动作（旧→新，前面是跟上一步隔了多久）：');
    for (const a of card.actions) {
      const gap = a.gapS === null ? '     ' : `+${String(a.gapS).padStart(3)}s`;
      const ok = a.ok === false ? '  → 失败' : (a.ok === true ? '  → 成了' : '');
      L.push(` ${gap} ${KIND_CN[a.kind] || '?'} ${a.target || ''}${ok}`);
    }
  }

  if (card.errText) {
    L.push('', '这一次的报错原文（尾部）：', card.errText);
  }
  if (card.diff && card.diff.body) {
    L.push('', '他没提交的改动（git diff）：', card.diff.body);
  }
  if (card.words.length) {
    L.push('', '他最近说的话：');
    for (const w of card.words) L.push(`- ${w}`);
  }
  if (card.diary.length) {
    L.push('', '她家日记里跟这件事有关的记录：');
    for (const d of card.diary) L.push(`- ${d}`);
  }
  const out = L.join('\n').trim();
  return out.length > LIMITS.total ? out.slice(0, LIMITS.total) + '\n（截断）' : out;
}

/** 缓存键：同一件事不重复花钱 */
function anchorOf({ kind, cue = {}, file }) {
  return [kind, cue.f || file || '', cue.err || '', cue.c || ''].join('|').slice(0, 120);
}

module.exports = {
  LIMITS,
  buildCard,
  renderCard,
  anchorOf,
  gitDiff,
  recentUserTurns,
  diaryHits,
};
