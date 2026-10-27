// 大肥鱼 · 积分账本
//
// WorkBuddy 把「每条消息花了多少积分」记在 ~/.workbuddy/workbuddy.db 的
// session_usage 表里：
//   session_id / used(上下文token) / size(上限) / updated_at / credit_json
// credit_json 形如 {"<messageId>": 1.26, "<messageId>": 0.06, ...}
//
// 这里只读，绝不写。她不是计费系统，只是替他记着这笔账。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_PATH = process.env.DAFEIYU_USAGE_DB
  ? path.resolve(process.env.DAFEIYU_USAGE_DB)
  : path.join(os.homedir(), '.workbuddy', 'workbuddy.db');
// 没有这个库不是错误（别的 agent 不记积分）。read() 返回 ok:false，
// 菜单退回「积分累计使用」这句通用文案 —— 功能少一个，人还在

/** credit_json → {credits, msgs}。脏数据当 0，别让她因为一行坏 JSON 就闭嘴 */
function sumCredits(json) {
  let credits = 0;
  let msgs = 0;
  let obj;
  try {
    obj = JSON.parse(json || '{}');
  } catch {
    return { credits: 0, msgs: 0 };
  }
  if (!obj || typeof obj !== 'object') return { credits: 0, msgs: 0 };
  for (const k of Object.keys(obj)) {
    const v = Number(obj[k]);
    if (!Number.isFinite(v)) continue;
    credits += v;
    msgs += 1;
  }
  return { credits, msgs };
}

function empty() {
  return {
    ok: false,
    err: null,
    at: 0,
    her: { credits: 0, msgs: 0, sessions: 0, lastCredits: 0, lastMsgs: 0 },
    all: { credits: 0, msgs: 0, sessions: 0 },
  };
}

/**
 * @param {string} homeDir 她的工作区目录（cwd 在它之下的会话算她花的）
 */
function read(homeDir) {
  const out = empty();
  out.at = Date.now();

  if (!fs.existsSync(DB_PATH)) {
    out.err = 'no-db';
    return out;
  }

  let db = null;
  try {
    // Electron 45 自带 Node 24，node:sqlite 可用；只读打开，WAL 下也能读
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH, { readOnly: true });

    const rows = db.prepare(`
      SELECT su.credit_json AS cj, su.updated_at AS ua, s.cwd AS cwd
      FROM session_usage su
      LEFT JOIN sessions s ON s.id = su.session_id
    `).all();

    const home = String(homeDir || '').replace(/\/+$/, '');
    let lastUpdated = -1;

    for (const r of rows) {
      const { credits, msgs } = sumCredits(r.cj);
      if (!msgs) continue;

      out.all.credits += credits;
      out.all.msgs += msgs;
      out.all.sessions += 1;

      const cwd = String(r.cwd || '');
      // 子目录也算她的：他到她家开会话时 cwd 就是那个目录本身
      const isHers = home && (cwd === home || cwd.startsWith(home + path.sep) || cwd.startsWith(home + '/'));
      if (!isHers) continue;

      out.her.credits += credits;
      out.her.msgs += msgs;
      out.her.sessions += 1;

      const ua = Number(r.ua) || 0;
      if (ua >= lastUpdated) {
        lastUpdated = ua;
        out.her.lastCredits = credits;
        out.her.lastMsgs = msgs;
      }
    }
    out.ok = true;
  } catch (e) {
    out.err = e && e.message ? e.message : String(e);
  } finally {
    try { db?.close(); } catch { /* 忽略 */ }
  }

  return out;
}

/** 一句话概括，给菜单标题用 */
function label(data) {
  if (!data || !data.ok) return '积分累计使用';
  if (!data.her.msgs) return '积分累计使用 0';
  return `积分累计使用 ${data.her.credits.toFixed(1)}`;
}

module.exports = { read, label, sumCredits, DB_PATH };
