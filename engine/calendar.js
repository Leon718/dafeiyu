'use strict';
// 她自己的日子。
//
// 吃喝、节日、玩耍这些动画不承载信息 —— 它们不告诉他「它干得怎么样」，
// 承载的是「她自己也活着」。所以它们不进时刻表，按日历随机播：
// 中秋吃月饼、冬天堆雪人、晚饭那个点才吃晚饭。
//
// 农历用 Intl 的 chinese 日历算，不维护节日日期表 ——
// 手写一张 2026-2035 的表，第二年就得改，而且改错没人发现（中秋播成端午也照样跑）。
// 这个能力是 Node 内置的：new Intl.DateTimeFormat('en-u-ca-chinese', ...)

// 农历节日（月-日）。闰月不影响：中秋永远是八月十五。
const LUNAR = {
  '1-1': 'spring',       // 春节
  '1-15': 'lantern',     // 元宵
  '5-5': 'dragon',       // 端午
  '7-7': 'qixi',         // 七夕
  '8-15': 'midautumn',   // 中秋
  '9-9': 'chongyang',    // 重阳
  '12-8': 'laba',        // 腊八
  '12-23': 'xiaonian',   // 小年（北方；南方是二十四，两种都过的人不在乎差一天）
};

// 公历节日
const SOLAR = {
  '1-1': 'newyear',
  '10-31': 'halloween',
  '12-25': 'christmas',
};

// 吃饭的点。早餐早一点，夜宵留到十一点
const MEALS = [
  ['breakfast', 6.5, 9.5],
  ['lunch', 11.5, 13.5],
  ['dinner', 17.5, 19.5],
  ['nightsnack', 21, 24],
];

let lunarFmt = null;
function lunarParts(d) {
  try {
    if (!lunarFmt) {
      lunarFmt = new Intl.DateTimeFormat('en-u-ca-chinese', { month: 'numeric', day: 'numeric' });
    }
    const parts = lunarFmt.formatToParts(d);
    const m = Number((parts.find((p) => p.type === 'month') || {}).value);
    const day = Number((parts.find((p) => p.type === 'day') || {}).value);
    return m > 0 && day > 0 ? { m, d: day } : null;
  } catch {
    // 老 Node（没带 full-icu）会抛。降级成「不认农历节日」，别让整个调度挂掉
    return null;
  }
}

/** 北半球四季，按公历月份粗分。她要的是「冬天堆雪人」，不是气象学 */
function seasonOf(d) {
  const m = d.getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

/** 现在是不是吃饭的点。不在点上返回 null */
function mealOf(d) {
  const h = d.getHours() + d.getMinutes() / 60;
  for (const [key, from, to] of MEALS) {
    if (h >= from && h < to) return key;
  }
  return null;
}

/** 今天是哪些节日（可能同时有公历和农历的） */
function festivalOf(d) {
  const out = [];
  const solarKey = `${d.getMonth() + 1}-${d.getDate()}`;
  if (SOLAR[solarKey]) out.push(SOLAR[solarKey]);
  const l = lunarParts(d);
  if (l) {
    const lunarKey = `${l.m}-${l.d}`;
    if (LUNAR[lunarKey]) out.push(LUNAR[lunarKey]);
  }
  return out;
}

/**
 * 这条动画现在能不能播。
 * when 可以不写（随时能播），可以写多个条件（全满足才算）。
 *   { meal: 'dinner' }          只有晚饭那个点
 *   { season: 'winter' }        只有冬天
 *   { month: [12, 1, 2] }       只有这几个月
 *   { hour: [22, 3] }           只在深夜（支持跨零点）
 *   { festival: 'midautumn' }   只有中秋那天
 */
function matches(when, d) {
  if (!when) return true;
  if (when.meal && mealOf(d) !== when.meal) return false;
  if (when.season && seasonOf(d) !== when.season) return false;
  if (when.month) {
    const want = Array.isArray(when.month) ? when.month : [when.month];
    if (!want.includes(d.getMonth() + 1)) return false;
  }
  if (when.hour) {
    const [from, to] = when.hour;
    const h = d.getHours();
    const ok = from <= to ? (h >= from && h < to) : (h >= from || h < to);
    if (!ok) return false;
  }
  if (when.festival) {
    const want = Array.isArray(when.festival) ? when.festival : [when.festival];
    const have = festivalOf(d);
    if (!want.some((w) => have.includes(w))) return false;
  }
  return true;
}

/** 从池子里挑出此刻能播的。返回的是原条目（带 weight），渲染层照常按权重抽 */
function available(pool, d) {
  const now = d || new Date();
  return (pool || []).filter((it) => it && it.name && matches(it.when, now));
}

module.exports = {
  LUNAR, SOLAR, MEALS,
  lunarParts, seasonOf, mealOf, festivalOf, matches, available,
};
