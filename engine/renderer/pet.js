// 大肥鱼 · 渲染层
// 形态二：她默认在做自己的事（idle 池循环），只在「时刻」到来时演一下、说一句，然后回去。
// 她不播报他的任务状态 —— 那不是陪伴，是监控。
'use strict';

// 素材路径一律由主进程给（paths.assetIndex() 建的表，键是动画名、值是 file:// URL）。
// 渲染层不再自己拼相对路径 —— 素材在别的目录、或者用户把角色放到仓库外时，
// 任何写死的相对路径都会静默变成一个 404 的黑窗口。
const FADE_MS = 180;

const el = {
  a: document.getElementById('va'),
  b: document.getElementById('vb'),
  bubble: document.getElementById('bubble'),
  stage: document.getElementById('stage'),
  ledger: document.getElementById('ledger'),
  num: document.getElementById('ledger-num'),
  ledgerSub: document.getElementById('ledger-sub'),
};

let cfg = null;
let reducedMotion = false;
let active = el.a;      // 当前可见的 video
let idle = el.b;        // 备用缓冲
let currentClip = null;
let currentState = 'idle';   // 逻辑上想呈现的状态
let playingState = 'idle';   // 正在播的状态
let pokeUntil = 0;
let idleTimer = null;
let bubbleTimer = null;
let lastPokeAt = 0;
let clipToken = 0;           // 防止旧 clip 的 ended 回调干扰
let speakToken = 0;          // 防止旧的一串话还没说完就被新的一句顶掉
let ledgerRun = 0;
let hidden = true;
// 她还要补一句话，先别走。主进程在深思结果回来前会设这个（见 main.js 的 maybeDeep）。
// 为什么要这个：模型要 6~8 秒，如果她说完第一拍就回去做自己的事，
// 那第二拍就成了「对着空气补一句」—— 她必须站在那儿等，那才像在说话。
let holdUntil = 0;
let holdTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 工具 ----------
function pick(pool) {
  const total = pool.reduce((s, x) => s + (x.weight || 1), 0);
  let r = Math.random() * total;
  for (const item of pool) {
    r -= item.weight || 1;
    if (r <= 0) return item.name;
  }
  return pool[pool.length - 1].name;
}

function fill(line, vars) {
  return String(line).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined ? vars[k] : ''));
}

/** 取一条台词，返回「拍子数组」——一条也可能是一串（她会连说几句） */
function lineOf(key, vars) {
  const list = cfg?.voices?.[key]?.lines;
  if (!Array.isArray(list) || !list.length) return null;
  const raw = list[Math.floor(Math.random() * list.length)];
  return (Array.isArray(raw) ? raw : [raw]).map((b) => fill(b, vars));
}

function pickLine(key, vars) {
  const beats = lineOf(key, vars);
  return beats ? beats[0] : null;
}

/** 气泡显示多久：短句别一闪而过，长句别赖着不走 */
function bubbleMs(text) {
  const n = String(text || '').length;
  // 最短 4.2 秒：他可能正在别处看代码，抬眼就看到她的时间得够长
  return Math.min(12000, Math.max(4200, 1500 + n * 200));
}

function say(text, ms) {
  if (!text) return;
  el.bubble.textContent = text;
  el.bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => el.bubble.classList.remove('show'), ms || bubbleMs(text));
}

/**
 * 找不到指定动画时用什么顶上。
 * 换角色的人往往只做了几个动作，配置里的池子名对不上 —— 这时宁可用一个通用待机，
 * 也别让窗口空着（空窗口看起来就是「这软件坏了」）。
 */
function fallbackSrc(table) {
  const keys = Object.keys(table);
  if (!keys.length) return null;
  return table['待机呼吸休闲'] || table[keys[0]];
}

// ---------- 播放核心 ----------
function playClip(name, { loop = false, token = null } = {}) {
  if (!name) return;
  const myToken = token ?? ++clipToken;
  currentClip = name;

  const next = idle;
  const table = (cfg && cfg.assets) || {};
  const src = table[name] || fallbackSrc(table);
  if (!src) {
    // 一个动画都没有 = 素材目录空的。说清楚，别留一个黑窗口让人猜
    console.warn('[pet] 没有这个动画，也没有任何可用素材：' + name);
    return;
  }
  if (!table[name]) console.warn('[pet] 没有这个动画，已回落到默认：' + name);
  next.src = src;
  next.loop = loop;

  const onReady = () => {
    next.removeEventListener('canplay', onReady);
    if (myToken !== clipToken) return;  // 已被更新的指令顶掉
    if (!hidden) next.play().catch(() => {});
    next.classList.add('visible');
    active.classList.remove('visible');
    const prev = active;
    active = next;
    idle = prev;
    setTimeout(() => { if (prev !== active) { prev.pause(); } }, FADE_MS + 60);
  };
  next.addEventListener('canplay', onReady);

  next.onended = () => {
    if (myToken !== clipToken) return;
    onClipEnd();
  };
}

function stopIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdle() {
  stopIdleTimer();
  if (!cfg || hidden) return;
  const [min, max] = cfg.idle.interval;
  const wait = (min + Math.random() * (max - min)) * 1000;
  idleTimer = setTimeout(() => {
    if (hidden || playingState !== 'idle') return;
    playClip(pick(cfg.idle.pool));
  }, wait);
}

// 演完 / 落地 / 收工：回去做她自己的事
function toIdle() {
  playingState = 'idle';
  currentState = 'idle';
  scheduleIdle();
}

function onClipEnd() {
  if (playingState === 'drag') return;   // 拖拽姿势是 loop，不会走到这
  if (playingState !== 'idle') { toIdle(); return; }
  scheduleIdle();
}

/**
 * 时刻到了：演一下、说一句（或几句），然后回去。
 * @param {{moment?:string,text?:string,beats?:string[],anim?:string|null,keepState?:boolean}} p
 */
async function perform(p) {
  if (!cfg) return;
  const my = ++speakToken;
  stopIdleTimer();

  const list = Array.isArray(p.beats) && p.beats.length
    ? p.beats.slice()
    : (p.text ? [p.text] : []);

  if (p.anim) {
    playingState = p.moment || 'moment';
    playClip(p.anim);
  }

  if (!list.length) {
    if (!p.anim) toIdle();
    return;
  }

  // 一句话说完要停一会儿，别像朗读器。这几百毫秒是她「像个人」的全部成本
  const total = list.reduce((s, t) => s + bubbleMs(t), 0);
  window.pet.speechBusy(Math.round(total * 0.95));

  // 连说几句时先给个「…」，像在组织语言
  if (list.length > 1) {
    say('…', 520);
    await sleep(540);
    if (my !== speakToken) return;
  }

  for (let i = 0; i < list.length; i++) {
    if (my !== speakToken) return;
    say(list[i], bubbleMs(list[i]));
    if (i < list.length - 1) {
      await sleep(Math.round(bubbleMs(list[i]) * 0.74));
      if (my !== speakToken) return;
    }
  }

  // 还有第二拍在路上：站着别动，等它到了再说。
  // 「…」不是装饰 —— 模型要 6 秒，那 6 秒里如果只是气泡消失，
  // 看起来是卡了；顶一个「…」就是「她在想」。同一个空白，两种读法。
  if (holdUntil && !p.deep) {
    clearTimeout(holdTimer);
    const wait = Math.max(600, holdUntil - Date.now());
    say('…', wait);
    holdTimer = setTimeout(() => {
      holdUntil = 0;
      if (my === speakToken && !hidden) toIdle();
    }, wait);
    return;
  }

  if (!p.anim && !p.keepState) toIdle();
}

/** 直接说某个时刻的台词（戳她、拖她这类交互用） */
function speakLine(key, vars, opts = {}) {
  const beats = lineOf(key, vars);
  if (!beats) return;
  perform({ moment: key, beats, text: beats[0], anim: null, keepState: !!opts.keepState });
}

// ---------- 积分小票 ----------
function ledgerSubText(d) {
  const her = (d && d.her) || {};
  const all = (d && d.all && d.all.credits) || 0;
  const l1 = her.msgs
    ? `${her.msgs} 句 · 平均 ${(her.credits / her.msgs).toFixed(2)} 分/句`
    : '';
  const l2 = all > 0 ? `WorkBuddy 全局 ${all.toFixed(0)} 分` : '';
  // 两行，不是一行挤在一起 —— 这行字是他真正要看的信息
  return [l1, l2].filter(Boolean).join('\n');
}

function closeLedger() {
  el.ledger.classList.remove('show');
  el.stage.classList.remove('ledger-on');
}

async function showLedger(d) {
  if (!cfg || !d) return;
  const my = ++ledgerRun;
  const her = d.her || { credits: 0, msgs: 0 };
  const total = Number(her.credits) || 0;

  // 花得越多，袋子越空
  const tiers = cfg.ledger?.tiers || [];
  let bagAnim = cfg.ledger?.fallbackAnim || '余额-钱袋如常';
  for (const t of tiers) {
    if (total <= t.maxCredits) { bagAnim = t.anim; break; }
  }

  stopIdleTimer();
  el.num.textContent = '0.0';
  el.ledgerSub.textContent = '让我数数';
  el.ledger.classList.add('show');
  el.stage.classList.add('ledger-on');

  playingState = 'ledger';
  // 循环：动画比数数短，不循环就会中途自己跳回待机
  playClip(cfg.ledger?.countingAnim || '吃Token', { loop: true });
  window.pet.speechBusy(5200);

  // 数字滚动
  const dur = 1500;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      if (my !== ledgerRun) { resolve(); return; }
      const k = Math.min(1, (performance.now() - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      el.num.textContent = (total * eased).toFixed(1);
      if (k < 1) requestAnimationFrame(tick);
      else { el.num.textContent = total.toFixed(1); resolve(); }
    };
    requestAnimationFrame(tick);
  });
  if (my !== ledgerRun) return;

  el.ledgerSub.textContent = ledgerSubText(d);

  // 数完了换成钱袋，再说一句
  playingState = 'ledger';
  playClip(bagAnim, { loop: true });
  const raw = cfg.voices?.[total >= 100 ? 'ledgerBig' : 'ledger']?.lines;
  if (Array.isArray(raw) && raw.length) {
    const line = fill(raw[Math.floor(Math.random() * raw.length)], { n: total.toFixed(1) });
    say(line, bubbleMs(line));
  }

  await sleep(4600);
  if (my !== ledgerRun) return;
  closeLedger();
  playClip(pick(cfg.idle.pool));
  toIdle();
}

// ---------- 交互 ----------
//
// 拖她这件事只有一个判据：**左键按着**。
//
// 踩过的坑：这里原来只在 mousedown 记一个 pointerDown，等 mouseup 来清。
// 可是拖动过程中窗口是用 setPosition 跟着鼠标挪的，指针很容易跑出窗口范围，
// 那一次 mouseup 就送不到这个窗口 —— pointerDown 留下来再也不会被清掉。
// 之后鼠标只是从她身上经过，mousemove 看到「还按着」，窗口就跟着跑：
// 她变成一块磁铁，一碰就滑走。所以每一帧都要自己核对一次按键状态。
let pointerDown = null;
let dragging = false;

/** 松手（或者发现其实早就松了）：把拖动状态彻底清掉，回待机 */
function endDrag() {
  const wasDragging = dragging;
  pointerDown = null;
  dragging = false;
  if (!wasDragging) return false;
  window.pet.dragEnd();
  playingState = 'idle';
  currentState = 'idle';
  playClip(pick(cfg.idle.pool));
  scheduleIdle();
  return true;
}

el.stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;          // 只有左键，右键留给菜单
  pointerDown = { x: e.screenX, y: e.screenY, t: Date.now() };
  dragging = false;
});

window.addEventListener('mousemove', (e) => {
  if (!pointerDown) return;
  // buttons === 0：他其实已经松手了，只是那一下没送到这个窗口
  if (e.buttons === 0) { endDrag(); return; }
  const dx = e.screenX - pointerDown.x;
  const dy = e.screenY - pointerDown.y;
  if (!dragging && Math.hypot(dx, dy) > 4) {
    dragging = true;
    window.pet.dragStart();
    if (cfg?.drag?.name) {
      stopIdleTimer();
      playClip(cfg.drag.name, { loop: true });
      playingState = 'drag';
      speakLine('drag', null, { keepState: true });
    }
  }
  if (dragging) window.pet.dragMove();
});

window.addEventListener('mouseup', (e) => {
  if (!pointerDown) return;
  if (e && e.button !== 0) return;
  const held = Date.now() - pointerDown.t;
  if (endDrag()) return;

  if (held < 600) {
    const now = Date.now();
    if (now - lastPokeAt < 900) return;   // 连点节流
    lastPokeAt = now;
    window.pet.poke();                     // 他还在，别急着退场
    if (reducedMotion) { speakLine('poke'); return; }
    stopIdleTimer();
    pokeUntil = now + 2600;
    playingState = 'poke';
    playClip(pick(cfg.poke.pool));
    speakLine('poke', null, { keepState: true });
  }
});

// 切走应用 / 窗口被藏起来：拖动一定已经结束了，别把状态留在那儿
window.addEventListener('blur', () => { if (pointerDown) endDrag(); });

// 双击：去找她说话
el.stage.addEventListener('dblclick', () => {
  window.pet.openHome();
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet.contextMenu();
});

// ---------- 启动 ----------
window.addEventListener('error', (e) => {
  console.error('JS_ERROR ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
});

for (const v of [el.a, el.b]) {
  v.addEventListener('error', () => {
    const c = v.error;
    console.error('VIDEO_ERROR code=' + (c && c.code) + ' src=' + decodeURIComponent(v.src || ''));
  });
}

function applyScale() {
  const base = cfg?.window?.scale || 1.2;
  const factor = cfg?.sizeFactor || 1;
  document.documentElement.style.setProperty('--scale', String(base * factor));
}

async function boot() {
  try {
    cfg = await window.pet.getConfig();
  } catch (e) {
    console.error('GET_CONFIG_FAIL ' + e);
    return;
  }
  if (!cfg) { console.error('NO_CONFIG'); return; }
  console.log('BOOT ok, idlePool=' + (cfg.idle?.pool?.length || 0) + ' voiceKeys=' + Object.keys(cfg.voices || {}).length);
  applyScale();
  // 开机她不说话。第一句话要等他真的来了再说
  playingState = 'idle';
  currentState = 'idle';
  playClip(pick(cfg.idle.pool));
  scheduleIdle();
}

boot();

window.pet.onConfig((c) => {
  if (!c) return;
  if (!cfg) { cfg = c; boot(); return; }
  cfg = c;
  applyScale();
});

window.pet.onReducedMotion((v) => {
  reducedMotion = v;
  if (v) {
    stopIdleTimer();
    playClip('待机呼吸休闲', { loop: true });
    playingState = 'idle';
  } else {
    toIdle();
    playClip(pick(cfg.idle.pool));
  }
});

window.pet.onResize((factor) => {
  const base = cfg?.window?.scale || 1.2;
  document.documentElement.style.setProperty('--scale', String(base * factor));
});

window.pet.onExternalState((payload) => {
  if (!payload) return;
  // 只延长待机：她还要补一句，别在这几秒里转身走开
  if (payload.holdMs && !payload.text && !payload.beats && !payload.anim) {
    holdUntil = Math.max(holdUntil, Date.now() + payload.holdMs);
    return;
  }
  if (payload.releaseHold) {
    holdUntil = 0;
    clearTimeout(holdTimer);
    // 只收掉「…」。她真说过的话不许被这个信号抹掉
    if (el.bubble.textContent === '…') el.bubble.classList.remove('show');
    if (!hidden) toIdle();
    return;
  }
  // 深思的第二拍：她本来就站在那儿，接着往下说就行，不要重新进场
  if (payload.deep) {
    holdUntil = 0;
    clearTimeout(holdTimer);
    if (payload.text || payload.beats) perform(payload);
    return;
  }
  if (payload.text || payload.anim || payload.beats) perform(payload);
});

window.pet.onLedger((d) => { showLedger(d); });

// ---------- 出场 / 退场 ----------
// 她不常驻。被召唤才淡入，没人理了就淡出 —— 淡出之后窗口会被整个隐藏，
// 桌面上不留任何东西（也不会挡住点击）。
// 隐着的时候必须停掉视频：窗口不可见还在解码 VP9，纯属白烧 CPU。
function setPresence(state, fadeMs) {
  if (state === 'hidden') {
    hidden = true;
    stopIdleTimer();
    speakToken++;
    ledgerRun++;
    closeLedger();
    el.bubble.classList.remove('show');
    el.a.pause();
    el.b.pause();
    return;
  }
  if (state === 'enter') {
    hidden = false;
    el.stage.style.transition = `opacity ${Math.max(0, fadeMs || 0)}ms ease`;
    el.stage.style.opacity = '1';
    // 醒来接着演：别每次都从同一个开场动作重来
    const v = active;
    if (v && !v.ended) v.play().catch(() => {});
    scheduleIdle();
    return;
  }
  el.stage.style.transition = `opacity ${Math.max(0, fadeMs || 0)}ms ease`;
  el.stage.style.opacity = '0';
}

window.pet.onPresence((p) => {
  if (!p) return;
  setPresence(p.state, p.fadeMs);
});
