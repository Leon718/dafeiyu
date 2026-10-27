#!/usr/bin/env node
/**
 * 素材体检：哪些动画在用、哪些还没排进池子。
 *
 * **这个脚本不删任何文件。** 它只回答两个问题：
 *   1. 代码里引用到的动画名，磁盘上都有吗？（少一个 = 那个时刻窗口黑一下）
 *   2. 磁盘上的动画，哪些还没被引用？（这些不是垃圾，是还没排进池子的素材）
 *
 * 用法：node tools/check-assets.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, usage } = require('./lib/used-anims');

const ASSET_DIR = path.join(ROOT, 'assets', 'third-party', 'webm');

function main() {
  const { usedBy } = usage();
  const have = fs.readdirSync(ASSET_DIR).filter((f) => f.endsWith('.webm'));
  const mb = (list) => (list.reduce((s, f) => s + fs.statSync(path.join(ASSET_DIR, f)).size, 0) / 1048576).toFixed(1);
  const nameOf = (f) => f.slice(0, -5);

  const used = have.filter((f) => usedBy[nameOf(f)]);
  const spare = have.filter((f) => !usedBy[nameOf(f)]);
  const haveSet = new Set(have.map(nameOf));

  // 反向检查：引用到了但磁盘上没有 = 那个时刻没画面（写错名 / 素材被移走）
  const missing = Object.keys(usedBy).filter((n) => isAnimName(n) && !haveSet.has(n));

  console.log('引用到的动画名 : ' + Object.keys(usedBy).length);
  console.log('磁盘上有       : ' + have.length + ' 个 / ' + mb(have) + ' MB');
  console.log('已在用         : ' + used.length + ' 个 / ' + mb(used) + ' MB');
  console.log('还没排进池子   : ' + spare.length + ' 个 / ' + mb(spare) + ' MB');

  if (missing.length) {
    console.log('\n⚠ 引用了但磁盘上没有（这些时刻会没有画面）:');
    missing.forEach((n) => console.log('   ' + n + '  ← ' + usedBy[n]));
  }
  if (spare.length) {
    console.log('\n还没被引用到的（不是垃圾，是待安排的素材）:');
    spare.forEach((f) => console.log('   ' + f));
  }
}

/** 是否像个动画名（排除配置里给人看的说明文字） */
function isAnimName(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 30 && !/[，。：、\s]/.test(s);
}

main();
