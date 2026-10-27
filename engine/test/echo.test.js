// 复读（echo）单测：node echo.test.js
// 守的是「他在聊天窗口收到几句，桌面上就该蹦几拍」
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const e = require('../echo');

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), exp = JSON.stringify(expected);
  if (a === exp) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got=${a}\n       want=${exp}`); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-echo-'));
function write(name, rows) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
const asst = (text) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const usr = (text) => ({ type: 'message', message: { role: 'user', content: text } });

console.log('\n[1] 从转录里取她最后一句');
{
  const p = write('a.jsonl', [usr('在吗'), asst('在。'), asst('在。\n干什么。')]);
  eq('取最后一条 assistant 文本', e.lastAssistantText(p), '在。\n干什么。');

  const p2 = write('b.jsonl', [asst('第一轮'), usr('第二轮呢'), asst('第二轮')]);
  eq('遇到 user 就停，不串到上一轮', e.lastAssistantText(p2), '第二轮');

  const p3 = write('c.jsonl', [
    asst(''),
    { type: 'message', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } },
    asst('说完了。'),
  ]);
  eq('跳过只有 tool_use 的记录', e.lastAssistantText(p3), '说完了。');

  ok('文件不存在返回空串（不抛）', e.lastAssistantText('/tmp/绝对没有这个文件.jsonl') === '');
}

console.log('\n[1b] 真实格式回归：message 只装 usage，正文在顶层，块类型是 output_text');
{
  const real = (role, blocks, usage) => ({
    id: 'x', type: 'message', role,
    content: blocks,
    message: usage ? { usage } : undefined,
  });
  const p = write('real.jsonl', [
    real('user', [{ type: 'input_text', text: '<system-reminder>...</system-reminder>\n今天天气不错' }]),
    real('assistant', [{ type: 'output_text', text: '**去吧。**\n下次回来我不一定开门。' }], { input_tokens: 100 }),
  ]);
  eq('输出块类型为 output_text', e.lastAssistantText(p), '**去吧。**\n下次回来我不一定开门。');
  eq('拆成两拍', e.toBeats(e.lastAssistantText(p)), ['去吧。', '下次回来我不一定开门。']);
  ok('真实格式能出气泡', !!e.fromTranscript(p));
}

console.log('\n[2] 拆拍：她的换行就是停顿');
{
  eq('两个换行 → 两拍', e.toBeats('去吧。\n下次回来我不一定开门。'), ['去吧。', '下次回来我不一定开门。']);
  eq('空行也当换行', e.toBeats('第一句\n\n第二句'), ['第一句', '第二句']);
  eq('单句就是一拍', e.toBeats('嗯。'), ['嗯。']);
  const many = e.toBeats('一。\n二。\n三。\n四。\n五。');
  eq('最多三拍', many.length, 3);
  ok('后面还有话 → 末拍带省略号', many[2].endsWith('…'), JSON.stringify(many));
  ok('超长单句被切开', e.toBeats('啊'.repeat(200)).every((b) => b.length <= 120));
}

console.log('\n[3] 纯文本：气泡里不该出现 markdown');
{
  eq('去星号', e.toBeats('**去吧。**'), ['去吧。']);
  eq('去列表点和反引号', e.toBeats('- `ls` 一下吧'), ['ls 一下吧']);
  eq('代码块整段丢掉', e.toBeats('看这个\n```js\nconsole.log(1)\n```\n没什么。'), ['看这个', '没什么。']);
}

console.log('\n[4] 没话说就别硬凑');
{
  eq('空文本 → 没有拍', e.toBeats('   '), []);
  eq('只有代码 → 没有拍', e.toBeats('```js\nx=1\n```'), []);
  const p = write('empty.jsonl', [usr('嗯'), asst('   ')]);
  eq('她说的是空白 → 不出气泡', e.fromTranscript(p), null);
  eq('没有 transcript_path → 不出气泡', e.fromTranscript(''), null);
}

console.log('\n[5] 交给渲染层的形状');
{
  const p = write('shape.jsonl', [asst('去吧。\n下次回来我不一定开门。')]);
  const out = e.fromTranscript(p);
  ok('第一拍进 text', out.text === '去吧。', JSON.stringify(out));
  eq('多拍进 beats', out.beats, ['去吧。', '下次回来我不一定开门。']);
  ok('带口型动画', typeof out.anim === 'string' && out.anim.length > 0, out.anim);
  ok('标记 home，主进程据此把她叫出场', out.home === true);
  const one = e.fromTranscript(write('one.jsonl', [asst('嗯。')]));
  ok('单拍不带 beats 字段', one.beats === undefined, JSON.stringify(one));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
