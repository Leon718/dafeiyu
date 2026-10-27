// 大肥鱼 · 感知闸门
//
// 形态二：她是个人，不是状态显示器。
// 所以这里是「时刻检测」而不是「状态映射」——
//   旧版：PreToolUse → working，PostToolUse → thinking，Stop → success …… 每次事件都演一次
//   新版：默认一句话都不说，只在少数真正值得开口的时刻放她出来
//
// 三条硬规矩（来自 CLAUDE.md）：
//   1. 她没读过他的代码。她说的是「他这个人现在怎么样」，不是任务进度
//   2. 不复述操作
//   3. 有预算：她话越少越值钱

const { WorkWatcher } = require('./watch');

const DEFAULT_GATE = {
  // 一小时最多主动打扰十二次（回应类不吃这个额度）。
  // 曾经是 8，被他实际使用推翻：连干两小时的话，8 次在头一小时就用干，
  // 后半段她彻底哑掉 —— 而这正是要修的病（「她只在旁边动，不说话」）。
  // 真正的防话痨是每类观察自己的去重窗口（watch.js 的 cueGapMs）和 60 秒冷却，
  // 预算只兜底。密度上限仍然是 1 句/分钟。
  maxPerHour: 12,
  maxPerTurn: 3,              // 兜底上限。正常轮不到它生效，见 FREE_MOMENTS 注释
  globalCooldownMs: 60 * 1000,
  longRunMs: 20 * 60 * 1000,  // 一轮干这么久才提一句
  comebackGapMs: 30 * 60 * 1000,
  // 他不在的时候的汇报：至少隔这么久才值得说。
  // 定 8 分钟：短于这个他根本没离开，汇报就成了播报；
  // 等待场景里一轮 agent 动辄十几分钟，8 分钟才够得上「他等了一会儿」。
  reportBackMinMs: 8 * 60 * 1000,
  reportBackMinActs: 3,       // 期间它至少干了这么多事，否则没什么可报
  reportBackMinFails: 3,      // 红这么多次才算「摔了不少跤」
  idleLongMs: 15 * 60 * 1000,
  nightFromHour: 23,
  nightFromMin: 30,
  nightToHour: 5,
  thoughtChance: 0.55,        // 手边有「想说的话」时，有多大比例真的说出口
  homeGreetGapMs: 10 * 60 * 1000,  // 他在她家开口，她隔这么久才应一声「来了」
};

// 失败到第几次她才报数。前两次她看着，不说话。
const FAIL_TIERS = [7, 5, 3];

// 见面礼不占预算。
// 踩过的坑：一开始给「一轮最多两句」，结果开局那句「来了。」吃掉一个名额，
// 到第 7 次失败她想说「我不数了」时已经没额度了 —— 最值钱的一句被最不值钱的挤掉了。
// 正确的做法是：每个时刻各有自己的去重机制（档位/一夜一次/轮内一次），
// 只有会重复发生的点评才吃小时预算。打招呼一天就一次，本来就不该跟点评抢。
const FREE_MOMENTS = ['firstGreet', 'comeback', 'openHome', 'bye', 'poke', 'drag', 'noSession', 'play'];

// 时刻 → 她用的动画。她工作的动画池（忙碌点按等）已经全部废弃，
// 那些是形态一的遗产：干活的是他，不是她。
const MOMENT_ANIM = {
  danger: '被吓一跳',
  flip: '工作状态-思考冒泡',
  rush: '玩游戏气急败坏',
  loop: '工作状态-原地踱步张望',
  searchOnly: '东张西望',
  stall: '碎碎念-对屏碎碎念',
  grind: '工作状态-原地踱步张望',
  guess: '碎碎念-对屏碎碎念',
  errKnown: '工作状态-垂头叹气冒汗',
  blast: '工作状态-思考冒泡',
  noVerify: '工作状态-思考冒泡',
  longRun: '东张西望',
  repeatedFailure: '工作状态-垂头叹气冒汗',
  lateNight: '哈欠连天',
  comeback: '东张西望',
  reportBack: '东张西望',
  successAfterStruggle: '工作状态-雀跃庆祝',
  firstGreet: '原地漂浮踏步',
  idleLong: '碎碎念-发呆碎碎念',
  openHome: '点击回应-元气挥手',
  thought: '碎碎念-对屏碎碎念',
};

// ── 动作优先：她说话时，播它手上那个活儿对应的动画 ────────────
// 原来 21 个时刻只配了 12 个动画，「东张西望」被 4 个时刻共用。
// 内容是新的、动作是旧的，动作就不再传递信息 —— 一个动作能被任何一句话套用，
// 它就等于没有动作。所以这几个观察类时刻先问「它此刻在干什么」（watch.js 的 action()），
// 有对应片子就播那个，动作和话互相印证。
//
// 剩下那些时刻不换：danger（她被吓一跳）、lateNight（她打哈欠）、
// successAfterStruggle（她雀跃）—— 那些动作本身就是她对这件事的反应，
// 换成「写代码」就把反应抹掉了。
const ACTION_FIRST = new Set(['flip', 'rush', 'loop', 'grind', 'guess', 'errKnown',
  'blast', 'noVerify', 'searchOnly', 'stall', 'repeatedFailure', 'longRun']);
const ACTION_ANIM = {
  write: '写代码',
  delete: '工作状态-清点归档',
  move: '工作状态-清点归档',
  read: '东张西望',
  run: '工作状态-忙碌点按',
};

// 不吃 60 秒冷却的两种。
//   danger：救命的话不能等，他下一毫秒就要按回车了
//   rush：它针对的就是「刚才那句刚说完他就重跑了」，被冷却吞掉等于这句永远说不出来
// 但它们仍然算「她主动开口」，rush 照样占小时预算（danger 连预算都不占，见 NO_BUDGET）。
const NO_COOLDOWN = ['danger', 'rush'];
// 完全不占预算的时刻。危险动作一个月只该出现几次，但如果真出现了十几次，
// 该被限流的是她的点评，不是她的「停」。
const NO_BUDGET = ['danger'];

// 同时满足多个时刻时谁先说。
// 喊停 > 看得见的细节 > 劝停 > 成了 > 报数 > 该睡了 > 坐太久 > 回来了
//
// 为什么 grind/guess/errKnown 排在最前：这三句是她「真的看见他了」的证据。
// 「又熬夜了」任何 AI 都能说，'agent.py 第三遍了'只有坐在旁边的人才说得出来。
// flip 排在 errKnown 前面：换错比认错有信息量 —— 它说明他往前走了，只是走进另一个坑。
const PRIORITY = [
  // 他明确要看的东西先给 —— 他开口了，别让他等
  'play',
  'danger',
  'flip',
  'rush',
  'grind',
  'loop',
  'errKnown',
  'guess',
  // 「它一直在写、一次没跑」比「它改得多」更值得说：前者是失控的前兆，后者只是范围大
  'noVerify',
  'blast',
  'searchOnly',
  'stall',
  'repeatedFailure',
  'successAfterStruggle',
  // 「你不在的时候它干了什么」排在熬夜之前：
  // 熬夜他忍忍就过去了，它想删东西这件事他必须知道。
  'reportBack',
  'lateNight',
  'longRun',
  'comeback',
  'firstGreet',
  'idleLong',
  'selfTalk',
];

function fillVars(line, vars) {
  return String(line).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined ? vars[k] : ''));
}

function hourOf(ts) {
  const d = new Date(ts);
  return d.getHours() + d.getMinutes() / 60;
}

function isNight(ts, gate) {
  const h = hourOf(ts);
  const from = gate.nightFromHour + gate.nightFromMin / 60;
  return h >= from || h < gate.nightToHour;
}

function dayKey(ts) {
  const d = new Date(ts);
  // 凌晨 5 点前算前一天夜里，跟 isNight 保持一致
  const t = d.getHours() < 5 ? ts - 24 * 3600 * 1000 : ts;
  const e = new Date(t);
  return `${e.getFullYear()}-${e.getMonth() + 1}-${e.getDate()}`;
}

class MomentDetector {
  constructor(opts = {}) {
    this.gate = { ...DEFAULT_GATE, ...(opts.gate || {}) };
    this.voices = opts.voices || {};
    this.home = opts.home || '';
    // 点播表：他直接说「跳个舞」她就演。零模型、零积分 ——
    // 这不是「她听懂了」，是「他说的话里有她认得的词」。装成前者就是骗人。
    this.playCues = opts.play || [];
    this._now = opts.now || (() => Date.now());   // 可注入时钟，单测要造「深夜」

    this.masterSession = null;
    this.herSession = null;    // 她在 WorkBuddy 里的会话 id（在自家说话时认出来）
    this.turn = null;          // 当前这一轮：{start, tools, fails, spoke, tiers}
    this.spokeAt = [];         // 最近一小时开口时刻
    this.lastSpokeAt = 0;
    this.lastSeenAt = 0;
    this.lastHomeAt = 0;       // 上次他在她家说话的时刻 —— 她出场/退场的计时基准
    this.lastHomeGreetAt = 0;  // 上次在他家应声的时刻 —— 别他每打一句都「来了」一遍
    this.nightSaid = null;     // 已经提醒过睡觉的那一天
    this.greeted = null;       // 已经打过招呼的那一天
    this.lastLine = Object.create(null);
    this.onDerivedMoment = null;

    // 「待说清单」：她在会话里想好的话，桌宠只负责在对的时机念出来。
    // 规则生不出见地 —— 见地必须来自她真的读过上下文。
    this.thoughtSource = opts.thoughtSource || null;   // () => {id,text}|null
    this.thoughtSink = opts.thoughtSink || null;       // (id) => void，念完就划掉
    this._rng = opts.rng || Math.random;               // 可注入，单测要确定性

    // 她看得见什么：只看动作（哪个项目、什么工具、改哪个文件、跑什么命令、成没成）。
    // 不是读代码 —— 见 watch.js 开头的理由。
    this.watcher = opts.watcher || new WorkWatcher({
      watch: opts.watch,
      projects: opts.projects,
      now: this._now,
    });
  }

  setThoughts(source, sink) {
    this.thoughtSource = source || null;
    this.thoughtSink = sink || null;
  }

  /** 只跟随「他」：后台定时任务的事件一律忽略，不再有会话互相抢状态 */
  _isHis(sessionId, ev) {
    if (!sessionId) return true;
    if (!this.masterSession) {
      if (ev === 'UserPromptSubmit') this.masterSession = sessionId;
      return this.masterSession === sessionId;
    }
    if (this.masterSession === sessionId) return true;
    // 只有他主动提问能换窗口：那一刻他确实站在那个窗口前面
    if (ev === 'UserPromptSubmit') {
      this.masterSession = sessionId;
      return true;
    }
    return false;
  }

  _budgetLeft(now) {
    this.spokeAt = this.spokeAt.filter((t) => now - t < 3600 * 1000);
    return this.gate.maxPerHour - this.spokeAt.length;
  }

  _canSpeak(now, opts = {}) {
    if (!opts.ignoreBudget && this._budgetLeft(now) <= 0) return false;
    if (opts.ignoreCooldown) return true;
    return now - this.lastSpokeAt >= this.gate.globalCooldownMs;
  }

  /**
   * @param key   时刻名
   * @param tier  按次数分档（byCount.3 / byCount.5）
   * @param sub   按种类分池（byKind.missing_module）—— 认错错专用
   */
  _pick(key, tier, sub) {
    return this._pickId(key, tier, sub)?.line ?? null;
  }

  /**
   * 挑一句，连它的身份证一起交出来。
   *
   * id 长这样：grind@5#1（时刻@档位#第几句）、danger.rm-wild#2（时刻.子类#第几句）。
   *
   * 为什么非要有个 id：改台词得先知道「哪一句真被念出来过、念了几次」。
   * 只统计到时刻这一层是没用的 —— 它会告诉你「grind 出现了 12 次」，
   * 却看不出 5 档里那句「你其实想推倒重写」到底有没有轮上过。
   * 而那一句恰恰是全库最值钱的。没有 id，优化就只能凭印象，凭印象必然改错地方。
   */
  _pickId(key, tier, sub) {
    const v = this.voices[key];
    const byKind = sub ? v?.byKind?.[sub] : null;
    const byCount = tier ? v?.byCount?.[String(tier)] : null;
    const lines = byKind || byCount || v?.lines;
    if (!lines || !lines.length) return null;
    const slot = byKind ? `.${sub}` : (byCount ? `@${tier}` : '');
    // 不连着说同一句
    const memoKey = `${key}:${tier || ''}:${sub || ''}`;
    let pool = lines;
    if (lines.length > 1 && this.lastLine[memoKey] !== undefined) {
      pool = lines.filter((_, i) => i !== this.lastLine[memoKey]);
    }
    const idx = Math.floor(this._rng() * pool.length);
    const realIdx = lines.indexOf(pool[idx]);
    this.lastLine[memoKey] = realIdx;
    return { line: pool[idx], id: `${key}${slot}#${realIdx}` };
  }

  /**
   * 这个时刻该播什么动画。
   * 观察类时刻先看它此刻在干什么 —— 动作和话对得上，动作才传递信息。
   */
  _animFor(moment) {
    if (ACTION_FIRST.has(moment) && this.watcher && typeof this.watcher.action === 'function') {
      const a = this.watcher.action();
      if (a && ACTION_ANIM[a]) return ACTION_ANIM[a];
    }
    return MOMENT_ANIM[moment] || null;
  }

  /**
   * 他是不是在点播一个动作（「给我跳支舞」）。
   *
   * 这是关键词表，不是理解 —— 别把它包装成「她听懂了他的话」。
   * 但正因为它笨，防误伤要严：光出现动作词不算，得有「让她做」的意思，
   * 否则「帮我看看这个跳舞的代码」她也会跳起来。
   */
  _matchPlay(prompt) {
    const p = String(prompt || '').trim();
    if (!p || p.length > 24) return null;   // 长句子在说正事，不抢戏
    const ask = /(给我|来一?[个支段下回]|表演|露一手|想看你|你跳|你唱|你演|做个|跳个|跳支|唱个|来点|整一个)/.test(p);
    // 整句就是个动作短语才算（「跳舞」「打个哈欠」）。
    // 带「的 / 代码 / 文件」的是在说这件事，不是要她做
    const nouny = /(的|代码|文件|函数|变量|测试|项目|文档|视频|图片|怎么|为什么)/;
    for (const cue of this.playCues) {
      for (const kw of (cue.match || [])) {
        if (!kw || !p.includes(kw)) continue;
        if (ask) return { anim: cue.anim, kw };
        if (p.length <= 8 && !nouny.test(p)) return { anim: cue.anim, kw };
      }
    }
    return null;
  }

  _emit(moment, vars, tier, now, animOverride) {
    // 第三种按子类选词：errKnown 用 vars.err（错误类型），danger 用 vars.k（危险类型），
    // reportBack 用 vars.sub（它不在那会儿属于哪种情况：危险 / 摔跤 / 闷头写 / 一路顺）
    const picked = this._pickId(moment, tier, vars && (vars.err || vars.k || vars.sub));
    if (!picked) return null;
    const raw = picked.line;
    // 一句台词可以是一条，也可以是一串（她像真人一样说两三个短句，中间带停顿）。
    // 语料里写成数组即可，渲染层会顺序播 —— 活人感的最大杠杆，且零成本。
    const beats = (Array.isArray(raw) ? raw : [raw]).map((b) => fillVars(b, vars));
    if (!FREE_MOMENTS.includes(moment) && !NO_BUDGET.includes(moment)) {
      this.spokeAt.push(now);
      if (this.turn) this.turn.spoke += 1;
    }
    this.lastSpokeAt = now;   // 不管说的什么，说完一句就得隔一会儿
    if (moment === 'lateNight') this.nightSaid = dayKey(now);
    if (moment === 'firstGreet') this.greeted = dayKey(now);
    return {
      moment,
      lineId: picked.id,
      text: beats[0],
      beats: beats.length > 1 ? beats : undefined,
      anim: animOverride || this._animFor(moment),
      tier: tier || null,
      // 原始槽位交出去：外面要拿它去凑事实卡（哪个文件、哪种错、哪条命令）。
      // 解析出来的台词是「话」，vars 才是「她看见了什么」。
      vars: vars || null,
      project: (vars && vars.p) || '',
    };
  }

  /**
   * 手边有她事先想好的话，就在这个时刻说出来。
   * 只在「他刚开口」和「他刚收工」两个时候考虑 —— 她不是播音器，不按分钟播报。
   */
  _thoughtMoment(payload, now) {
    if (!this.thoughtSource) return null;
    const ev = payload && payload.hook_event_name;
    if (ev !== 'UserPromptSubmit' && ev !== 'Stop') return null;
    if (!this._canSpeak(now)) return null;
    // 纸条是稀有资源。有一张就一定要说，那是倒垃圾，不是聊天
    if (this._rng() > this.gate.thoughtChance) return null;
    let item = null;
    try {
      item = this.thoughtSource();
    } catch { return null; }
    if (!item || !item.text) return null;

    this.spokeAt.push(now);
    this.lastSpokeAt = now;
    if (this.turn) this.turn.spoke += 1;
    try { this.thoughtSink?.(item.id); } catch { /* 划不掉下次还会说，不致命 */ }
    return { moment: 'thought', text: item.text, anim: MOMENT_ANIM.thought, thought: true };
  }

  /** 失败次数落到哪一档；没到档位返回 null */
  _failTier(n) {
    return FAIL_TIERS.find((t) => n >= t) || null;
  }

  /**
   * 收工 / 进行中都可能触发的时刻。返回按优先级排序的候选。
   * @param {number} now
   * @param {boolean} ending 是否是 Stop（一轮结束）
   */
  _candidates(now, ending) {
    const out = [];
    const t = this.turn;
    if (!t) return out;

    if (t.fails >= 3 && !t.tiers.includes(this._failTier(t.fails))) {
      out.push({ moment: 'repeatedFailure', tier: this._failTier(t.fails), vars: { n: t.fails } });
    }
    // 只有挣扎过才值得说「成了」。一路顺风的成功她不稀奇，也不撒花
    if (ending && t.fails >= 2 && !t.okSaid) {
      // 「成了」他自己第一眼就看见了。他看不见的是它摔了几跤才过 —— 那才是她该补的
      out.push({ moment: 'successAfterStruggle', vars: { n: t.fails } });
    }
    if (isNight(now, this.gate) && this.nightSaid !== dayKey(now)) {
      out.push({ moment: 'lateNight', vars: { clock: `${new Date(now).getHours()}:${String(new Date(now).getMinutes()).padStart(2, '0')}` } });
    }
    if (!t.longRunSaid && now - t.start >= this.gate.longRunMs) {
      const mins = Math.round((now - t.start) / 60000);
      out.push({
        moment: 'longRun',
        vars: { m: mins, h: (mins / 60).toFixed(1).replace(/\.0$/, ''), clock: `${new Date(t.start).getHours()}:${String(new Date(t.start).getMinutes()).padStart(2, '0')}` },
      });
    }
    return out;
  }

  /**
   * 他不在的时候，这里发生过什么。
   *
   * 等待场景里这是她最值钱的一句：他说完需求就走开了，agent 干了十几分钟，
   * 中间红的、卡的、甚至想删东西的，他一个都没看见。她一直在，所以只有她能说。
   *
   * 只回答「该不该说」和「属于哪一种」，具体怎么说是台词的事。
   *
   * @param {object|null} L watcher.closeLedger() 的结算
   */
  _reportBack(L) {
    const g = this.gate;
    if (!L || !L.since) return null;                  // 启动后第一个周期，没有「之前」可言
    if (L.ms < g.reportBackMinMs) return null;        // 他没走开，汇报就成了播报
    const vars = {
      m: Math.round(L.ms / 60000),
      n: L.acts,
      w: L.writes,
      r: L.runs,
      f: L.fails,
      e: L.errKinds.length,
    };
    const rep = (sub, extra) => ({
      moment: 'reportBack',
      vars: { ...vars, sub, ...extra },
      // 危险那一族不受冷却和预算限制：它跟当场那句「停」是同一件事的两个半截，
      // 他当时没听见，现在补上。被限流吞掉，等于它趁他不在干的事没人知道。
      must: sub.startsWith('danger'),
    });

    // ── 危险最优先 ───────────────────────────────────────
    // 分三种：她看得见 exitCode，所以「它真跑了」「没跑成」「不知道」都是事实不是猜。
    // 这三种的分量完全不同 —— 真跑了要他去看一眼，没跑成只需让他知道它动过这个念头。
    const dg = L.dangers[L.dangers.length - 1];
    if (dg) {
      const sub = dg.ran === true ? 'dangerRan' : dg.ran === false ? 'dangerBlocked' : 'dangerUnknown';
      return rep(sub, { d: L.dangers.length, c: dg.cmd, t: dg.target });
    }
    // 危险之外的才算「没什么可报」。
    // 顺序要紧：它就算只干了一件回不去的事，也比干了十件寻常事更该说。
    if (L.acts < g.reportBackMinActs) return null;
    if (L.fails >= g.reportBackMinFails) {
      // 换过几种错法，说明它一直在换路子试，不是在同一个地方撞墙
      return rep(L.errKinds.length >= 2 ? 'struggleFlip' : 'struggle', {});
    }
    if (L.writes >= 3 && L.runs === 0) return rep('noRun', {});
    if (L.fails === 0 && L.runs >= 1) return rep('smooth', {});
    // 摔了一两次又自己爬起来 —— 正常迭代，不值得在他开口时先插一嘴
    return null;
  }

  _speakBest(list, now) {
    if (!list.length) return null;
    list.sort((a, b) => PRIORITY.indexOf(a.moment) - PRIORITY.indexOf(b.moment));
    for (const c of list) {
      const free = FREE_MOMENTS.includes(c.moment);
      const noCool = NO_COOLDOWN.includes(c.moment);
      const noBudget = NO_BUDGET.includes(c.moment);
      // 回应类（他回来了、他开口了、他戳她）必须答：不占小时预算，也不吃冷却。
      // 踩过的坑：这里原来对所有时刻都查 _canSpeak，于是 4 分钟冷却内的「来了」「你回来了」
      // 直接被吞掉 —— 屏幕上只剩动画没有台词，看起来就像气泡坏了 / 她哑了。
      // 限流只该管「她主动来打扰」，不该管「他找她」。
      // must：它趁他不在干了危险的事，这条不受冷却和预算限制 ——
      // 它跟 danger 是同一件事的两个半截：当时他听不见，现在补上。被限流吞掉就等于没发生过。
      const must = c.must === true;
      if (!free && !must && !this._canSpeak(now, { ignoreCooldown: noCool, ignoreBudget: noBudget })) return null;
      // 见面礼不受轮内上限约束；点评才有。危险动作也不受 —— 一轮里遇见两次 rm -rf 就得说两次
      if (!free && !must && !noBudget && this.turn && this.turn.spoke >= this.gate.maxPerTurn) continue;
      const out = this._emit(c.moment, c.vars, c.tier, now);
      if (out) {
        // 只有真说出口，这次观察才算用掉。
        // 被上面的闸门拦下的那些，下次他再犯同样的错她还能提 —— 而不是白等 20 分钟。
        if (c.key && this.watcher && typeof this.watcher.commit === 'function') {
          this.watcher.commit(c, now);
        }
        if (c.moment === 'repeatedFailure') this.turn.tiers.push(c.tier);
        if (c.moment === 'longRun') this.turn.longRunSaid = true;
        if (c.moment === 'successAfterStruggle') this.turn.okSaid = true;
        return out;
      }
    }
    return null;
  }

  /**
   * @param {object} payload hook stdin JSON
   * @returns {{moment:string,text:string,anim:string|null,beats?:string[]}|null}
   */
  handle(payload) {
    const out = this._handleInner(payload);
    if (out) return out;
    // 其他时刻都没话说，再看看她手上有没有攒着想说的话
    return this._thoughtMoment(payload, this._now());
  }

  _handleInner(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const ev = payload.hook_event_name;
    if (!ev) return null;

    const now = this._now();

    // 她家的会话要认出来：桌宠靠这个把点击送回去（main.js 会读 herSession）
    //
    // 这里曾经是「在自家聊天不进闸门，直接 return null」——那是形态一的思路。
    // 现在反过来了：他在她家说话，是她出场的第一信号。
    // （她在那个 session 里的回复就是她本人说的，桌宠不替她再编一遍台词，只负责露面陪着）
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    if (cwd && this.home && (cwd === this.home || cwd.startsWith(this.home + '/'))) {
      this.herSession = payload.session_id || this.herSession;
      this.lastHomeAt = now;
      this.lastSeenAt = now;      // 他确实出现了，别把他当成「消失很久」
      // 他刚来的时候她要应一声 —— 但只应一次。
      // 原来这里恒返回 text:null（怕和聊天窗口里的回复重复），代价是 openHome 那几句台词
      // 写了却从来念不出来：他坐下来跟她聊半小时，桌面上只看得到动画、听不到一句话。
      const fresh = now - this.lastHomeGreetAt >= this.gate.homeGreetGapMs;
      if (!fresh) return { moment: 'atHome', home: true, text: null, anim: null };
      this.lastHomeGreetAt = now;
      const picked = this._pickId('openHome');
      if (!picked) return { moment: 'atHome', home: true, text: null, anim: null };
      const beats = (Array.isArray(picked.line) ? picked.line : [picked.line]).map((b) => fillVars(b, { home: this.home }));
      return {
        moment: 'openHome',
        home: true,
        lineId: picked.id,
        text: beats[0],
        beats: beats.length > 1 ? beats : undefined,
        anim: MOMENT_ANIM.openHome || null,
      };
    }

    if (!this._isHis(payload.session_id, ev)) return null;
    if (ev === 'SessionEnd') {
      this.masterSession = null;
      this.turn = null;
      return null;
    }
    if (ev === 'SessionStart') return null;

    // 先留一份旧的「上次见他」，再更新。
    // 踩过的坑：原来先更新再算 comeback，导致时间差永远是 0，comeback 一次都没触发过
    const prevSeenAt = this.lastSeenAt;
    this.lastSeenAt = now;

    switch (ev) {
      case 'UserPromptSubmit': {
        const day = dayKey(now);
        const back = prevSeenAt > 0 && now - prevSeenAt >= this.gate.comebackGapMs;
        // 他开口了 —— 上一轮「他不在」的周期到此结束。
        // 顺序不能反：账本记的是上一轮，turn 是这一轮的。
        const ledger = this.watcher ? this.watcher.closeLedger(now) : null;
        this.turn = { start: now, tools: 0, fails: 0, spoke: 0, tiers: [], longRunSaid: false, okSaid: false };
        this.watcher?.newTurn();      // 新的一轮，本轮改动过的文件清单从零算
        const rep = this._reportBack(ledger);
        const list = [];
        // 他在点播（「给我跳支舞」）：先演他要的。
        // 排在招呼和事后汇报之前 —— 他正盯着屏幕等回应，这时候先说「来了。我盯着呢」
        // 再跳舞，就是没听懂。
        const pc = this._matchPlay(payload.prompt);
        if (pc) {
          const out = this._emit('play', {}, null, now, pc.anim);
          if (out) return out;
          // 台词库里没有 play 这一组（自己改台词时删掉了，或用的是精简台词集）。
          // 这时候不能装死 —— 他正盯着屏幕等回应，「说了没反应」和「她死了」分不出来。
          // 只演不说话也行：动作本身就把「听懂了」说清楚了。
          return { moment: 'play', lineId: null, text: '', anim: pc.anim, tier: null, vars: null, project: '' };
        }
        // 「今天见过了」先记下，再决定说不说。
        // 否则：万一被冷却挤掉没吭声，下一次提问她又要「来了」一遍
        if (this.greeted !== day) {
          this.greeted = day;
          // 隔夜回来先打招呼。除非它趁他不在干了回不去的事 —— 那就先说事，
          // 打招呼晚一句不要紧，删掉的东西要不回来。
          if (rep && rep.must) list.push(rep);
          else list.push({ moment: 'firstGreet', vars: {} });
        } else if (rep) {
          // 他不知道的是自己走了多久，以及他不在的时候这里发生过什么
          list.push(rep);
        } else if (back) {
          // 「你回来了」是废话 —— 他知道自己回来了。
          list.push({ moment: 'comeback', vars: { m: Math.round((now - prevSeenAt) / 60000) } });
        }
        // 开局不检查久坐/失败，才刚开始。睡觉这事一夜只提一次，说了没听见也不再念叨
        if (isNight(now, this.gate) && this.nightSaid !== day) {
          this.nightSaid = day;
          list.push({ moment: 'lateNight', vars: { clock: `${new Date(now).getHours()}:${String(new Date(now).getMinutes()).padStart(2, '0')}` } });
        }
        return this._speakBest(list, now);
      }

      case 'PreToolUse': {
        // 默认静默：他正在干活，她看着。
        // 例外只有一个来源 —— 她真的看见了什么（watch.js 的观察）。
        if (!this.turn) return null;
        this.turn.tools += 1;
        const seen = this.watcher ? this.watcher.observe(payload) : { cues: [] };
        if (seen.cues && seen.cues.length) {
          const out = this._speakBest(seen.cues, now);
          if (out) return out;
        }
        // 坐太久也要查 —— 这里不查的话，一个长命令跑着（只有 PreToolUse 没有 PostToolUse）永远查不到
        if (this.turn.longRunSaid || now - this.turn.start < this.gate.longRunMs) return null;
        return this._speakBest(this._candidates(now, false), now);
      }

      case 'PostToolUse': {
        if (!this.turn) return null;
        const resp = payload.tool_response || {};
        const seen = this.watcher ? this.watcher.observe(payload) : { cues: [] };
        if (resp.exitCode !== undefined && resp.exitCode !== 0) {
          this.turn.fails += 1;
          // 她认得出这个错，就先说认得的那个 —— 「又一个 ModuleNotFound」比「又败了」具体一百倍
          if (seen.cues && seen.cues.length) {
            const out = this._speakBest(seen.cues, now);
            if (out) return out;
          }
          return this._speakBest(this._candidates(now, false), now);
        }
        // 工具跑完了但模型还在想：只有「坐太久」值得提
        if (!this.turn.longRunSaid && now - this.turn.start >= this.gate.longRunMs) {
          return this._speakBest(this._candidates(now, false), now);
        }
        return null;
      }

      case 'PostToolUseFailure': {
        if (this.turn) this.turn.fails += 1;
        const seen = this.watcher ? this.watcher.observe(payload) : { cues: [] };
        if (seen.cues && seen.cues.length) {
          const out = this._speakBest(seen.cues, now);
          if (out) return out;
        }
        return this._speakBest(this._candidates(now, false), now);
      }

      case 'Stop': {
        const out = this._speakBest(this._candidates(now, true), now);
        this.turn = null;
        return out;
      }

      // 形态一里这些会举牌/变脸；形态二里她不做反应，他自己会看
      case 'Notification':
      case 'PermissionRequest':
      case 'SubagentStart':
      case 'SubagentStop':
      case 'PreCompact':
      case 'PostCompact':
        return null;

      default:
        return null;
    }
  }

  /** 桌宠主动让她说一句（戳她、找不到她的会话等）。不走闸门判断，直接取词 */
  say(key, vars) {
    const raw = this._pick(key);
    return raw ? fillVars(raw, { home: this.home, ...(vars || {}) }) : null;
  }

  /** 桌宠侧定时调用：他很久没动静时，她自己出个声（低概率由调用方控制） */
  idleTick(now = this._now()) {
    if (this.turn) return null;                    // 他正在干活，不打扰
    if (!this.lastSeenAt) return null;
    if (now - this.lastSeenAt < this.gate.idleLongMs) return null;
    if (!this._canSpeak(now)) return null;
    const key = Math.random() < 0.35 ? 'selfTalk' : 'idleLong';
    const picked = this._pickId(key);
    if (!picked) return null;
    this.spokeAt.push(now);
    this.lastSpokeAt = now;
    this.lastSeenAt = now;                          // 说完这笔就翻篇，不然会一直触发
    return { moment: key, lineId: picked.id, text: fillVars(picked.line, { home: this.home }), anim: MOMENT_ANIM[key] || null };
  }

  snapshot() {
    const now = this._now();
    return {
      herSession: this.herSession || null,
      masterSession: this.masterSession,
      budgetLeft: this._budgetLeft(now),
      turn: this.turn ? { ...this.turn } : null,
      lastSpokeAgoMs: this.lastSpokeAt ? now - this.lastSpokeAt : null,
      lastHomeAgoMs: this.lastHomeAt ? now - this.lastHomeAt : null,
      nightSaid: this.nightSaid,
      greeted: this.greeted,
      watch: this.watcher ? this.watcher.snapshot() : null,
    };
  }
}

/**
 * 台词 id → 那句原话。审计日志里只存 id（短），要看它到底是哪句时用这个反查。
 *
 * 没有它，拿到 grind@5#1 就得自己打开 voices.json 去数第五档的第二句 ——
 * 数错一行，优化就改到错的句子上去了。
 *
 * @returns {string[]|null} 那句台词（可能多块，返回数组）
 */
function resolveLine(voices, lineId) {
  if (!voices || !lineId) return null;
  const m = /^([^#]+)#(\d+)$/.exec(String(lineId));
  if (!m) return null;
  const slot = m[1];
  const i = Number(m[2]);
  let key = slot, sub = null, tier = null;
  const dot = slot.indexOf('.');
  const at = slot.indexOf('@');
  if (dot > 0) { key = slot.slice(0, dot); sub = slot.slice(dot + 1); }
  else if (at > 0) { key = slot.slice(0, at); tier = slot.slice(at + 1); }
  const v = voices[key];
  if (!v) return null;
  const lines = (sub && v.byKind && v.byKind[sub]) || (tier && v.byCount && v.byCount[tier]) || v.lines;
  if (!lines || i >= lines.length) return null;
  const it = lines[i];
  return Array.isArray(it) ? it.slice() : [it];
}

module.exports = {
  MomentDetector, DEFAULT_GATE, FAIL_TIERS, MOMENT_ANIM, ACTION_FIRST, ACTION_ANIM,
  fillVars, isNight, dayKey, resolveLine,
};
