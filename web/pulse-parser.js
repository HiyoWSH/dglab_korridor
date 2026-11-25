/* .pulse 脚本解析器 —— 纯浏览器端,无依赖
 * 支持两种输入:
 *   1. 已编译的 V3 帧数组(JSON):["0A0A0A0A64646464", ...]
 *   2. 官方明文:Dungeonlab+pulse:18,1,8=27,7,32,3,1/0-1,50-0,100-1[+section+...]
 * 编译算法参考 sse-dg-lab / node-dglab-pulse-helper(频率数据集 + 25ms 采样 + 压缩)
 */
(() => {
  'use strict';

  // 频率数据集:索引 0-83 → 波形频率(ms)
  const FREQ = [
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
    52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80,
    85, 90, 95, 100,
    110, 120, 130, 140, 150, 160, 170, 180, 190, 200,
    233, 266, 300, 333, 366, 400,
    450, 500, 550, 600,
    700, 800, 900, 1000,
  ];

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const getFreq = (i) => FREQ[clamp(Math.floor(Number(i) || 0), 0, FREQ.length - 1)] ?? 10;
  const getDuration = (i) => clamp(Math.floor(Number(i) || 0), 0, 99) + 1; // 单位 100ms

  // 波形频率(ms) → 设备输出值(10-240),V3 分段压缩
  function compressFreq(x) {
    let out;
    if (x >= 10 && x <= 100) out = x;
    else if (x > 100 && x <= 600) out = (x - 100) / 5 + 100;
    else if (x > 600 && x <= 1000) out = (x - 600) / 10 + 200;
    else out = 10;
    return clamp(Math.round(out), 10, 240);
  }

  const HEX16 = /^[0-9a-fA-F]{16}$/;

  function normalizeFrames(arr, label = '帧数组') {
    if (!Array.isArray(arr)) throw new Error(`${label}必须是数组`);
    if (arr.length === 0) throw new Error(`${label}为空`);
    if (arr.length > 1000) throw new Error(`${label}帧数过多(${arr.length}),上限 1000`);
    return arr.map((f, i) => {
      if (typeof f !== 'string') throw new Error(`第 ${i + 1} 帧不是字符串`);
      const hex = f.trim().replace(/^0x/i, '');
      if (!HEX16.test(hex)) throw new Error(`第 ${i + 1} 帧不是合法 V3 帧(需 16 位十六进制):${f}`);
      return hex.toUpperCase();
    });
  }

  // 编译一个 .pulse 明文为帧数组
  function compilePulseText(text, name = '') {
    const raw = String(text).trim();
    if (!raw.startsWith('Dungeonlab+pulse:')) {
      throw new Error("明文必须以 'Dungeonlab+pulse:' 开头");
    }
    const clean = raw.replace(/^Dungeonlab\+pulse:/i, '');
    const parts = clean.split('+section+');
    const first = parts[0];
    const eq = first.indexOf('=');
    if (eq === -1) throw new Error("缺少全局设置分隔符 '='");

    // 全局设置:sectionRestTime, playbackSpeed, frequencyBalance
    const globals = first.slice(0, eq).split(',');
    const restTime = clamp(Math.floor(Number(globals[0]) || 0), 0, 100);
    const playbackSpeed = [1, 2, 4].includes(Number(globals[1])) ? Number(globals[1]) : 1;
    const balance = Number(globals[2]) || 8;

    // 小节数据:第一段在 '=' 之后,其余在 +section+ 后面
    const sectionData = [first.slice(eq + 1), ...parts.slice(1)];

    const sections = [];
    for (let i = 0; i < sectionData.length && i < 10; i++) {
      const sd = sectionData[i];
      if (!sd) continue;
      const slash = sd.indexOf('/');
      if (slash === -1) throw new Error(`第 ${i + 1} 小节缺少 '/' 分隔符`);
      const head = sd.slice(0, slash).split(',');
      if (head.length < 5) throw new Error(`第 ${i + 1} 小节头部字段不足(需 5 个)`);

      const fStartIdx = Number(head[0]) || 0;
      const fEndIdx = Number(head[1]) || 0;
      const durIdx = Number(head[2]) || 0;
      const mode = clamp(Number(head[3]) || 1, 1, 4);
      const enabled = head[4] !== '0';

      const shape = [];
      for (const item of sd.slice(slash + 1).split(',')) {
        if (!item) continue;
        const seg = item.split('-');
        const strength = clamp(Math.round(Number(seg[0]) || 0), 0, 100);
        shape.push(strength);
      }
      if (shape.length < 2) throw new Error(`第 ${i + 1} 小节至少需要 2 个形状点`);

      if (enabled) {
        sections.push({
          fStart: getFreq(fStartIdx),
          fEnd: getFreq(fEndIdx),
          duration: getDuration(durIdx), // 单位 100ms
          mode,
          shape,
        });
      }
    }
    if (sections.length === 0) throw new Error('没有启用的小节');

    // 生成帧:每帧 = 4×频率字节 + 4×强度字节,每字节 25ms,每帧 100ms
    const freqList = [];
    const valueList = [];

    for (const sec of sections) {
      const shapeCount = sec.shape.length;
      const pulseCount = Math.max(1, Math.ceil(sec.duration / shapeCount));
      const actualDuration = pulseCount * shapeCount;

      for (let p = 0; p < pulseCount; p++) {
        for (let s = 0; s < shapeCount; s++) {
          const t = p * shapeCount + s;
          const sectionProgress = t / actualDuration;
          const elementProgress = s / shapeCount;
          let f;
          switch (sec.mode) {
            case 1: // 固定
              f = sec.fStart;
              break;
            case 2: // 节内渐变
              f = sec.fStart + (sec.fEnd - sec.fStart) * sectionProgress;
              break;
            case 3: // 元内渐变
              f = sec.fStart + (sec.fEnd - sec.fStart) * elementProgress;
              break;
            case 4: { // 元间渐变
              const ep = pulseCount > 1 ? p / (pulseCount - 1) : 0;
              f = sec.fStart + (sec.fEnd - sec.fStart) * ep;
              break;
            }
            default:
              f = sec.fStart;
          }
          const outF = compressFreq(f);
          const strength = sec.shape[s];
          // 每个形状点展开 4 个 25ms 采样;播放速率影响每段采样重复次数
          const repeat = playbackSpeed === 4 ? 1 : playbackSpeed === 2 ? 2 : 4;
          for (let n = 0; n < repeat; n++) {
            freqList.push(outF);
            valueList.push(strength);
          }
        }
      }
    }

    // 休息时长:restTime 是滑块值 ×0.1 秒 → 每 100ms 一帧,插入空帧
    if (restTime > 0) {
      const sleepFrames = Math.ceil(restTime * 0.1 * 1000 / 100);
      for (let i = 0; i < sleepFrames * 4; i++) {
        freqList.push(10);
        valueList.push(0);
      }
    }

    // 补齐到 4 的倍数
    while (freqList.length % 4 !== 0) {
      freqList.push(10);
      valueList.push(0);
    }

    const frames = [];
    for (let i = 0; i < freqList.length; i += 4) {
      let hex = '';
      for (let j = 0; j < 4; j++) hex += clamp(freqList[i + j] ?? 10, 10, 240).toString(16).padStart(2, '0');
      for (let j = 0; j < 4; j++) hex += clamp(valueList[i + j] ?? 0, 0, 100).toString(16).padStart(2, '0');
      frames.push(hex.toUpperCase());
    }

    return {
      frames,
      name,
      meta: {
        source: 'pulse',
        sectionCount: sections.length,
        playbackSpeed,
        balance,
        restTime,
        durationMs: frames.length * 100,
      },
    };
  }

  // 解析 JSON:支持纯数组,或 {frames/pulseData/frames_v3/expectedV3} 对象
  function parseJsonFrames(text, name = '') {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error('JSON 格式无效');
    }
    let arr = obj;
    if (!Array.isArray(obj) && obj && typeof obj === 'object') {
      arr = obj.frames ?? obj.pulseData ?? obj.frames_v3 ?? obj.expectedV3 ?? obj.framesV3 ?? obj.v;
    }
    const frames = normalizeFrames(arr);
    return {
      frames,
      name: name || (obj && !Array.isArray(obj) ? obj.name : '') || '',
      meta: { source: 'json', sectionCount: 0, durationMs: frames.length * 100 },
    };
  }

  // 统一入口:根据内容自动识别格式
  function parse(text, fallbackName = '') {
    const trimmed = String(text).trim();
    if (!trimmed) throw new Error('内容为空');
    let result;
    if (trimmed.startsWith('Dungeonlab+pulse:')) {
      result = compilePulseText(trimmed, fallbackName);
    } else if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      result = parseJsonFrames(trimmed, fallbackName);
    } else {
      throw new Error('无法识别格式:需为 Dungeonlab+pulse: 明文或 JSON 帧数组');
    }
    // 强度曲线(用于预览):取每帧后 4 字节的平均值
    result.meta.points = result.frames.map((f) => {
      const bytes = f.match(/.{2}/g).map((b) => parseInt(b, 16));
      return Math.round((bytes[4] + bytes[5] + bytes[6] + bytes[7]) / 4);
    });
    return result;
  }

  window.PulseParser = { parse, compilePulseText, parseJsonFrames, normalizeFrames, FREQ };
})();
