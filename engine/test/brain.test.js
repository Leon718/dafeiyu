// 大肥鱼 · 深思单测
//
// 这一层的失败模式和别的都不一样：它不会崩，它会让**她说了卡里没有的话**。
// 一句「它在第 88 行崩的」（根本没有第 88 行）就足以让人不再信她。
// 所以这里最重的部分不是「能不能调通模型」，而是 guard ——
// 一个便宜、确定、可测的裁判，替她挡掉所有编造。
//
// 模型本身不进单测（花钱、不确定、还慢）。测的是：
//   什么时刻值得花钱 / 提示词守不守得住 / 什么样的输出必须被拦 / 预算会不会失控

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  guard, chooseDeep, buildPrompt, SYSTEM, DEFAULT_BRAIN, Brain,
  cleanOutput, findClaude,
} = require('../brain');
const { buildCard, renderCard, anchorOf } = require('../context');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name}  ${extra}`); }
}
function eq(name, a, b) { ok(name, a === b, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`); }

// 一张真实形状的卡：报错在第 42 行，diff 动了判断，他刚说过一句话
function cardOf() {
  const errText = [
    'Traceback (most recent call last):',
    '  File "/repo/agent.py", line 42, in <module>',
    '    total = total + row',
    'TypeError: unsupported operand type(s) for +: int and NoneType',
  ].join('\n');
  const diff = { body: '-if x > 0:\n+if x >= 0:', stat: '1 file changed, 1 insertion(+), 1 deletion(-)' };
  const card = {
    project: 'demo',
    file: 'agent.py',
    cmd: 'pytest -x',
    errKind: 'runtime',
    errText,
    diff,
    words: ['这个接口应该能过吧'],
    diary: ['- 21:10 他说：agent.py 那个 total 又出问题了'],
    actions: [
      { agoS: 120, gapS: null, kind: 'W', target: 'agent.py', ok: null },
      { agoS: 96, gapS: 24, kind: 'C', target: 'pytest', ok: false },
      { agoS: 60, gapS: 36, kind: 'W', target: 'agent.py', ok: null },
      { agoS: 8, gapS: 52, kind: 'C', target: 'pytest', ok: false },
    ],
  };
  card.allowText = [card.project, card.file, card.cmd, card.errText, diff.body, diff.stat,
    ...card.words, ...card.diary, 'agent.py', 'pytest', 24, 36, 52, 120, 96, 60, 8].join('\n');
  return card;
}

console.log('\n[1] 该说的能过：具体、有据、像她');
{
  const card = cardOf();
  const good = [
    '第 42 行。它拿到的是 None。',
    '这个判断反了。你原来是大于。',
    'pytest 第四遍。你改了同一个判断。',
    '21:10 那句你还没答。',
    'TypeError。加了个 None 进去。',
  ];
  for (const t of good) {
    const g = guard(t, card, {});
    ok(`过：${t}`, g.ok, g.reason);
  }
}

console.log('\n[2] 编造必须被拦 —— 这是这一层的命门');
{
  const card = cardOf();
  const bad = [
    ['第 88 行。它在那崩的。', 'unknown-number'],          // 卡里没有 88
    ['auth.py 里那个 token 没取到。', 'unknown-symbol'],   // 卡里没有这个文件
    ['config.yaml 少了 default。', 'unknown-symbol'],
    ['user.profile 那层是空的。', 'unknown-symbol'],
  ];
  for (const [t, want] of bad) {
    const g = guard(t, card, {});
    ok(`拦：${t}`, !g.ok, '竟然通过了');
    ok(`  → 原因是 ${want}`, String(g.reason).includes(want.split(':')[0]), g.reason);
  }
}

console.log('\n[3] 体裁：她不是助理，也不是朗诵器');
{
  const card = cardOf();
  const bad = [
    ['建议你在 total 上先加个默认值，然后再跑一次试试。', 'banned'],
    ['这个报错是因为你把字符串和整数相加了！', 'exclamation'],
    ['我理解你现在很烦，但你可以试试先打印一下。', 'banned'],
    ['`total = 0` 这样改就行。', 'code-fence'],
    ['As an AI assistant, I think you should debug line 42 first.', 'chinese'],
    ['第 42 行。它拿到的是 None。你上面那个 get 少了一个默认值，改成 or 0 就不会崩了，然后再跑一遍，', 'too-long'],
  ];
  for (const [t, want] of bad) {
    const g = guard(t, card, {});
    ok(`拦：${t.slice(0, 18)}…`, !g.ok, '竟然通过了');
    ok(`  → ${want}`, String(g.reason).includes(want), g.reason);
  }
  // 她不会用括号给自己解释
  ok('拦：带括号补注', !guard('它崩在第 42 行（也就是累加那行）。', card, {}).ok);
  // 三句以上不该出现在气泡里：那不是她，那是汇报
  ok('拦：三句以上', !guard('第 42 行。是 None。你又没改。', card, {}).ok);
}

console.log('\n[4] 什么时候值得花钱');
{
  // 时间线是卡里唯一永远不空的素材。判据放宽后，只要够长就值得看形状。
  const steps = (n) => Array.from({ length: n },
    (_, i) => ({ agoS: (n - i) * 10, gapS: 10, kind: 'W', target: `f${i}.py`, ok: null }));
  const longErr = { errText: 'x'.repeat(400), diff: { body: '' }, actions: steps(3) };
  const shortErr = { errText: 'boom', diff: { body: '' }, actions: steps(3) };
  const withDiff = { errText: 'x'.repeat(400), diff: { body: 'diff...' }, actions: steps(3) };
  // 时间线只有两步：看不出拍子，不值得花钱
  const flat = (c) => ({ ...c, actions: steps(2) });

  eq('长报错 → 读报文', chooseDeep({ moment: 'errKnown', card: longErr }), 'readErr');
  eq('有 diff 且改到第 5 次 → 看改动', chooseDeep({ moment: 'grind', tier: 5, card: withDiff }), 'seeDiff');
  eq('横扫 → 猜在干什么', chooseDeep({ moment: 'blast', card: shortErr }), 'plan');
  eq('翻半天没写 → 猜在找什么', chooseDeep({ moment: 'searchOnly', card: shortErr }), 'plan');

  // 放宽后的核心：不挑时刻，只看时间线。这是 grind@3 第一次有路可走 ——
  // 旧判据下 9 种 not-worth-it 全是 grind，等于这条路在他真实使用里走不到。
  eq('改到第 3 次，没 diff 也能看拍子', chooseDeep({ moment: 'grind', tier: 3, card: longErr }), 'dig');
  eq('循环 → 看时间线形状', chooseDeep({ moment: 'loop', card: shortErr }), 'dig');
  eq('坐太久且失败够多 → 看时间线', chooseDeep({ moment: 'repeatedFailure', tier: 5, card: shortErr }), 'dig');
  eq('重复失败三次也看（不再卡档位）', chooseDeep({ moment: 'repeatedFailure', tier: 3, card: shortErr }), 'dig');
  eq('闷头写不跑 → 看它是不是只写不跑', chooseDeep({ moment: 'noVerify', card: shortErr }), 'dig');
  eq('命令挂住 → 看它卡在哪一步前', chooseDeep({ moment: 'stall', card: shortErr }), 'dig');
  eq('短报错读不出东西，但时间线够长 → 看形状', chooseDeep({ moment: 'errKnown', card: shortErr }), 'dig');

  // 时间线太短：只有两步看不出拍子，跟素材空着一样
  eq('时间线只有两步 → 不花钱', chooseDeep({ moment: 'grind', tier: 3, card: flat(longErr) }), null);
  eq('循环但时间线太短 → 不花钱', chooseDeep({ moment: 'loop', card: flat(shortErr) }), null);
  eq('短报错 + 短时间线 → 不花钱', chooseDeep({ moment: 'errKnown', card: flat(shortErr) }), null);

  // 这些永远不花钱：救命的话不能拖 0.8 秒，也不该被一句「深思」冲淡
  eq('喊停不深思', chooseDeep({ moment: 'danger', card: withDiff }), null);
  eq('深夜不深思（陪伴时刻没有形状可看）', chooseDeep({ moment: 'lateNight', card: withDiff }), null);
  eq('打招呼不深思', chooseDeep({ moment: 'comeback', card: withDiff }), null);
  eq('没卡就不说', chooseDeep({ moment: 'errKnown', card: null }), null);
}

console.log('\n[5] 提示词守不守得住');
{
  const card = cardOf();
  const { system, user } = buildPrompt({ kind: 'readErr', card, cardText: renderCard(card) });
  ok('系统提示里写清了「不许编」', /不许编/.test(system));
  ok('系统提示禁了感叹号', /感叹号/.test(system));
  ok('系统提示给了字数上限', /25 个字/.test(system));
  ok('系统提示带了她的口气示例', /agent\.py 第三遍/.test(system));
  ok('用户消息里带上了报错原文', /line 42/.test(user));
  ok('用户消息里带上了「这次该看什么」', /报错原文/.test(user));
  ok('不同时刻问法不同', buildPrompt({ kind: 'plan', card, cardText: '' }).user !==
    buildPrompt({ kind: 'dig', card, cardText: '' }).user);
  eq('提示词不认识「作为 AI」这种腔调', /作为/.test(SYSTEM), false);
}

console.log('\n[6] 预算：防的不是省钱，是把她变成碎嘴');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-brain-'));
  const b = new Brain({ cfg: { maxPerHour: 2, minGapMs: 1000 }, dir });
  let t = 1793000000000;
  eq('开机就能用', b.canCall(t).ok, true);
  b.mark('a', t);
  eq('刚说完不能再花', b.canCall(t + 10).reason, 'gap');
  eq('隔够了可以', b.canCall(t + 2000).ok, true);
  b.mark('b', t + 2000);
  eq('一小时两次用完就停', b.canCall(t + 3000).reason, 'hour-budget');
  eq('过了一小时恢复', b.canCall(t + 3600 * 1000 + 5000).ok, true);

  // 同一件事说过就不再花钱：他会对着同一个报错折腾很久
  t = 1793000000000;
  ok('没说过 → 值得说', b.fresh('err:42', t));
  b.remember('err:42', '第 42 行。', t);
  ok('说过了 → 闭嘴', !b.fresh('err:42', t + 1000));
  ok('过半天了 → 可以说（他可能又改回去了）', b.fresh('err:42', t + 13 * 3600 * 1000));

  const off = new Brain({ cfg: { enabled: false }, dir });
  eq('关掉就是关掉', off.canCall(t).reason, 'off');
  const off2 = new Brain({ cfg: { provider: 'off' }, dir });
  eq('provider=off 也算关掉', off2.canCall(t).reason, 'off');

  // 缓存文件坏了不能带崩她
  fs.writeFileSync(path.join(dir, 'brain-cache.json'), '{坏的');
  const b3 = new Brain({ cfg: {}, dir });
  eq('缓存坏了就当没缓存', Object.keys(b3.cache).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[7] 输出清洗：CLI 会往 stdout 里吐警告');
{
  eq('只留最后一行正文', cleanOutput('⚠ update available\n第 42 行。'), '第 42 行。');
  eq('去掉 ANSI 颜色', cleanOutput('\u001b[31m第 42 行。\u001b[0m'), '第 42 行。');
  eq('空输入不炸', cleanOutput(''), '');
  ok('找得到本机的 claude', !!findClaude('') || process.platform !== 'darwin');
}

console.log('\n[8] 事实卡：她看见的必须都进得去、且不撑爆');
{
  const card = cardOf();
  const text = renderCard(card);
  ok('卡里有动作时间线', /他刚才的动作/.test(text));
  ok('时间线带间隔秒数（这是人判断「他慌没慌」的唯一依据）', /\+24s/.test(text) || /\+ 24s/.test(text));
  ok('卡里有失败标记', /失败/.test(text));
  ok('卡里有报错原文', /line 42/.test(text));
  ok('卡里有 diff', /if x >= 0/.test(text));
  ok('卡里有他说的话', /应该能过/.test(text));
  ok('卡里有日记（她唯一的记忆优势）', /total 又出问题/.test(text));

  // 撑爆 prompt = 每次都多花钱、还更慢。这条守死。
  const huge = cardOf();
  huge.errText = 'E'.repeat(9000);
  huge.diff.body = 'D'.repeat(9000);
  const t2 = renderCard(huge);
  ok('一万八千字的素材渲染后不超过 4000 字', t2.length <= 4010, `实际 ${t2.length}`);
  ok('截断了会说一声', /截断/.test(t2));

  // 空卡不许硬凑：没有的东西整段省略
  const empty = renderCard({ actions: [], words: [], diary: [], diff: { body: '' }, errText: '' });
  eq('什么都没有就是空的', empty, '');

  // 同一件事的锚必须稳定，否则去重失效、钱会重复花
  eq('同一个错同一个文件 → 同一个锚',
    anchorOf({ kind: 'readErr', cue: { f: 'agent.py', err: 'runtime' }, file: 'agent.py' }),
    anchorOf({ kind: 'readErr', cue: { f: 'agent.py', err: 'runtime' }, file: 'agent.py' }));
  ok('换个文件就是另一件事',
    anchorOf({ kind: 'seeDiff', cue: { f: 'a.py' }, file: 'a.py' }) !==
    anchorOf({ kind: 'seeDiff', cue: { f: 'b.py' }, file: 'b.py' }));
}

console.log('\n[9] 真 git：读得到就写进卡，读不到就空着');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-git-'));
  const { execFileSync } = require('child_process');
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.py'), 'x = 1\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'i'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.py'), 'x = 2\n');
    const c1 = await buildCard({ cue: { f: 'a.py' }, payload: { cwd: dir } });
    ok('未提交的改动读到了', /x = 2/.test(c1.diff.body), JSON.stringify(c1.diff.body).slice(0, 80));
    ok('shortstat 也有', /1 file changed/.test(c1.diff.stat), c1.diff.stat);

    const c2 = await buildCard({ cue: { f: 'a.py' }, payload: { cwd: os.tmpdir() } });
    eq('不是 git 仓库 → 空着，不报错', c2.diff.body, '');

    // 打错文件的 diff 比不说更糟
    const c3 = await buildCard({ cue: { f: 'other.py' }, payload: { cwd: dir, tool_input: { file_path: path.join(dir, 'a.py') } } });
    eq('路径对不上就不收窄（宁可给整体 diff）', /x = 2/.test(c3.diff.body), true);
  } catch (e) {
    ok('git 环境不可用，跳过', true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
