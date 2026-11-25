# DG-LAB 震动联动 · 新手入门教程

> 这份教程假设你**完全没接触过**这个项目。照着从上往下做就行，每一步都写了「你要做什么」和「应该看到什么」。
> 遇到问题时直接翻到最后的【常见问题】。

---

## 0. 先看懂这张图（30 秒）

整个东西是一条链，像接力赛：

```
你的游戏(KORRIDOR)  →  插件  →  korridor 服务  →  control 服务  →  v4 服务  →  手机 APP  →  震动设备
       ①                ②          ③               ④              ⑤            ⑥           ⑦
```

- 如果你**只是想让手机/设备震动**（不联动游戏），只需要 ④⑤⑥⑦ 这三步。
- 如果你想**游戏里挨打就震动**，才需要把 ①②③ 也装上。

本教程分两条路线：
- **路线 A**：基础震动（5 分钟搞定，先跑通这个）
- **路线 B**：游戏联动（在 A 的基础上再加东西）

建议：**先把路线 A 跑通，再做路线 B。**

---

## 1. 准备工作（两条路线都要做）

### 1.1 安装 Bun（项目的运行器）

Bun 就是这个项目用来跑 TypeScript 的程序，相当于 Python 的 python 命令。

**Windows 上打开 PowerShell**（按 `Win + X`，选「终端」或「PowerShell」），粘贴这行回车：

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

装完后**关掉 PowerShell 重新开一个**（让环境变量生效），然后验证：

```powershell
bun --version
```

👉 能看到一个版本号（比如 `1.3.14`）就是装好了。

> 已经装过的跳过这步。

### 1.2 查你电脑的局域网 IP（重要！）

手机要靠这个地址找到你的电脑。**每次换个 WiFi/路由器，这个地址可能会变，要重新查、重新改配置、重新扫码。**

在 PowerShell 里输入：

```powershell
ipconfig
```

在输出里找到你正在用的那个网卡（一般是「无线局域网适配器 WLAN」或「以太网适配器」），下面有一行：

```
IPv4 地址 . . . . . . . . . . . . : 192.168.1.23
```

把这个 `192.168.1.23` **记下来**，下面要用到。它就是你电脑的局域网 IP。

> ⚠️ 不要用 `127.0.0.1`，那是"我自己"，手机照着连会连到它自己的手机上，肯定连不上。

### 1.3 解压这个包

把 zip 解压到一个**没有中文和空格**的路径，比如 `D:\dglab-kit\`。
解压后你应该看到这些文件：

```
dglab-kit/
├── 新手教程.md          ← 你正在看的
├── control.config.json  ← 要改 IP 的配置文件
├── korridor.config.json
├── package.json
├── v4-server.ts
├── control-service.ts
├── korridor-service.ts
├── web/                 ← 网页控制台
├── korridor-bridge/     ← 游戏插件源码
├── prebuilt/            ← 编译好的插件 DLL
└── third-party/         ← BepInEx 安装包
```

---

## 2. 路线 A：让手机/设备震动

### 第 1 步：改配置文件里的 IP

用记事本打开 `control.config.json`，找到这两行：

```json
"v4Url": "ws://127.0.0.1:9998",
"advertiseUrl": "ws://192.168.1.X:9998",
```

把 `192.168.1.X` 换成刚才 1.2 查到的 IP（比如 `192.168.1.23`）：

```json
"v4Url": "ws://127.0.0.1:9998",
"advertiseUrl": "ws://192.168.1.23:9998",
```

> - `v4Url` 是 control 连接 v4 用的，两者都在你电脑上，`127.0.0.1` 保持不变就行。
> - `advertiseUrl` 是给手机扫码用的，**必须**换成你电脑的局域网 IP。
> - 保存时注意别把引号改没了。

### 第 2 步：启动 v4 服务

在解压目录里打开 PowerShell（在文件夹地址栏输入 `powershell` 回车），运行：

```powershell
bun run v4
```

👉 应该看到类似：

```
[V4] 服务启动 端口=9998 路径=/
[V4] Web 控制台 http://127.0.0.1:9998/
```

**这个窗口保持开着，不要关。** 要开新窗口就重新打开一个 PowerShell。

### 第 3 步：启动 control 服务（出二维码）

**新开一个 PowerShell 窗口**，进入同一个目录，运行：

```powershell
bun run control
```

👉 应该看到一段**二维码**（一堆黑白方块），以及：

```
[CTRL] 控制方 ID = xxxxxxxx
[CTRL] APP 扫码地址 = ws://192.168.1.23:9998?tid=xxxxxxxx
[CTRL] 等待 APP 扫码接入…
[CTRL] HTTP API 已启动 http://127.0.0.1:9997
```

**这个窗口也保持开着。**

> 如果看到警告「v4Url 指向本机，手机无法扫码连接」，说明你漏了第 1 步，回去把 `advertiseUrl` 改了再重启 control。

### 第 4 步：手机扫码配对

1. 手机上打开 **DG-LAB APP**（就是配你震动设备的那个 APP）。
2. 找到**扫码连接 / 扫描二维码**的功能（不同版本位置不同，一般在连接设备或设置页里）。
3. 扫第 3 步控制台里那个二维码。
4. 扫完回到电脑看 control 窗口，出现连接成功的提示就对了。

> 扫不上？先看【常见问题 Q2】。

### 第 5 步：发一条测试震动

确认手机连上后，**再开一个 PowerShell 窗口**，粘贴：

> Windows PowerShell 里 `curl` 是别的命令，所以这里要写 `curl.exe`（Windows 自带）。

```powershell
curl.exe -X POST http://127.0.0.1:9997/vibrate -H "content-type: application/json" -d "{\"channel\":0,\"strength\":60,\"duration\":3000,\"wait\":false,\"frames\":[\"6464646464646464\"]}"
```

👉 设备应该震 3 秒。返回里如果有 `"accepted":true` 就说明发出去了。

震了吗？
- **震了** → 路线 A 成功！可以去做路线 B，或者用网页控制台玩。
- **没震** → 看【常见问题 Q3】。

### 第 6 步（可选）：用网页控制台

浏览器打开 `http://127.0.0.1:9998/`，有一个网页界面，能配对、调强度、发波形、录脚本。

---

## 3. 路线 B：游戏里挨打就震动（KORRIDOR）

> 前提：路线 A 已经跑通（control 能连上、手机能震）。
> 目标：游戏里掉血、死亡、拿 Marks、Boss 出场时自动震动。

### 第 1 步：确认游戏目录

本教程默认游戏装在：

```
D:\SteamLibrary\steamapps\common\KORRIDOR\KORRIDOR\
```

如果你的装在别处，下面所有「游戏目录」都换成你自己的路径。
判断方法：这个目录下应该有一个 `KORRIDOR.exe`。

### 第 2 步：安装 BepInEx（游戏的插件框架）

1. **先确认游戏没在运行**（任务管理器里没有 `KORRIDOR.exe`）。
2. 打开包里的 `third-party/` 文件夹，把里面的
   `BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.793.zip`
   **解压到游戏目录**（就是有 `KORRIDOR.exe` 的那一层）。
   解压后游戏目录里会多出 `BepInEx/` 文件夹、`winhttp.dll`、`doorstop_config.ini`。

> ⚠️ 这个版本是专门配 Unity 6000.2 游戏的。游戏如果更新了，BepInEx 可能要重装，看【常见问题 Q5】。

### 第 3 步：放入我们的插件

把包里这两个文件复制到游戏目录对应位置（没有文件夹就新建）：

| 包里的文件 | 复制到 |
|---|---|
| `prebuilt/KorridorHpBridge.dll` | `游戏目录\BepInEx\plugins\KorridorHpBridge.dll` |
| `korridor-bridge/com.dglab.korridor.hpbridge.cfg` | `游戏目录\BepInEx\config\com.dglab.korridor.hpbridge.cfg` |

### 第 4 步：启动 korridor 服务

回到解压目录，**新开一个 PowerShell 窗口**，运行：

```powershell
bun run korridor
```

👉 应该看到：

```
[KORR] 配置已加载：control http://127.0.0.1:9997 ...
[KORR] HTTP 服务已监听 http://127.0.0.1:9996
```

**这个窗口也保持开着。** 现在一共应该有 3 个窗口：v4、control、korridor。

### 第 5 步：进游戏验证

1. 从 Steam 启动 KORRIDOR，**进入能操控角色的关卡**（停在主菜单不算，主菜单没有血量）。
2. 在浏览器打开 `http://127.0.0.1:9996/health`。
3. 👉 看到 `"hpPercent":100` 之类的数字，并且 `ts` 是一串很大的数字（不是 0），说明**游戏数据已经通了**。

然后随便挨一下打让血量掉破 90%，korridor 窗口应该出现：

```
触发 mode1：强度 20 ...
```

设备跟着震一下就成了。

### 第 6 步：调参数（按需）

- **震动强度、时长、波形**：用记事本改 `korridor.config.json`，改完要**重启 korridor 服务**才生效。
- **游戏里字段读不到**：改游戏目录里的 `com.dglab.korridor.hpbridge.cfg`，**重启游戏**生效（不用重新编译）。
- 各模式的详细说明见 `KORRIDOR.md`。

---

## 4. 常见问题（按症状查）

### Q1：启动时提示找不到 bun / 不是内部命令
Bun 没装好，或装完没重开终端。回到 1.1 重装并**重新打开 PowerShell**。

### Q2：手机扫不上码 / 扫了连不上
1. 确认手机和电脑在**同一个 WiFi**。
2. 电脑防火墙可能挡了。PowerShell（管理员）放行端口：
   ```powershell
   netsh advfirewall firewall add rule name="dglab" dir=in action=allow protocol=TCP localport=9998
   ```
3. 确认 `advertiseUrl` 填的是**电脑的局域网 IP**（1.2 查的），不是 `127.0.0.1`。
4. 电脑 IP 变了就重新查、重新改、重新扫码（旧码会失效）。
5. 在手机浏览器访问 `http://你电脑IP:9998/`，能打开网页说明网络通。

### Q3：接口返回 accepted 但设备不震
1. control 窗口里有没有设备接入？没有就是没配对成功，回第 4 步重扫。
2. 强度别太低，测试用 60 以上。
3. 确认发了波形（`frames` 字段），只发强度不会震。
4. DG-LAB APP 里设备是否连着、电量够不够。

### Q4：korridor 里 `ts` 一直是 0 / 没有触发日志
说明游戏插件没推数据过来。按顺序查：
1. **游戏真的进关卡了吗？** 停在主菜单读不到血量。
2. **BepInEx 注入成功了吗？** 看 `游戏目录\BepInEx\LogOutput.log` 的时间是不是刚刚，里面有没有 `Korridor HP Bridge v2.0.0 已加载`。
3. 游戏是不是从昨晚/上次启动后就没重开？改了插件 DLL 必须**彻底退出游戏再启动**。

### Q5：游戏更新后插件失效了
游戏（Unity 6000.2）更新后，BepInEx 可能要重装：
1. 彻底退出游戏。
2. 把 `third-party/` 里的 BepInEx 包重新解压覆盖到游戏目录。
3. **保留** `BepInEx\plugins\KorridorHpBridge.dll` 和 `BepInEx\config\` 里的配置（解压时别删它们）。
4. 重启游戏。

如果日志里出现 `Unsupported metadata version`，就是这个原因。

### Q6：游戏退出时卡住 / 无响应
先删掉旧的大日志 `游戏目录\BepInEx\LogOutput.log`（BepInEx 会自动重建），再试一次。
如果还卡，多半是游戏自身的 DOTween 动画警告，与本插件无关；确认退出后进程真的还在不在（任务管理器看 `KORRIDOR.exe`）。

### Q7：想改震动档位
设备实际输出档位 ≈ `振幅 × 强度 ÷ 1000`（取整）。
- 强度改 `korridor.config.json` 里各模式的 `strength`。
- 振幅是波形帧后 4 字节，`64`=满幅，`00`=停。
- 强度范围 0–200，原样下发，不用凑整十。

---

## 5. 命令速查表

在解压目录里打开 PowerShell，常用命令：

| 命令 | 作用 |
|---|---|
| `bun run v4` | 启动 v4 服务（网页控制台 :9998） |
| `bun run control` | 启动 control（出二维码，HTTP API :9997） |
| `bun run korridor` | 启动游戏联动服务（:9996） |
| `bun run dev:v4` | 开发模式启动 v4（改代码自动重启） |

**日常使用的启动顺序**：先 `bun run v4` → 再 `bun run control`（扫码）→ 玩纯震动就到此为止；要游戏联动再加 `bun run korridor` → 最后开游戏。

---

## 6. 端口一览（排查时用）

| 端口 | 服务 | 说明 |
|---|---|---|
| 9998 | v4 | WebSocket 中继 + 网页控制台 |
| 9997 | control | HTTP API（外部服务调它发震动） |
| 9996 | korridor | 接收游戏插件推的状态 |

---

*更多技术细节见 `API.md`（HTTP 接口文档）和 `KORRIDOR.md`（游戏联动说明）。*
