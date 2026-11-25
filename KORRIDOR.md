# KORRIDOR 游戏联动

让 DG-LAB 设备随 KORRIDOR 游戏里的角色状态震动：血量越低震动越强，死亡时最强；并获得 Marks、Boss、击杀、围攻等事件反馈。

## 整体链路

```
KORRIDOR.exe
   └─(BepInEx 插件 KorridorHpBridge)── HTTP POST /game-state ──> korridor-service (本服务, :9996)
                                                                      │
                                                                      └─ HTTP POST /vibrate ─> control-service (:9997)
                                                                                                   │
                                                                                                   └─ WS ─> v4-server (:9998) ─> APP/设备
```

- **BepInEx 插件**：装在游戏里，读血量/死亡及 Marks、击杀、Boss、敌人数，主动推送。安装与编译见 `korridor-bridge/README.md`。
  - **2026-11-23 起为 BepInEx 6 + Unity IL2CPP 版**：游戏当天更新后从 Mono 切到 IL2CPP，插件已重写并编译安装（v2.0.0，原生 il2cpp API + 配置驱动字段查找）。游戏目录已装 **BepInEx 6 IL2CPP bleeding-edge #793**（内置支持 Unity 6000.2 的 metadata v31；`pre.2` 的老 Cpp2IL 只支持 v23–29，会导致插件无法加载，勿回退）。旧的 BepInEx 5 已清除。
- **korridor-service**：联动逻辑（10 模式判定、冷却、优先级、输出预算、双通道）。
- **control-service**：唯一控制方，真正下发震动。需先启动并让手机 APP 扫它的码接入。
- v4/control/korridor 三个服务按日常启动；插件随游戏启动自动加载。

## 输出档位公式（针对有限档位设备）

用户设备的实际输出为：

```
单通道输出档位 = floor(波形振幅字节 × 全局强度 / 1000)   范围 0–20
```

波形帧 8 字节 = **前 4 字节频率 + 后 4 字节振幅**。振幅有效值 0–100（`64` hex = 100 = 满幅，`00` = 断开）。频率决定节奏疏密，不参与输出计算；动波形只改**后 4 字节**。所有波形频率段固定 `64646464`（保持已调好的脉冲基调），强弱/渐强/骤停节奏全靠振幅段排列实现。

一个波形帧 = 4 个时间片 × 25ms = **100ms**。`frames` 是帧数组，多帧串起来就是一段连续节奏；帧数按「时长 ÷ 100ms」给，整段正好播一遍不循环（循环型 mode3/siege 按 `periodMs` 对齐）。振幅速查：`64`=满幅、`50`=78%、`32`=50%、`19`=25%、`00`=停。各模式峰值振幅保留 `64`，所以输出档位仍等于 `output` 配置值。

## 十种联动模式

### 血量痛感（A 通道，优先级高）

| 模式 | 触发条件 | 节奏（帧数×100ms） | 强度 | 输出档位 | 时长 | 通道 |
|---|---|---|---|---|---|---|
| 1 轻伤 | 血量**下降穿越** 90% | 轻叩三连 + 渐弱（6 帧） | 20 | 2 | 600ms | A |
| 2 中伤 | 血量**下降穿越** 60% | 强-强-停 脉冲群 ×3（12 帧） | 60 | 6 | 1200ms | A |
| 3 濒死 | 血量 < 35%（状态） | 强弱细颤 + 骤停抽搐（8 帧） | 120 | 12↔6 | 循环，800ms/拍 | A |
| 4 死亡 | 活→死瞬间 | 全程满幅爆发 + 心跳重拍（30 帧，无停顿/无渐弱） | 200 | 20 | 3 秒 | A（独占全部） |

### 事件反馈（B 通道为主，优先级低）

| 模式 | 触发条件 | 节奏（帧数×100ms） | 强度 | 输出档位 | 时长 | 通道 |
|---|---|---|---|---|---|---|
| Boss 击杀 | `bossKills` 增加 | 强弱大脉冲 + 结尾四连重击（15 帧） | 150 | 15↔7 | 1.5 秒 | A+B |
| Boss 登场 | `bossActive` false→true | 阶梯渐强 + 心跳脉冲（15 帧） | 80 | 4→8 | 1.5 秒 | A+B |
| Boss 二阶段 | `bossPhase2` false→true | 阶梯骤升 → 持续满幅（10 帧） | 100 | 10→5 | 1 秒 | A |
| 围攻压力（当前关闭） | 敌人数 ≥ 阈值（状态） | 强弱颤动交替（10 帧） | 50 | 5↔2 | 循环，1s/拍 | A |
| 击杀连段 | 总击杀数增加 | 一下即停的短促点击（2 帧） | 40 | 4 | 200ms | B |
| Marks 获得 | `marks` 增加 | 两下轻提示递减（4 帧） | 30 | 3→0 | 400ms | B |

### 触发与并发规则

- **模式 1/2 是"受伤事件"**：只在血量从阈值上方跌破那一刻触发一次；停在低血区间不重复，挂机不会一直震。
- **迟滞防抖**：触发后血量须回升到 `阈值 + hysteresisPercent`（默认 +3%）才重新布防；阈值附近小幅来回不连发。
- **冷却**：模式 1/2 共享 `cooldownMs`（默认 5 秒）；**更严重档位可打断冷却**（刚因轻伤触发模式1，2 秒后掉到中伤档会无视冷却立即触发模式2）。
- **模式 3 / 围攻是"状态"**：血 < 模式3的 `hpBelow` 或敌人数达阈值时按各自周期持续循环，条件消失即停，不受冷却。
- **优先级**（高→低）：死亡(100) > 中伤(80) > 轻伤(70) > 濒死(60) > Boss击杀(50) > Boss登场(45) > Boss二阶段(40) > 围攻(35) > 击杀(25) > Marks(15)。
- **通道输出预算**：每个通道独立维护输出档位之和，上限 `output.maxPerChannel`（默认 20）。超额时高优先级驱逐低优先级；仍容纳不下则跳过。
- **循环抑制**：循环模式每拍前检查目标通道是否有更高优先级模式活跃，有则跳过该拍——这就是"1/2/4 抑制 3""血险时压制信息提示"的实现。
- **死亡独占**：mode4 触发后在其时长内独占、屏蔽一切其它模式（含 B 通道信息提示），修复了死亡反复震动的问题。

## 配置

`korridor.config.json`（支持 `//` 和 `/* */` 注释，文件内已自带逐项说明）：

| 字段 | 说明 |
|---|---|
| `listen` | 本服务监听地址与 token（插件的 `ApiKey` 要与 `token` 一致；留空不鉴权） |
| `control.baseUrl` | control-service 地址，默认 `http://127.0.0.1:9997` |
| `control.token` | control 的 API Key（若 control 设了） |
| `thresholds` | 血量三档阈值的兼容兜底，默认 80/50/20；仅当对应模式没写 `hpBelow` 时生效 |
| `hysteresisPercent` | 迟滞百分比，默认 3 |
| `cooldownMs` | 模式 1/2 共享冷却，默认 5000；更严重档位可打断 |
| `output.maxPerChannel` | 单通道输出档位上限，默认 20 |
| `siege.enabled` | 围攻压力总开关，当前 `false`（已关闭，不再自动触发）。想重新开启改为 `true` |
| `siege.minEnemies` | 围攻压力触发的敌人数阈值，当前 120（仅在 `siege.enabled=true` 时生效） |
| `modes.*.strength` | 全局强度，原样下发 |
| `modes.*.durationMs` | 单次时长；循环模式为单拍时长 |
| `modes.*.frames` | 波形帧（16 位 hex）：前 8 位频率、后 8 位振幅，振幅 00–64 |
| `modes.*.channel` | 通道：0=A，1=B，2=A+B |
| `modes.*.output` | 该模式峰值输出档位（用于抢占预算计算） |
| `modes.*.priority` | 优先级，越大越高（用于抢占与循环抑制） |
| `modes.mode1/2/3.hpBelow` | 血量阈值百分比：血量低于该值触发该档（轻伤/中伤/濒死），默认 80/50/20，需满足 濒死<中伤<轻伤 |
| `modes.mode3.periodMs` / `modes.siege.periodMs` | 循环节拍间隔 |

## 运行顺序

```bash
bun run v4        # 1. 中继服务（若已在运行可跳过）
bun run control   # 2. 控制服务，手机扫码接入（时间线已在 control.config.json 里关闭）
bun run korridor  # 3. 联动服务，监听 :9996 接收插件推送
```

然后启动装了插件的 KORRIDOR。插件按 `korridor-bridge/README.md` 配置 `PushUrl=http://127.0.0.1:9996/game-state`。

## 接口

本服务对插件暴露：

- `POST /game-state`：body 如下，成功返回 `{"ok":true}`。未携带的扩展字段沿用上一次值（兼容旧版插件）。

```json
{
  "hpPercent": 55.5,
  "dead": false,
  "marks": 12,
  "kills": 30,
  "bossActive": false,
  "bossKills": 1,
  "bossPhase2": false,
  "enemies": 4,
  "ts": 1795320000000
}
```

- `GET /state`：当前血量、档位、布防状态、两循环是否运行、独占剩余、各通道输出档位与活跃震动列表。
- `GET /health`：健康检查。
- 若 `listen.token` 非空，所有请求需带 `X-API-Key` 头。

调试示例（手动模拟受伤）。注意首帧只建立基线不触发，需先发一次高血再发低血：

```bash
# 1) 先建立满血基线（扩展状态首帧也会建立基线）
curl -X POST http://127.0.0.1:9996/game-state -H 'content-type: application/json' \
  -d '{"hpPercent":100,"dead":false,"marks":0,"kills":0,"bossActive":false,"bossKills":0,"bossPhase2":false,"enemies":0,"ts":1}'
# 2) 掉到 45%，下降穿越中伤阈值(60%)，触发模式2
curl -X POST http://127.0.0.1:9996/game-state -H 'content-type: application/json' \
  -d '{"hpPercent":45,"dead":false,"marks":0,"kills":0,"bossActive":false,"bossKills":0,"bossPhase2":false,"enemies":0,"ts":2}'
# 3) Marks 从 0 增到 3，触发 Marks（B 通道）
curl -X POST http://127.0.0.1:9996/game-state -H 'content-type: application/json' \
  -d '{"hpPercent":45,"dead":false,"marks":3,"kills":0,"bossActive":false,"bossKills":0,"bossPhase2":false,"enemies":0,"ts":3}'
```

## 状态字段识别

血量走专用路径（`Player.dead` / `Data.saveFile.currentGameSave.hp` / `Player.MaxHP()`），扩展状态经 il2cpp 原生 API 按配置里的字段名读取（结构在 Mono 版反编译中已确认，IL2CPP 同源）。启动后看日志：

- `Korridor HP Bridge v2.0.0 已加载（IL2CPP）` 表示插件注入成功；`===== IL2CPP 字段探测 =====` 段会逐项打印类/字段/方法是否找到。
- 血量在主菜单阶段读不到是正常的（存档未加载），进入关卡后自动恢复。
- 若某项显示"未找到"，直接在 `BepInEx/config/com.dglab.korridor.hpbridge.cfg` 里校正对应类名/字段名，**无需重编译 DLL**。IL2CPP 结构分析可用 Il2CppDumper 导出 `dump.cs`（或对照 metadata 字符串），详见插件 README。
