'use strict';
/**
 * 桌宠替她记账：把他这一轮说的话，抄进今天的日记。
 *
 * 为什么不是在会话里让她自己写：
 *   让她写 = 一次工具调用 = **一次额外的模型往返**。实测她那两轮，
 *   每多一次往返就是 +2~5 秒。而且她为了决定「这轮要不要写」
 *   还要在脑子里多推几百字（她一轮本来就要写 1100 字推理）。
 *   所以她越是被要求记账，回话就越慢 —— 这个代价不该由他承担。
 *
 *   桌宠不会思考，但**抄写不需要思考**。她 Stop 的时候，
 *   payload 里带着 transcript_path，他说了什么就写在里面。
 *   读本地文件：零积分、零模型往返、零延迟（后台做完）。
 *
 *   更深一层的好处：她通过工具写的文件会被客户端的文件历史（checkpoint）
 *   追踪，之后每一轮快照都要过一遍。日记一年几百个文件，
 *   那就等于**每轮都多背一点包袱**。桌宠写的文件不进那个追踪。
 *
 * 分工：
 *   桌宠负责「编码」（原话落盘，机械、不判断）
 *   她负责「整合」（下次聊天时想翻就翻，判断要不要改 MEMORY.md）
 *
 * 格式刻意和 AGENTS.md 里给她看的一致：
 *   - 18:37 他说：我先跑一下测试吧，还记得吗
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_CHARS = 60;          // 一行太长就不像日记了
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

/** 取最后一条 user 消息里 <user_query> 的内容（注入块全在它外面） */
function lastUserTurn(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return { text: '', at: 0 };
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    const m = d.message && d.message.role ? d.message : d;
    const role = m.role || d.role;
    if (role !== 'user') continue;

    const c = m.content !== undefined ? m.content : d.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      text = c.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n');
    }
    if (!text) continue;

    // 真正的用户输入在 <user_query> 里；没有它说明这是系统推送（automation、提醒），
    // 不是他本人说的 —— 不记账。
    const hit = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
    if (!hit) continue;
    // 时间用他**发出**那一刻，不是记账那一刻（hook 可能延迟、也可能被重放）
    const ts = typeof d.timestamp === 'number' ? d.timestamp : 0;
    return { text: hit[1].replace(/\s+/g, ' ').trim(), at: ts };
  }
  return { text: '', at: 0 };
}

function lastUserText(transcriptPath) {
  return lastUserTurn(transcriptPath).text;
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function diaryPath(homeDir, now) {
  const d = new Date(now);
  return path.join(homeDir, '.workbuddy', 'memory', `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`);
}

function hhmm(now) {
  const d = new Date(now);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shorten(text, max) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  // 在标点处断开，别把词切一半
  const cut = t.slice(0, max);
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('？'), cut.lastIndexOf('！'));
  return (at > max * 0.5 ? cut.slice(0, at) : cut) + '…';
}

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}

/**
 * 把他这一轮说的话写进今天的日记。
 * @param {{transcriptPath:string, homeDir:string, now?:number, maxChars?:number}} opts
 * @returns {{ok:boolean, reason?:string, file?:string, line?:string}}
 */
function appendTurn(opts = {}) {
  const { transcriptPath, homeDir, now = Date.now(), maxChars = MAX_CHARS } = opts;
  if (!homeDir) return { ok: false, reason: 'no-home' };
  if (!transcriptPath) return { ok: false, reason: 'no-transcript' };

  const text = lastUserTurn(transcriptPath);
  if (!text.text || text.text.length < 2) return { ok: false, reason: 'empty' };
  const said = text.text;
  // 优先用他发出那一刻的时间；拿不到才退回记账时刻
  const when = text.at && text.at > 0 ? text.at : now;

  const memDir = path.join(homeDir, '.workbuddy', 'memory');
  const stateFile = path.join(memDir, '.journal-state.json');
  const key = said.length + ':' + said.slice(0, 80);
  const st = readState(stateFile);
  // 同一条话重复触发（Stop 可能连着来两次）不重复记账
  if (st.key === key && now - (st.at || 0) < DEDUPE_WINDOW_MS) {
    return { ok: false, reason: 'duplicate' };
  }

  const file = diaryPath(homeDir, when);
  const line = `- ${hhmm(when)} 他说：${shorten(said, maxChars)}`;

  try {
    fs.mkdirSync(memDir, { recursive: true });
    const exists = fs.existsSync(file);
    const head = exists ? '' : `# ${path.basename(file, '.md')}\n\n`;
    // 文件末尾没换行时补一个，免得两行黏在一起
    let prefix = head;
    if (exists) {
      const old = fs.readFileSync(file, 'utf8');
      prefix = old && !old.endsWith('\n') ? '\n' : '';
    }
    fs.appendFileSync(file, `${prefix}${line}\n`, 'utf8');
    fs.writeFileSync(stateFile, JSON.stringify({ key, at: now }), 'utf8');
    return { ok: true, file, line };
  } catch (err) {
    return { ok: false, reason: 'write-failed: ' + err.message };
  }
}

module.exports = { lastUserText, lastUserTurn, diaryPath, shorten, appendTurn, MAX_CHARS };
