'use strict';
/**
 * 「哪些动画被引用了」—— 只有一个真相源。
 *
 * 三个来源必须取并集，少一个就会把还在用的动画判成没用：
 *   1. config.default.json  池子（idle/poke/life）、账本档位、复读动画、点播表
 *   2. hook-mapper.js 的 MOMENT_ANIM + ACTION_ANIM  每个时刻配的动作 / 按动作覆盖的动作
 *   3. renderer/pet.js 的 playClip('xxx')  渲染层兜底动作
 *
 * 踩过的坑：ACTION_ANIM 加进来之后忘了同步这里，于是「写代码」「工作状态-清点归档」
 * 被报成「还没安排上」—— 它明明每次写文件都在播。检查工具漏扫一个来源，
 * 比没有检查工具更坏：它会让人以为还有余量，然后去重画一遍已经在用的动画。
 *
 * 之前体检脚本和清单脚本各写了一份，结果同一个仓库报出 31 和 32 两个数字 ——
 * 这种不一致比数字本身错更糟：它会让人不再相信任何一份报告。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function config() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'engine', 'config.default.json'), 'utf8'));
}

/** 动画名 → 谁在用（时刻名 / 池子名 / 用途） */
function usage() {
  const cfg = config();
  const usedBy = {};

  (function walk(o, ctx) {
    if (Array.isArray(o)) return o.forEach((x) => walk(x, ctx));
    if (!o || typeof o !== 'object') return;
    // name 只有带 weight 的才是动画名；别的 name 是给人看的（host.name）
    if (typeof o.name === 'string' && 'weight' in o) usedBy[o.name] = usedBy[o.name] || ctx;
    for (const k of ['anim', 'countingAnim', 'fallbackAnim']) {
      if (typeof o[k] === 'string') usedBy[o[k]] = usedBy[o[k]] || ctx;
    }
    for (const k of Object.keys(o)) {
      if (k.startsWith('_')) continue;
      const v = o[k];
      const childCtx = v && typeof v === 'object' && 'weight' in v ? ctx : k;
      walk(v, childCtx);
    }
  })(cfg, 'config');

  for (const pool of ['idle', 'poke']) {
    for (const item of (cfg[pool] && cfg[pool].pool) || []) usedBy[item.name] = pool + ' 池';
  }
  if (cfg.drag && cfg.drag.name) usedBy[cfg.drag.name] = '拖拽';

  const mapper = fs.readFileSync(path.join(ROOT, 'engine', 'hook-mapper.js'), 'utf8');
  const mi = mapper.indexOf('MOMENT_ANIM');
  const momentAnim = {};
  for (const m of mapper.slice(mi, mapper.indexOf('};', mi)).matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
    momentAnim[m[1]] = m[2];
    usedBy[m[2]] = usedBy[m[2]] || '时刻:' + m[1];
  }

  const renderer = fs.readFileSync(path.join(ROOT, 'engine', 'renderer', 'pet.js'), 'utf8');
  for (const m of renderer.matchAll(/playClip\(\s*'([^']+)'/g)) usedBy[m[1]] = usedBy[m[1]] || '渲染层默认';

  // 「它此刻在干什么」那套覆盖动画。跟 MOMENT_ANIM 一样是代码里的字面量，
  // 不扫它就会把「写代码」「清点归档」算成闲置素材
  const ai = mapper.indexOf('ACTION_ANIM');
  if (ai > 0) {
    for (const m of mapper.slice(ai, mapper.indexOf('};', ai)).matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
      usedBy[m[2]] = usedBy[m[2]] || '动作:' + m[1];
    }
  }

  return { usedBy, momentAnim, names: new Set(Object.keys(usedBy)) };
}

module.exports = { ROOT, usage };
