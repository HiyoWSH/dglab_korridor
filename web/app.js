(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    wsUrl: $('wsUrl'), btnConnect: $('btnConnect'), btnDisconnect: $('btnDisconnect'),
    statusDot: $('statusDot'), statusText: $('statusText'), targetId: $('targetId'),
    statusPill: $('statusPill'), connBadge: $('connBadge'), headClients: $('headClients'), uptime: $('uptime'),
    qrcode: $('qrcode'), pairUrl: $('pairUrl'), btnCopyPair: $('btnCopyPair'),
    clientList: $('clientList'), clientCount: $('clientCount'),
    deviceList: $('deviceList'), deviceHint: $('deviceHint'),
    selClient: $('selClient'), selSlot: $('selSlot'), selChannel: $('selChannel'), chSegment: $('chSegment'),
    selPreset: $('selPreset'), pulseFrames: $('pulseFrames'), pulseDuration: $('pulseDuration'),
    tempSlider: $('tempSlider'), tempValue: $('tempValue'), tempDuration: $('tempDuration'),
    log: $('log'), btnClearLog: $('btnClearLog'),
    logFilters: $('logFilters'), logSearch: $('logSearch'), logAuto: $('logAuto'), logExport: $('logExport'),
    recordCount: $('recordCount'), btnRecord: $('btnRecord'), btnStopRecord: $('btnStopRecord'),
    btnReplay: $('btnReplay'), btnClearRecord: $('btnClearRecord'),
    toastWrap: $('toastWrap'),
  };

  let ws = null;
  let targetId = '';
  let connectedAt = 0;
  let uptimeTimer = null;
  const clients = new Map(); // appClientId -> { devices: Map<slotId, info>, strengths: {0:..,1:..} }
  let reqSeq = 0;
  let recording = false;
  let recordStart = 0;
  let records = []; // { t, clientId, data }
  let replaying = false;

  // 脚本播放:A/B 两通道独立状态
  // scriptChannels[0|1] = { script, playing, reqId, panel }
  const scriptChannels = [0, 1].map((ch) => ({
    ch,
    panel: document.querySelector(`.script-panel[data-channel="${ch}"]`),
    script: null,
    playing: false,
    reqId: '',
    startedAt: 0,
    timer: null,
  }));

  // 官方内置波形数据(dglab-kit):负鼠 OVC / 郊狼 COYOTE 原版帧,已验证可用
  const PRESETS = {
    steady: '["6464646464646464","6464646464646464"]',
    pinpoint: '["0A0A0A0A64646464","0A0A0A0A64646464","0A0A0A0A00000000"]',
    beat: '["0A0A0A0A00000000","0A0A0A0A21212121","0A0A0A0A42424242","0A0A0A0A64646464","0A0A0A0A00000000","0A0A0A0A64646464","0A0A0A0A00000000","0A0A0A0A00000000"]',
    candy: '["0A0A0A0A64646464","0A0A0A0A00000000","0A0A0A0A64646464","0A0A0A0A00000000","0A0A0A0A64646464","0A0A0A0A00000000","0A0A0A0A64646464","0A0A0A0A00000000"]',
    breath: '["0A0A0A0A00000000","0A0A0A0A14141414","0A0A0A0A28282828","0A0A0A0A3C3C3C3C","0A0A0A0A50505050","0A0A0A0A64646464","0A0A0A0A50505050","0A0A0A0A3C3C3C3C","0A0A0A0A28282828","0A0A0A0A14141414","0A0A0A0A00000000"]',
  };

  // ---------- Toast 反馈 ----------
  function toast(msg, type) {
    if (!els.toastWrap) return;
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    const icon = type === 'err'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>';
    t.innerHTML = icon + '<span>' + escapeHtml(msg) + '</span>';
    els.toastWrap.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 2400);
  }

  // ---------- 日志 ----------
  let logFilter = 'all';
  function log(kind, msg) {
    const div = document.createElement('div');
    div.className = 'line ' + kind;
    div.dataset.kind = kind;
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    div.innerHTML = `<span class="t">[${ts}]</span> <span class="${kind}">${escapeHtml(msg)}</span>`;
    els.log.appendChild(div);
    applyLogFilter(div);
    if (els.logAuto.checked) els.log.scrollTop = els.log.scrollHeight;
  }
  function applyLogFilter(div) {
    const q = (els.logSearch.value || '').trim().toLowerCase();
    const kindOk = logFilter === 'all' || div.dataset.kind === logFilter;
    const textOk = !q || div.textContent.toLowerCase().includes(q);
    div.classList.toggle('hidden', !(kindOk && textOk));
  }
  function refreshLogFilter() { els.log.querySelectorAll('.line').forEach(applyLogFilter); }
  function exportLog() {
    const lines = [...els.log.querySelectorAll('.line:not(.hidden)')].map((n) => n.textContent);
    if (!lines.length) { toast('没有可导出的日志', 'err'); return; }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dglab-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`已导出 ${lines.length} 条日志`, 'ok');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 连接 ----------
  const WS_URL_KEY = 'dglab.wsUrl';
  function loadSavedUrl() {
    try { return localStorage.getItem(WS_URL_KEY) || ''; } catch { return ''; }
  }
  function saveUrl(url) {
    try { localStorage.setItem(WS_URL_KEY, url); } catch {}
  }
  function defaultUrl() {
    const saved = loadSavedUrl();
    if (saved) return saved;
    const prefix = window.WS_PREFIX || '/';
    const safePrefix = (typeof prefix === 'string' && prefix.startsWith('/')) ? prefix : '/';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}${safePrefix === '/' ? '' : safePrefix}`;
  }
  els.wsUrl.value = defaultUrl();

  function connect() {
    const url = els.wsUrl.value.trim();
    if (!url) { log('err', '请输入 WebSocket 地址'); return; }
    let wsUrl;
    try { wsUrl = new URL(url); } catch { log('err', '地址格式无效'); return; }
    if (wsUrl.protocol !== 'ws:' && wsUrl.protocol !== 'wss:') { log('err', '协议必须是 ws 或 wss'); return; }
    saveUrl(url);
    log('evt', '地址已保存到浏览器');

    disconnect(true);
    clients.clear(); renderClients(); renderDevices();
    log('evt', `正在连接 ${url} ...`);
    try { ws = new WebSocket(url); } catch (e) { log('err', '创建连接失败: ' + e.message); return; }

    ws.onopen = () => {
      connectedAt = Date.now();
      startUptime();
      setStatus(true, '已连接,等待配对');
      els.btnConnect.disabled = true; els.btnDisconnect.disabled = false;
      log('evt', 'WebSocket 已打开,等待 hello 帧');
      toast('连接成功', 'ok');
    };
    ws.onmessage = (ev) => handleFrame(ev.data);
    ws.onerror = () => log('err', 'WebSocket 错误(请检查地址与网络)');
    ws.onclose = (ev) => {
      stopUptime();
      setStatus(false, '已断开');
      els.btnConnect.disabled = false; els.btnDisconnect.disabled = true;
      targetId = ''; els.targetId.textContent = '-';
      els.qrcode.innerHTML = '<span class="qr-placeholder">连接后显示配对二维码</span>';
      els.pairUrl.value = ''; els.btnCopyPair.disabled = true;
      clients.clear(); renderClients(); renderDevices();
      for (const sc of scriptChannels) {
        if (sc.playing) { sc.playing = false; sc.reqId = ''; clearScriptTimer(sc); setScriptProgress(sc, 0); setScriptStatus(sc, '', '连接已断开'); updateScriptButtons(sc); }
      }
      log('evt', `连接关闭 code=${ev.code} reason=${ev.reason || '-'}`);
    };
  }

  function startUptime() {
    stopUptime();
    const tick = () => {
      const s = Math.floor((Date.now() - connectedAt) / 1000);
      els.uptime.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    uptimeTimer = setInterval(tick, 1000);
  }
  function stopUptime() {
    if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; }
    els.uptime.textContent = '--:--';
  }

  function disconnect(silent) {
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try { ws.close(); } catch {}
    }
    ws = null;
    if (!silent) log('evt', '已主动断开');
  }

  function setStatus(on, text) {
    els.statusDot.classList.toggle('on', on);
    if (els.statusPill) els.statusPill.classList.toggle('on', on);
    els.statusText.textContent = text;
    if (els.connBadge) {
      els.connBadge.textContent = on ? (clients.size ? `${clients.size} 个设备在线` : '在线') : '未连接';
      els.connBadge.classList.toggle('live', on);
    }
  }

  // ---------- 收发帧 ----------
  function handleFrame(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { log('err', '收到非 JSON 帧: ' + raw); return; }
    log('in', '← ' + raw);

    switch (frame.type) {
      case 'hello':
        targetId = frame.clientId;
        els.targetId.textContent = targetId;
        setStatus(true, '已连接,等待 APP 接入');
        renderQR();
        break;
      case 'client_attached':
        clients.set(frame.clientId, { devices: new Map(), strengths: {} });
        renderClients();
        setStatus(true, `已连接 · ${clients.size} 个 APP`);
        log('evt', `APP 接入: ${frame.clientId}`);
        requestDevices(frame.clientId);
        break;
      case 'client_disconnected':
        clients.delete(frame.clientId);
        renderClients(); renderDevices();
        setStatus(true, `已连接 · ${clients.size} 个 APP`);
        log('evt', `APP 断开: ${frame.clientId}`);
        break;
      case 'controller_disconnected':
        log('err', '控制方被服务端关闭');
        break;
      case 'message':
        handleAppMessage(frame.clientId, frame.data);
        break;
      case 'error':
        log('err', `错误 ${frame.code || ''} ${frame.message || ''}`);
        break;
      case 'heartbeat': case 'pong':
        break;
      default:
        break;
    }
  }

  function send(data, targetClient) {
    const clientId = targetClient || els.selClient.value;
    if (!ws || ws.readyState !== WebSocket.OPEN) { log('err', '未连接,无法发送'); return false; }
    if (!clientId) { log('err', '请先选择目标 APP'); return false; }
    const frame = { type: 'message', clientId, data };
    const text = JSON.stringify(frame);
    ws.send(text);
    log('out', '→ ' + text);
    if (recording) records.push({ t: Date.now() - recordStart, clientId, data });
    return true;
  }

  function nextReqId() { return `req-${Date.now()}-${++reqSeq}`; }

  // ---------- APP 消息解析 ----------
  function handleAppMessage(clientId, data) {
    if (!data || typeof data !== 'object') return;
    const client = clients.get(clientId);
    // 设备快照 / 增量
    if (data.ev === 'devices.snapshot' || data.ev === 'devices.patch') {
      if (!client) return;
      if (Array.isArray(data.devices)) data.devices.forEach((d) => client.devices.set(d.slotId, d));
      if (Array.isArray(data.added)) data.added.forEach((d) => client.devices.set(d.slotId, d));
      if (Array.isArray(data.removed)) data.removed.forEach((s) => client.devices.delete(s));
      renderDevices();
      log('evt', `设备更新 ${clientId}: ${[...client.devices.keys()].join(', ') || '(空)'}`);
    }
    // 槽位强度增量
    else if (data.ev === 'slots.patch') {
      if (client && Array.isArray(data.slots)) {
        data.slots.forEach((s) => {
          if (s.props && typeof s.props.strength === 'number') client.strengths[s.slotId] = s.props.strength;
        });
        renderDevices();
      }
    }
    // 自定义动作
    else if (data.ev === 'custom.action') {
      log('evt', `APP 动作 ${clientId}: action=${data.action}`);
    }
    // RPC 响应
    else if (data.t === 'resp') {
      log('evt', `响应 reqId=${data.reqId} ${data.error ? '错误:' + data.error : 'OK'}`);
      // 脚本播放:匹配到本通道的 reqId 即视为播放结束
      for (const sc of scriptChannels) {
        if (sc.playing && sc.reqId && data.reqId === sc.reqId) {
          sc.playing = false; sc.reqId = '';
          clearScriptTimer(sc);
          if (!data.error) setScriptProgress(sc, 1);
          const err = data.error ? ` · 错误:${data.error}` : '';
          setScriptStatus(sc, data.error ? 'error' : 'done', `播放完毕${err}`);
          updateScriptButtons(sc);
          if (data.error) { log('err', `通道 ${sc.ch === 0 ? 'A' : 'B'} 脚本失败:${data.error}`); toast('脚本播放失败:' + data.error, 'err'); }
          else toast(`通道 ${sc.ch === 0 ? 'A' : 'B'} 播放完毕`, 'ok');
        }
      }
    }
  }

  function requestDevices(clientId) {
    send({ t: 'req', reqId: nextReqId(), m: 'devices.get' }, clientId);
  }

  // ---------- 渲染 ----------
  function renderQR() {
    if (!targetId) return;
    const wsBase = els.wsUrl.value.trim().replace(/\/+$/, '');
    const appSocketUrl = `${wsBase}?tid=${targetId}`;
    const pairUrl = `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(appSocketUrl)}`;
    els.pairUrl.value = pairUrl;
    els.btnCopyPair.disabled = false;
    els.qrcode.innerHTML = '';
    try {
      new QRCode(els.qrcode, { text: pairUrl, width: 160, height: 160, colorDark: '#1f2430', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    } catch (e) {
      els.qrcode.innerHTML = '<span class="qr-placeholder">二维码生成失败</span>';
      log('err', '二维码生成失败: ' + e.message);
    }
  }

  function renderClients() {
    els.clientCount.textContent = clients.size;
    if (els.headClients) els.headClients.textContent = clients.size;
    if (els.connBadge && els.statusPill.classList.contains('on')) {
      els.connBadge.textContent = clients.size ? `${clients.size} 个设备在线` : '在线';
    }
    els.clientList.innerHTML = '';
    if (clients.size === 0) {
      els.clientList.innerHTML = '<li class="empty">暂无 APP 接入，扫码后自动出现</li>';
    } else {
      for (const id of clients.keys()) {
        const li = document.createElement('li');
        li.dataset.id = id;
        li.classList.toggle('selected', els.selClient.value === id);
        li.innerHTML = `<span class="lead-dot"></span><span class="cid">${escapeHtml(id)}</span><span class="tail">${(clients.get(id).devices.size)} 设备</span>`;
        li.addEventListener('click', () => { els.selClient.value = id; renderClients(); renderDevices(); });
        els.clientList.appendChild(li);
      }
    }
    // 更新下拉
    const cur = els.selClient.value;
    els.selClient.innerHTML = '<option value="">-- 未接入 --</option>';
    for (const id of clients.keys()) {
      const o = document.createElement('option'); o.value = id; o.textContent = id;
      els.selClient.appendChild(o);
    }
    if (clients.has(cur)) els.selClient.value = cur;
    else if (clients.size) els.selClient.value = clients.keys().next().value;
  }

  function renderDevices() {
    const id = els.selClient.value;
    els.deviceList.innerHTML = '';
    const client = clients.get(id);
    // slot 下拉
    const curSlot = els.selSlot.value;
    els.selSlot.innerHTML = '<option value="">-- 无设备 --</option>';
    if (!client || client.devices.size === 0) {
      els.deviceList.innerHTML = '<li class="empty">暂无设备</li>';
      els.deviceHint.textContent = client ? '' : '(选中 APP 后显示)';
      return;
    }
    els.deviceHint.textContent = `(${client.devices.size} 个)`;
    for (const [slotId, info] of client.devices) {
      const o = document.createElement('option'); o.value = slotId; o.textContent = `${slotId} · ${info.name || info.type || ''}`;
      els.selSlot.appendChild(o);
      const li = document.createElement('li');
      li.dataset.slot = slotId;
      const strength = client.strengths[slotId];
      const pct = strength != null ? Math.min(100, Math.max(0, (strength / 200) * 100)) : 0;
      li.innerHTML = `<div class="dev-info"><div class="dev-name">${escapeHtml(slotId)} <span class="muted">${escapeHtml(info.name || info.type || '')}</span></div>` +
        `<div class="dev-progress"><i style="width:${pct}%"></i></div></div>` +
        `<span class="strength">${strength != null ? escapeHtml(String(strength)) : '-'}</span>`;
      els.deviceList.appendChild(li);
    }
    if ([...client.devices.keys()].includes(curSlot)) els.selSlot.value = curSlot;
  }

  // ---------- 控制指令 ----------
  function opFrame(reqId, m, data) {
    const o = { t: 'req', reqId, m };
    if (data !== undefined) o.data = data;
    return o;
  }

  function doOperation(op) {
    const clientId = els.selClient.value;
    const slot = els.selSlot.value;
    const channel = Number(els.selChannel.value);
    if (!clientId) { log('err', '请先选择目标 APP'); return; }

    switch (op) {
      case 'add': case 'reduce': {
        if (!slot) { log('err', '请先选择设备 slot'); return; }
        const step = Math.abs(parseInt($('intStep').value, 10) || 5);
        const v = op === 'add' ? step : -step;
        send(opFrame(nextReqId(), 'device.op', { s: slot, t: 3, c: channel, p: 1, v }), clientId);
        break;
      }
      case 'temp': {
        if (!slot) { log('err', '请先选择设备 slot'); return; }
        const v = parseInt($('tempValue').value, 10);
        const d = parseInt($('tempDuration').value, 10);
        if (!Number.isFinite(v)) { log('err', '临时强度数值无效'); return; }
        send(opFrame(nextReqId(), 'device.op', { s: slot, t: 4, c: channel, p: 1, v, d: Number.isFinite(d) ? d : 0 }), clientId);
        break;
      }
      case 'reset': {
        if (!slot) { log('err', '请先选择设备 slot'); return; }
        send(opFrame(nextReqId(), 'device.op', { s: slot, t: 7, c: channel, p: 1, v: 0 }), clientId);
        break;
      }
      case 'clearChannel': case 'clearAll': {
        const data = slot ? { s: slot, c: channel } : undefined;
        if (op === 'clearAll') send(opFrame(nextReqId(), 'device.op.clear'), clientId);
        else {
          if (!slot) { log('err', '请先选择设备 slot'); return; }
          send(opFrame(nextReqId(), 'device.op.clear', data), clientId);
        }
        break;
      }
      case 'pulse': {
        if (!slot) { log('err', '请先选择设备 slot'); return; }
        let frames;
        try { frames = JSON.parse(els.pulseFrames.value.trim()); } catch { log('err', '帧数组不是合法 JSON'); return; }
        if (!Array.isArray(frames)) { log('err', '帧必须是数组'); return; }
        const d = parseInt(els.pulseDuration.value, 10);
        send(opFrame(nextReqId(), 'device.op', { s: slot, t: 0, c: channel, p: 1, d: Number.isFinite(d) ? d : 0, v: frames }), clientId);
        break;
      }
      case 'raw': {
        const text = $('rawData').value.trim();
        if (!text) { log('err', '原始 RPC 内容为空'); return; }
        let data;
        try { data = JSON.parse(text); } catch { log('err', '原始 RPC 不是合法 JSON'); return; }
        if (!data.reqId) data.reqId = nextReqId();
        send(data, clientId);
        break;
      }
    }
  }

  // ---------- 脚本播放 ----------
  function setScriptStatus(sc, cls, text) {
    const el = sc.panel.querySelector('.script-status');
    el.className = 'script-status' + (cls ? ' ' + cls : '');
    el.textContent = text;
  }
  function setScriptProgress(sc, ratio) {
    const bar = sc.panel.querySelector('.script-progress i');
    if (bar) bar.style.width = Math.max(0, Math.min(100, ratio * 100)) + '%';
    const time = sc.panel.querySelector('.script-time');
    if (time) {
      const total = sc.script ? (sc.script.meta.durationMs || 0) / 1000 : 0;
      const cur = total * Math.max(0, Math.min(1, ratio));
      time.textContent = total ? `${cur.toFixed(1)}s / ${total.toFixed(1)}s` : '-- / --';
    }
  }
  function clearScriptTimer(sc) {
    if (sc.timer) { clearInterval(sc.timer); sc.timer = null; }
  }
  function updateScriptButtons(sc) {
    sc.panel.querySelector('.script-play').disabled = !sc.script || sc.playing;
    sc.panel.querySelector('.script-stop').disabled = !sc.playing;
  }
  function drawWaveform(sc) {
    const canvas = sc.panel.querySelector('.script-canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f7f9fc';
    ctx.fillRect(0, 0, w, h);
    if (!sc.script) return;
    const pts = sc.script.meta.points || [];
    if (!pts.length) return;
    ctx.fillStyle = sc.ch === 0 ? '#4f7cff' : '#e07a3f';
    const bw = Math.max(1, w / pts.length);
    for (let i = 0; i < pts.length; i++) {
      const bh = (pts[i] / 100) * (h - 6);
      ctx.fillRect(i * bw, h - bh - 3, Math.max(1, bw - 0.5), bh);
    }
  }

  function loadScriptFile(sc, file) {
    if (!file) return;
    const meta = sc.panel.querySelector('.script-meta');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        const script = window.PulseParser.parse(text, file.name.replace(/\.[^.]+$/, ''));
        sc.script = script;
        meta.className = 'script-meta loaded';
        const src = script.meta.source === 'pulse' ? '明文编译' : '帧数组';
        const sec = script.meta.sectionCount ? ` · ${script.meta.sectionCount} 小节` : '';
        meta.textContent = `${script.name || file.name} · ${src}${sec} · ${script.frames.length} 帧 · ${(script.meta.durationMs / 1000).toFixed(1)}s`;
        setScriptStatus(sc, '', '已就绪,可播放');
        setScriptProgress(sc, 0);
        drawWaveform(sc);
        updateScriptButtons(sc);
        log('evt', `通道 ${sc.ch === 0 ? 'A' : 'B'} 载入脚本:${script.frames.length} 帧 / ${(script.meta.durationMs / 1000).toFixed(1)}s`);
        toast(`通道 ${sc.ch === 0 ? 'A' : 'B'} 脚本已载入`, 'ok');
      } catch (e) {
        sc.script = null;
        meta.className = 'script-meta error';
        meta.textContent = `解析失败:${e.message}`;
        setScriptStatus(sc, 'error', '脚本无效');
        setScriptProgress(sc, 0);
        drawWaveform(sc);
        updateScriptButtons(sc);
        log('err', `脚本解析失败:${e.message}`);
        toast(`脚本解析失败:${e.message}`, 'err');
      }
    };
    reader.onerror = () => {
      meta.className = 'script-meta error';
      meta.textContent = '文件读取失败';
    };
    reader.readAsText(file);
  }

  function playScript(sc) {
    if (!sc.script || sc.playing) return;
    const clientId = els.selClient.value;
    const slot = els.selSlot.value;
    if (!clientId) { log('err', '请先选择目标 APP'); return; }
    if (!slot) { log('err', '请先选择设备 slot'); return; }
    const reqId = nextReqId();
    const data = {
      s: slot,
      t: 0,
      c: sc.ch,
      p: 1,
      d: sc.script.meta.durationMs || 0,
      v: sc.script.frames,
      ver: 3,
    };
    if (send(opFrame(reqId, 'device.op', data), clientId)) {
      sc.playing = true;
      sc.reqId = reqId;
      sc.startedAt = Date.now();
      setScriptStatus(sc, 'playing', `播放中… (${sc.script.frames.length} 帧)`);
      setScriptProgress(sc, 0);
      updateScriptButtons(sc);
      log('evt', `通道 ${sc.ch === 0 ? 'A' : 'B'} 开始播放脚本 reqId=${reqId}`);
      clearScriptTimer(sc);
      const total = sc.script.meta.durationMs || 0;
      sc.timer = setInterval(() => {
        if (!sc.playing) { clearScriptTimer(sc); return; }
        if (total > 0) {
          const ratio = (Date.now() - sc.startedAt) / total;
          setScriptProgress(sc, ratio);
          if (ratio >= 1) sc.panel.querySelector('.script-status').textContent = '等待设备完成回执…';
        } else {
          const t = sc.panel.querySelector('.script-time');
          if (t) t.textContent = `${((Date.now() - sc.startedAt) / 1000).toFixed(1)}s / --`;
        }
      }, 100);
    }
  }

  function stopScript(sc) {
    if (!sc.playing) return;
    const clientId = els.selClient.value;
    const slot = els.selSlot.value;
    if (!clientId || !slot) { log('err', '请先选择 APP 与设备'); return; }
    // clear 指定 slot + 通道,取消正在播放的任务
    send(opFrame(nextReqId(), 'device.op.clear', { s: slot, c: sc.ch }), clientId);
    sc.playing = false;
    sc.reqId = '';
    clearScriptTimer(sc);
    setScriptProgress(sc, 0);
    setScriptStatus(sc, '', '已停止');
    updateScriptButtons(sc);
    log('evt', `通道 ${sc.ch === 0 ? 'A' : 'B'} 停止播放`);
    toast(`通道 ${sc.ch === 0 ? 'A' : 'B'} 已停止`);
  }

  // ---------- 录制回放 ----------
  function updateRecordUI() {
    els.recordCount.textContent = records.length + ' 条';
    els.btnReplay.disabled = records.length === 0 || recording || replaying;
    els.btnClearRecord.disabled = recording || replaying || records.length === 0;
  }
  function startRecord() {
    recording = true; recordStart = Date.now(); records = [];
    els.btnRecord.disabled = true; els.btnRecord.classList.add('recording');
    els.btnStopRecord.disabled = false;
    updateRecordUI(); log('evt', '开始录制');
  }
  function stopRecord() {
    recording = false;
    els.btnRecord.disabled = false; els.btnRecord.classList.remove('recording');
    els.btnStopRecord.disabled = true;
    updateRecordUI(); log('evt', `录制结束,共 ${records.length} 条`);
  }
  async function replay() {
    if (replaying || records.length === 0) return;
    replaying = true; els.btnReplay.disabled = true; els.btnClearRecord.disabled = true;
    log('evt', '开始回放');
    let last = 0;
    for (const rec of records) {
      const delay = rec.t - last; last = rec.t;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (!ws || ws.readyState !== WebSocket.OPEN) { log('err', '回放中断:连接已断开'); break; }
      const frame = { type: 'message', clientId: rec.clientId, data: rec.data };
      ws.send(JSON.stringify(frame));
      log('out', '↺ ' + JSON.stringify(frame));
    }
    replaying = false; updateRecordUI(); log('evt', '回放结束');
  }

  // ---------- 事件绑定 ----------
  els.btnConnect.addEventListener('click', connect);
  els.btnDisconnect.addEventListener('click', () => disconnect(false));
  els.btnCopyPair.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(els.pairUrl.value); log('evt', '配对链接已复制'); toast('配对链接已复制', 'ok'); }
    catch { els.pairUrl.select(); log('err', '复制失败,请手动复制'); toast('复制失败,请手动复制', 'err'); }
  });
  els.btnClearLog.addEventListener('click', () => { els.log.innerHTML = ''; });
  els.logExport.addEventListener('click', exportLog);
  els.logAuto.addEventListener('change', () => { if (els.logAuto.checked) els.log.scrollTop = els.log.scrollHeight; });
  els.logSearch.addEventListener('input', refreshLogFilter);
  els.logFilters.querySelectorAll('button[data-filter]').forEach((b) => {
    b.addEventListener('click', () => {
      logFilter = b.dataset.filter;
      els.logFilters.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      refreshLogFilter();
    });
  });
  els.selPreset.addEventListener('change', () => {
    if (PRESETS[els.selPreset.value]) els.pulseFrames.value = PRESETS[els.selPreset.value];
  });
  els.selClient.addEventListener('change', () => { renderClients(); renderDevices(); });

  // 通道分段控件（与隐藏的 selChannel 同步）
  els.chSegment.querySelectorAll('button[data-ch]').forEach((b) => {
    b.addEventListener('click', () => {
      const ch = b.dataset.ch;
      els.selChannel.value = ch;
      els.chSegment.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    });
  });

  // 临时强度：滑块 <-> 数字联动 + 快捷档位
  function syncTemp(fromRange) {
    let v = parseInt(fromRange ? els.tempSlider.value : els.tempValue.value, 10);
    if (!Number.isFinite(v)) v = 0;
    v = Math.min(200, Math.max(0, v));
    els.tempSlider.value = v; els.tempValue.value = v;
    els.tempSlider.style.setProperty('--fill', (v / 200 * 100) + '%');
  }
  els.tempSlider.addEventListener('input', () => syncTemp(true));
  els.tempValue.addEventListener('input', () => syncTemp(false));
  document.querySelectorAll('[data-level]').forEach((b) => {
    b.addEventListener('click', () => { els.tempValue.value = b.dataset.level; syncTemp(false); });
  });
  syncTemp(false);

  // ws 地址回车连接
  els.wsUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !els.btnConnect.disabled) connect(); });
  document.querySelectorAll('[data-op]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const op = btn.dataset.op;
      if (op === 'record') return startRecord();
      if (op === '') return;
      doOperation(op);
    });
  });
  els.btnStopRecord.addEventListener('click', stopRecord);
  els.btnReplay.addEventListener('click', replay);
  els.btnClearRecord.addEventListener('click', () => { records = []; updateRecordUI(); });

  // 脚本播放:每个通道绑定文件选择/播放/停止
  for (const sc of scriptChannels) {
    sc.panel.querySelector('.script-file').addEventListener('change', (e) => {
      loadScriptFile(sc, e.target.files[0]);
    });
    sc.panel.querySelector('.script-play').addEventListener('click', () => playScript(sc));
    sc.panel.querySelector('.script-stop').addEventListener('click', () => stopScript(sc));
    updateScriptButtons(sc);
    setScriptProgress(sc, 0);
    drawWaveform(sc);
  }

  log('evt', loadSavedUrl() ? `已恢复上次地址:${els.wsUrl.value}` : '控制台就绪;自动填充地址后点击连接');
  updateRecordUI();
})();
