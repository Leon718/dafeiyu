'use strict';
/**
 * 唯一一处决定「东西在哪」的地方。
 *
 * 为什么值得单独一个文件：
 *   原来这些路径散在三处（main.js 的家目录、hook-bridge.sh 的六个绝对路径、
 *   renderer 的相对路径），任意一处写死，别人装上去就是黑的。
 *   现在全部收敛到这里，规则只有一条：
 *
 *     **能推导的不配置，要配置的只在安装时写一次，绝不在源码里出现用户的家目录。**
 *
 * 三层资产的边界：
 *   content/            他自己的东西（人格、台词、自有美术）—— 可以整个替换
 *   assets/third-party/ 别人的东西（dsh-pet，MIT）—— 不许改许可，只许引用
 *   其余一切            引擎代码 —— MIT
 */

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ENGINE_DIR = __dirname;
const APP_ROOT = path.resolve(ENGINE_DIR, '..');

/** 环境变量优先，空字符串当作没设置（hook 派生出来的环境里常见空值） */
function env(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

// ---- 三个资产根 ----
// 内容：允许用户完全换成自己的角色，所以可配置
const CONTENT_DIR = path.resolve(env('DAFEIYU_CONTENT', path.join(APP_ROOT, 'content')));
// 第三方素材：跟着仓库走，一般不动
const THIRD_PARTY_ASSETS = path.resolve(
  env('DAFEIYU_ASSETS', path.join(APP_ROOT, 'assets', 'third-party', 'webm')),
);
// 自有美术：放在内容层里，与第三方同名时覆盖它（他要换角色，第一件事就是同名替换）
const OWN_ASSETS = path.join(CONTENT_DIR, 'assets');

/**
 * 她的人格目录：台词（voices.json）、日记都在这儿。
 *
 * 三级回落，顺序就是优先级：
 *   1. DAFEIYU_HOME —— 用户显式指定（老用户升级、多人共用一台机器时用）
 *   2. <userData>/persona —— 用户自己放过 voices.json，说明他想改
 *   3. content/ —— 出厂人格
 *
 * 第 2 级必须检查文件存在，不能只看目录：userData 目录第一次运行一定会被创建，
 * 若只看目录存在，出厂人格就永远轮不到，开源版用户装上去会一个字都不说。
 */
function personaDir(userDataDir) {
  const explicit = env('DAFEIYU_HOME', '');
  if (explicit) return path.resolve(explicit);
  if (userDataDir) {
    const candidate = path.join(userDataDir, 'persona');
    if (fs.existsSync(path.join(candidate, 'voices.json'))) return candidate;
  }
  return CONTENT_DIR;
}

/** hooks 目录只有「住在某个 agent 里」这件事才需要，引擎自己不猜 */
function hooksDir() {
  return env('DAFEIYU_HOOKS_DIR', '');
}

/**
 * 素材索引：动画名 → file:// URL。
 *
 * 为什么不让渲染层自己拼相对路径：
 *   自有美术和第三方素材在两个目录，渲染层不知道优先级；
 *   而且渲染层用相对路径只能指到仓库内，用户换到仓库外就失效。
 *   这里一次扫完，建表传下去，渲染层只管查表。
 *
 * 扫描顺序决定优先级：先第三方、后自有 —— 后写的覆盖同名的。
 */
function assetIndex() {
  const index = {};
  const scan = (dir) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // 目录不存在是正常情况（还没放自有美术）
    }
    for (const file of names) {
      if (!file.endsWith('.webm')) continue;
      index[file.slice(0, -5)] = pathToFileURL(path.join(dir, file)).href;
    }
  };
  scan(THIRD_PARTY_ASSETS);
  scan(OWN_ASSETS);
  return index;
}

/** 读取一份 JSON，读不到就返回 null —— 调用方自己决定怎么兜底 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 深合并两份配置：用户那份盖在出厂默认上。
 *
 * 必须是深的。用户想调 life.interval 时只会写 {"life":{"interval":[60,120]}}，
 * 浅合并会把他没写的 life.pool 一起抹掉 —— 于是她再也不会自己出来做任何事，
 * 而且不报错（空池子和「今天没有动画该播」长得一模一样）。
 *
 * 数组一律整体替换，不拼接：谁想改 pool 就是想换掉它，把两份池子掺在一起
 * 会得到一堆他根本没打算要的动画。
 */
function mergeDeep(base, over) {
  if (over === undefined || over === null) return base;
  if (typeof over !== 'object' || Array.isArray(over)) return over;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) {
    // undefined 当作「他没写这一项」，不当作「他要把它清空」。
    // JSON 里根本没有 undefined，会走到这儿的只有代码传进来的半成品对象 ——
    // 那种情况下他的本意一定不是删配置。
    if (v === undefined) continue;
    const b = base && typeof base === 'object' && !Array.isArray(base) ? base[k] : undefined;
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)
      && b && typeof b === 'object' && !Array.isArray(b))
      ? mergeDeep(b, v)
      : v;
  }
  return out;
}

module.exports = {
  ENGINE_DIR,
  APP_ROOT,
  CONTENT_DIR,
  THIRD_PARTY_ASSETS,
  OWN_ASSETS,
  personaDir,
  hooksDir,
  assetIndex,
  readJson,
  mergeDeep,
};
