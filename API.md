# control-service 对外 HTTP 接口

外部服务通过本接口让 DG-LAB 设备震动，**不需要理解 V4 WebSocket 协议**。

## 架构与角色

```
外部服务 ──HTTP POST──> control-service ──WS(控制方)──> v4-server ──WS(tid)──> APP/设备
```

- `control-service` 是 APP 唯一认可的控制方；外部服务只跟它的 HTTP 端口打交道。
- 一个 APP 只能认一个控制方（V4 的 `tid` 绑定）。扫了 `control-service` 的码后，该 APP 由本接口控制，浏览器控制台不再控制同一台设备。
- APP 的执行回执（`resp`）由本服务按 `reqId` 匹配，转成同步 HTTP 结果返回。

一次 HTTP 调用**只控制一个设备**（默认第一个在线设备，可用 `target`/`slot` 指定）；这与配置里时间线的"广播给所有设备"不同。

## 启动

```bash
bun run v4        # 中继服务，若已在运行可跳过
bun run control   # 常驻控制服务，同时开启 HTTP 接口
```

`control-service` 启动后会在终端打印二维码，手机扫码接入。接口监听地址由 `control.config.json` 的 `api` 段决定：

```json
{
  "v4Url": "ws://127.0.0.1:9998",
  "advertiseUrl": "ws://192.168.1.X:9998",
  "api": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 9997,
    "token": "",
    "waitTimeoutMs": 5000
  },
  "timelineEnabled": false
}
```

| 字段 | 说明 |
|---|---|
| `timelineEnabled` | 是否按 `timeline` 自动下发，默认 `true`；设为 `false` 则停用自动下发，只保留 HTTP 接口（外部服务完全接管控制时使用） |
| `enabled` | `true` 才启动 HTTP 接口 |
| `host` | 监听地址。默认 `127.0.0.1` 仅本机可访问；外部服务在别的机器时改为 `0.0.0.0` 或局域网 IP |
| `port` | 监听端口，默认 `9997` |
| `token` | API Key。留空不鉴权；非空时所有请求必须带 `X-API-Key` 头 |
| `waitTimeoutMs` | 等待 APP 回执的超时毫秒数，默认 `5000` |

> 把 `host` 暴露到局域网时**务必设置 `token`**，否则任何机器都能控制设备。

## 通用约定

- 基础地址：`http://<host>:<port>`，默认 `http://127.0.0.1:9997`
- 请求体：JSON，header `Content-Type: application/json`
- 鉴权：`token` 非空时，请求头带 `X-API-Key: <token>`；缺失或错误返回 `401`
- 通道：`channel` 为 `0`（A 通道）或 `1`（B 通道），默认 `0`
- 时长：`duration` 单位毫秒，默认 `1000`
- 目标：`target`（APP 的 clientId）、`slot`（设备 slotId）均可省略，省略时自动选第一个在线设备；`target` 指定但找不到时返回 `503`

所有成功响应都带 `ok: true`。同步等待（`wait` 为 `true`，默认）成功时：

```json
{
  "ok": true,
  "reqId": "ctrl-1795319934736-2",
  "target": { "clientId": "e59480f5", "slot": "slot-X" },
  "result": { "reason": "completed", "type": 4 }
}
```

`wait: false` 时不等待回执，立即返回：

```json
{ "ok": true, "accepted": true, "reqId": "ctrl-...", "target": { "clientId": "e59480f5", "slot": "slot-X" } }
```

失败响应带 HTTP 状态码和 `ok: false`、`error` 字段。

## 接口清单

### `GET /devices`

查询在线 APP 及其设备 slot。下发前可先调它拿到 `target` / `slot`。

```json
{
  "ok": true,
  "controllerId": "53c0055b",
  "devices": [
    { "clientId": "e59480f5", "devices": ["slot-X"] }
  ]
}
```

### `GET /health`

健康检查，不需要设备在线。

```json
{ "ok": true, "connected": true, "controllerId": "53c0055b", "deviceCount": 1 }
```

### `POST /vibrate`

让设备震动。一次调用下发两条指令：`t:4` 设强度（到时自动归零）+ `t:0` 持续波形（提供脉冲节奏）。**强度只是电压，波形才是开关——没有波形设备不会震**，所以本接口自动附带一段默认波形，无需调用方单独发 `/pulse`。同步回执取自波形指令（强度指令 APP 不回执）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `strength` | number | 是 | 强度值，**原样下发**，服务端不做约束 |
| `duration` | number | 否 | 毫秒，默认 `1000` |
| `channel` | 0\|1 | 否 | 通道，默认 `0`（A） |
| `frames` | string[] | 否 | 自定义波形帧；不传则用默认持续输出 `["6464646464646464"]` |
| `target` | string | 否 | APP clientId |
| `slot` | string | 否 | 设备 slotId |
| `wait` | boolean | 否 | 是否等待回执，默认 `true` |

```bash
curl -X POST http://127.0.0.1:9997/vibrate \
  -H 'content-type: application/json' \
  -d '{"channel":0,"strength":30,"duration":1000}'
```

> 强度虽原样下发，但 DG-LAB APP 端要求强度值为 **10 的倍数**（10/20/30…，范围 0–200）。填 `7` 这类值服务端照发，APP 会回 `value_must_be_multiple_of_10` 错误，该错误通过响应里的 `error` 返回。是否需要规整由调用方自行决定。

### `POST /pulse`

下发波形帧（`device.op t:0`）。APP 按每帧约 100ms 逐个播放，播完回 `completed`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `frames` | string[] | 是 | 8 字节十六进制帧数组，每帧 16 个 hex 字符 |
| `duration` | number | 否 | 毫秒，默认 `1000` |
| `channel` | 0\|1 | 否 | 通道，默认 `0` |
| `target` / `slot` / `wait` | — | 否 | 同上 |

```bash
curl -X POST http://127.0.0.1:9997/pulse \
  -H 'content-type: application/json' \
  -d '{"channel":0,"frames":["6464646464646464","0000000000000000"],"duration":2000}'
```

波形帧示例（8 字节 = 8 个时间片，`64` 为满输出）：

```json
["0A0A0A0A64646464", "0A0A0A0A32323232"]
```

> 波形只决定脉冲节奏，真正决定电压大小的是通道强度。若通道强度为 0 或不回执，波形不会产生体感。播放前请先确保目标通道有强度（例如先调一次 `/vibrate`）。

### `POST /stop`

清除指定通道的任务（`device.op.clear`）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `channel` | 0\|1 | 否 | 通道，默认 `0` |
| `target` / `slot` / `wait` | — | 否 | 同上 |

```bash
curl -X POST http://127.0.0.1:9997/stop \
  -H 'content-type: application/json' \
  -d '{"channel":0}'
```

### `POST /command`

原始 RPC 透传，用于上面语义接口覆盖不了的高级场景。需要了解 V4 协议。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `m` | string | 是 | RPC 方法名，如 `device.op`、`devices.get` |
| `data` | object | 否 | 完整参数对象，原样下发 |
| `target` / `slot` / `wait` | — | 否 | 同上 |

```bash
curl -X POST http://127.0.0.1:9997/command \
  -H 'content-type: application/json' \
  -d '{"m":"device.op","data":{"s":"slot-X","t":3,"c":0,"p":1,"v":10}}'
```

`device.op` 常用 `t` 值：`0` 波形、`3` 强度增减、`4` 临时强度、`7` 归零；`c` 为通道 `0/1`。

## 错误码

| HTTP | `error` | 含义 |
|---|---|---|
| 400 | `invalid json body` | 请求体不是合法 JSON |
| 400 | `strength must be a number` | `/vibrate` 缺 `strength` 或类型不对 |
| 400 | `frames must be an array` | `/pulse` 缺 `frames` 或不是数组 |
| 400 | `m must be a string` | `/command` 缺 `m` 或不是字符串 |
| 401 | `unauthorized` | 鉴权失败（`X-API-Key` 缺失或错误） |
| 503 | `no online device` | 没有匹配的在线设备 |
| 200 | `timeout` | 等待 APP 回执超时（响应体带 `reqId`、`target`、`timeoutMs`） |
| 200 | `disconnected` | 等待期间 APP 断线 |
| 200 | `not connected to v4-server` | 控制服务未连上中继 |
| 200 | `value_must_be_multiple_of_10` 等 | APP 返回的协议级错误，见 `error` 字段 |

业务级失败（如 `timeout`、APP 返回错误）用 HTTP 200 + `ok: false` 表示，需检查响应体的 `ok` 与 `error`，不能只看 HTTP 状态码。

## 调用示例

### Python

```python
import requests

BASE = "http://127.0.0.1:9997"
HEADERS = {"X-API-Key": "your-token"}  # token 留空时可去掉

# 查设备
print(requests.get(f"{BASE}/devices", headers=HEADERS).json())

# 震动 A 通道，强度 30，持续 1 秒，同步等待结果
r = requests.post(f"{BASE}/vibrate", headers=HEADERS, json={
    "channel": 0, "strength": 30, "duration": 1000
})
print(r.json())
```

### JavaScript / Node.js

```js
const BASE = 'http://127.0.0.1:9997';
const headers = { 'content-type': 'application/json', 'X-API-Key': 'your-token' };

const r = await fetch(`${BASE}/vibrate`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ channel: 0, strength: 30, duration: 1000 }),
});
console.log(await r.json());
```

### 免等待（高频触发场景）

```bash
curl -X POST http://127.0.0.1:9997/vibrate \
  -H 'content-type: application/json' \
  -d '{"channel":0,"strength":30,"duration":1000,"wait":false}'
```

高频调用建议用 `wait: false`，避免每次都挂起等回执；需要确认结果时再单独用 `wait: true`。

## 常见问题

1. **调接口没反应？** 先查 `GET /devices` 是否有在线设备、`GET /health` 的 `connected` 是否为 `true`。APP 必须扫 `control-service` 的码接入。
2. **APP 回了 `value_must_be_multiple_of_10`？** 强度填了非 10 的倍数，改成 10/20/30…。
3. **发了波形不震动？** 通道强度可能为 0，先调 `/vibrate` 设强度再发波形；或帧数组本身就是全 0。
4. **总是 `timeout`？** APP 未回执或回执 reqId 不匹配；可调大 `waitTimeoutMs`，或改用 `wait: false`。
5. **外部机器连不上？** `api.host` 默认 `127.0.0.1` 只监听本机；改 `0.0.0.0` 并放行防火墙端口，同时设置 `token`。
