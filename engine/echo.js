'use strict';
/**
 * 让她把刚在聊天窗口里说过的话，在桌面上再说一遍。
 *
 * 为什么需要这个：
 *   桌宠原来只在「时刻」说话（你回来了、你连着失败三次、你坐太久），
 *   于是**你跟她正经聊天的时候，桌面上反而一个字都没有** —— 屏幕上只有动画。
 *   她明明刚在聊天窗口说了「去吧。下次回来我不一定开门。」，
 *   桌面上那只鱼却一声不吭，看起来就像个哑巴挂件。
 *
 * 数据从哪来：
 *   hook 的 payload 里带 transcript_path，那是一个 jsonl。
 *   她在聊天窗口说的话就写在里面 —— 读本地文件，**零积分**，不调模型。
 *
 * 拆句：
 *   她本来就有换行分段的习惯，一个换行就是一个停顿，
 *   正好对应渲染层的 beats（气泡一句一句蹦出来，中间停一下）。
 */

const fs = require('node:fs');

const MAX_BEATS = 3;      // 再多就成朗读器了，三句是「一口气」的上限
const MAX_CHARS = 60;     // 单句上限，超了按句号切
const MIN_CHARS = 1;

/** 从转录里取她最后一条带文字的回复（遇到你刚说的那句就停） */
function lastAssistantText(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split('\n');
  // 从文件尾部往前扫：最后一条 assistant 文本就是她刚说完的那句。
  // 中间可能夹着仅有 tool_use 的 assistant 记录 —— 跳过，继续往前找。
  //
  // 格式坑（踩过）：WorkBuddy 的转录里 `message` 往往只装 usage，
  // 正文在**顶层**的 content；文本块类型叫 `output_text`，不是 `text`。
  // 第一版按 {message:{role,content}} + 'text' 读，读真实文件永远是空串。
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    const m = d.message && d.message.role ? d.message : d;
    const role = m.role || d.role;
    if (role === 'user') return '';          // 走到他这句话了，上面没有新回复
    if (role !== 'assistant') continue;

    const c = m.content !== undefined ? m.content : d.content;
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c)) {
      // 文本块：text / output_text 都认；thinking、tool_use 没有 text 字段，自然被滤掉
      const parts = c
        .filter((b) => b && typeof b.text === 'string' && b.text.trim())
        .map((b) => b.text);
      if (parts.length) return parts.join('\n');
    }
  }
  return '';
}

/** 去掉 markdown 记号：气泡是纯文本，星号和反引号只会碍眼 */
function plain(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, '')        // 代码块整段丢掉
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')    // 标题井号
    .replace(/^\s{0,3}>\s?/gm, '')         // 引用
    .replace(/^\s{0,3}[-*+]\s+/gm, '')     // 列表点
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,2}/g, '');
}

/** 长句按句末标点切开，太长的再硬切 */
function splitLong(line, max) {
  if (line.length <= max) return [line];
  const parts = line.split(/(?<=[。！？!?…；;])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  for (const p of parts) {
    if (buf && (buf + p).length > max) { out.push(buf); buf = p; }
    else buf += p;
  }
  if (buf) out.push(buf);
  return out.flatMap((s) => (s.length <= max * 2 ? [s] : chunk(s, max)));
}

function chunk(s, max) {
  const out = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

/** 一段回复 → 气泡里逐句蹦的那几拍 */
function toBeats(text, opts = {}) {
  const maxBeats = opts.maxBeats || MAX_BEATS;
  const maxChars = opts.maxChars || MAX_CHARS;

  const clean = plain(text).trim();
  if (!clean) return [];

  const chunks = [];
  for (const line of clean.split(/\n+/)) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    chunks.push(...splitLong(t, maxChars));
  }

  const beats = chunks.filter((s) => s.length >= MIN_CHARS).slice(0, maxBeats);
  if (!beats.length) return [];
  // 后面还有话没念：末尾留个省略号，别让气泡把半句话当成说完了
  if (chunks.length > beats.length) beats[beats.length - 1] += '…';
  return beats;
}

/**
 * 他跟她说完一句、她在聊天窗口回复完了（Stop），把这句话交给桌面上的她。
 * @param {string} transcriptPath hook payload 的 transcript_path
 * @param {{maxBeats?:number,maxChars?:number,anim?:string}} [opts]
 * @returns {{moment:string,home:true,text:string,beats?:string[],anim:string|null,echo:true}|null}
 */
function fromTranscript(transcriptPath, opts = {}) {
  if (!transcriptPath) return null;
  const beats = toBeats(lastAssistantText(transcriptPath), opts);
  if (!beats.length) return null;
  return {
    moment: 'echo',
    home: true,
    text: beats[0],
    beats: beats.length > 1 ? beats : undefined,
    anim: opts.anim || '碎碎念-对屏碎碎念',
    echo: true,
  };
}

module.exports = { lastAssistantText, toBeats, plain, fromTranscript, MAX_BEATS, MAX_CHARS };
