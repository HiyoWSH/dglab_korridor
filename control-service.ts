import QRCode from 'qrcode';

// ============ 配置类型 ============
type OpName = 'temp' | 'pulse' | 'add' | 'reduce' | 'reset' | 'clear' | 'wait';

interface TimelineStep {
  at: number;          // 相对本轮起点的毫秒偏移
  op: OpName;          // 动作类型
  channel?: 0 | 1;     // 通道，默认 A
  value?: number;      // 强度值 / 增减步长
  duration?: number;   // 毫秒时长（temp / pulse）
  frames?: string[];   // 波形帧数组（pulse）
}

interface ApiConfig {
  enabled: boolean;            // 是否启用 HTTP 接口
  host: string;                // 监听地址，本机自用建议 127.0.0.1
  port: number;                // 监听端口
  token: string;               // API Key，留空则不鉴权
  waitTimeoutMs: number;       // 等待 APP 回执的超时
}

interface ControlConfig {
  v4Url: string;               // 控制方连接的 WebSocket 地址
  advertiseUrl?: string;       // 二维码给手机用的地址（局域网/WSS），默认同 v4Url
  api?: ApiConfig;             // HTTP 对外接口（可选）
  timelineEnabled: boolean;    // 是否按 timeline 自动下发，默认 true；false 时只保留 HTTP 接口
  loop: boolean;               // 是否循环播放
  loopDelayMs: number;         // 每轮结束后的等待
  timeline: TimelineStep[];    // 动作序列
}

// ============ 连接状态 ============
interface Waifu {
  devices: Set<string>;        // 该 APP 上报的设备 slotId
}

const CONFIG_PATH = process.argv[2] || `${import.meta.dir}/control.config.json`;
const RECONNECT_MS = 3000;

let config: ControlConfig;
let ws: WebSocket | null = null;
let controllerId = '';
let stopping = false;
let reqSeq = 0;
const waifus = new Map<string, Waifu>();   // 被控方 clientId -> 设备集合
const cycleTimers: Timer[] = [];
let cycleTimer: Timer | null = null;

// HTTP 请求的回执等待表：reqId -> { resolve, timer }
interface PendingCall {
  resolve: (resp: Record<string, unknown>) => void;
  timer: Timer;
}
const pending = new Map<string, PendingCall>();

// ============ 日志 ============
function log(level: 'info' | 'warn' | 'error' | 'debug', msg: string): void {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[CTRL ${ts}] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'debug') {
    if (Bun.env.VERBOSE === 'true') console.debug(line);
  } else console.log(line);
}

// ============ 配置 ============
async function loadConfig(): Promise<ControlConfig> {
  let raw: string;
  try {
    raw = await Bun.file(CONFIG_PATH).text();
  } catch {
    throw new Error(`读取配置失败: ${CONFIG_PATH}`);
  }
  let parsed: ControlConfig;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`配置不是合法 JSON: ${(e as Error).message}`);
  }
  const t = parsed.timeline;
  if (!Array.isArray(t)) throw new Error('配置 timeline 必须是数组');
  for (const s of t) {
    if (typeof s.at !== 'number' || s.at < 0) throw new Error('每个步骤的 at 必须是非负毫秒数');
    if (!['temp', 'pulse', 'add', 'reduce', 'reset', 'clear', 'wait'].includes(s.op)) {
      throw new Error(`未知动作 op=${s.op}`);
    }
  }
  if (typeof parsed.v4Url !== 'string' || !parsed.v4Url) throw new Error('缺少 v4Url');
  parsed.timelineEnabled = parsed.timelineEnabled !== false;
  parsed.loop = parsed.loop !== false;
  parsed.loopDelayMs = Number.isFinite(parsed.loopDelayMs) && parsed.loopDelayMs >= 0 ? parsed.loopDelayMs : 2000;

  // API 配置：默认关闭，给合理默认值
  const a = parsed.api;
  if (a && typeof a === 'object') {
    a.enabled = a.enabled === true;
    a.host = typeof a.host === 'string' && a.host ? a.host : '127.0.0.1';
    a.port = Number.isInteger(a.port) && a.port > 0 && a.port < 65536 ? a.port : 9997;
    a.token = typeof a.token === 'string' ? a.token : '';
    a.waitTimeoutMs = Number.isFinite(a.waitTimeoutMs) && a.waitTimeoutMs > 0 ? a.waitTimeoutMs : 5000;
  } else {
    parsed.api = { enabled: false, host: '127.0.0.1', port: 9997, token: '', waitTimeoutMs: 5000 };
  }
  return parsed;
}

// ============ RPC ============
function nextReqId(): string { return `ctrl-${Date.now()}-${++reqSeq}`; }

function opFrame(reqId: string, m: string, data?: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { t: 'req', reqId, m };
  if (data !== undefined) o.data = data;
  return o;
}

function sendTo(clientId: string, data: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'message', clientId, data }));
}

function collectTargets(): Array<{ clientId: string; slot: string }> {
  const out: Array<{ clientId: string; slot: string }> = [];
  for (const [clientId, w] of waifus) {
    for (const slot of w.devices) out.push({ clientId, slot });
  }
  return out;
}

// ============ 二维码 ============
async function renderQR(): Promise<void> {
  if (!controllerId) return;
  const base = (config.advertiseUrl || config.v4Url).trim().replace(/\/+$/, '');
  const appSocketUrl = `${base}?tid=${controllerId}`;
  const pairUrl = `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(appSocketUrl)}`;

  log('info', `控制方 ID = ${controllerId}`);
  if (!config.advertiseUrl && /127\.0\.0\.1|localhost/.test(base)) {
    log('warn', 'v4Url 指向本机，手机无法扫码连接；请在配置里设置 advertiseUrl 为电脑局域网 IP');
  }
  log('info', `APP 扫码地址 = ${appSocketUrl}`);
  try {
    const art = await QRCode.toString(pairUrl, { type: 'terminal', small: true, margin: 1 });
    console.log('\n' + art + '\n');
  } catch (e) {
    log('warn', `二维码生成失败，请手动用上面的链接: ${(e as Error).message}`);
  }
  log('info', '等待 APP 扫码接入…');
}

// ============ 帧处理 ============
function handleFrame(raw: string): void {
  let frame: Record<string, unknown>;
  try { frame = JSON.parse(raw); } catch { return; }

  switch (frame.type) {
    case 'hello':
      controllerId = String(frame.clientId ?? '');
      log('info', `已连接 v4-server，拿到控制方 ID`);
      void renderQR();
      break;

    case 'client_attached': {
      const id = String(frame.clientId ?? '');
      waifus.set(id, { devices: new Set() });
      log('info', `APP 接入: ${id}`);
      sendTo(id, opFrame(nextReqId(), 'devices.get'));
      break;
    }

    case 'client_disconnected': {
      const id = String(frame.clientId ?? '');
      waifus.delete(id);
      log('info', `APP 断开: ${id}`);
      break;
    }

    case 'message': {
      const data = frame.data;
      if (!data || typeof data !== 'object') return;
      const d = data as Record<string, unknown>;
      const clientId = String(frame.clientId ?? '');

      // RPC 回执：匹配 HTTP 请求等待表（可能在 waifus 记录之前到达）
      if (d.t === 'resp' || d.t === 'error') {
        const reqId = String(d.reqId ?? '');
        const p = pending.get(reqId);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(reqId);
          p.resolve(d);
        }
        return;
      }

      const w = waifus.get(clientId);
      if (!w) return;
      if (d.ev === 'devices.snapshot' || d.ev === 'devices.patch') {
        const arr = (Array.isArray(d.devices) ? d.devices : []).concat(
          Array.isArray(d.added) ? d.added : [],
        ) as Array<Record<string, unknown>>;
        for (const dev of arr) {
          if (typeof dev.slotId === 'string') w.devices.add(dev.slotId);
        }
        if (Array.isArray(d.removed)) {
          for (const slot of d.removed) if (typeof slot === 'string') w.devices.delete(slot);
        }
        log('info', `设备更新 ${clientId}: ${[...w.devices].join(', ') || '(空)'}`);
      }
      break;
    }

    case 'idle_timeout':
      log('warn', '控制方空闲超时（无 APP 接入）');
      break;

    case 'error':
      log('warn', `服务端错误: ${JSON.stringify(frame)}`);
      break;

    default:
      break;
  }
}

// ============ 时间线调度 ============
function fireStep(step: TimelineStep): void {
  if (step.op === 'wait') return;
  const targets = collectTargets();
  if (targets.length === 0) {
    log('debug', `跳过 ${step.op}: 当前无在线设备`);
    return;
  }
  const ch = step.channel ?? 0;
  const value = Number.isFinite(step.value) ? Number(step.value) : 0;
  const duration = Number.isFinite(step.duration) ? Number(step.duration) : 0;

  for (const { clientId, slot } of targets) {
    let data: Record<string, unknown> | undefined;
    switch (step.op) {
      case 'temp':
        data = { s: slot, t: 4, c: ch, p: 1, v: value, d: duration };
        break;
      case 'add':
      case 'reduce':
        data = { s: slot, t: 3, c: ch, p: 1, v: step.op === 'add' ? Math.abs(value) : -Math.abs(value) };
        break;
      case 'pulse':
        data = { s: slot, t: 0, c: ch, p: 1, d: duration, v: Array.isArray(step.frames) ? step.frames : [] };
        break;
      case 'reset':
        data = { s: slot, t: 7, c: ch, p: 1, v: 0 };
        break;
      case 'clear':
        data = undefined; // device.op.clear 单独处理
        break;
    }
    if (step.op === 'clear') {
      sendTo(clientId, opFrame(nextReqId(), 'device.op.clear', { s: slot, c: ch }));
    } else if (data) {
      sendTo(clientId, opFrame(nextReqId(), 'device.op', data));
    }
  }
  log('info', `触发 ${step.op} → ${targets.length} 个设备 (通道 ${ch === 0 ? 'A' : 'B'})`);
}

function clearCycleTimers(): void {
  while (cycleTimers.length) clearTimeout(cycleTimers.pop()!);
  if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null; }
}

function runCycle(): void {
  if (stopping || !config) return;
  if (!config.timelineEnabled) {
    log('debug', '时间线下发已停用（timelineEnabled=false）');
    return;
  }
  clearCycleTimers();
  for (const step of config.timeline) {
    const timer = setTimeout(() => fireStep(step), step.at);
    cycleTimers.push(timer);
  }
  const lastAt = Math.max(...config.timeline.map((s) => s.at));
  const wait = Math.max(0, lastAt) + config.loopDelayMs;
  cycleTimer = setTimeout(() => {
    cycleTimer = null;
    if (config.loop) runCycle();
    else log('info', '时间线播放完毕（未开启循环）');
  }, wait);
  log('info', `开始一轮时间线（${config.timeline.length} 步 / ${Math.round(wait / 1000)}s）`);
}

// ============ HTTP API ============
interface ApiTarget { clientId: string; slot: string }

// /vibrate 默认波形：持续满输出，提供脉冲节奏（每字节 0x64=100）
const DEFAULT_VIBRATE_FRAMES = ['6464646464646464'];

// 从请求参数中选择目标设备：优先按 target/slot 指定，否则取第一个在线设备
function pickTarget(body: Record<string, unknown>): ApiTarget | null {
  const all = collectTargets();
  if (all.length === 0) return null;
  let pool = all;
  if (typeof body.target === 'string' && body.target) {
    pool = pool.filter((t) => t.clientId === body.target);
    if (pool.length === 0) return null;
  }
  if (typeof body.slot === 'string' && body.slot) {
    const bySlot = pool.filter((t) => t.slot === body.slot);
    if (bySlot.length) pool = bySlot;
  }
  return pool[0] ?? null;
}

function deviceList(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [clientId, w] of waifus) {
    out.push({ clientId, devices: [...w.devices] });
  }
  return out;
}

// 下发一条 RPC；wait=true 时挂起等待 APP 回执（同步语义），否则立即返回
function sendRpcWait(
  m: string,
  data: Record<string, unknown>,
  target: ApiTarget,
  wait: boolean,
): Promise<Record<string, unknown>> {
  const reqId = nextReqId();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, error: 'not connected to v4-server', reqId, target });
  }
  if (!wait) {
    sendTo(target.clientId, opFrame(reqId, m, data));
    return Promise.resolve({ ok: true, accepted: true, reqId, target });
  }
  return new Promise((resolve) => {
    const timeoutMs = config.api?.waitTimeoutMs ?? 5000;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({ ok: false, error: 'timeout', reqId, target, timeoutMs });
    }, timeoutMs);
    pending.set(reqId, {
      timer,
      resolve: (resp: Record<string, unknown>) => {
        const error = resp.error ? String(resp.error) : undefined;
        resolve({
          ok: !error,
          reqId,
          target,
          ...(error ? { error } : {}),
          result: resp.result ?? null,
        });
      },
    });
    sendTo(target.clientId, opFrame(reqId, m, data));
  });
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-api-key',
    },
  });
}

let apiServer: ReturnType<typeof Bun.serve> | null = null;

function startApi(): void {
  const api = config.api;
  if (!api?.enabled) { log('info', 'HTTP API 未启用（配置 api.enabled=false）'); return; }
  apiServer = Bun.serve({
    hostname: api.host,
    port: api.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'OPTIONS') return jsonResponse({});
      if (api.token && req.headers.get('x-api-key') !== api.token) {
        return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
      }

      if (req.method === 'GET' && url.pathname === '/devices') {
        return jsonResponse({ ok: true, controllerId, devices: deviceList() });
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return jsonResponse({ ok: true, connected: !!ws, controllerId, deviceCount: collectTargets().length });
      }
      if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'not found' }, 404);

      let body: Record<string, unknown>;
      try { body = (await req.json()) as Record<string, unknown>; }
      catch { return jsonResponse({ ok: false, error: 'invalid json body' }, 400); }
      if (!body || typeof body !== 'object') return jsonResponse({ ok: false, error: 'invalid json body' }, 400);

      const wait = body.wait !== false;
      const target = pickTarget(body);
      if (!target) return jsonResponse({ ok: false, error: 'no online device' }, 503);
      const ch = body.channel === 1 ? 1 : 0;
      const duration = Number.isFinite(Number(body.duration)) && Number(body.duration) >= 0
        ? Number(body.duration) : 1000;

      if (url.pathname === '/vibrate') {
        const strength = Number(body.strength);
        if (!Number.isFinite(strength)) return jsonResponse({ ok: false, error: 'strength must be a number' }, 400);

        // 1) 强度(t:4)：APP 不发回执，直接下发，到时自动归零
        const strengthData = { s: target.slot, t: 4, c: ch, p: 1, v: strength, d: duration };
        sendTo(target.clientId, opFrame(nextReqId(), 'device.op', strengthData));

        // 2) 波形(t:0)：提供脉冲节奏，APP 会回 completed，等待它作为同步结果
        const frames = Array.isArray(body.frames) && body.frames.length > 0
          ? body.frames : DEFAULT_VIBRATE_FRAMES;
        const pulseData = { s: target.slot, t: 0, c: ch, p: 1, d: duration, v: frames };
        return jsonResponse(await sendRpcWait('device.op', pulseData, target, wait));
      }

      if (url.pathname === '/pulse') {
        if (!Array.isArray(body.frames)) return jsonResponse({ ok: false, error: 'frames must be an array' }, 400);
        const data = { s: target.slot, t: 0, c: ch, p: 1, d: duration, v: body.frames };
        return jsonResponse(await sendRpcWait('device.op', data, target, wait));
      }

      if (url.pathname === '/stop') {
        const data = { s: target.slot, c: ch };
        return jsonResponse(await sendRpcWait('device.op.clear', data, target, wait));
      }

      if (url.pathname === '/command') {
        if (typeof body.m !== 'string' || !body.m) return jsonResponse({ ok: false, error: 'm must be a string' }, 400);
        const data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
        return jsonResponse(await sendRpcWait(body.m, data, target, wait));
      }

      return jsonResponse({ ok: false, error: 'not found' }, 404);
    },
  });
  log('info', `HTTP API 已启动 http://${api.host}:${api.port}  token=${api.token ? '已启用' : '未启用'}`);
}

// ============ 连接 ============
function connect(): void {
  if (stopping) return;
  log('info', `连接 ${config.v4Url} …`);
  let sock: WebSocket;
  try {
    sock = new WebSocket(config.v4Url);
  } catch (e) {
    log('error', `创建连接失败: ${(e as Error).message}`);
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.onopen = () => {
    log('info', 'WebSocket 已打开，等待 hello');
    runCycle();
  };
  sock.onmessage = (ev) => handleFrame(String(ev.data));
  sock.onerror = () => log('warn', 'WebSocket 错误');
  sock.onclose = (ev) => {
    if (ws === sock) ws = null;
    controllerId = '';
    waifus.clear();
    clearCycleTimers();
    // 断线时立即终结所有等待中的 HTTP 请求，避免挂到超时
    for (const [reqId, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'disconnected' });
      pending.delete(reqId);
    }
    if (stopping) return;
    log('warn', `连接断开 code=${ev.code} reason=${ev.reason || '-'}`);
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  setTimeout(() => { if (!stopping) connect(); }, RECONNECT_MS);
}

// ============ 启动 / 退出 ============
async function main(): Promise<void> {
  config = await loadConfig();
  log('info', `配置加载完成: ${config.timeline.length} 步 / 时间线下发=${config.timelineEnabled ? '启用' : '停用'} / 循环=${config.loop}`);
  startApi();
  connect();
}

process.on('SIGINT', () => {
  stopping = true;
  clearCycleTimers();
  for (const [reqId, p] of pending) { clearTimeout(p.timer); pending.delete(reqId); }
  if (apiServer) { try { apiServer.stop(); } catch {} }
  if (ws && ws.readyState <= WebSocket.OPEN) { try { ws.close(); } catch {} }
  log('info', '已退出');
  process.exit(0);
});

main().catch((e) => {
  log('error', (e as Error).message);
  process.exit(1);
});
