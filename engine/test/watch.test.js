// 大肥鱼 · 工作观察单测
//
// 这套逻辑的失败模式不是「崩」，而是「说她不该说的话」：
//   他正常翻代码，她骂他原地打转；他换个文件犯同一个错，她闭嘴了。
// 所以测试里最重的几条是「什么时候她必须闭嘴」。

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  WorkWatcher, baseName, cmdHead, classifyCmd, errorKind, lastToolOutput,
} = require('../watch');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name}  ${extra}`); }
}
function eq(name, a, b) { ok(name, a === b, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`); }
// 模拟 hook-mapper 的「说出口才记账」：
// watch._cue 只查不记，commit 要等闸门放行、台词真的播了才调用。
// 这里的去重断言测的是「说过之后不再说」，所以必须走这条完整路径。
function said(w, payload) {
  const r = w.observe(payload);
  for (const c of r.cues) w.commit(c);
  return r.cues;
}

function mk(opts = {}) {
  let t = opts.t || 1793000000000;
  const clock = { now: () => t, adv: (ms) => { t += ms; } };
  const w = new WorkWatcher({
    now: clock.now,
    watch: opts.watch || {},
    projects: opts.projects || { demo: 'demo', empty: '' },
  });
  return { w, clock };
}

const F = '/home/me/code/demo/agent.py';
const CWD = '/home/me/code/demo';
const DATE_CWD = '/home/me/work/2026-01-01-00-00-00';

function pre(tool, input, cwd = CWD) {
  return { hook_event_name: 'PreToolUse', cwd, tool_name: tool, tool_input: input };
}
function post(exitCode = 0, extra = {}) {
  return { hook_event_name: 'PostToolUse', cwd: CWD, tool_name: 'Bash', tool_response: { exitCode }, ...extra };
}

console.log('\n[1] 原地打转：同一个文件写到第 3 次才开口');
{
  const { w, clock } = mk();
  w.newTurn();
  let cues = w.observe(pre('Edit', { file_path: F })).cues;
  eq('第 1 次不出声', cues.length, 0);
  clock.adv(30000);
  cues = w.observe(pre('Edit', { file_path: F })).cues;
  eq('第 2 次不出声', cues.length, 0);
  clock.adv(30000);
  cues = said(w, pre('Edit', { file_path: F }));
  eq('第 3 次开口', cues.length, 1);
  eq('时刻是 grind', cues[0] && cues[0].moment, 'grind');
  eq('档位 3', cues[0] && cues[0].tier, 3);
  eq('槽位带文件名（不带全路径）', cues[0] && cues[0].vars.f, 'agent.py');
  eq('槽位带项目名', cues[0] && cues[0].vars.p, 'demo');
  clock.adv(30000);
  cues = said(w, pre('Edit', { file_path: F }));
  eq('第 4 次不重复报', cues.length, 0);
  // 第 5 次要念 —— 而且念的是新档位。这里曾经是「压住」，
  // 那正是「递进从来不生效」那条 bug 的测试写法（见 [1b]）
  clock.adv(120000);
  cues = said(w, pre('Edit', { file_path: F }));
  eq('第 5 次换档再说', cues[0] && cues[0].tier, 5);
  // 过了去重窗口，第 8 次（tier）才有话说
  clock.adv(9 * 60000);
  w.observe(pre('Edit', { file_path: F }));
  w.observe(pre('Edit', { file_path: F }));
  cues = w.observe(pre('Edit', { file_path: F })).cues;
  eq('第 8 次开口', cues.length, 1);
  eq('档位 8', cues[0] && cues[0].tier, 8);
}

console.log('\n[2] 不许误判：他专注时她必须闭嘴，他迷路时才开口');
{
  // 专注：同一个文件啃二十遍。这是「在读代码」，不是在找东西，她不该打扰
  const { w, clock } = mk();
  w.newTurn();
  let total = 0;
  for (let i = 0; i < 20; i++) {
    total += w.observe(pre('Read', { file_path: F })).cues.length;
    clock.adv(30000);          // 同一处看了十分钟
  }
  eq('同一个文件啃 20 遍、看十分钟，一句都不说', total, 0);

  // 发散：十几个不同地方、一行没写、撑了四分钟 —— 他自己也不知道在找什么
  const d = mk();
  d.w.newTurn();
  let say = 0;
  for (let i = 0; i < 13; i++) {
    say += said(d.w, pre('Read', { file_path: `/repo/src/m${i}.js` })).length;
    d.clock.adv(20000);
  }
  eq('翻了 13 个不同地方、四分钟没写一个字 → 开口一次', say, 1);

  const b = mk();
  b.w.newTurn();
  let n = 0;
  for (let i = 0; i < 5; i++) {
    n += said(b.w, pre('Write', { file_path: '/a/one.js' })).length;
    b.clock.adv(1000);
    n += said(b.w, pre('Write', { file_path: '/a/two.js' })).length;
    b.clock.adv(1000);
  }
  // 两个文件各写满 5 次 → 各说 3、5 两档 = 4 句。
  // 10 次动作只换来 4 句，剩下 6 次她看着。真正压住密度的是闸门的 60 秒冷却，
  // 不是这里 —— 这里只保证「不是每步都念」。
  ok('两个文件各写 5 次只开口 4 次（10 次动作）', n === 4, `实际 ${n}`);
}

console.log('\n[3] 猜：同一条命令跑到第 3 次');
{
  const { w, clock } = mk();
  w.newTurn();
  const cmd = 'npm test';
  eq('第 1 次不出声', w.observe(pre('Bash', { command: cmd })).cues.length, 0);
  clock.adv(20000);
  eq('第 2 次不出声', w.observe(pre('Bash', { command: cmd })).cues.length, 0);
  clock.adv(20000);
  const cues = w.observe(pre('Bash', { command: cmd })).cues;
  eq('第 3 次开口', cues.length, 1);
  eq('时刻是 guess', cues[0] && cues[0].moment, 'guess');
  eq('命令槽位只留命令头', cues[0] && cues[0].vars.c, 'npm test');

  const other = mk();
  other.w.newTurn();
  let total = 0;
  ['npm test', 'ls -la', 'git status', 'grep -r x .', 'node app.js'].forEach((c) => {
    total += other.w.observe(pre('Bash', { command: c })).cues.length;
    other.clock.adv(3000);
  });
  eq('五条不同的命令各跑一次，一句都不说', total, 0);
}

console.log('\n[4] 横扫：一轮里动了 6 个文件');
{
  const { w, clock } = mk();
  w.newTurn();
  let hit = null;
  for (let i = 0; i < 8; i++) {
    const cues = w.observe(pre('Write', { file_path: `/a/f${i}.js` })).cues;
    if (cues.some((c) => c.moment === 'blast')) hit = cues.find((c) => c.moment === 'blast');
    clock.adv(2000);
  }
  ok('六个文件时开口', !!hit);
  eq('槽位是文件数 6', hit && hit.vars.n, 6);
  const { w: w2, clock: c2 } = mk();
  w2.newTurn();
  let hit2 = false;
  for (let i = 0; i < 5; i++) {
    if (w2.observe(pre('Write', { file_path: `/a/g${i}.js` })).cues.some((c) => c.moment === 'blast')) hit2 = true;
    c2.adv(2000);
  }
  eq('五个文件时不开口', hit2, false);
  // 新一轮要重新数
  w2.newTurn();
  let hit3 = false;
  for (let i = 0; i < 6; i++) {
    if (w2.observe(pre('Write', { file_path: `/a/h${i}.js` })).cues.some((c) => c.moment === 'blast')) hit3 = true;
    c2.adv(2000);
  }
  eq('换一轮后重新计数', hit3, true);
}

console.log('\n[4b] 一直写、一次没跑：它改了好几个文件，从没验证过');
{
  // 这条数的不是「做了多少」，是「没做什么」。界面上只看得到文件一个一个冒出来，
  // 看不出它从没跑过任何一个 —— 闷头写不跑，最容易交付一堆没跑通过的东西。
  const { w, clock } = mk();
  w.newTurn();
  let hit = null;
  for (let i = 0; i < 5; i++) {
    const cues = w.observe(pre('Write', { file_path: `/a/nv${i}.js` })).cues;
    if (cues.some((c) => c.moment === 'noVerify')) hit = cues.find((c) => c.moment === 'noVerify');
    clock.adv(2000);
  }
  ok('改到第 4 个还没跑过，开口', !!hit);
  // 第一次开口必须是第 4 个 —— 键里带文件数是为了 5、6 个还会接着说（递进），
  // 所以循环跑完时 hit 会停在最后一次上，得单独看第一次。
  const { w: wf, clock: cf } = mk();
  wf.newTurn();
  let first = null;
  for (let i = 0; i < 6 && !first; i++) {
    const cues = wf.observe(pre('Write', { file_path: `/a/nf${i}.js` })).cues;
    const c = cues.find((x) => x.moment === 'noVerify');
    if (c) first = c;
    cf.adv(2000);
  }
  eq('第一次开口是第 4 个文件', first && first.vars.n, 4);
  ok('比横扫（6 个）早 —— 等到 6 个就晚了', !!(first && first.vars.n < 6));

  // 跑过一次就不算：它验证过了
  const { w: w2, clock: c2 } = mk();
  w2.newTurn();
  let hit2 = false;
  for (let i = 0; i < 5; i++) {
    if (i === 2) { w2.observe(pre('Bash', { command: 'pytest -q' })); c2.adv(2000); }
    if (w2.observe(pre('Write', { file_path: `/a/m${i}.js` })).cues.some((c) => c.moment === 'noVerify')) hit2 = true;
    c2.adv(2000);
  }
  eq('中途跑过一次，就不说了', hit2, false);

  // 换一轮要重新数：上一轮跑过，不代表这一轮跑过
  const { w: w3, clock: c3 } = mk();
  w3.newTurn();
  w3.observe(pre('Bash', { command: 'pytest -q' }));
  c3.adv(2000);
  w3.newTurn();
  let hit3 = null;
  for (let i = 0; i < 4; i++) {
    const cues = w3.observe(pre('Write', { file_path: `/a/p${i}.js` })).cues;
    if (cues.some((c) => c.moment === 'noVerify')) hit3 = cues.find((c) => c.moment === 'noVerify');
    c3.adv(2000);
  }
  ok('新一轮的「跑过」不带到下一轮', !!hit3);

  // 阈值不到不该说
  const { w: w4, clock: c4 } = mk();
  w4.newTurn();
  let hit4 = false;
  for (let i = 0; i < 3; i++) {
    if (w4.observe(pre('Write', { file_path: `/a/q${i}.js` })).cues.some((c) => c.moment === 'noVerify')) hit4 = true;
    c4.adv(2000);
  }
  eq('只改 3 个还不够说', hit4, false);
}

console.log('\n[4c] 他不在的时候：账本记得住，危险一条都不漏');
{
  const { w, clock } = mk();
  w.newTurn();
  w.observe(pre('Write', { file_path: F }));
  clock.adv(5000);
  w.observe(pre('Write', { file_path: '/home/me/code/demo/b.py' }));
  clock.adv(5000);
  w.observe(pre('Bash', { command: 'python3 a.py' }));
  w.observe(post(0));
  clock.adv(5000);
  w.observe(pre('Bash', { command: 'python3 b.py' }));
  w.observe(post(1));

  const L = w.closeLedger(clock.now());
  eq('碰过 2 个不同文件', L.writes, 2);
  eq('跑了 2 条命令', L.runs, 2);
  eq('红过 1 次', L.fails, 1);
  eq('动作数 4', L.acts, 4);
  eq('没有危险', L.dangers.length, 0);

  // 结算完就翻篇：上一轮的账不能带到下一轮，否则他会反复听到同一件事
  const L2 = w.closeLedger(clock.now() + 1000);
  eq('结算后归零', L2.acts, 0);
  eq('结算后危险也清空', L2.dangers.length, 0);
}
{
  const { w, clock } = mk();
  w.newTurn();
  w.observe(pre('Bash', { command: 'rm -rf ~/.ssh' }));
  w.observe(post(0));
  const L = w.closeLedger(clock.now());
  eq('危险留痕', L.dangers.length, 1);
  eq('记的是哪一种', L.dangers[0] && L.dangers[0].kind, 'rm-secret');
  // cmdHead 会剥掉 -rf 这种选项、长路径只留末段 —— 她念的是「rm .ssh」不是原始命令，
  // 这是故意的：念出来要像话。所以只断言它认得出目标
  ok('命令留了可念的原文', !!(L.dangers[0] && /ssh/.test(L.dangers[0].cmd)), JSON.stringify(L.dangers[0]));
  eq('它真跑了（exitCode 0）', L.dangers[0] && L.dangers[0].ran, true);
}
{
  const { w, clock } = mk();
  w.newTurn();
  w.observe(pre('Bash', { command: 'git reset --hard' }));
  w.observe(post(1));
  const L = w.closeLedger(clock.now());
  eq('没跑成也记得住，只是 ran 是 false', L.dangers[0] && L.dangers[0].ran, false);
}
{
  // 最关键的一条：她喊不出来，账本也必须记着。
  // 他不在屏幕前，那一声「停」白喊了 —— 要是连账都不记，这事就当没发生过。
  const { w, clock } = mk();
  w.newTurn();
  said(w, pre('Bash', { command: 'rm -rf ~/.ssh' }));   // 第一次说出口，去重键占住
  w.observe(post(0));
  clock.adv(1000);
  const cues = w.observe(pre('Bash', { command: 'rm -rf ~/.ssh' })).cues;
  eq('第二次被 5 分钟去重吞掉，她不出声', cues.filter((c) => c.moment === 'danger').length, 0);
  w.observe(post(0));
  const L = w.closeLedger(clock.now());
  eq('但账本两条都在', L.dangers.length, 2);
}

console.log('\n[5] 认错错：只有在真的看到报错时才说，且分类正确');
{
  const tmp = path.join(os.tmpdir(), 'pet-watch-fixture.jsonl');
  function writeFixture(text) {
    const line = JSON.stringify({
      type: 'function_call_result',
      name: 'Bash',
      output: { type: 'text', text },
    });
    fs.writeFileSync(tmp, JSON.stringify({ type: 'message', role: 'user' }) + '\n' + line + '\n');
    return tmp;
  }
  const cases = [
    ['ModuleNotFoundError: No module named flask', 'missing_module'],
    ['  File "a.py", line 3\nSyntaxError: invalid syntax', 'syntax'],
    ['Error: listen EADDRINUSE: address already in use :::3000', 'port'],
    ['zsh: command not found: pnpm', 'notfound'],
    ['FAILED tests/test_a.py::test_one - AssertionError', 'testfail'],
    ['TypeError: Cannot read properties of undefined', 'runtime'],
  ];
  for (const [text, want] of cases) {
    const p = writeFixture(text);
    eq(`从输出尾部认出 ${want}`, errorKind(text), want);
    const { w } = mk();
    w.newTurn();
    w.observe(pre('Bash', { command: 'npm test' }));
    const cues = w.observe({ ...post(1), transcript_path: p }).cues;
    eq(`  → 开口说 ${want}`, cues.length, 1);
    eq(`  → 时刻 errKnown`, cues[0] && cues[0].moment, 'errKnown');
    eq(`  → 槽位 err=${want}`, cues[0] && cues[0].vars.err, want);
  }
  fs.unlinkSync(tmp);

  const { w } = mk();
  w.newTurn();
  w.observe(pre('Bash', { command: 'ls' }));
  const cues = w.observe({ ...post(1), transcript_path: '/nonexistent/file.jsonl' }).cues;
  eq('拿不到输出就闭嘴（不许瞎猜）', cues.length, 0);
  eq('但成败她还是知道了', w.lastOk, false);
}

console.log('\n[6] 同一个错换个文件犯，她还能再开口一次');
{
  const tmp = path.join(os.tmpdir(), 'pet-watch-dup.jsonl');
  fs.writeFileSync(tmp, JSON.stringify({ type: 'function_call_result', output: { type: 'text', text: 'ModuleNotFoundError: No module named x' } }) + '\n');
  const { w, clock } = mk();
  w.newTurn();
  w.observe(pre('Bash', { command: 'python a.py' }));
  const a = said(w, { ...post(1), transcript_path: tmp });
  eq('第一次说', a.length, 1);
  clock.adv(60000);
  w.observe(pre('Bash', { command: 'python b.py' }));
  const b = said(w, { ...post(1), transcript_path: tmp });
  eq('一分钟后再犯同一个错：压住', b.length, 0);
  fs.unlinkSync(tmp);
}

console.log('\n[9] 危险动作：她唯一有资格喊停的时刻');
{
  const { dangerOf } = require('../watch');
  const yes = [
    ['rm -rf /', 'rm-root'],
    ['rm -rf ~', 'rm-root'],
    ['rm -rf *', 'rm-wild'],
    ['rm -rf ../', 'rm-root'],
    ['rm -rf .git', 'rm-secret'],
    ['rm -rf .env', 'rm-secret'],
    ['cd /tmp && rm -rf *', 'rm-wild'],
    ['cd src; rm -rf $HOME', 'rm-root'],
    ['sudo rm -rf /', 'rm-root'],
    ['git reset --hard HEAD~3', 'git-dirty'],
    ['git -C repo reset --hard', 'git-dirty'],
    ['git checkout .', 'git-dirty'],
    ['git restore .', 'git-dirty'],
    ['git clean -fdx', 'git-clean'],
    ['git push --force origin main', 'git-force'],
    ['git push origin +main:main', 'git-force'],
    ['git stash drop', 'git-stash'],
    ['psql -c "DROP TABLE users"', 'sql-drop'],
    ['mysql -e "drop database prod"', 'sql-drop'],
    ['DROP TABLE users', 'sql-drop'],
    ['sqlite3 a.db "delete from users"', 'sql-delete'],
  ];
  for (const [cmd, kind] of yes) eq(`认得 ${kind}：${cmd}`, (dangerOf(cmd) || {}).kind, kind);

  // 误报会毁掉她。删能重建的东西、正常操作，一律不吭声
  const no = [
    'rm -rf node_modules', 'rm -rf dist', 'rm -rf ./build', 'rm -rf __pycache__',
    'rm -rf .venv', 'rm -rf tmp', 'rm foo.txt', 'rm -r node_modules',
    'git status', 'git log', 'git diff', 'git checkout -b feat', 'git checkout main',
    'git push origin main', 'delete from users where id=1', 'npm test', 'ls -la', 'make clean',
    // 下面这三条是真正容易翻车的地方：他只是在**聊**这条命令，不是在跑它。
    // 判据必须是「段首就是那条命令」——查文档、写笔记不该被当成要执行
    'echo "git reset --hard"', 'grep -r "DROP TABLE" migrations/', 'rg "rm -rf" docs/',
    'echo rm -rf /', 'cat notes.txt | grep reset',
  ];
  for (const cmd of no) eq(`不吭声：${cmd}`, dangerOf(cmd), null);

  // 走完整链路
  const { w, clock } = mk();
  w.newTurn();
  const c1 = said(w, pre('Bash', { command: 'git reset --hard' }));
  eq('危险动作立刻开口', c1.length, 1);
  eq('  → 时刻 danger', c1[0] && c1[0].moment, 'danger');
  eq('  → 槽位 k', c1[0] && c1[0].vars.k, 'git-dirty');
  clock.adv(60000);
  eq('一分钟内不重复念', said(w, pre('Bash', { command: 'git reset --hard' })).length, 0);
  clock.adv(60000);
  eq('换个危险类型才再说（各自计时）', w.observe(pre('Bash', { command: 'rm -rf ~' })).cues[0].vars.k, 'rm-root');
}

console.log('\n[10] 换错：他绕过第一个坑，掉进下一个');
{
  const tmpA = path.join(os.tmpdir(), 'pet-watch-flip-a.jsonl');
  const tmpB = path.join(os.tmpdir(), 'pet-watch-flip-b.jsonl');
  const fx = (file, text) => fs.writeFileSync(
    file,
    JSON.stringify({ type: 'function_call_result', output: { type: 'text', text } }) + '\n',
  );
  fx(tmpA, 'ModuleNotFoundError: No module named flask');
  fx(tmpB, 'TypeError: unsupported operand type');

  const { w, clock } = mk();
  w.newTurn();
  w.observe(pre('Bash', { command: 'python run.py' }));
  const a = w.observe({ ...post(1), transcript_path: tmpA }).cues;
  eq('第一次：只说认得这个错', a[0] && a[0].moment, 'errKnown');

  clock.adv(60000);
  w.observe(pre('Bash', { command: 'python run.py' }));
  const b = w.observe({ ...post(1), transcript_path: tmpB }).cues;
  eq('换了一种错 → 说 flip', b[0] && b[0].moment, 'flip');
  eq('  → 槽位 a=前一种', b[0] && b[0].vars.a, '找不到模块');
  eq('  → 槽位 b=这一种', b[0] && b[0].vars.b, '运行时错');

  // 换了项目就不是「同一个问题在往前走」，退回承认得错
  const c = mk();
  c.w.newTurn();
  c.w.observe(pre('Bash', { command: 'python run.py' }));
  c.w.observe({ ...post(1), transcript_path: tmpA });
  c.clock.adv(60000);
  c.w.observe(pre('Bash', { command: 'python run.py' }, '/home/me/code/other'));
  const cc = c.w.observe({ ...post(1, { cwd: '/home/me/code/other' }), transcript_path: tmpB }).cues;
  eq('换个项目换种错 → 不算 flip', cc[0] && cc[0].moment, 'errKnown');

  // 隔了半小时才换，那不是同一段挣扎
  const d = mk();
  d.w.newTurn();
  d.w.observe(pre('Bash', { command: 'python run.py' }));
  d.w.observe({ ...post(1), transcript_path: tmpA });
  d.clock.adv(31 * 60 * 1000);
  d.w.observe(pre('Bash', { command: 'python run.py' }));
  const dd = d.w.observe({ ...post(1), transcript_path: tmpB }).cues;
  eq('隔半小时 → 不算 flip', dd[0] && dd[0].moment, 'errKnown');

  fs.unlinkSync(tmpA);
  fs.unlinkSync(tmpB);
}

console.log('\n[11] 秒重跑：他根本没看上一屏');
{
  const tmp = path.join(os.tmpdir(), 'pet-watch-rush.jsonl');
  fs.writeFileSync(tmp, JSON.stringify({
    type: 'function_call_result',
    output: { type: 'text', text: 'FAILED tests/test_a.py::test_one' },
  }) + '\n');

  const { w, clock } = mk();
  w.newTurn();
  w.observe(pre('Bash', { command: 'pytest -x' }));
  const a = w.observe({ ...post(1), transcript_path: tmp }).cues;
  eq('第一次失败：说认得的错', a[0] && a[0].moment, 'errKnown');

  w.observe(pre('Bash', { command: 'pytest -x' }));
  clock.adv(8000);
  const b = w.observe({ ...post(1), transcript_path: tmp }).cues;
  eq('八秒后同一条命令又红 → 说 rush', b[0] && b[0].moment, 'rush');
  eq('  → 槽位带秒数', b[0] && b[0].vars.s, 8);

  // 隔得久一点，说明他真看了，就不该拿这句刺他
  const c = mk();
  c.w.newTurn();
  c.w.observe(pre('Bash', { command: 'pytest -x' }));
  c.w.observe({ ...post(1), transcript_path: tmp });
  c.clock.adv(90000);
  c.w.observe(pre('Bash', { command: 'pytest -x' }));
  const cc = said(c.w, { ...post(1), transcript_path: tmp });
  eq('一分半后再跑 → 不是 rush', cc[0] && cc[0].moment !== 'rush', true);

  // 换一条命令就不是「重跑刚才那条」
  const d = mk();
  d.w.newTurn();
  d.w.observe(pre('Bash', { command: 'pytest -x' }));
  d.w.observe({ ...post(1), transcript_path: tmp });
  d.clock.adv(5000);
  d.w.observe(pre('Bash', { command: 'pytest -k other' }));
  const dd = said(d.w, { ...post(1), transcript_path: tmp });
  eq('五秒后但换了命令 → 不是 rush', dd[0] && dd[0].moment !== 'rush', true);

  // 改文件失败不能被当成「重跑了命令」
  const e = mk();
  e.w.newTurn();
  e.w.observe(pre('Bash', { command: 'pytest -x' }));
  e.w.observe({ ...post(1), transcript_path: tmp });
  e.clock.adv(5000);
  const ee = e.w.observe({
    hook_event_name: 'PostToolUseFailure', cwd: CWD, tool_name: 'Write',
    tool_input: { file_path: F }, tool_response: {},
  }).cues;
  eq('写文件失败 → 不判 rush', ee.length, 0);

  fs.unlinkSync(tmp);
}

console.log('\n[12] 循环：改→跑→改→跑，第三轮才开口');
{
  // 注意：真实的循环里同一条命令也会跑到第 3 遍（guess 同时成立），
  // 这里只看 loop 有没有出现 —— 最终说哪句由 PRIORITY 决定。
  const { w, clock } = mk();
  w.newTurn();
  const got = [];
  const step = (fn) => {
    for (const c of w.observe(fn()).cues) got.push(c.moment);
    clock.adv(20000);
  };
  step(() => pre('Write', { file_path: '/repo/src/a.js' }));
  step(() => pre('Bash', { command: 'npm test' }));
  step(() => pre('Write', { file_path: '/repo/src/b.js' }));
  step(() => pre('Bash', { command: 'npm test' }));
  eq('两轮还不说', got.length, 0);
  step(() => pre('Write', { file_path: '/repo/src/c.js' }));
  step(() => pre('Bash', { command: 'npm test' }));
  eq('第三轮认出循环', got.includes('loop'), true);

  // 中间夹读操作不影响判断（读是噪声，早被剔掉了）
  const r = mk();
  r.w.newTurn();
  const rgot = [];
  const rstep = (fn) => {
    for (const c of r.w.observe(fn()).cues) rgot.push(c.moment);
    r.clock.adv(20000);
  };
  for (let i = 0; i < 3; i++) {
    rstep(() => pre('Write', { file_path: `/repo/src/x${i}.js` }));
    rstep(() => pre('Read', { file_path: `/repo/src/y${i}.js` }));
    rstep(() => pre('Bash', { command: 'npm test' }));
    rstep(() => pre('Grep', { pattern: 'foo' }));
  }
  eq('中间夹读操作，依然认出循环', rgot.includes('loop'), true);

  // 只在写、一次没跑 —— 那是「想清楚再动手」，不是循环
  const p = mk();
  p.w.newTurn();
  const pgot = [];
  for (let i = 0; i < 4; i++) {
    for (const c of p.w.observe(pre('Write', { file_path: `/repo/src/z${i}.js` })).cues) pgot.push(c.moment);
    p.clock.adv(20000);
  }
  eq('没跑命令就不算循环', pgot.includes('loop'), false);
}

console.log('\n[13] 长命令挂住：跑完才知道它挂了多久');
{
  const { w, clock } = mk();
  w.newTurn();
  w.observe(pre('Bash', { command: 'python train.py' }));
  clock.adv(7 * 60 * 1000);
  const cues = w.observe(post(0)).cues;
  eq('跑七分钟 → 开口', cues.length, 1);
  eq('  → 时刻 stall', cues[0] && cues[0].moment, 'stall');
  eq('  → 槽位带分钟', cues[0] && cues[0].vars.m, 7);

  const q = mk();
  q.w.newTurn();
  q.w.observe(pre('Bash', { command: 'ls' }));
  q.clock.adv(20000);
  eq('二十秒的命令不念', q.w.observe(post(0)).cues.length, 0);
}

console.log('\n[7] 项目名：念得像人话才念');
{
  const { w } = mk();
  eq('demo 念得出来', w.projectOf('/home/me/code/demo'), 'demo');
  eq('日期式目录名不念', w.projectOf(DATE_CWD), '');
  eq('映射成空的项目不念', w.projectOf('/tmp/empty'), '');
}

console.log('\n[8] 小工具函数');
{
  eq('baseName 取末段', baseName('/a/b/c.py'), 'c.py');
  eq('baseName 超长要截', baseName('/a/' + 'x'.repeat(40) + '.py').endsWith('…'), true);
  eq('cmdHead 去掉 && 后面', cmdHead('npm test && echo done'), 'npm test');
  eq('cmdHead 管住长度', cmdHead('a'.repeat(60), 10), 'a'.repeat(10) + '…');
  eq('classifyCmd 认 test', classifyCmd('npx vitest run'), 'test');
  eq('classifyCmd 认 install', classifyCmd('pip3 install requests'), 'install');
  eq('classifyCmd 认 git', classifyCmd('git commit -m x'), 'git');
  eq('classifyCmd 兜底 other', classifyCmd('open -a Chrome'), 'other');
  eq('errorKind 认不出返回 null', errorKind('everything is fine'), null);
  eq('lastToolOutput 文件不存在返回空串', lastToolOutput('/no/such/file'), '');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
