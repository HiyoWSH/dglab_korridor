# DG-LAB 震动联动 · 分享包

**第一次用？直接打开 [START_HERE.md](START_HERE.md)（新手教程），照着做就行。**

## 这个包里有什么

| 文件/目录 | 说明 |
|---|---|
| **START_HERE.md** | ⭐ 零基础入门教程，从安装到跑通，照着敲命令 |
| API.md | HTTP 接口文档（外部服务如何调用发震动） |
| KORRIDOR.md | 游戏联动详细说明（模式、阈值、波形配置） |
| v4-server.ts | WebSocket 中继 + 网页控制台（端口 9998） |
| control-service.ts | 控制方 + HTTP API（端口 9997，出二维码） |
| korridor-service.ts | KORRIDOR 游戏联动服务（端口 9996） |
| control.config.json | ⚠️ 使用前必须改里面的局域网 IP |
| korridor.config.json | 各震动模式的强度/波形/阈值配置 |
| web/ | 网页控制台前端 |
| korridor-bridge/ | BepInEx 插件源码 + 配置模板 |
| prebuilt/ | 编译好的插件 DLL（可直接用） |
| third-party/ | BepInEx 6 IL2CPP 安装包（Unity 6000.2 用） |

## 三步跑通（详见新手教程）

```powershell
bun run v4        # 窗口1：网页控制台
bun run control   # 窗口2：扫码配对，出二维码
bun run korridor  # 窗口3：游戏联动（可选，玩游戏才需要）
```

## 重要提醒

1. **先改 IP**：`control.config.json` 的 `advertiseUrl` 要改成你电脑的局域网 IP，否则手机扫不上。用 `ipconfig` 查。
2. **只保留 V4**：这个包是纯 V4 版本，V3 已移除。
3. **需要 Bun**：运行需要 Bun ≥1.3，安装见新手教程第 1.1 节。
4. **游戏联动**：KORRIDOR 已更新为 IL2CPP 构建，必须用包内的 BepInEx 6（BE793），不要用老的 BepInEx 5。

## 链路图

```
游戏 → 插件(游戏内) → korridor:9996 → control:9997 → v4:9998 → 手机APP → 设备
```
