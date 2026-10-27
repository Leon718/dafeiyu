#!/usr/bin/env node
'use strict';
/**
 * 从完整台词库生成开源仓库用的示例集。
 *
 * 为什么要有这一步：
 *   content/voices.json 是授权内容（完整人格，168 句里有 98 句台词），不进开源仓库；
 *   但开源版必须能跑起来、每个时刻都有话说，否则别人 clone 下来看到的是个哑巴。
 *   所以这份示例集是**派生出来的**，不是手写的 —— 手写两份必然走样。
 *
 * 抽取规则（刻意保守，只取够用不取精彩）：
 *   - 列表型时刻：取第 1 个变体（一个变体可能本身就是「连说几句」的数组，整体保留）
 *   - 按键分档的时刻（危险种类、递进次数）：每档取 1 个变体 —— 这类不能省，
 *     省了就是某类危险来临时她哑了，那是功能坏了，不是节流
 *   - 说明字段（_doc / _rules / _when / _note）原样保留 —— 它们讲的是怎么写台词，不是台词本身
 *
 * 结果：开源版每个时刻都有话说，但同一时刻只有一个变体（听久了会腻）；
 * 完整版的增量就是「同一时刻有 3~6 种说法」，这也是付费内容的真实卖点。
 *
 * 用法：
 *   node tools/make-sample.js [完整版路径] [输出路径]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.argv[2] || path.join(ROOT, 'content', 'voices.json');
const OUT = process.argv[3] || path.join(ROOT, 'content', 'voices.sample.json');

const PER_LIST = 1;
const PER_BUCKET = 1;

const ANNOTATION_KEYS = new Set(['_doc', '_change', '_rules']);

/**
 * 递归裁剪：遇到数组就只留前 PER_LIST 个变体，遇到对象就往下走，标量原样保留。
 *
 * 有一层结构容易看错：分档时刻长这样
 *   byKind: { dangerRan: [ ["它刚才 {c}。", "我喊了一声，你不在。"], [...] ] }
 * 外层是「变体」，内层才是「一次连说几句」。所以只切外层，内层整体保留 ——
 * 切了内层会把一句连说砍成半句。
 */
function trim(node) {
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) out[key] = value.slice(0, PER_LIST);
    else if (value && typeof value === 'object') out[key] = trim(value);
    else out[key] = value;
  }
  return out;
}

const full = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const sample = {};
for (const [name, moment] of Object.entries(full)) {
  // _doc / _rules 这类说明字段讲的是「怎么写台词」，不是台词本身，整段保留：
  // 开源版要能让人照着写出自己的台词，否则他拿到手也不知道该往哪加东西
  if (ANNOTATION_KEYS.has(name) || !moment || typeof moment !== 'object') {
    sample[name] = moment;
  } else {
    sample[name] = trim(moment);
  }
}
sample._doc = '示例台词集：开源版自带，够跑、每个时刻都有话说。完整人格请替换本文件（或放到 <userData>/persona/voices.json）。';

fs.writeFileSync(OUT, JSON.stringify(sample, null, 2) + '\n');

const count = (o) => {
  let n = 0;
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) n += v.length;
    else if (v && typeof v === 'object') n += count(v);
  }
  return n;
};

console.log('%s → %s', path.relative(ROOT, SRC), path.relative(ROOT, OUT));
console.log('台词：%d 句 → %d 句', count(full), count(sample));
