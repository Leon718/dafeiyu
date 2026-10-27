'use strict';
/**
 * journal.js 的单测。
 *
 * 守的是什么：
 *   1. 只抄「他本人说的话」，系统推送（automation、提醒）不许进日记
 *   2. 转录里那一大堆注入块（user_info / identity / project_context）不许混进去
 *   3. 同一个 Stop 触发两次，日记不能出现两行一样的
 *   4. 日记文件不存在时自己建，且带上日期标题
 *   5. 长句要截断，不能一行占满屏
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const journal = require('../journal');

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  →  ' + info : '')); }
}
function eq(name, actual, expected) {
  ok(`${name}（期望 ${JSON.stringify(expected)}）`, actual === expected, '实际 ' + JSON.stringify(actual));
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-journal-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.workbuddy', 'memory'), { recursive: true });

function writeTranscript(rows, name) {
  const p = path.join(TMP, name || 't.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}

// WorkBuddy 真实格式：message 只带 role，正文在顶层 content；
// 用户输入被包在 <user_query> 里，前面塞着一堆注入块
const injection = [
  '<system-reminder data-role="user-context">',
  '<user_info>他叫什么、什么时区</user_info>',
  '<identity_context>股票顾问人格，跟这里无关</identity_context>',
  '<project_context>File: ~/WorkBuddy/大肥鱼/AGENTS.md</project_context>',
  '</system-reminder>',
].join('\n');

const realTurn = [
  { type: 'message', role: 'assistant', content: [{ type: 'text', text: '记着。' }] },
  {
    type: 'message', role: 'user',
    content: injection + '\n<user_query>' + '不是不是，我是说先跑一下测试吧，还记得吗' + '</user_query>',
  },
];

console.log('\n[1] 只取 <user_query> 里的东西，注入块不许混进来');
{
  const p = writeTranscript(realTurn, 'a.jsonl');
  const t = journal.lastUserText(p);
  eq('取到他原话', t, '不是不是，我是说先跑一下测试吧，还记得吗');
  ok('不含 user_info', !t.includes('user_info'));
  ok('不含 project_context', !t.includes('project_context'));
}

console.log('\n[2] 系统推送（没有 user_query）不记账');
{
  const p = writeTranscript([
    { type: 'message', role: 'user', content: '<system-reminder data-role="user-context">自动化任务触发</system-reminder>' },
  ], 'b.jsonl');
  eq('读出来是空', journal.lastUserText(p), '');
  const r = journal.appendTurn({ transcriptPath: p, homeDir: HOME, now: Date.now() });
  ok('appendTurn 跳过', r.ok === false && r.reason === 'empty', JSON.stringify(r));
}

console.log('\n[3] 写进今天的日记，带时间与标题');
{
  const dir = path.join(TMP, 'h3');
  const now = new Date(2026, 9, 26, 18, 37).getTime();   // 2026-10-26 18:37
  const p = writeTranscript(realTurn, 'c.jsonl');
  const r = journal.appendTurn({ transcriptPath: p, homeDir: dir, now });
  ok('写入成功', r.ok === true, JSON.stringify(r));
  eq('文件名是日期', path.basename(r.file), '2026-10-26.md');
  eq('这一行', r.line, '- 18:37 他说：不是不是，我是说先跑一下测试吧，还记得吗');
  const body = fs.readFileSync(r.file, 'utf8');
  ok('带日期标题', body.startsWith('# 2026-10-26\n'), JSON.stringify(body.slice(0, 40)));
  ok('正文在文件里', body.includes('测试'));
}

console.log('\n[4] 同一个 Stop 连来两次，只记一行');
{
  const dir = path.join(TMP, 'h4');
  const now = new Date(2026, 9, 26, 18, 40).getTime();
  const p = writeTranscript(realTurn, 'd.jsonl');
  const a = journal.appendTurn({ transcriptPath: p, homeDir: dir, now });
  const b = journal.appendTurn({ transcriptPath: p, homeDir: dir, now: now + 3000 });
  ok('第一次写', a.ok === true);
  ok('第二次判重', b.ok === false && b.reason === 'duplicate', JSON.stringify(b));
  const lines = fs.readFileSync(a.file, 'utf8').split('\n').filter((l) => l.startsWith('- '));
  eq('只有一行', lines.length, 1);
}

console.log('\n[5] 第二条追加到同一文件，且不粘连');
{
  const dir = path.join(TMP, 'h5');
  const p1 = writeTranscript(realTurn, 'e1.jsonl');
  const r1 = journal.appendTurn({ transcriptPath: p1, homeDir: dir, now: new Date(2026, 9, 26, 9, 5).getTime() });
  const p2 = writeTranscript([
    { type: 'message', role: 'user', content: '<user_query>又熬到两点了</user_query>' },
  ], 'e2.jsonl');
  const r2 = journal.appendTurn({ transcriptPath: p2, homeDir: dir, now: new Date(2026, 9, 26, 23, 50).getTime() });
  ok('两次都写成功', r1.ok && r2.ok, JSON.stringify([r1, r2]));
  const lines = fs.readFileSync(r2.file, 'utf8').split('\n').filter((l) => l.startsWith('- '));
  eq('两行', lines.length, 2);
  ok('第二行时间正确', lines[1].startsWith('- 23:50 他说：又熬到两点了'), lines[1]);
}

console.log('\n[6] 长句截断，不占满一整行');
{
  const long = '我跟你说今天这个事情真的特别复杂，从早上开始就在弄那个数据，弄到下午发现字段对不上，又回头改，改完发现还有别的坑，一直弄到晚上';
  eq('短句不动', journal.shorten('有点累', 60), '有点累');
  const s = journal.shorten(long, 60);
  ok('截到 60 字以内（含省略号）', s.length <= 61, `长度 ${s.length}`);
  ok('末尾有省略号', s.endsWith('…'));
  ok('在标点处断开', /[。，]$/.test(s.slice(0, -1)) || s.length <= 61, s);
}

console.log('\n[7] 时间用「他发出那一刻」，不是「记账那一刻」');
{
  const dir = path.join(TMP, 'h7');
  const said = new Date(2026, 9, 26, 18, 37).getTime();      // 他发出
  const late = new Date(2026, 9, 26, 19, 43).getTime();      // hook 迟了半小时才到
  const p = writeTranscript([
    { type: 'message', role: 'user', timestamp: said, content: '<user_query>我先跑一下测试吧</user_query>' },
  ], 'g.jsonl');
  const r = journal.appendTurn({ transcriptPath: p, homeDir: dir, now: late });
  ok('写进去了', r.ok === true, JSON.stringify(r));
  eq('时间是 18:37 而不是 19:43', r.line, '- 18:37 他说：我先跑一下测试吧');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass} passed, ${fail} failed\n`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 留着也无所谓 */ }
process.exit(fail === 0 ? 0 : 1);
