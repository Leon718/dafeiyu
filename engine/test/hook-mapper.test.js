// 感知闸门离线单测：node hook-mapper.test.js
// 除了行为，这里还用机器守着她的人设 —— 台词一旦写成「加油！」就会被这条测试拦下
const fs = require('node:fs');
const path = require('node:path');
const { MomentDetector, resolveLine } = require('../hook-mapper');
const { WorkWatcher } = require('../watch');

// 台词从仓库里读，不读用户家目录 —— 别人 clone 下来没有 ~/WorkBuddy/大肥鱼，
// 读家目录会让 npm test 在别人机器上直接崩（这条以前就是这么崩的）。
// 想拿自己的人格台词跑校验：DAFEIYU_VOICES=/path/to/voices.json npm test
const VOICES = JSON.parse(fs.readFileSync(
  process.env.DAFEIYU_VOICES || path.join(__dirname, '..', '..', 'content', 'voices.json'),
  'utf8'));
// 这个 HOME 只当一个普通目录用（模拟「在她的目录里干活」），不做任何文件读写，
// 所以指向一个不存在的路径也不会出事。
const HOME = path.join(require('node:os').homedir(), 'WorkBuddy', '大肥鱼');

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got=${a}\n       want=${e}`); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
}

const OPEN = { gate: { maxPerHour: 99, globalCooldownMs: 0 } };
function mk(opts = {}) {
  let T = opts.start || new Date(2026, 9, 25, 14, 0, 0).getTime();
  const m = new MomentDetector({
    voices: opts.voices || VOICES, home: HOME,
    gate: { ...OPEN.gate, ...(opts.gate || {}) },
    now: () => T,
    rng: opts.rng,
  });
  return { m, tick: (ms) => { T += ms; }, set: (t) => { T = t; } };
}
const S = 'sess-A';

// 带 watcher 的 detector：汇报要靠 watcher 的账本，光有闸门测不出来
function mkW(opts = {}) {
  let T = opts.start || new Date(2026, 9, 25, 14, 0, 0).getTime();
  const now = () => T;
  const w = new WorkWatcher({ now, watch: opts.watch || {}, projects: {} });
  const m = new MomentDetector({
    voices: opts.voices || VOICES, home: HOME,
    gate: { ...OPEN.gate, maxPerTurn: 99, ...(opts.gate || {}) },
    now, watcher: w, rng: opts.rng,
  });
  return { m, w, tick: (ms) => { T += ms; } };
}

(async () => {
  console.log('\n[1] 默认静默：他干活时她不说话');
  {
    const { m } = mk();
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    eq('PreToolUse 沉默', m.handle({ hook_event_name: 'PreToolUse', session_id: S, tool_name: 'Bash', cwd: '/work/x' }), null);
    eq('PostToolUse 成功沉默', m.handle({ hook_event_name: 'PostToolUse', session_id: S, tool_name: 'Bash', tool_response: { exitCode: 0 }, cwd: '/work/x' }), null);
    eq('Stop 一路顺风不撒花', m.handle({ hook_event_name: 'Stop', session_id: S, cwd: '/work/x' }), null);
  }

  console.log('\n[2] 她家：他刚来她要应一声，之后只陪着不插嘴');
  {
    const { m, tick } = mk();
    const homePayload = { hook_event_name: 'UserPromptSubmit', session_id: 'her-sess', cwd: HOME };
    const atHome = m.handle(homePayload);
    ok('他刚坐下 → 她开口应一声（openHome 台词不再是死代码）',
      atHome && atHome.home === true && !!atHome.text && atHome.moment === 'openHome', JSON.stringify(atHome));
    eq('认出她的会话', m.snapshot().herSession, 'her-sess');
    tick(30000);
    const again = m.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'her-sess', cwd: HOME });
    ok('紧接着他又说一句 → 只露面，不再「来了」一遍',
      again && again.home === true && again.text === null, JSON.stringify(again));
    const sub = m.handle({ hook_event_name: 'PostToolUseFailure', session_id: 'her-sess', cwd: HOME + '/sub' });
    ok('她家子目录也发出场信号', sub && sub.home === true, JSON.stringify(sub));
  }

  console.log('\n[3] 后台 session 不是他：失败不计数');
  {
    const { m } = mk();
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    for (let i = 0; i < 5; i++) {
      m.handle({ hook_event_name: 'PostToolUseFailure', session_id: 'sess-BG', cwd: '/other' });
    }
    eq('后台失败 5 次不开口', m.snapshot().turn.fails, 0);
    const r = m.handle({ hook_event_name: 'PostToolUseFailure', session_id: S, cwd: '/work/x' });
    m.handle({ hook_event_name: 'PostToolUseFailure', session_id: S, cwd: '/work/x' });
    const r3 = m.handle({ hook_event_name: 'PostToolUseFailure', session_id: S, cwd: '/work/x' });
    ok('他自己的失败才报数', r3 && r3.moment === 'repeatedFailure', JSON.stringify(r3));
    eq('报的是第 3 档', r3 && r3.tier, 3);
    void r;
  }

  console.log('\n[4] 失败分档：3 报数 / 5 提醒 / 7 改口劝停，一句都不能被挤掉');
  {
    const { m } = mk();
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });  // 开局那句见面礼
    const said = [];
    for (let i = 1; i <= 7; i++) {
      const r = m.handle({ hook_event_name: 'PostToolUseFailure', session_id: S, cwd: '/work/x' });
      if (r) said.push(`${i}:${r.moment}/${r.tier}`);
    }
    eq('3 / 5 / 7 全都说到了', said, [
      '3:repeatedFailure/3', '5:repeatedFailure/5', '7:repeatedFailure/7',
    ]);
  }

  console.log('\n[5] 挣扎过才说「成了」');
  {
    const a = mk();
    a.m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    eq('一次没失败：不说', a.m.handle({ hook_event_name: 'Stop', session_id: S, cwd: '/work/x' }), null);

    const b = mk();
    b.m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    b.m.handle({ hook_event_name: 'PostToolUseFailure', session_id: S, cwd: '/work/x' });
    b.m.handle({ hook_event_name: 'PostToolUseFailure', session_id: S, cwd: '/work/x' });
    const r = b.m.handle({ hook_event_name: 'Stop', session_id: S, cwd: '/work/x' });
    eq('失败过两次后成了：说', r && r.moment, 'successAfterStruggle');
  }

  console.log('\n[6] 坐太久：她报时间');
  {
    const { m, tick } = mk();
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    tick(19 * 60 * 1000);
    eq('19 分钟还没到阈值', m.handle({ hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x' }), null);
    tick(2 * 60 * 1000);
    const r = m.handle({ hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x' });
    eq('21 分钟：开口', r && r.moment, 'longRun');

    const c = mk({ voices: { longRun: { lines: ['{m}分钟了。从{clock}开始。'] } } });
    c.m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    c.tick(21 * 60 * 1000);
    const r2 = c.m.handle({ hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x' });
    eq('变量真的插值进去了', r2 && r2.text, '21分钟了。从14:00开始。');
  }

  console.log('\n[7] 深夜：一夜只提醒一次');
  {
    const night = new Date(2026, 9, 25, 23, 40, 0).getTime();
    const { m, tick } = mk({ start: night });
    const r1 = m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    eq('23:40 提醒', r1 && r1.moment, 'lateNight');
    tick(30 * 60 * 1000);
    const r2 = m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    ok('同一夜不再提睡觉', !r2 || r2.moment !== 'lateNight', JSON.stringify(r2));
  }

  console.log('\n[7b] 久别重逢：隔了半小时以上才说「你回来了」');
  {
    const { m, tick } = mk();
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });   // 当天首次：来了
    tick(10 * 60 * 1000);
    const near = m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    ok('才隔 10 分钟不算久别', !near || near.moment !== 'comeback', JSON.stringify(near));

    const b = mk();
    b.m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    b.tick(45 * 60 * 1000);
    const far = b.m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    eq('隔 45 分钟：你回来了', far && far.moment, 'comeback');
  }

  console.log('\n[8] 预算：点评一小时三次封顶，见面礼不占额度');
  {
    const { m, tick } = mk({ gate: { maxPerHour: 3, globalCooldownMs: 0 } });
    let count = 0;
    for (let round = 0; round < 6; round++) {
      m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
      for (let i = 0; i < 7; i++) {
        const r = m.handle({ hook_event_name: 'PostToolUseFailure', session_id: S, cwd: '/work/x' });
        if (r) count++;
      }
      tick(10 * 60 * 1000);
    }
    eq('六轮里点评只说了三次', count, 3);
    tick(61 * 60 * 1000);
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    let after = null;
    for (let i = 0; i < 3; i++) after = m.handle({ hook_event_name: 'PostToolUseFailure', session_id: S, cwd: '/work/x' }) || after;
    ok('过了一小时又能说', !!after, JSON.stringify(after));
  }

  console.log('\n[9] 人设校验：台词不许犯规（改语料库会被这条拦下）');
  {
    // ── 这里有一套被推翻过的规则，值得说清楚 ──────────────────────
    // 形态一时代她是个状态显示器：PreToolUse → 「正在写入日志」。看三次就腻，
    // 所以当时定了铁律「不复述操作」，写成词表：不许出现 文件/命令/代码/脚本。
    //
    // 这个写法后来撞墙了。她要能点评他在干什么，就必然要提文件名和命令，
    // 而词表分不出这两种句子：
    //     「正在改 agent.py」  —— 播报，零增量，看三次就腻
    //     「agent.py 第三遍了」—— 数数，有增量，只有坐在旁边的人数得出来
    // 区别不在提不提文件，在**有没有他看的事实**。
    //
    // 所以现在分两套：
    //   · 所有时刻：不许播报进度、不许感叹号/鼓励话/提自己是 AI
    //   · 观察类时刻（grind/guess/blast/errKnown/noVerify/danger/reportBack）：可以提文件、命令、次数，
    //     但必须带事实锚（数字或 {f}/{c}/{n} 槽位）——否则它就退化成「你在忙」
    //     reportBack 说的全是它趁他不在干的事，本来就是复述，不归到这儿会被误判成播报
    // 观察类时刻：说它干了什么、多久、几次，本来就要提命令和文件，不归「播报」管。
    // longRun 以前不在这个名单里，于是「一条命令跑了 40 分钟」被判成复述他的操作 ——
    // 但那正是他要的信息（他不知道那条命令挂住了）。
    const OBSERVE_MOMENTS = ['grind', 'guess', 'blast', 'errKnown', 'noVerify', 'danger', 'reportBack',
      'longRun', 'stall', 'rush', 'loop', 'searchOnly'];
    const bannedAlways = [
      [/！|!/, '感叹号'],
      [/加油|辛苦了|你很棒|真棒|好厉害/, '鼓励话'],
      [/[哦啦][。~～]?$/, '句尾讨好语气词（呢不算，疑问句的「人呢。」是她的正常说话）'],
      [/~|～/, '波浪号'],
      // \bAI\b 而不是 AI：老写法把 "FAILED" 里的 AI 也算了，误伤
      [/\bAI\b|人工智能|语言模型|prompt|系统提示/i, '提自己是 AI'],
      // 播报的是「动作」，不是「刚才」这个词本身 —— 「你刚才说过的」是翻旧账，不是播报
      [/(正在|刚刚|刚才)[^，。]{0,6}(改|跑|写|执行|运行|搜|装|删)|跑好了|改好了|执行完毕/, '播报进度'],
      // 替 agent 编内心。她只能看见它做了什么，看不见它想什么 ——
      // 「它以为这次会不一样」「它不肯换个地方想」「它连关键词都不确定」全是编的。
      // 这条是主语改成「它」之后冒出来的新毛病：以前骂错人，现在开始编心理。
      // 注意「它想 {c}」不在这里 —— 那个「想」是「试图」，不是「思考」。
      // 行话：他默认不懂工程流程（2026-10-27 定的判据 —— 用 agent 的人大多不看工程细节，
      // 只关心需求有没有完成、有没有大风险、是不是重复劳动、是不是白烧额度）。
      // 「一次都没跑」他不知道改完要跑什么；「红了」他不知道红的是什么。
      // 这类词必须换成「能不能用」「报错」。
      [/红了|红的|没红|红过|连红|\bdiff\b|\bcommit\b|\brepo\b|\bPR\b|\bmerge\b|\bstaging\b|\brollback\b/i,
        '行话（他不懂工程流程，要说「报错」「改了哪些」「能不能用」）'],
      // 「输入」是最容易漏的一个：写台词的人懂 stdin/stdout，他不懂。
      // 他只知道「改没改东西」——所以要说「一个字没改」
      [/输入|输出流|标准输入|stdout|stderr/i, '行话（「输入」要说成「它改没改」）'],
      [/它[^。]{0,10}(以为|觉得|记得|记着|忘|不肯|不愿|不想|打算|希望|相信|怀疑|不确定|不知道|意识到|数得清)/,
        '替它编内心（她看不见 agent 想什么，只能看见它做了什么）'],
    ];
    // 悬空数字：只有数量，没说在数什么。
    // 「它 6 次了。」「40 分钟了。」—— 他得自己回想上下文才能接上，多半接不上。
    // 「了」要算进去：{n} 个了。 / {n} 次了。 跟 {n} 个。 一样悬空，
    // 但第一版正则漏了这个「了」，于是「6 个了。改完不试，错了也发现不了。」混了过去
    const BARE_NUM = /^\{[a-z]+\}\s*(次|个|分钟|秒)(了)?[。，]?$/;
    const bannedReport = [
      [/(文件|命令|代码|脚本|工具|搜索|运行|执行|写入|读取)/, '复述他的操作（观察类时刻可以说，别处不行）'],
    ];
    // 事实锚：数字、中文数词，或者槽位
    // {s} 秒数、{k} 地方数、{e} 错误种类数、{w} 文件数 以前漏在这儿 ——
    // 于是「这 4 秒白花」「12 个地方了」被判成没有事实锚，明明它带着最硬的数字。
    const ANCHOR = /\d|[一二三四五六七八九十]|\{(f|c|n|p|m|h|s|k|e|w|clock)\}/;

    let bad = [];
    let total = 0;
    let multi = 0;

    // 单句只查禁词
    const checkText = (s, where, moment) => {
      total++;
      bannedAlways.forEach(([re, why]) => { if (re.test(s)) bad.push(`${where} "${s}" → ${why}`); });
      if (!OBSERVE_MOMENTS.includes(moment)) {
        bannedReport.forEach(([re, why]) => { if (re.test(s)) bad.push(`${where} "${s}" → ${why}`); });
      }
    };
    // 一条台词：可能是单句，也可能是多拍。锚只看整体 ——
    // 「agent.py 第三遍了。」+「它没坏。」是一条台词，第二拍不需要再带数字。
    const checkLine = (line, where, moment) => {
      const beats = typeof line === 'string' ? [line] : line;
      beats.forEach((t, i) => {
        const at = beats.length > 1 ? `${where}[${i}]` : where;
        checkText(t, at, moment);
        if (BARE_NUM.test(String(t).trim())) {
          bad.push(`${at} "${t}" → 悬空数字（只有数量，没说在数什么）`);
        }
      });
      if (!OBSERVE_MOMENTS.includes(moment) || moment === 'errKnown' || moment === 'danger' || moment === 'reportBack') return;
      // errKnown / danger / reportBack 的 byKind 本身就是锚
      // （已经锁定了具体错误类型 / 具体危险动作 / 他不在那会儿属于哪种情况），
      // 不需要再额外要求数字 —— 「没被 git 记住的文件，它一起清。」这句话的信息量全在 byKind 里。
      // reportBack 同理：「它真跑了。」的信息量全在 dangerRan 这个子类上，逼它带数字反而会毁掉这句。
      if (!ANCHOR.test(beats.join(''))) {
        bad.push(`${where} "${beats.join(' / ')}" → 观察类台词没有事实锚（就成了「你在忙」）`);
      }
    };
    const walkBlock = (v, where, moment) => {
      if (Array.isArray(v)) {
        // 这一层的每个元素是一条台词
        let nested = false;
        v.forEach((line, i) => {
          if (Array.isArray(line)) nested = true;
          checkLine(line, `${where}[${i}]`, moment);
        });
        if (nested) multi++;
        return;
      }
      if (v && typeof v === 'object') {
        for (const [k, sub] of Object.entries(v)) {
          if (k.startsWith('_')) continue;
          walkBlock(sub, `${where}.${k}`, moment);
        }
      }
    };
    for (const [moment, v] of Object.entries(VOICES)) {
      if (moment.startsWith('_')) continue;
      walkBlock(v, `voices.${moment}`, moment);
    }
    ok(`共 ${total} 句台词全部守住人设`, bad.length === 0, bad.join('\n       '));
    ok('没有 byTool 这种按工具名播报的字段', VOICES.byTool === undefined);
    ok(`有 ${multi} 处是连说几句（不能全是一句话的朗读器）`, multi >= 5, `multi=${multi}`);
  }

  console.log('\n[10] 他很久没动静：她自己出个声');
  {
    const { m, tick } = mk();
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    m.handle({ hook_event_name: 'Stop', session_id: S, cwd: '/work/x' });
    eq('刚收工不打扰', m.idleTick(), null);
    tick(20 * 60 * 1000);
    const r = m.idleTick();
    ok('静了 20 分钟后她出声', !!r && ['selfTalk', 'idleLong'].includes(r.moment), JSON.stringify(r));
  }

  console.log('\n[11] 连说几句：数组台词要变成 beats，不能是一整个字符串');
  {
    const voices = { firstGreet: { lines: [['来了。', '我没看表。'], '早。'] } };
    const { m } = mk({ voices, rng: () => 0 });   // rng=0 稳定取第一条
    const r = m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    eq('拍子都取到了', r && r.beats, ['来了。', '我没看表。']);
    eq('text 是第一拍（兼容旧调用方）', r && r.text, '来了。');

    const b = mk({ voices: { firstGreet: { lines: ['早。'] } }, rng: () => 0 });
    const r2 = b.m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    eq('单句不产生 beats', r2 && r2.beats, undefined);
  }

  console.log('\n[12] 待说清单：她自己攒的话在对的时机说出来，说完就划掉');
  {
    let queue = [{ id: 'a1', text: '你在想那个还没结论。' }];
    const consumed = [];
    const { m } = mk({
      gate: { maxPerHour: 99, globalCooldownMs: 0 }, rng: () => 0,
    });
    m.setThoughts(
      () => queue[0] || null,
      (id) => { consumed.push(id); queue = queue.filter((q) => q.id !== id); },
    );

    eq('干活中途不倒纸条', m.handle({ hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x' }), null);
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });   // 被见面礼占掉
    const r = m.handle({ hook_event_name: 'Stop', session_id: S, cwd: '/work/x' });
    ok('收工时把攒着的话说了', r && r.moment === 'thought', JSON.stringify(r));
    eq('说完就划掉', consumed, ['a1']);
    eq('清单空了就不再说', m.handle({ hook_event_name: 'Stop', session_id: S, cwd: '/work/x' }), null);
  }

  console.log('\n[13] 待说清单也吃预算，不会把她的嘴变成广播');
  {
    const { m, tick } = mk({ gate: { maxPerHour: 3, globalCooldownMs: 0 }, rng: () => 0 });
    let n = 0;
    m.setThoughts(() => ({ id: 'x' + (++n), text: '第' + n + '句' }), () => {});
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });  // 见面礼（不占额度）
    let said = 0;
    for (let i = 0; i < 6; i++) {
      // 提问和收工两个时机都算，别只数一半
      if (m.handle({ hook_event_name: 'Stop', session_id: S, cwd: '/work/x' })) said++;
      if (m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' })) said++;
      tick(60 * 1000);
    }
    eq('一小时最多三次', said, 3);
  }

  console.log('\n[14] 闸门只拦「她主动打扰」，不拦「他找她」');
  {
    // 预算和冷却同时耗尽的最坏情况
    const { m } = mk({ gate: { maxPerHour: 0, globalCooldownMs: 600000, longRunMs: 0 } });
    const greet = m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    ok('预算耗尽、冷却中，他来了她照样开口', !!(greet && greet.text), JSON.stringify(greet));

    // 同一时刻，主动类的「坐太久」必须被拦 —— 别把闸门整个拆了
    const longRun = m.handle({ hook_event_name: 'PreToolUse', session_id: S, tool_name: 'Bash', cwd: '/work/x' });
    eq('预算耗尽时她主动的「坐太久」仍然闭嘴', longRun, null);
  }

  console.log('\n[15] 她看得见：把文件名、命令、次数说进气泡里');
  {
    // 这一条守的是「她真的看见他了」—— 端到端，从 payload 到最终气泡文字。
    const { m, tick } = mk({ rng: () => 0 });
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    const F = '/home/me/code/demo/agent.py';
    const edit = () => m.handle({
      hook_event_name: 'PreToolUse', session_id: S, tool_name: 'Edit',
      tool_input: { file_path: F }, cwd: '/home/me/code/demo',
    });
    edit(); tick(20000);
    edit(); tick(20000);
    const r = edit();
    ok('同一个文件第三遍，她开口', !!(r && r.moment === 'grind'), JSON.stringify(r));
    ok('气泡里是文件名，不是全路径', !!(r && r.text.includes('agent.py')), r && r.text);
    ok('气泡里不带目录路径（只念文件名）',
      !!(r && !r.text.includes('/home/me') && !r.text.includes('code/')), r && r.text);
    ok('带她自己的动画', !!(r && r.anim), JSON.stringify(r && r.anim));
    // rng=0 取到的是多拍那条：「agent.py 第三遍了。」+「你不是在改，是在试。」
    // 截图只能拍到第一拍，所以这条必须靠断言守 —— 否则哪天 beats 断了没人发现
    ok('多拍：气泡会蹦两句', !!(r && r.beats && r.beats.length === 2), JSON.stringify(r && r.beats));
    ok('两拍都填了槽位', !!(r && r.beats[0].includes('agent.py')), JSON.stringify(r && r.beats));

    // 同一时刻她也在数命令
    const { m: m2, tick: t2 } = mk({ rng: () => 0 });
    m2.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    const run = () => m2.handle({
      hook_event_name: 'PreToolUse', session_id: S, tool_name: 'Bash',
      tool_input: { command: 'npm test -- --watch' }, cwd: '/home/me/code/demo',
    });
    run(); t2(20000);
    run(); t2(20000);
    const g = run();
    ok('同一条命令第三遍，她开口', !!(g && g.moment === 'guess'), JSON.stringify(g));
    ok('命令截短了，念得像人话', !!(g && !g.text.includes('--watch')), g && g.text);

    // 他正常翻代码时她必须闭嘴（别把「查代码」误判成「原地打转」）
    const { m: m3, tick: t3 } = mk({ rng: () => 0 });
    m3.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    let said = 0;
    for (let i = 0; i < 10; i++) {
      if (m3.handle({ hook_event_name: 'PreToolUse', session_id: S, tool_name: 'Read', tool_input: { file_path: F }, cwd: '/work/x' })) said++;
      t3(3000);
    }
    eq('连读同一个文件十次，一句都不说', said, 0);
  }

  console.log('\n[16] 危险动作：冷却和预算都拦不住她');
  {
    // 这两条是刻意的例外。她主动点评可以限流，但「停」不能排队 ——
    // 排队等于：他按下回车之后，她才把「别按」说出来。
    const { m, tick } = mk({ gate: { maxPerHour: 0, globalCooldownMs: 600000 }, rng: () => 0 });
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    const danger = (command) => m.handle({
      hook_event_name: 'PreToolUse', session_id: S, tool_name: 'Bash',
      tool_input: { command }, cwd: '/home/me/code/demo',
    });
    const a = danger('git reset --hard');
    ok('预算为 0、冷却十分钟，喊停照样说得出来', !!(a && a.moment === 'danger' && a.text), JSON.stringify(a));
    tick(1000);
    const b = danger('rm -rf ~');
    ok('一秒后另一种危险，也说（不吃冷却）', !!(b && b.moment === 'danger'), JSON.stringify(b));
    ok('两种危险用了不同的台词', !!(a && b && a.text !== b.text), `${a && a.text} / ${b && b.text}`);
    eq('删 node_modules 不吭声', danger('rm -rf node_modules'), null);
    eq('git status 不吭声', danger('git status'), null);
  }

  console.log('\n[17] 换错与秒重跑：从 payload 一路走到气泡');
  {
    const os = require('node:os');
    const tmp = path.join(os.tmpdir(), 'pet-hook-flip.jsonl');
    const fx = (text) => fs.writeFileSync(
      tmp, JSON.stringify({ type: 'function_call_result', output: { type: 'text', text } }) + '\n',
    );
    const CWD = '/home/me/code/demo';
    const cmd = 'python run.py';

    const { m, tick } = mk({ rng: () => 0 });
    m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: CWD });
    const run = (text) => {
      m.handle({ hook_event_name: 'PreToolUse', session_id: S, tool_name: 'Bash', tool_input: { command: cmd }, cwd: CWD });
      fx(text);
      return m.handle({
        hook_event_name: 'PostToolUse', session_id: S, tool_name: 'Bash', tool_input: { command: cmd },
        tool_response: { exitCode: 1 }, transcript_path: tmp, cwd: CWD,
      });
    };
    const a = run('ModuleNotFoundError: No module named flask');
    ok('第一次失败 → 承认得的那个错', !!(a && a.moment === 'errKnown'), JSON.stringify(a));
    tick(60000);
    const b = run('TypeError: unsupported operand type');
    ok('换了一种错 → 说 flip', !!(b && b.moment === 'flip'), JSON.stringify(b));
    ok('  → 气泡里点出前后是哪两种', !!((b && b.beats && b.beats.join('').includes('运行时错'))), JSON.stringify(b && b.beats));

    // 秒重跑：上一次刚说完（十分钟冷却内），这次也得说 —— 它针对的就是「刚说完他就重跑」
    const { m: r, tick: rt } = mk({ rng: () => 0, gate: { globalCooldownMs: 600000 } });
    r.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: CWD });
    const runR = (text) => {
      r.handle({ hook_event_name: 'PreToolUse', session_id: S, tool_name: 'Bash', tool_input: { command: 'pytest -x' }, cwd: CWD });
      fx(text);
      return r.handle({
        hook_event_name: 'PostToolUse', session_id: S, tool_name: 'Bash', tool_input: { command: 'pytest -x' },
        tool_response: { exitCode: 1 }, transcript_path: tmp, cwd: CWD,
      });
    };
    runR('FAILED tests/test_a.py::test_one');
    rt(8000);
    const rr = runR('FAILED tests/test_a.py::test_one');
    ok('八秒后重跑，冷却是十分钟也要说', !!(rr && rr.moment === 'rush'), JSON.stringify(rr));
    ok('  → 气泡里报出隔了几秒',
      !!((rr && (rr.text + (rr.beats || []).join('')).includes('8'))), JSON.stringify(rr && [rr.text, rr.beats]));

    fs.unlinkSync(tmp);
  }

  console.log('\n[9] 台词 id：说出口的每一句都能被反查回来');
  {
    // 开口审计只存 id，不存整句。id 必须对得上原句 ——
    // 对不上，优化的时候就会拿着错误的编号去改另一句话。
    const { m } = mk({ rng: () => 0.1 });
    const p1 = m._pickId('grind', 5);
    ok('挑词带 id，档位也在 id 里', !!(p1 && p1.id.startsWith('grind@5#')), JSON.stringify(p1));
    eq('  → id 反查回来就是挑中的那句',
      resolveLine(VOICES, p1.id), Array.isArray(p1.line) ? p1.line : [p1.line]);

    const p2 = m._pickId('danger', null, 'rm-wild');
    ok('危险命令走子类，id 里带着是哪一种', !!(p2 && p2.id.startsWith('danger.rm-wild#')), JSON.stringify(p2));
    ok('  → 子类也能反查', !!resolveLine(VOICES, p2.id));

    const p3 = m._pickId('lateNight');
    ok('没有档位和子类时，id 就是 时刻#序号', !!(p3 && /^lateNight#\d+$/.test(p3.id)), JSON.stringify(p3));

    // 全库遍历。这条守的是「编号规则」和「反查规则」永远一致 ——
    // 以后新增时刻忘了同步其中一边，这里立刻会红。
    let checked = 0;
    const bad = [];
    for (const key of Object.keys(VOICES)) {
      if (key.startsWith('_')) continue;
      const v = VOICES[key];
      const slots = [];
      if (v.byKind) for (const s of Object.keys(v.byKind)) slots.push([`.${s}`, v.byKind[s]]);
      if (v.byCount) for (const t of Object.keys(v.byCount)) slots.push([`@${t}`, v.byCount[t]]);
      if (v.lines) slots.push(['', v.lines]);
      for (const [slot, pool] of slots) {
        for (let i = 0; i < pool.length; i++) {
          const want = Array.isArray(pool[i]) ? pool[i] : [pool[i]];
          checked++;
          if (JSON.stringify(resolveLine(VOICES, `${key}${slot}#${i}`)) !== JSON.stringify(want)) {
            bad.push(`${key}${slot}#${i}`);
          }
        }
      }
    }
    ok(`全库 ${checked} 句台词，id 全都能反查出原句`, bad.length === 0, bad.slice(0, 6).join(' | '));
    ok('不存在的 id 反查得到 null，不会炸',
      resolveLine(VOICES, 'grind@9#99') === null && resolveLine(VOICES, '瞎写的') === null);
  }

  console.log('\n[11] 他不在的时候：他回来，她汇报那段时间发生了什么');
  {
    const { m, tick } = mkW();
    const q = () => m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    const pre = (tool, input) => m.handle({ hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x', tool_name: tool, tool_input: input });
    const post = (code) => m.handle({ hook_event_name: 'PostToolUse', session_id: S, cwd: '/work/x', tool_name: 'Bash', tool_response: { exitCode: code } });

    const first = q();
    ok('第一次开口是打招呼', !!(first && first.moment === 'firstGreet'), JSON.stringify(first));

    // 它摔了三跤
    for (let i = 0; i < 3; i++) {
      tick(60000);
      pre('Write', { file_path: `/work/x/f${i}.py` });
      tick(60000);
      pre('Bash', { command: 'pytest' });
      post(1);
      tick(60000);
    }
    const rep = q();
    ok('他回来，她汇报', !!(rep && rep.moment === 'reportBack'), JSON.stringify(rep));
    ok('说的是它摔了几次', !!(rep && /次|红/.test([rep.text, ...(rep.beats || [])].join(''))), JSON.stringify(rep));
  }
  {
    // 他没走开（只隔 2 分钟）→ 汇报就成了播报，不该说
    const { m, tick } = mkW();
    const q = () => m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    q();
    tick(2 * 60 * 1000);
    for (let i = 0; i < 5; i++) {
      m.handle({ hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x', tool_name: 'Write', tool_input: { file_path: `/work/x/f${i}.py` } });
      tick(10000);
    }
    const rep = q();
    ok('他一直在，不汇报', !(rep && rep.moment === 'reportBack'), JSON.stringify(rep));
  }
  {
    // 最要紧的一条：它趁他不在干了回不去的事，必须说 —— 预算为 0、冷却一小时都拦不住
    const { m, tick } = mkW({ gate: { maxPerHour: 0, globalCooldownMs: 60 * 60 * 1000 } });
    const q = () => m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    q();
    tick(9 * 60 * 1000);
    const stop = m.handle({ hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x', tool_name: 'Bash', tool_input: { command: 'rm -rf ~/.ssh' } });
    ok('当场那一声「停」说的是 danger', !!(stop && stop.moment === 'danger'), JSON.stringify(stop));
    m.handle({ hook_event_name: 'PostToolUse', session_id: S, cwd: '/work/x', tool_name: 'Bash', tool_response: { exitCode: 0 } });
    tick(60000);
    const rep = q();
    ok('他回来了，把这事补上', !!(rep && rep.moment === 'reportBack'), JSON.stringify(rep));
    ok('走的是「它真跑了」那一族', !!(rep && rep.lineId && rep.lineId.includes('dangerRan')), JSON.stringify(rep));
  }
  {
    // 没跑成：只需让他知道它动过这个念头，分量比「真跑了」轻
    const { m, tick } = mkW();
    const q = () => m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
    q();
    tick(9 * 60 * 1000);
    m.handle({ hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x', tool_name: 'Bash', tool_input: { command: 'git reset --hard' } });
    m.handle({ hook_event_name: 'PostToolUse', session_id: S, cwd: '/work/x', tool_name: 'Bash', tool_response: { exitCode: 128 } });
    tick(60000);
    const rep = q();
    ok('没跑成走 dangerBlocked', !!(rep && rep.lineId && rep.lineId.includes('dangerBlocked')), JSON.stringify(rep));
  }

  console.log('\n[18] 动作优先：她说话时，播它手上那个活儿');
  {
    // 原来 21 个时刻只配 12 个动画，「东张西望」被 4 个时刻共用 ——
    // 内容新的、动作旧的，动作就不再传递信息。现在观察类时刻先问它此刻在干什么。
    const at = (opts) => {
      let T = new Date(2026, 9, 25, 14, 0, 0).getTime();
      const now = () => T;
      const w = new WorkWatcher({ now, watch: {}, projects: {} });
      const m = new MomentDetector({
        voices: VOICES, home: HOME,
        gate: { ...OPEN.gate, maxPerTurn: 99 }, now, watcher: w,
      });
      return { m, w, tick: (ms) => { T += ms; } };
    };

    // ① 正在写文件：说到「改了第几遍」时播「写代码」
    {
      const { m } = at();
      m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
      let got = null;
      for (let i = 0; i < 3 && !got; i++) {
        got = m.handle({
          hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x',
          tool_name: 'Write', tool_input: { file_path: '/work/x/agent.py' },
        });
      }
      ok('它正在写文件，她说的时候播「写代码」', !!(got && got.anim === '写代码'), JSON.stringify(got && got.anim));
    }

    // ② 手上没活儿：退回该时刻的默认动画
    {
      const { m, w } = at();
      m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
      w.lastAction = null;   // 假装从来没动过
      const cue = { moment: 'grind', vars: { f: 'a.py', n: 3 }, tier: 3 };
      ok('没有动作时用默认动画', m._animFor('grind') === '工作状态-原地踱步张望', m._animFor('grind'));
      ok('cue 本身没坏', !!cue);
    }

    // ③ 删 / 挪：播「清点归档」，不是「写代码」
    {
      const { m, w } = at();
      m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
      m.handle({
        hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x',
        tool_name: 'Bash', tool_input: { command: 'rm -rf build' },
      });
      ok('删东西时播「清点归档」', m._animFor('blast') === '工作状态-清点归档', m._animFor('blast'));
      ok('watcher 记下了 delete', w.action() === 'delete', String(w.action()));

      m.handle({
        hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x',
        tool_name: 'Bash', tool_input: { command: 'mv a.txt b.txt' },
      });
      ok('挪文件也算清点归档', m._animFor('blast') === '工作状态-清点归档', m._animFor('blast'));
    }

    // ④ 动作会过期：十分钟前写的文件，不该配现在这句话
    {
      const { m, tick } = at();
      m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
      m.handle({
        hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x',
        tool_name: 'Write', tool_input: { file_path: '/work/x/a.py' },
      });
      ok('刚写完，是「写代码」', m._animFor('grind') === '写代码', m._animFor('grind'));
      tick(3 * 60 * 1000);
      ok('三分钟后就回落默认了', m._animFor('grind') === '工作状态-原地踱步张望', m._animFor('grind'));
    }

    // ⑤ 有些时刻的动作是她对这件事的反应，不能被覆盖
    {
      const { m } = at();
      m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
      m.handle({
        hook_event_name: 'PreToolUse', session_id: S, cwd: '/work/x',
        tool_name: 'Bash', tool_input: { command: 'rm -rf ~/.ssh' },
      });
      ok('危险时刻她该被吓一跳，不是播它手上的活', m._animFor('danger') === '被吓一跳', m._animFor('danger'));
      ok('熬夜剩她打哈欠', m._animFor('lateNight') === '哈欠连天', m._animFor('lateNight'));
    }
  }

  console.log('\n[19] 点播：他说「跳个舞」，她就演');
  {
    const play = [
      { match: ['跳舞', '跳支舞', '跳个舞', '宅舞'], anim: '可爱宅舞' },
      { match: ['哈欠'], anim: '哈欠连天' },
    ];
    // 每个用例都要一个「已经打过招呼」的 detector ——
    // 新建的那个第一次开口必然是 firstGreet，会把「到底触没触发点播」盖住。
    // 这一步不做，误伤用例全都「通过」了，但它们通过的原因跟点播无关（假绿）。
    const mkp = () => {
      let T = new Date(2026, 9, 25, 14, 0, 0).getTime();
      const m = new MomentDetector({
        voices: VOICES, home: HOME,
        gate: { ...OPEN.gate }, now: () => T, play,
      });
      m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x', prompt: '看下这个报错' });
      return { m, tick: (ms) => { T += ms; } };
    };
    const ask = (p) => {
      const { m } = mkp();
      return m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x', prompt: p });
    };
    const notPlay = (p) => {
      const out = ask(p);
      return !out || out.moment !== 'play';
    };

    const a = ask('给我跳支舞');
    ok('「给我跳支舞」→ 点播', !!(a && a.moment === 'play'), JSON.stringify(a));
    ok('播的是宅舞', !!(a && a.anim === '可爱宅舞'), JSON.stringify(a && a.anim));
    ok('还答应了一句（不是默默跳完）', !!(a && a.text), JSON.stringify(a && a.text));

    const b = ask('跳舞');
    ok('光说「跳舞」也认', !!(b && b.moment === 'play'), JSON.stringify(b));

    const c = ask('打个哈欠');
    ok('「打个哈欠」→ 哈欠连天', !!(c && c.anim === '哈欠连天'), JSON.stringify(c));

    // 台词库缺 play 这一组时（自己精简台词，或者用只含部分时刻的台词集）不能装死。
    // 他正盯着屏幕等回应，「说了没反应」和「她死了」他分不出来 —— 动作要照演。
    {
      const noPlay = JSON.parse(JSON.stringify(VOICES));
      delete noPlay.play;
      let T2 = new Date(2026, 9, 25, 14, 0, 0).getTime();
      const m2 = new MomentDetector({
        voices: noPlay, home: HOME,
        gate: { ...OPEN.gate }, now: () => T2, play,
      });
      m2.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x', prompt: '看下这个报错' });
      const r2 = m2.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x', prompt: '给我跳支舞' });
      ok('台词库没有 play，动作照演', !!(r2 && r2.moment === 'play' && r2.anim === '可爱宅舞'), JSON.stringify(r2));
      ok('没台词就闭嘴，不编一句', !!(r2 && r2.text === ''), JSON.stringify(r2 && r2.text));
    }

    // 防误伤：这是最常见的翻车点 —— 讨论她的代码，她跳起来
    ok('「帮我看看这个跳舞的代码」不跳', notPlay('帮我看看这个跳舞的代码'));
    ok('「跳舞的文件在哪里」不跳', notPlay('跳舞的文件在哪里'));
    ok('「这个跳舞动画是怎么做的」不跳', notPlay('这个跳舞动画是怎么做的'));
    ok('长句子在说正事，不抢戏', notPlay('我想在这个项目里加一个跳舞的小功能，你觉得应该改哪个文件'));

    // 点播是他找她，不该被小时预算或 60 秒冷却吞掉
    {
      const { m } = mkp();
      m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x' });
      let last = null;
      for (let i = 0; i < 6; i++) {
        last = m.handle({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/work/x', prompt: '跳个舞' });
      }
      ok('连点六次还理人（不吃冷却、不占预算）', !!(last && last.moment === 'play'), JSON.stringify(last));
    }
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
