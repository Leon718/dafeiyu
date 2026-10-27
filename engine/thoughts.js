// 大肥鱼 · 待说清单
//
// 她的「见地」不该由规则生成 —— 规则生不出见地。
// 正确的位置是在她真的读得懂上下文的地方（WorkBuddy 会话里）想好，
// 写成一张小纸条放在这，桌宠只负责在对的时机把纸条念出来。
//
// 这样做的好处：
//   · 零额外积分：想这些话用的就是那次对话本来就付过的 token
//   · 带记忆：她写的时候手边就有 memory 和上下文
//   · 有时效：纸条过期作废，不会拿上周的话糊弄他
//
// 文件：<她家>/.workbuddy/thoughts.jsonl，一行一张纸条
//   {"text":"...","at":1792300000000}
//
// 「她家」不在这里推导 —— 由 main.js 用 paths.personaDir() 算好后 configure() 进来。
// 这里原本写死了 ~/WorkBuddy/大肥鱼，别人装上去会去一个不存在的目录找纸条：
// 不报错、不提示，只是永远没有纸条可念（最典型的一种静默失败）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let BASE = null;

/** 由 main.js 在知道人格目录之后调用一次 */
function configure(dir) {
  BASE = dir ? path.resolve(dir) : null;
}

/** 没 configure 时的兜底：环境变量 → 用户目录下的 .dafeiyu（不猜别人的项目目录） */
function baseDir() {
  if (BASE) return BASE;
  const env = (process.env.DAFEIYU_HOME || '').trim();
  if (env) return path.resolve(env);
  return path.join(require('node:os').homedir(), '.dafeiyu');
}

function file() {
  return path.join(baseDir(), '.workbuddy', 'thoughts.jsonl');
}

function seenFile() {
  return path.join(baseDir(), '.workbuddy', 'thoughts.seen.json');
}

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;   // 一周没说出来就作废
const MAX_KEEP_SEEN = 500;

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function loadSeen() {
  try {
    const a = JSON.parse(fs.readFileSync(seenFile(), 'utf8'));
    return new Set(Array.isArray(a) ? a : []);
  } catch {
    return new Set();
  }
}

function saveSeen(set) {
  try {
    const a = [...set].slice(-MAX_KEEP_SEEN);
    fs.writeFileSync(seenFile(), JSON.stringify(a), 'utf8');
  } catch { /* 记不住就记不住，不能因此崩掉 */ }
}

function load({ now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  let raw = '';
  try {
    raw = fs.readFileSync(file(), 'utf8');
  } catch {
    return [];
  }
  const seen = loadSeen();
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue;          // 半行/坏行直接跳过，别让她因为一行坏字卡死
    }
    const text = typeof o === 'string' ? o : String(o.text || '').trim();
    if (!text) continue;
    if (text.length > 80) continue;        // 桌宠气泡装不下长篇大论
    const at = Number(o.at) || 0;
    if (at && now - at > maxAgeMs) continue;
    const id = String(o.id || '') || hash(text);
    if (seen.has(id)) continue;
    out.push({ id, text, at, at_orig: at });
  }
  return out;
}

function pick(opts = {}) {
  const list = load(opts);
  if (!list.length) return null;
  // 想说的越早，越先说出来
  list.sort((a, b) => (a.at_orig || 0) - (b.at_orig || 0));
  return list[0];
}

function consume(id) {
  if (!id) return;
  const seen = loadSeen();
  seen.add(id);
  saveSeen(seen);
}

function count() {
  return load().length;
}

module.exports = { pick, consume, count, load, configure, file, baseDir };
