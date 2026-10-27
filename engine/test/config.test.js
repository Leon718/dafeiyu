'use strict';
// 配置合并：用户的 config.json 盖在出厂默认上。
//
// 这个文件存在的理由是一个真踩到的坑：浅合并下，用户想调 life.interval
// 只写 {"life":{"interval":[60,120]}}，结果把 life.pool 整个抹掉 ——
// 她从此不会自己出来做任何事，而且一个错都不报（空池子看起来就像「今天没动画该播」）。
const { mergeDeep } = require('../paths');

let pass = 0;
let fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};
const j = (x) => JSON.stringify(x);

console.log('\n[1] 深合并：只写一半，另一半要活着');
{
  const base = {
    life: { interval: [720, 1500], pool: [{ name: '吃晚餐' }, { name: '踢毽子' }] },
    gate: { maxPerHour: 12 },
  };
  const over = { life: { interval: [60, 120] } };
  const m = mergeDeep(base, over);
  t('用户改的 interval 生效了', j(m.life.interval) === '[60,120]', j(m.life.interval));
  t('他没写的 pool 还在（这是浅合并会丢的那个）', Array.isArray(m.life.pool) && m.life.pool.length === 2, j(m.life.pool));
  t('没碰的 gate 原样', m.gate.maxPerHour === 12, j(m.gate));
  t('没有把用户的键写回默认对象', j(base.life.interval) === '[720,1500]', j(base.life.interval));
}

console.log('\n[2] 数组整体替换，不拼接');
{
  const base = { pool: [{ name: 'a' }, { name: 'b' }] };
  const m = mergeDeep(base, { pool: [{ name: 'c' }] });
  t('换成新的就是新的', j(m.pool) === '[{"name":"c"}]', j(m.pool));
  // 如果哪天有人把数组也「深度合并」，长度会变成 3 —— 那意味着他自定义池子时
  // 会莫名其妙多出一堆没打算要的动画
  t('不会偷偷掺进旧的', m.pool.length === 1, String(m.pool.length));
}

console.log('\n[3] 空值：不能把配置清成 undefined');
{
  const base = { a: 1, b: { c: 2 } };
  t('undefined 不覆盖', j(mergeDeep(base, { a: undefined })) === '{"a":1,"b":{"c":2}}');
  t('null 不覆盖', j(mergeDeep(base, null)) === '{"a":1,"b":{"c":2}}');
  t('空对象不覆盖', j(mergeDeep(base, {})) === '{"a":1,"b":{"c":2}}');
  t('空子对象也不砸掉父层', j(mergeDeep(base, { b: {} })) === '{"a":1,"b":{"c":2}}');
  t('基础值为空时也能用', j(mergeDeep(null, { a: 1 })) === '{"a":1}');
}

console.log('\n[4] 多层嵌套');
{
  const base = { a: { b: { c: { d: 1, e: 2 } } } };
  const m = mergeDeep(base, { a: { b: { c: { e: 9 } } } });
  t('第四层能改到', m.a.b.c.e === 9, j(m.a.b.c));
  t('同层兄弟还在', m.a.b.c.d === 1, j(m.a.b.c));
}

console.log('\n[5] 出厂配置本身要站得住');
{
  const cfg = require('../config.default.json');
  const { available } = require('../calendar');

  t('life 存在', !!cfg.life);
  t('life.interval 是两个正数', Array.isArray(cfg.life.interval)
    && cfg.life.interval.length === 2
    && cfg.life.interval.every((x) => typeof x === 'number' && x > 0), j(cfg.life.interval));
  t('间隔不是「一分钟一次」（那是挂件，不是生活）', cfg.life.interval[0] >= 300, j(cfg.life.interval));

  // 一年里随便挑 12 个时刻，池子都不该是空的 ——
  // 空了就意味着那段时间她只会站着，而且没人会发现
  const empties = [];
  for (let mon = 1; mon <= 12; mon++) {
    for (const h of [8, 12, 18, 22]) {
      const d = new Date(2026, mon - 1, 15, h);
      if (available(cfg.life.pool, d).length === 0) empties.push(`${mon}月${h}点`);
    }
  }
  t('一年十二个月、四个饭点，池子都不会空', empties.length === 0, empties.join(' '));

  // 每条都有 name 和 weight
  const bad = cfg.life.pool.filter((it) => !it.name || typeof it.weight !== 'number');
  t('池子里每条都有名字和权重', bad.length === 0, j(bad.slice(0, 2)));

  // 点播表：match 是非空字符串数组，anim 有值
  const badCue = (cfg.play.cues || []).filter(
    (c) => !Array.isArray(c.match) || !c.match.length || !c.anim
  );
  t('点播表结构完整', (cfg.play.cues || []).length > 0 && badCue.length === 0, j(badCue.slice(0, 2)));

  // 点播词不能太宽（一个字的词会到处命中）
  const tooShort = [];
  for (const c of cfg.play.cues || []) {
    for (const k of c.match) if (String(k).length < 2) tooShort.push(`${c.anim}:${k}`);
  }
  t('点播词没有单个字的（会到处命中）', tooShort.length === 0, tooShort.join(','));
}

console.log('');
if (fail) { console.log(`FAILED  ${pass} passed, ${fail} failed`); process.exit(1); }
console.log(`ALL PASS  ${pass} passed, 0 failed`);
