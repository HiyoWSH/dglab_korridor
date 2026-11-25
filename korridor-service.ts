// korridor-service — KORRIDOR 游戏联动服务（10 模式 + 双通道）
//
// 链路：
//   KORRIDOR.exe (BepInEx 插件) --HTTP POST /game-state--> 本服务 --HTTP POST /vibrate--> control-service --> 设备
//
// 设备输出公式（用户设备档位有限）：
//   输出档位 = floor(波形振幅字节 * 全局强度 / 1000)，单通道 0-20 档
//   波形帧 8 字节 = 前 4 字节频率 + 后 4 字节振幅；振幅有效值 0-100（0x64 = 100 = 满幅）
//
// 模式（详见 KORRIDOR.md）：
//   血量痛感（A 通道，优先级高→低）：
//     mode4 死亡 100 / 20 档 / 3s         — 一次性，触发后独占全部通道
//     mode2 中伤 60  / 6 档 / 2s          — 下降穿越 50%，更严重可打断冷却
//     mode1 轻伤 20  / 2 档 / 1s          — 下降穿越 80%
//     mode3 濒死 120 / 12↔6 档 / 循环      — 血 < 20% 状态循环，血回升或死亡即停
//   信息提示（B 通道为主，优先级低）：
//     bossKill    Boss 击杀   150 / 15↔7 档 / 1.5s / A+B
//     bossAppear  Boss 登场    80 / 4↔8 档 / 1.5s / A+B
//     bossPhase2  Boss 二阶段 100 / 10→5 档 / 1s   / A
//     siege       围攻压力     50 / 5↔2 档 / 循环  / A
//     kill        击杀连段     40 / 4 档   / 200ms / B
//     marks       Marks 获得   30 / 3→0 档 / 400ms / B
//
// 并发规则：
//   - 每个通道独立维护输出预算 maxPerChannel（默认 20 档），超额时高优先级驱逐低优先级。
//   - 循环型模式（mode3/siege）每次节拍前检查：若目标通道有更高优先级模式活跃则跳过该拍，
//     这就实现了"1/2/4 抑制 3"以及血量危险时压制信息提示。
//   - mode4 死亡触发后 exclusiveUntil 期间独占，屏蔽一切其它模式（含 B 通道信息提示）。
//
// 按项目约定：只写代码，不主动运行/测试。

import { serve } from 'bun';

// ============ 配置类型 ============
type ModeName =
  | 'mode1' | 'mode2' | 'mode3' | 'mode4'
  | 'marks' | 'bossAppear' | 'bossKill' | 'bossPhase2' | 'siege' | 'kill';
type HighMode = 'mode1' | 'mode2';
type Channel = 0 | 1 | 2; // 2 = A+B 双通道
type ConcreteChannel = 0 | 1;

interface ModeConfig {
  strength: number;
  durationMs: number;
  frames: string[];
  channel: Channel;
  output: number;        // 峰值输出档位（用于预算）
  priority: number;      // 越大优先级越高
  periodMs?: number;     // 仅循环型模式（mode3/siege）
  hpBelow?: number;      // 仅血量模式（mode1/2/3）：血量低于此百分比时触发该档
}

interface KorridorConfig {
  listen: { host: string; port: number; token: string };
  control: { baseUrl: string; token: string };
  thresholds: { low80: number; low50: number; low20: number };  // 兼容旧配置；优先用 modes.modeX.hpBelow
  hysteresisPercent: number;
  cooldownMs: number;
  output: { maxPerChannel: number };
  siege: { enabled: boolean; minEnemies: number };  // enabled=false 彻底关闭围攻压力；否则敌人数 >= minEnemies 触发
  modes: Record<ModeName, ModeConfig>;
}

interface GameState {
  hpPercent: number;
  dead: boolean;
  marks: number;
  kills: number;
  bossActive: boolean;
  bossKills: number;
  bossPhase2: boolean;
  enemies: number;
  ts: number;
}

interface ActiveFire {
  mode: ModeName;
  channel: ConcreteChannel;
  output: number;
  until: number;
  priority: number;
}

const CONFIG_PATH = process.argv[2] || `${import.meta.dir}/korridor.config.json`;

// ============ 运行时状态 ============
let config: KorridorConfig;
let state: GameState = emptyState();
let firstFrame = true;            // 血量首帧作为基线，不触发穿越
let firstExtrasFrame = true;      // 扩展状态首帧作为基线，不触发 marks/kills/boss
let armed80 = true;
let armed50 = true;
let lastDead = false;
let lastHighFireAt = 0;
let lastHighSeverity = 0;
let exclusiveUntil = 0;           // mode4 死亡独占到期时间
let activeFires: ActiveFire[] = [];
let mode3Timer: Timer | null = null;
let siegeTimer: Timer | null = null;

// 扩展状态上一次的快照（用于变化检测）
let lastMarks = 0;
let lastKills = 0;
let lastBossActive = false;
let lastBossKills = 0;
let lastBossPhase2 = false;

function emptyState(): GameState {
  return {
    hpPercent: 100, dead: false, marks: 0, kills: 0,
    bossActive: false, bossKills: 0, bossPhase2: false, enemies: 0, ts: 0,
  };
}

const SEVERITY: Record<HighMode, number> = { mode1: 1, mode2: 2 };

// ============ 日志 ============
function log(level: 'info' | 'warn' | 'error' | 'debug', msg: string): void {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[KORR ${ts}] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'debug') {
    if (Bun.env.VERBOSE === 'true') console.debug(line);
  } else console.log(line);
}

// ============ 配置 ============
function defaultModes(): Record<ModeName, ModeConfig> {
  return {
    // ---- 血量痛感（A 通道）----
    mode1: {
      strength: 20, durationMs: 1000, frames: ['6464646464646464'],
      channel: 0, output: 2, priority: 70, hpBelow: 80,
    },
    mode2: {
      strength: 60, durationMs: 2000, frames: ['6464646464646464'],
      channel: 0, output: 6, priority: 80, hpBelow: 50,
    },
    mode3: {
      strength: 120, durationMs: 1000, periodMs: 800,
      frames: ['6464646464326432'], // 振幅 100/50 交替 → 12↔6 档
      channel: 0, output: 12, priority: 60, hpBelow: 20,
    },
    mode4: {
      strength: 200, durationMs: 3000, frames: ['6464646464646464'],
      channel: 0, output: 20, priority: 100,
    },
    // ---- 信息提示 ----
    marks: {
      strength: 30, durationMs: 400, frames: ['6464646464640000'], // 3→0
      channel: 1, output: 3, priority: 15,
    },
    bossAppear: {
      strength: 80, durationMs: 1500, frames: ['6464646432326464'], // 4→8
      channel: 2, output: 8, priority: 45,
    },
    bossKill: {
      strength: 150, durationMs: 1500, frames: ['6464646464326432'], // 15↔7
      channel: 2, output: 15, priority: 50,
    },
    bossPhase2: {
      strength: 100, durationMs: 1000, frames: ['6464646464646432'], // 10→5
      channel: 0, output: 10, priority: 40,
    },
    siege: {
      strength: 50, durationMs: 1000, periodMs: 1000,
      frames: ['6464646464326432'], // 5↔2
      channel: 0, output: 5, priority: 35,
    },
    kill: {
      strength: 40, durationMs: 200, frames: ['6464646464000000'], // 4
      channel: 1, output: 4, priority: 25,
    },
  };
}

// 剥离 JSON 注释（// 行注释、/* */ 块注释），字符串内的 // 不受影响。
// 让配置文件可写注释（JSONC），解析仍走标准 JSON.parse。
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n' || c === '\r') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      else if (c === '\n' || c === '\r') out += c; // 保留换行便于定位行号
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

async function loadConfig(): Promise<KorridorConfig> {
  let raw: string;
  try {
    raw = await Bun.file(CONFIG_PATH).text();
  } catch {
    throw new Error(`读取配置失败: ${CONFIG_PATH}`);
  }
  let parsed: KorridorConfig;
  try {
    parsed = JSON.parse(stripJsonComments(raw)) as KorridorConfig;
  } catch (e) {
    throw new Error(`配置不是合法 JSON: ${(e as Error).message}`);
  }

  const l = parsed.listen ?? ({} as KorridorConfig['listen']);
  l.host = typeof l.host === 'string' && l.host ? l.host : '127.0.0.1';
  l.port = Number.isInteger(l.port) && l.port > 0 && l.port < 65536 ? l.port : 9996;
  l.token = typeof l.token === 'string' ? l.token : '';

  const c = parsed.control ?? ({} as KorridorConfig['control']);
  c.baseUrl = typeof c.baseUrl === 'string' && c.baseUrl ? c.baseUrl.replace(/\/$/, '') : 'http://127.0.0.1:9997';
  c.token = typeof c.token === 'string' ? c.token : '';

  const t = parsed.thresholds ?? ({} as KorridorConfig['thresholds']);
  t.low80 = finiteOr(t.low80, 80);
  t.low50 = finiteOr(t.low50, 50);
  t.low20 = finiteOr(t.low20, 20);
  if (!(t.low20 < t.low50 && t.low50 < t.low80)) {
    throw new Error('阈值必须满足 low20 < low50 < low80');
  }

  parsed.hysteresisPercent = nonNegative(parsed.hysteresisPercent, 3);
  parsed.cooldownMs = nonNegative(parsed.cooldownMs, 5000);

  const o = parsed.output ?? ({} as KorridorConfig['output']);
  o.maxPerChannel = clamp(finiteOr(o.maxPerChannel, 20), 1, 20);
  parsed.output = o;

  const sg = parsed.siege ?? ({} as KorridorConfig['siege']);
  // 显式 false 才关闭；缺省视为开启（兼容旧配置缺 enabled 字段）
  sg.enabled = sg.enabled !== false;
  sg.minEnemies = Math.max(1, Math.round(finiteOr(sg.minEnemies, 40)));
  parsed.siege = sg;

  const defaults = defaultModes();
  const m = (parsed.modes ?? {}) as Partial<Record<ModeName, Partial<ModeConfig>>>;
  parsed.modes = {} as Record<ModeName, ModeConfig>;
  // 血量阈值优先取各模式自己的 hpBelow；缺省回退到旧 thresholds（兼容旧配置）
  const hpFallback: Partial<Record<ModeName, number>> = {
    mode1: t.low80, mode2: t.low50, mode3: t.low20,
  };
  for (const key of Object.keys(defaults) as ModeName[]) {
    const u = m[key] ?? {};
    const d = defaults[key];
    const ch = [0, 1, 2].includes(Number(u.channel)) ? Number(u.channel) as Channel : d.channel;
    const frames = Array.isArray(u.frames) && u.frames.length > 0
      ? u.frames.map(String) : d.frames;
    parsed.modes[key] = {
      strength: finiteOr(u.strength, d.strength),
      durationMs: nonNegative(u.durationMs, d.durationMs),
      frames,
      channel: ch,
      output: clamp(finiteOr(u.output, d.output), 0, 20),
      priority: finiteOr(u.priority, d.priority),
      ...(d.periodMs !== undefined ? { periodMs: Math.max(100, finiteOr(u.periodMs, d.periodMs)) } : {}),
      ...(d.hpBelow !== undefined
        ? { hpBelow: finiteOr(u.hpBelow, hpFallback[key] ?? d.hpBelow) }
        : {}),
    };
  }

  // 生效的血量阈值（各模式 hpBelow）必须满足 濒死 < 中伤 < 轻伤
  const hp20 = parsed.modes.mode3.hpBelow ?? 20;
  const hp50 = parsed.modes.mode2.hpBelow ?? 50;
  const hp80 = parsed.modes.mode1.hpBelow ?? 80;
  if (!(hp20 < hp50 && hp50 < hp80)) {
    throw new Error('血量阈值必须满足 mode3.hpBelow < mode2.hpBelow < mode1.hpBelow');
  }

  parsed.listen = l;
  parsed.control = c;
  parsed.thresholds = t;
  return parsed;
}

function finiteOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function nonNegative(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ============ 档位（仅用于 /state 展示） ============
function tierOf(hp: number, dead: boolean): number {
  if (dead) return 4;
  const m = config.modes;
  if (hp < (m.mode3.hpBelow ?? 20)) return 3;
  if (hp < (m.mode2.hpBelow ?? 50)) return 2;
  if (hp < (m.mode1.hpBelow ?? 80)) return 1;
  return 0;
}

// ============ 输出预算与抢占 ============
function pruneExpired(now: number): void {
  activeFires = activeFires.filter((f) => f.until > now);
}

function channelOutput(channel: ConcreteChannel, now: number): number {
  return activeFires
    .filter((f) => f.channel === channel && f.until > now)
    .reduce((sum, f) => sum + f.output, 0);
}

function channelsOf(mode: ModeName): ConcreteChannel[] {
  const ch = config.modes[mode].channel;
  return ch === 2 ? [0, 1] : [ch as ConcreteChannel];
}

// 循环型模式每次节拍前检查：目标通道是否存在更高优先级的活跃模式
function hasHigherPriorityActive(mode: ModeName, now: number): boolean {
  const prio = config.modes[mode].priority;
  const chans = channelsOf(mode);
  return activeFires.some(
    (f) => f.until > now && f.priority > prio && chans.includes(f.channel),
  );
}

async function sendVibrate(mode: ModeName, channel: ConcreteChannel): Promise<void> {
  const m = config.modes[mode];
  const body = {
    channel,
    strength: m.strength,
    duration: m.durationMs,
    frames: m.frames,
    wait: false, // fire-and-forget，不阻塞状态处理
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.control.token) headers['X-API-Key'] = config.control.token;

  const tag = `${mode}/${channel === 0 ? 'A' : 'B'}`;
  try {
    const resp = await fetch(`${config.control.baseUrl}/vibrate`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) {
      // 失败必须可见：HTTP 4xx/5xx（如 503 no online device）默认就被藏住了
      log('warn', `${tag} 下发失败 HTTP ${resp.status}：${text}`);
      return;
    }
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* 非 JSON，忽略 */ }
    if (parsed && parsed.ok === false) {
      // control 返回 ok:false（如未连接 v4-server），同样提升为可见
      log('warn', `${tag} 被 control 拒绝：${String(parsed.error ?? text)}`);
    } else {
      // 成功保持 debug，避免循环模式每秒刷屏；想看可用 VERBOSE=true 启动
      log('debug', `${tag} 响应 [${resp.status}] ${text}`);
    }
  } catch (e) {
    log('error', `${tag} 下发失败：${(e as Error).message}`);
  }
}

// 尝试触发一个模式：检查独占、输出预算、优先级驱逐；成功则注册占用并下发
function tryFire(mode: ModeName): boolean {
  const now = Date.now();
  if (now < exclusiveUntil && mode !== 'mode4') {
    log('debug', `${mode} 被 mode4 独占期屏蔽`);
    return false;
  }

  const m = config.modes[mode];
  pruneExpired(now);
  const chans = channelsOf(mode);

  for (const ch of chans) {
    let used = channelOutput(ch, now);
    if (used + m.output <= config.output.maxPerChannel) continue;

    // 驱逐该通道上优先级更低、且驱逐后能容纳的活跃项
    const victims = activeFires
      .filter((f) => f.channel === ch && f.priority < m.priority && f.until > now)
      .sort((a, b) => a.priority - b.priority);
    for (const v of victims) {
      if (used + m.output <= config.output.maxPerChannel) break;
      used -= v.output;
      activeFires = activeFires.filter((f) => f !== v);
      log('info', `${mode} 抢占 ${v.mode}（通道 ${ch === 0 ? 'A' : 'B'}）`);
    }
    if (used + m.output > config.output.maxPerChannel) {
      log('debug', `${mode} 被通道 ${ch === 0 ? 'A' : 'B'} 输出预算拒绝（${used}+${m.output}>${config.output.maxPerChannel}）`);
      return false;
    }
  }

  // 同一模式在同一通道的旧占用视为被新一次覆盖（非叠加），先移除
  for (const ch of chans) {
    activeFires = activeFires.filter((f) => !(f.mode === mode && f.channel === ch));
    activeFires.push({ mode, channel: ch, output: m.output, until: now + m.durationMs, priority: m.priority });
  }

  // 死亡独占：duration 期间屏蔽一切其它模式
  if (mode === 'mode4') {
    exclusiveUntil = now + m.durationMs;
    log('info', `mode4 死亡独占 ${m.durationMs}ms，屏蔽其它模式`);
  }

  log('info', `触发 ${mode}：强度 ${m.strength} / 输出 ${m.output} 档 / ${m.durationMs}ms / 通道 ${chans.map((c) => c === 0 ? 'A' : 'B').join('+')}`);
  for (const ch of chans) void sendVibrate(mode, ch);
  return true;
}

// ============ 模式1/2：下降穿越 + 冷却（更严重可打断） ============
function tryFireHigh(mode: HighMode, now: number): void {
  const sev = SEVERITY[mode];
  const elapsed = now - lastHighFireAt;
  if (elapsed < config.cooldownMs && sev <= lastHighSeverity) {
    log('debug', `${mode} 被冷却跳过（严重度 ${sev} <= 上次 ${lastHighSeverity}，间隔 ${elapsed}ms）`);
    return;
  }
  if (elapsed < config.cooldownMs) {
    log('info', `${mode} 更严重，打断冷却立即触发（距上次 ${elapsed}ms）`);
  }
  lastHighFireAt = now;
  lastHighSeverity = sev;
  void tryFire(mode);
}

// ============ 模式4：死亡，一次性，不受冷却，独占 ============
function fireDeath(): void {
  log('info', '死亡触发 mode4（一次性，不受冷却）');
  void tryFire('mode4');
}

// ============ 模式3：濒死循环 ============
function refreshMode3(): void {
  const active = () => state.hpPercent < (config.modes.mode3.hpBelow ?? 20) && !state.dead;
  if (!active()) {
    stopMode3();
    return;
  }
  if (mode3Timer) return;

  const period = config.modes.mode3.periodMs ?? 800;
  log('info', `模式3 启动：濒死颤动 ${config.modes.mode3.strength} 强度，每 ${period}ms 一拍`);

  const beat = () => {
    if (!active()) {
      stopMode3();
      return;
    }
    if (hasHigherPriorityActive('mode3', Date.now())) return; // 被血量高档/死亡抑制
    void tryFire('mode3');
  };

  if (!hasHigherPriorityActive('mode3', Date.now())) beat();
  mode3Timer = setInterval(beat, period);
}

function stopMode3(): void {
  if (mode3Timer) {
    clearInterval(mode3Timer);
    mode3Timer = null;
    log('info', '模式3 停止');
  }
}

// ============ 围攻压力：敌人数达到阈值时循环 ============
function refreshSiege(): void {
  // 关闭时立即停掉任何正在跑的围攻循环，且不再启动
  if (!config.siege.enabled) {
    stopSiege();
    return;
  }
  const active = () => !state.dead && state.enemies >= config.siege.minEnemies;
  if (!active()) {
    stopSiege();
    return;
  }
  if (siegeTimer) return;

  const period = config.modes.siege.periodMs ?? 1000;
  log('info', `围攻压力启动：敌人 ${state.enemies} ≥ ${config.siege.minEnemies}，每 ${period}ms 一拍`);

  const beat = () => {
    if (!active()) {
      stopSiege();
      return;
    }
    if (hasHigherPriorityActive('siege', Date.now())) return;
    void tryFire('siege');
  };

  if (!hasHigherPriorityActive('siege', Date.now())) beat();
  siegeTimer = setInterval(beat, period);
}

function stopSiege(): void {
  if (siegeTimer) {
    clearInterval(siegeTimer);
    siegeTimer = null;
    log('info', '围攻压力停止');
  }
}

// ============ 扩展状态变化检测 ============
function detectExtras(now: number): void {
  if (state.dead) return; // 死亡期间不感知游戏内事件

  if (firstExtrasFrame) {
    firstExtrasFrame = false;
    return;
  }

  // Marks 获得：数量增加
  if (state.marks > lastMarks) {
    log('debug', `Marks 增加 ${lastMarks} → ${state.marks}`);
    void tryFire('marks');
  }
  // 击杀连段：总击杀数增加
  if (state.kills > lastKills) {
    log('debug', `击杀 ${lastKills} → ${state.kills}`);
    void tryFire('kill');
  }
  // Boss 登场：false → true
  if (state.bossActive && !lastBossActive) {
    log('info', 'Boss 登场');
    void tryFire('bossAppear');
  }
  // Boss 击杀：击杀数增加
  if (state.bossKills > lastBossKills) {
    log('info', `Boss 击杀 ${lastBossKills} → ${state.bossKills}`);
    void tryFire('bossKill');
  }
  // Boss 二阶段：false → true
  if (state.bossPhase2 && !lastBossPhase2) {
    log('info', 'Boss 二阶段');
    void tryFire('bossPhase2');
  }

  lastMarks = state.marks;
  lastKills = state.kills;
  lastBossActive = state.bossActive;
  lastBossKills = state.bossKills;
  lastBossPhase2 = state.bossPhase2;
}

// ============ 处理新状态 ============
function onState(next: GameState): void {
  const now = Date.now();
  const risingDeath = next.dead && !lastDead;

  state = { ...next, ts: now };
  lastDead = next.dead;
  log('debug', `状态 HP ${state.hpPercent.toFixed(1)}% dead=${state.dead} marks=${state.marks} kills=${state.kills} boss=${state.bossActive} 敌人=${state.enemies}`);

  // 死亡：停掉所有循环；仅在"活→死"上升沿触发一次
  if (state.dead) {
    stopMode3();
    stopSiege();
    if (risingDeath) fireDeath();
    // 死亡期间屏蔽游戏内事件；复活后不应把死亡前的历史值当作新变化重放
    lastMarks = state.marks;
    lastKills = state.kills;
    lastBossActive = state.bossActive;
    lastBossKills = state.bossKills;
    lastBossPhase2 = state.bossPhase2;
    firstFrame = false;
    firstExtrasFrame = false;
    return;
  }

  // 血量路径：阈值取自各血量模式自己的 hpBelow 配置
  const hp80 = config.modes.mode1.hpBelow ?? 80;
  const hp50 = config.modes.mode2.hpBelow ?? 50;
  const hp20 = config.modes.mode3.hpBelow ?? 20;
  if (state.hpPercent < hp20) {
    refreshMode3();
    firstFrame = false;
  } else {
    stopMode3();
    const h = config.hysteresisPercent;

    if (firstFrame) {
      armed80 = state.hpPercent >= hp80 + h;
      armed50 = state.hpPercent >= hp50 + h;
      firstFrame = false;
    } else {
      if (state.hpPercent >= hp80 + h) armed80 = true;
      if (state.hpPercent >= hp50 + h) armed50 = true;

      if (armed50 && state.hpPercent < hp50) {
        armed50 = false;
        armed80 = false;
        tryFireHigh('mode2', now);
      } else if (armed80 && state.hpPercent < hp80) {
        armed80 = false;
        tryFireHigh('mode1', now);
      }
    }
  }

  // 围攻压力（敌人数）
  refreshSiege();

  // 扩展状态事件（marks / kills / boss）
  detectExtras(now);
}

// ============ HTTP 服务 ============
function authorized(req: Request): boolean {
  if (!config.listen.token) return true;
  return req.headers.get('X-API-Key') === config.listen.token;
}

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function startServer(): void {
  const server = serve({
    hostname: config.listen.host,
    port: config.listen.port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (!authorized(req)) return jsonResponse({ ok: false, error: 'unauthorized' }, 401);

      if (req.method === 'GET' && url.pathname === '/health') {
        return jsonResponse({
          ok: true, service: 'korridor-service', state,
          mode3Running: mode3Timer !== null,
          siegeRunning: siegeTimer !== null,
        });
      }

      if (req.method === 'GET' && url.pathname === '/state') {
        const now = Date.now();
        pruneExpired(now);
        return jsonResponse({
          ok: true,
          state,
          tier: tierOf(state.hpPercent, state.dead),
          armed80, armed50,
          mode3Running: mode3Timer !== null,
          siegeRunning: siegeTimer !== null,
          exclusiveRemainingMs: Math.max(0, exclusiveUntil - now),
          cooldownRemainingMs: Math.max(0, config.cooldownMs - (now - lastHighFireAt)),
          channelOutput: { A: channelOutput(0, now), B: channelOutput(1, now) },
          activeFires,
        });
      }

      if (req.method === 'POST' && url.pathname === '/game-state') {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ ok: false, error: 'invalid json body' }, 400);
        }
        if (!body || typeof body !== 'object') {
          return jsonResponse({ ok: false, error: 'invalid json body' }, 400);
        }
        const hp = Number(body.hpPercent);
        if (!Number.isFinite(hp)) {
          return jsonResponse({ ok: false, error: 'hpPercent must be a number' }, 400);
        }

        // 未携带的扩展字段沿用上一次的值（兼容旧版插件）
        const numOr = (v: unknown, fallback: number): number => {
          const n = Number(v);
          return Number.isFinite(n) ? n : fallback;
        };
        const boolOr = (v: unknown, fallback: boolean): boolean =>
          typeof v === 'boolean' ? v : (v === undefined ? fallback : v === true);

        onState({
          hpPercent: clamp(hp, 0, 100),
          dead: boolOr(body.dead, state.dead),
          marks: Math.max(0, Math.round(numOr(body.marks, state.marks))),
          kills: Math.max(0, Math.round(numOr(body.kills, state.kills))),
          bossActive: boolOr(body.bossActive, state.bossActive),
          bossKills: Math.max(0, Math.round(numOr(body.bossKills, state.bossKills))),
          bossPhase2: boolOr(body.bossPhase2, state.bossPhase2),
          enemies: Math.max(0, Math.round(numOr(body.enemies, state.enemies))),
          ts: numOr(body.ts, Date.now()),
        });
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ ok: false, error: 'not found' }, 404);
    },
  });
  log('info', `HTTP 服务已监听 http://${server.hostname}:${server.port}`);
}

// ============ 启动 ============
config = await loadConfig();
log('info', `配置已加载：control ${config.control.baseUrl}，通道输出上限 ${config.output.maxPerChannel} 档，围攻压力${config.siege.enabled ? `开启（阈值 ${config.siege.minEnemies} 敌人）` : '已关闭'}`);
log('info', `血量阈值 轻伤${config.modes.mode1.hpBelow}/中伤${config.modes.mode2.hpBelow}/濒死${config.modes.mode3.hpBelow}%，迟滞 ${config.hysteresisPercent}%，冷却 ${config.cooldownMs}ms（更严重可打断）`);
startServer();
