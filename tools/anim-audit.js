#!/usr/bin/env node
/**
 * 生成 docs/ANIM-AUDIT.md：把「时刻 → 动画」和「全部素材」摊成一张可标记的清单。
 *
 * 用脚本生成而不是手写：动画名有三个来源，手抄必漏；漏了就不是评审，是凭印象。
 * 名字来源统一走 tools/lib/used-anims.js（和 check-assets 共用一份）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, usage } = require('./lib/used-anims');

const ASSET_DIR = path.join(ROOT, 'assets', 'third-party', 'webm');

const names = fs.readdirSync(ASSET_DIR).filter((f) => f.endsWith('.webm'))
  .map((f) => f.slice(0, -5)).sort((a, b) => a.localeCompare(b, 'zh'));

const { usedBy, momentAnim } = usage();
const { ACTION_FIRST, ACTION_ANIM } = require(path.join(ROOT, 'engine', 'hook-mapper'));

const voices = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'voices.json'), 'utf8'));

// 占位符要填成她真的会说的样子。
// 这里曾经填成 {a:'README', b:'配置'}，于是清单上显示「不是README了。是配置。」——
// 用户按这句话提了意见，而那句话她一次都不会说（真实的是「不是找不到模块了。是语法错。」）。
// 拿假样本做评审，比不评审更坏：意见是真的，但打在了一个不存在的靶子上。
const { KIND_CN } = require(path.join(ROOT, 'engine', 'watch'));
const FILL = {
  a: KIND_CN.missing_module,   // 上一个错：找不到模块
  b: KIND_CN.syntax,           // 这一个错：语法错
  f: 'agent.py',
  c: 'npm run build',
  n: '6', k: '12', m: '40', s: '4', h: '3',
  e: '4', w: '6',
  clock: '两点',
  home: '大肥鱼',
};

/** 台词有三种形状：字符串、「一句一拍」的 beats 数组、同一档里的多组变体。只取第一组 */
function text(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    // 多组变体（每种说法一组）：只要第一种，否则整档台词会连成一大段
    if (v.length && (Array.isArray(v[0]) || (v[0] && typeof v[0] === 'object'))) return text(v[0]);
    return v.map(text).join('');
  }
  if (v && typeof v === 'object' && v.lines) return text(v.lines[0]);
  return '';
}

/** 一句话 + 分档标签，把占位符填成人能读的例子 */
function say(key) {
  const o = voices[key];
  if (!o) return '';
  const fill = (s) => String(s || '')
    .replace(/\{(\w+)\}/g, (_, k) => FILL[k] ?? ('{' + k + '}'))
    .replace(/\s*\n\s*/g, ' ')
    .trim();
  if (Array.isArray(o.lines)) return fill(text(o.lines[0]));
  // 分档类（危险种类 / 递进次数）：取两档举例，否则看不出她在说什么
  for (const field of ['byKind', 'byCount']) {
    const b = o[field];
    if (!b) continue;
    const parts = Object.entries(b).slice(0, 2).map(([k, v]) => `${k} → ${fill(text(v))}`);
    if (parts.length) return parts.join('；');
  }
  return '';
}

const MOMENT_CN = {
  danger: '它跑了危险命令（rm -rf / git 清空）',
  flip: '同一处改来改去，方向在翻转',
  rush: '几秒内重跑同一条命令（没改就重试）',
  loop: '改→跑→改，第三轮',
  searchOnly: '翻了很多地方，一行没写',
  stall: '长时间卡住不动',
  grind: '同一个文件写到第三遍，改动越来越小',
  guess: '同一个错试第三遍（没改输入）',
  errKnown: '报错是常见类型（缺模块/语法/端口/权限）',
  blast: '一轮动了很多文件',
  noVerify: '改了好几个文件，一次都没跑',
  longRun: '一条命令跑了很久',
  repeatedFailure: '连续失败多次',
  lateNight: '深夜',
  comeback: '他离开很久回来',
  reportBack: '他不在时发生了什么（事后报告）',
  successAfterStruggle: '反复失败后终于成功',
  firstGreet: '第一次见面',
  idleLong: '很久没人理她',
  openHome: '他要跟她说话',
  thought: '念他写好的纸条',
};

const L = [];
L.push('# 动画现状');
L.push('');
L.push('> 这张表是给她（和改她的人）看的，不是评审单。');
L.push('> 未安排的动画不是垃圾，是还没找到位置的素材：`npm run assets-check` 会列出来。');
L.push('');
L.push('## 一、时刻：她跳出来说一句时，配的是什么动作');
L.push('');
L.push('| # | 时刻 | 她说的话（真实槽位） | 默认动画 | 会不会被「它手上那个活」顶掉 |');
L.push('|---|---|---|---|---|');
Object.keys(momentAnim).forEach((k, i) => {
  const act = ACTION_FIRST.has(k)
    ? '会（写文件→写代码，删/挪→清点归档，跑命令→忙碌点按）'
    : '不会（这个动作是她对这件事的反应）';
  L.push(`| M${i + 1} | ${MOMENT_CN[k] || k} | ${say(k)} | ${momentAnim[k]} | ${act} |`);
});
const distinct = new Set(Object.values(momentAnim));
L.push('');
L.push(`默认动画只有 ${distinct.size} 种，21 个时刻共用。`);
L.push('');
L.push('**这正是「动作没营养」的来源，解决办法不是给每个时刻多配一个动画，而是让它跟现场对上：**');
L.push('她说话时它正在写文件，就播「写代码」；正在删/挪，就播「清点归档」。');
L.push('一个动作能被任何一句话套用，它就等于没有动作。');
L.push('');
L.push('剩下那几个不换的时刻（danger / lateNight / successAfterStruggle 等），动作本身就是她的反应 ——');
L.push('她被吓一跳、她打哈欠、她雀跃。换成「写代码」就把反应抹掉了。');
L.push('');
L.push('## 二、全部 106 个动画');
L.push('');
L.push('| # | 动画 | 现在用在哪 |');
L.push('|---|---|---|');
names.forEach((n, i) => {
  L.push(`| A${String(i + 1).padStart(3, '0')} | ${n} | ${usedBy[n] || '—（还没安排上）'} |`);
});
L.push('');
const usedCount = names.filter((n) => usedBy[n]).length;
L.push(`合计 ${names.length} 个：已安排 ${usedCount} 个，未安排 ${names.length - usedCount} 个。`);
L.push('');

fs.writeFileSync(path.join(ROOT, 'docs', 'ANIM-AUDIT.md'), L.join('\n') + '\n', 'utf8');
console.log('写入 docs/ANIM-AUDIT.md：%d 个时刻 + %d 个动画（已安排 %d / 未安排 %d）',
  Object.keys(momentAnim).length, names.length, usedCount, names.length - usedCount);
