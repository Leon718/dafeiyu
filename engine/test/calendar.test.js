'use strict';
// 她自己的日子：什么时候能吃什么、什么时候能堆雪人。
//
// 这些动画不传递信息，但它们一旦播错日子就不是「生活感」而是 bug ——
// 十月的桌面上冒出「中秋赏月吃月饼」，比不播更糟。
const cal = require('../calendar');

let pass = 0;
let fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};
const eq = (name, got, want) => t(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const near = (name, got, want) => t(name, JSON.stringify(got) === JSON.stringify(want),
  `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// 早上/中午/晚上的几个时刻（本地时间，构造函数用本地时区）
const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi || 0);

console.log('\n[1] 农历：节日不能算错日子');
{
  // 2026-09-25 是农历八月十五（中秋）。这个数不是猜的 ——
  // 用 Intl 的 chinese 日历反查过，也是公开日历上写的那天
  eq('2026-09-25 的农历', JSON.stringify(cal.lunarParts(at(2026, 9, 25, 12))), '{"m":8,"d":15}');
  eq('中秋那天认得出中秋', JSON.stringify(cal.festivalOf(at(2026, 9, 25, 12))), '["midautumn"]');
  t('中秋前一天不是中秋', !cal.festivalOf(at(2026, 9, 24, 12)).includes('midautumn'));

  // 2026 春节是 2 月 17 日（正月初一）
  eq('2026-02-17 认得出春节', JSON.stringify(cal.festivalOf(at(2026, 2, 17, 12))), '["spring"]');

  // 公历节日跟农历无关
  eq('12-25 是圣诞', JSON.stringify(cal.festivalOf(at(2026, 12, 25, 12))), '["christmas"]');
  eq('10-31 是万圣', JSON.stringify(cal.festivalOf(at(2026, 10, 31, 12))), '["halloween"]');
  // 普通日子没有节日
  eq('平常日子没有节日', JSON.stringify(cal.festivalOf(at(2026, 10, 27, 12))), '[]');
}

console.log('\n[2] 饭点：什么钟点什么饭');
{
  eq('7:00 是早餐', cal.mealOf(at(2026, 10, 27, 7)), 'breakfast');
  eq('10:00 什么都不吃', cal.mealOf(at(2026, 10, 27, 10)), null);
  eq('12:00 是午餐', cal.mealOf(at(2026, 10, 27, 12)), 'lunch');
  eq('15:00 什么都不吃', cal.mealOf(at(2026, 10, 27, 15)), null);
  eq('18:00 是晚餐', cal.mealOf(at(2026, 10, 27, 18)), 'dinner');
  eq('20:30 不吃了', cal.mealOf(at(2026, 10, 27, 20, 30)), null);
  eq('22:00 是夜宵', cal.mealOf(at(2026, 10, 27, 22)), 'nightsnack');
}

console.log('\n[3] 季节：按公历月份粗分');
{
  eq('3 月是春', cal.seasonOf(at(2026, 3, 15, 12)), 'spring');
  eq('7 月是夏', cal.seasonOf(at(2026, 7, 15, 12)), 'summer');
  eq('10 月是秋', cal.seasonOf(at(2026, 10, 15, 12)), 'autumn');
  eq('1 月是冬', cal.seasonOf(at(2026, 1, 15, 12)), 'winter');
  eq('12 月是冬', cal.seasonOf(at(2026, 12, 15, 12)), 'winter');
}

console.log('\n[4] 条件判定：一条动画只在它该出现的时候出现');
{
  const dinner = { meal: 'dinner' };
  t('晚饭点能播晚饭', cal.matches(dinner, at(2026, 10, 27, 18)));
  t('中午不能播晚饭', !cal.matches(dinner, at(2026, 10, 27, 12)));

  const winter = { season: 'winter' };
  t('一月能堆雪人', cal.matches(winter, at(2026, 1, 10, 12)));
  t('七月不能堆雪人', !cal.matches(winter, at(2026, 7, 10, 12)));

  const months = { month: [12, 1, 2] };
  t('一月在名单里', cal.matches(months, at(2026, 1, 10, 12)));
  t('三月不在名单里', !cal.matches(months, at(2026, 3, 10, 12)));

  // 跨零点的深夜区间
  const night = { hour: [22, 3] };
  t('23 点在区间内', cal.matches(night, at(2026, 10, 27, 23)));
  t('2 点在区间内（跨零点）', cal.matches(night, at(2026, 10, 27, 2)));
  t('12 点不在区间内', !cal.matches(night, at(2026, 10, 27, 12)));

  // 没写条件 = 随时能播
  t('没有条件就是随时', cal.matches(undefined, at(2026, 10, 27, 12)));
  // 多个条件要全满足
  t('两个条件都满足才算', cal.matches({ season: 'winter', meal: 'dinner' }, at(2026, 1, 10, 18)));
  t('只满足一个不算', !cal.matches({ season: 'winter', meal: 'dinner' }, at(2026, 7, 10, 18)));
}

console.log('\n[5] 从池子里挑：不该出现的真的不会出现');
{
  const pool = [
    { name: '中秋赏月吃月饼', weight: 8, when: { festival: 'midautumn' } },
    { name: '堆雪人', weight: 5, when: { season: 'winter' } },
    { name: '吃午餐', weight: 10, when: { meal: 'lunch' } },
    { name: '吃晚餐', weight: 10, when: { meal: 'dinner' } },
    { name: '踢毽子', weight: 2 },
  ];

  const noonAutumn = cal.available(pool, at(2026, 10, 27, 12));
  const names = noonAutumn.map((x) => x.name);
  t('十月底中午：能踢毽子', names.includes('踢毽子'));
  t('十月底中午：能吃饭', names.includes('吃午餐'));
  t('十月底中午：不能吃月饼', !names.includes('中秋赏月吃月饼'), names.join(','));
  t('十月底中午：不能堆雪人', !names.includes('堆雪人'));
  t('十月底中午：不能吃晚饭', !names.includes('吃晚餐'));

  const midautumn = cal.available(pool, at(2026, 9, 25, 12));
  t('中秋中午：能吃月饼了', midautumn.map((x) => x.name).includes('中秋赏月吃月饼'));

  const winterNight = cal.available(pool, at(2026, 1, 10, 18));
  const wn = winterNight.map((x) => x.name);
  t('冬天晚上：能堆雪人', wn.includes('堆雪人'));
  t('冬天晚上：能吃晚饭', wn.includes('吃晚餐'));

  t('空池子不炸', cal.available([], new Date()).length === 0);
  t('脏数据不炸', cal.available([null, {}, { when: {} }], new Date()).length === 0);
}

console.log('\n[6] 出厂配置：池子里的动画名和条件都要站得住');
{
  const cfg = require('../config.default.json');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'assets', 'third-party', 'webm');
  let have = new Set();
  try {
    have = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.webm')).map((f) => f.slice(0, -5)));
  } catch { /* 素材没下载：跳过这项，不把它当成失败 */ }

  const pool = cfg.life.pool;
  t('life 池不是空的', pool.length > 20, String(pool.length));
  if (have.size) {
    const missing = pool.filter((it) => !have.has(it.name)).map((it) => it.name);
    t('池子里的动画都有片子', missing.length === 0, missing.join(','));
    const badCues = (cfg.play.cues || []).filter((c) => !have.has(c.anim)).map((c) => c.anim);
    t('点播的动画都有片子', badCues.length === 0, badCues.join(','));
  }
  // 每条 when 只能用 calendar 认识的字段，写错的字段会被静默忽略 —— 那等于永远能播
  const KNOWN = new Set(['meal', 'season', 'month', 'hour', 'festival']);
  const bad = [];
  for (const it of pool) {
    for (const k of Object.keys(it.when || {})) if (!KNOWN.has(k)) bad.push(`${it.name}.${k}`);
  }
  t('when 里没有拼错的字段', bad.length === 0, bad.join(','));

  // 每个节日条件至少有一条动画配着，否则那个节日她只会站着
  const usedFest = new Set();
  for (const it of pool) {
    const f = it.when && it.when.festival;
    if (f) (Array.isArray(f) ? f : [f]).forEach((x) => usedFest.add(x));
  }
  const known = new Set(Object.values(cal.LUNAR).concat(Object.values(cal.SOLAR)));
  const orphan = [...usedFest].filter((x) => !known.has(x));
  t('节日条件都是认得的节日', orphan.length === 0, orphan.join(','));
}

console.log('');
if (fail) { console.log(`FAILED  ${pass} passed, ${fail} failed`); process.exit(1); }
console.log(`ALL PASS  ${pass} passed, 0 failed`);
