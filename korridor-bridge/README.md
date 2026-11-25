# KorridorHpBridge — 游戏血量桥接插件

**BepInEx 6 + Unity IL2CPP 插件**，运行在 KORRIDOR 游戏进程内。读取玩家血量、死亡、Marks、击杀数、Boss 状态与敌人数，状态变化时通过 HTTP **主动推送**给外部联动服务（`korridor-service.ts`）。

> **2026-11-23 重大迁移**：游戏当天更新后从 Unity Mono 切换到 **IL2CPP** 构建（删除了 `Managed/` 和 `MonoBleedingEdge/`），原 BepInEx 5 + System.Reflection 插件完全失效。本插件已迁移到 BepInEx 6 + 原生 il2cpp API，并已在本机编译安装。
>
> **同日二次修复**：BepInEx 6 `pre.2` 自带的 Cpp2IL 只支持 IL2CPP metadata v23–29，而 Unity 6000.2 用的是 **v31**，导致 interop 生成失败、插件无法加载。已升级到官方 bleeding-edge **#793**（内置支持 v23–106 的新 Cpp2IL）。相应地，`BasePlugin` 命名空间从 `BepInEx.IL2CPP` 改为 `BepInEx.Unity.IL2CPP`，目标框架改为 `net6.0`。

## 为什么需要它

外部服务无权直接读游戏内存，且轮询截图/OCR 延迟高。插件注入游戏后能拿到第一手血量数据，一有变化立刻推送，延迟最低。

## 技术原理

不依赖 BepInEx 生成的 Il2CppInterop 代理程序集，而是直接 `DllImport("GameAssembly")` 调用 il2cpp 原生 C API：

- `il2cpp_domain_assembly_open` / `il2cpp_class_from_name` —— 按程序集名 + 类名找类（类名带命名空间时自动拆分，并兜底遍历全部类按短名匹配）
- `il2cpp_class_get_field_from_name` / `il2cpp_field_static_get_value` / `il2cpp_field_get_offset` —— 读静态/实例字段
- `il2cpp_class_get_method_from_name` / `il2cpp_runtime_invoke` / `il2cpp_object_unbox` —— 调 `Player.MaxHP()` 这类无参静态方法并拆箱返回值
- `il2cpp_array_length` —— 读击杀数组/敌人集合长度

**好处**：游戏更新导致字段改名时，改配置文件即可校正，无需重新生成代理、无需重编译 DLL。所有类名/字段名都可通过配置覆盖，启动时会逐个探测并把结果打到日志。

## 安装状态（本机已完成）

- 游戏目录：`D:\SteamLibrary\steamapps\common\KORRIDOR\KORRIDOR`
- BepInEx 6 IL2CPP：**bleeding-edge #793**（`BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.793+dbc82f0.zip`，2026-11-05），已安装；老的 `pre.2` 已清除并备份
- 插件：`KorridorHpBridge.dll`（v2.0.0，net6.0 / 引用 `BepInEx.Unity.IL2CPP`）已编译并放入 `BepInEx/plugins/`
- 备份：BepInEx 5 → `/tmp/bepinex5_full_backup/`；pre.2 的插件与配置 → `/tmp/bep6_pre2_backup/`

## 编译（需要时）

本机已装 .NET SDK 11 与 BepInEx 官方 NuGet 模板源。若游戏再次更新需要重编：

```bash
cd korridor-bridge
dotnet build KorridorHpBridge.csproj -c Release
# 产物 bin/Release/net6.0/KorridorHpBridge.dll
# 复制到 <游戏目录>/BepInEx/plugins/
```

`NuGet.Config` 指向 BepInEx 官方源（`https://nuget.bepinex.dev/v3/index.json`）。目标框架 `net6.0`，引用 `BepInEx.Unity.IL2CPP` 6.0.0-be.793（BE793 起的新包名/命名空间；旧 `BepInEx.IL2CPP` 停在 pre.1，不能用于 BE793）。编译期不依赖任何游戏 DLL。

**注意 1**：主类名是 `KorridorHpBridgePlugin`（不能叫 `KorridorHpBridge`，会与 `BepInEx.PluginInfoProps` 自动生成的同名类冲突 CS0101）。

**注意 2**：BepInEx 与插件必须版本匹配——BE793 的 `BasePlugin` 在 `BepInEx.Unity.IL2CPP` 命名空间。若日后换 BepInEx 版本导致插件加载失败，先核对命名空间与包版本，再重新编译。旧的 `pre.2` 因 Cpp2IL 不支持 metadata v31，**不要回退**。

## 配置

启动一次游戏后生成 `BepInEx/config/com.dglab.korridor.hpbridge.cfg`。关键项：

| 段 | 键 | 默认 | 说明 |
|---|---|---|---|
| Bridge | PushUrl | `http://127.0.0.1:9996/game-state` | 联动服务地址 |
| Bridge | ApiKey | 空 | 与联动服务 token 一致 |
| Bridge | PollIntervalMs | 200 | 检测间隔 |
| Bridge | HeartbeatMs | 3000 | 无变化时心跳推送间隔 |
| Il2Cpp | Assembly | `Assembly-CSharp` | 游戏主程序集名 |
| Il2Cpp | VerboseProbe | true | 启动时打印每个类/字段/方法的探测结果（校准用） |
| Il2Cpp | PlayerClass / DataClass / MainManagerClass / OpponentsClass | 见 cfg | 类名（可带命名空间） |
| Fields | DeadField / MaxHpMethod | `dead` / `MaxHP` | 死亡字段、最大血量方法 |
| Fields | SaveFileField / CurrentGameSaveField / HpField / MarksField | `saveFile` / `currentGameSave` / `hp` / `marks` | 血量链字段名 |
| Fields | InstanceField | `I` | 单例静态字段名 |
| Fields | CurrentBossField / BossKillCountField / BossPhase2Field | 见 cfg | Boss 状态字段 |
| Fields | KillCountPerSegmentField / ActiveOpponentsField | 见 cfg | 击杀/敌人数集合字段 |

**血量结构**（Mono 版反编译确认，IL2CPP 由同一套 C# 源码编译，结构一致）：

- 当前血量：`Data.saveFile.currentGameSave.hp`
- 最大血量：`Player.MaxHP()`（无参静态方法）
- 死亡标志：`Player.dead`（静态 bool）

游戏还在主菜单/存档未加载时 `saveFile` 为 null，插件静默跳过，进入关卡后自动恢复。死亡标志先于 `MaxHP()` 读取，保证死亡瞬间不延迟。

## 数据格式

插件每次推送一个 JSON（血量 + 扩展状态）：

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

| 字段 | 含义 | 来源（反编译确认） |
|---|---|---|
| `hpPercent` | 玩家血量百分比 0–100 | `Data.saveFile.currentGameSave.hp` / `Player.MaxHP()` |
| `dead` | 是否死亡 | `Player.dead` |
| `marks` | 当前 Marks 数 | `Data.saveFile.currentGameSave.marks` |
| `kills` | 总击杀数 | `OpponentsManager.I.killCountPerSegment` 各段求和 |
| `bossActive` | 当前是否有 Boss | `MainManager.I.currentBoss != null` |
| `bossKills` | Boss 击杀数 | `MainManager.I.bossKillCount` |
| `bossPhase2` | 最终 Boss 二阶段 | `MainManager.I.finalBossSecondPhase` |
| `enemies` | 当前场上敌人数 | `OpponentsManager.I.activeOpponents` 元素数 |
| `ts` | Unix 毫秒时间戳 | — |

扩展状态任一项读不到时用默认值（0/false），不影响血量主线。联动服务对未携带的扩展字段沿用上次值。

推送只在状态变化（血量幅度 ≥0.05% 或任一扩展字段变化）或心跳周期到达时发生。

## 排查

- **游戏启动时日志无插件**：确认 `BepInEx/plugins/KorridorHpBridge.dll` 存在、游戏目录顶层有 `winhttp.dll` + `doorstop_config.ini`（BepInEx 6 注入器）；`LogOutput.log` 时间应刷新为当前。
- **启动日志有一堆"字段未找到"**：开了 `VerboseProbe=true`，按提示的字段名去 cfg 里校正。注意 C# 属性在 IL2CPP 里是 `get_Xxx` 方法而非字段，若某字段实际是属性，当前版本读不到（会保持默认值，不影响血量）。
- **收不到推送**：确认 PushUrl 端口与 `korridor.config.json` 的 `listen.port`（9996）一致。
- **血量恒为 100 或无数据**：看启动探测日志，确认 `Player.dead` / `MaxHP` / `hp` 三项都"找到"；没找到就按实际名字改 cfg 字段配置，无需重编译。
- **换游戏版本后失效**：字段名/类名可能变了，用 `VerboseProbe` 日志重新校准配置；若程序集名变了改 `Il2Cpp/Assembly`。
- **启动弹窗 `AccessViolationException`（崩在 `il2cpp_runtime_invoke` / `InvokeStaticFloat`）**：插件自建线程必须先 attach 到 IL2CPP domain 才能执行 `Player.MaxHP()` 这类托管方法。当前版本 `PollLoop` 入口已调 `il2cpp_thread_attach`、退出时 detach。若仍崩，退化方案是彻底不调方法、改用纯字段读取计算 maxHp。
- **启动日志 `Unsupported metadata version 23-29, got 31`**：BepInEx 太老（pre.2 的老 Cpp2IL），必须升到 BE793+（见安装状态），不要回退。
