// KorridorHpBridge — BepInEx 6 (Unity IL2CPP) 插件
// 作用：在 KORRIDOR 游戏进程内读取玩家血量百分比、死亡状态及扩展状态
//       (marks / kills / boss / enemies)，状态变化或周期性心跳时通过 HTTP POST
//       推送给外部联动服务（korridor-service，默认 http://127.0.0.1:9996/game-state）。
//
// 【为什么重写】
// 游戏 2026-11-23 更新后从 Unity Mono 切换为 IL2CPP 构建：Managed/ 目录与
// MonoBleedingEdge 消失，BepInEx 5 + System.Reflection 那套不再可用。本版迁移到
// BepInEx 6 + 原生 il2cpp API：直接 DllImport("GameAssembly") 调用 il2cpp_class_*
// / il2cpp_field_* / il2cpp_runtime_invoke，按「程序集/类名/字段名」在运行时查找。
//
// 【为什么不依赖生成的代理程序集】
// 常见的另一种做法是让 BepInEx 生成 Il2CppInterop 代理 DLL 后用强类型引用。
// 这里改用原生 API + 配置驱动，好处：游戏每次更新导致字段改名时，改 cfg 即可，
// 不必重新生成代理、也不必重新编译本 DLL；且编译期不依赖任何游戏程序集。
//
// 【类/字段名从哪来】
// 沿用 Mono 版反编译确认的结构（IL2CPP 由同一套 C# 源码编译，结构一致）：
//   Player.dead                        static bool
//   Data.saveFile.currentGameSave.hp   static -> instance -> instance, float
//   Player.MaxHP()                     static 无参方法, 返回 float
//   Data.saveFile.currentGameSave.marks
//   MainManager.I.currentBoss / bossKillCount / finalBossSecondPhase
//   OpponentsManager.I.killCountPerSegment (int[]) / activeOpponents (List)
// 这些名字全部可在 BepInEx 配置里覆盖；启动时逐个探测并打印日志，方便更新后校正。
// 注意：C# 属性在 IL2CPP 里是 get_Xxx 方法而非字段，配置里已区分「字段」与「方法」。

using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Unity.IL2CPP;
using BepInEx.Logging;

[BepInPlugin(PluginGuid, PluginName, PluginVersion)]
public class KorridorHpBridgePlugin : BasePlugin
{
    public const string PluginGuid = "com.dglab.korridor.hpbridge";
    public const string PluginName = "Korridor HP Bridge";
    public const string PluginVersion = "2.0.0";

    // 自建日志源（名字避开基类 Log，方便传给原生层）
    private static ManualLogSource BridgeLog;

    // ===== 可配置项 =====
    private ConfigEntry<string> cfgPushUrl;
    private ConfigEntry<string> cfgApiKey;
    private ConfigEntry<int> cfgPollIntervalMs;
    private ConfigEntry<int> cfgHeartbeatMs;

    // 类/字段名配置（IL2CPP 更新后若改名，改这里即可，无需重编译）
    private ConfigEntry<string> cfgAssembly;        // 游戏程序集名，通常 Assembly-CSharp
    private ConfigEntry<string> cfgPlayerClass;
    private ConfigEntry<string> cfgDataClass;
    private ConfigEntry<string> cfgMainManagerClass;
    private ConfigEntry<string> cfgOpponentsClass;
    private ConfigEntry<string> cfgDeadField;
    private ConfigEntry<string> cfgMaxHpMethod;
    private ConfigEntry<string> cfgSaveFileField;
    private ConfigEntry<string> cfgCurrentGameSaveField;
    private ConfigEntry<string> cfgHpField;
    private ConfigEntry<string> cfgMarksField;
    private ConfigEntry<string> cfgInstanceField;
    private ConfigEntry<string> cfgCurrentBossField;
    private ConfigEntry<string> cfgBossKillCountField;
    private ConfigEntry<string> cfgBossPhase2Field;
    private ConfigEntry<string> cfgKillCountPerSegmentField;
    private ConfigEntry<string> cfgActiveOpponentsField;
    private ConfigEntry<bool> cfgVerboseProbe;      // 打印每个字段探测结果

    // ===== 状态与推送 =====
    private float lastPercent = -1f;
    private bool lastDead;
    private GameExtras lastExtras;
    private bool extrasInitialized;
    private DateTime nextHeartbeat = DateTime.MinValue;
    private readonly ConcurrentQueue<string> pushQueue = new ConcurrentQueue<string>();
    private Thread pollThread;
    private Thread pushThread;
    private volatile bool running;

    private struct GameExtras
    {
        public int marks;
        public int kills;
        public bool bossActive;
        public int bossKills;
        public bool bossPhase2;
        public int enemies;
    }

    public override void Load()
    {
        BridgeLog = BepInEx.Logging.Logger.CreateLogSource(PluginName);
        InitializeConfig();
        running = true;

        Il2CppNative.Init(cfgAssembly.Value, cfgVerboseProbe.Value, BridgeLog);
        Il2CppNative.ProbeAll(this);

        pollThread = new Thread(PollLoop) { IsBackground = true, Name = "KorridorHpBridge-Poll" };
        pollThread.Start();
        pushThread = new Thread(PushLoop) { IsBackground = true, Name = "KorridorHpBridge-Push" };
        pushThread.Start();

        BridgeLog.LogInfo($"{PluginName} v{PluginVersion} 已加载（IL2CPP），推送目标 {cfgPushUrl.Value}");
    }

    public override bool Unload()
    {
        running = false;
        BridgeLog.LogInfo($"{PluginName} 已卸载");
        return true;
    }

    private void InitializeConfig()
    {
        cfgPushUrl = Config.Bind("Bridge", "PushUrl", "http://127.0.0.1:9996/game-state",
            "外部联动服务接收状态的地址");
        cfgApiKey = Config.Bind("Bridge", "ApiKey", "",
            "若联动服务设置了 token，这里填相同的 X-API-Key");
        cfgPollIntervalMs = Config.Bind("Bridge", "PollIntervalMs", 200,
            "检测状态的间隔（毫秒）");
        cfgHeartbeatMs = Config.Bind("Bridge", "HeartbeatMs", 3000,
            "即使状态无变化也推送当前状态的间隔（毫秒）");

        cfgAssembly = Config.Bind("Il2Cpp", "Assembly", "Assembly-CSharp",
            "游戏主程序集名");
        cfgPlayerClass = Config.Bind("Il2Cpp", "PlayerClass", "Player",
            "玩家类全名（含命名空间，如 Game.Player；不确定就先填短名）");
        cfgDataClass = Config.Bind("Il2Cpp", "DataClass", "Data", "Data 类名");
        cfgMainManagerClass = Config.Bind("Il2Cpp", "MainManagerClass", "MainManager", "MainManager 类名");
        cfgOpponentsClass = Config.Bind("Il2Cpp", "OpponentsClass", "OpponentsManager", "OpponentsManager 类名");

        cfgDeadField = Config.Bind("Fields", "DeadField", "dead", "Player 上的死亡标志字段名（bool）");
        cfgMaxHpMethod = Config.Bind("Fields", "MaxHpMethod", "MaxHP", "Player 上返回最大血量的无参静态方法名");
        cfgSaveFileField = Config.Bind("Fields", "SaveFileField", "saveFile", "Data 上的静态字段名");
        cfgCurrentGameSaveField = Config.Bind("Fields", "CurrentGameSaveField", "currentGameSave", "saveFile 对象上的实例字段名");
        cfgHpField = Config.Bind("Fields", "HpField", "hp", "currentGameSave 对象上的当前血量字段名");
        cfgMarksField = Config.Bind("Fields", "MarksField", "marks", "currentGameSave 对象上的 Marks 字段名");

        cfgInstanceField = Config.Bind("Fields", "InstanceField", "I", "MainManager/OpponentsManager 上的单例静态字段名");
        cfgCurrentBossField = Config.Bind("Fields", "CurrentBossField", "currentBoss", "MainManager 上当前 Boss 字段名（引用类型，null 表示无 Boss）");
        cfgBossKillCountField = Config.Bind("Fields", "BossKillCountField", "bossKillCount", "MainManager 上 Boss 击杀数字段名");
        cfgBossPhase2Field = Config.Bind("Fields", "BossPhase2Field", "finalBossSecondPhase", "MainManager 上 Boss 二阶段字段名（bool）");
        cfgKillCountPerSegmentField = Config.Bind("Fields", "KillCountPerSegmentField", "killCountPerSegment", "OpponentsManager 上各段击杀数字段名（int[]）");
        cfgActiveOpponentsField = Config.Bind("Fields", "ActiveOpponentsField", "activeOpponents", "OpponentsManager 上当前敌人数集合字段名（数组/List）");

        cfgVerboseProbe = Config.Bind("Il2Cpp", "VerboseProbe", true,
            "启动时打印每个类/字段/方法的探测结果（更新后校准字段名时很有用）");
    }

    // ===== 轮询线程（替代 Mono 版 Update）=====
    private void PollLoop()
    {
        // IL2CPP 铁律：外部线程调用任何托管代码前必须先 attach 到 il2cpp domain。
        // 不 attach 时字段读取侥幸能用，但 il2cpp_runtime_invoke（如 Player.MaxHP()）
        // 会触发 AccessViolationException 直接带崩游戏进程。
        if (Il2CppNative.AttachCurrentThread() == IntPtr.Zero)
            BridgeLog.LogWarning("轮询线程未能 attach 到 IL2CPP，将跳过需要执行方法的血量计算");
        try
        {
        while (running)
        {
            try
            {
                float percent;
                bool dead;
                if (TryReadState(out percent, out dead))
                {
                    GameExtras extras;
                    bool hasExtras = TryReadExtras(out extras);
                    if (!hasExtras) extras = lastExtras;

                    bool changed = Math.Abs(percent - lastPercent) >= 0.05f ||
                                   dead != lastDead || ExtrasChanged(extras);
                    bool heartbeat = DateTime.UtcNow >= nextHeartbeat;
                    if (changed || heartbeat || lastPercent < 0f)
                    {
                        lastPercent = percent;
                        lastDead = dead;
                        lastExtras = extras;
                        extrasInitialized = true;
                        nextHeartbeat = DateTime.UtcNow.AddMilliseconds(Math.Max(200, cfgHeartbeatMs.Value));
                        EnqueueState(percent, dead, extras);
                    }
                }
            }
            catch (Exception ex)
            {
                if (cfgVerboseProbe.Value) BridgeLog.LogDebug($"轮询异常：{ex.Message}");
            }
            Thread.Sleep(Math.Max(20, cfgPollIntervalMs.Value));
        }
        }
        finally
        {
            Il2CppNative.DetachCurrentThread();
        }
    }

    private bool ExtrasChanged(GameExtras e)
    {
        if (!extrasInitialized) return true;
        return e.marks != lastExtras.marks || e.kills != lastExtras.kills ||
               e.bossActive != lastExtras.bossActive || e.bossKills != lastExtras.bossKills ||
               e.bossPhase2 != lastExtras.bossPhase2 || e.enemies != lastExtras.enemies;
    }

    // ===== 血量读取 =====
    private bool TryReadState(out float percent, out bool dead)
    {
        percent = 0f;
        dead = false;

        IntPtr playerClass = Il2CppNative.GetClass(cfgPlayerClass.Value);
        IntPtr dataClass = Il2CppNative.GetClass(cfgDataClass.Value);

        // 死亡标志先读（延迟关键）：Player.dead 静态字段，不依赖 MaxHP。
        bool deadKnown = false;
        IntPtr deadField = Il2CppNative.GetField(playerClass, cfgDeadField.Value);
        if (deadField != IntPtr.Zero)
        {
            try { dead = Il2CppNative.ReadStaticBool(deadField); deadKnown = true; }
            catch (Exception) { }
        }

        // Data.saveFile -> currentGameSave -> hp
        IntPtr gameSave = Il2CppNative.GetGameSave(dataClass,
            cfgSaveFileField.Value, cfgCurrentGameSaveField.Value);
        if (gameSave == IntPtr.Zero)
        {
            // 存档未加载（主菜单）：若已确认死亡，按 0% 上报；否则跳过
            if (deadKnown && dead) { percent = 0f; return true; }
            return false;
        }

        float cur = 0f;
        IntPtr hpField = Il2CppNative.GetField(Il2CppNative.GetObjectClass(gameSave), cfgHpField.Value);
        if (hpField == IntPtr.Zero) return false;
        try { cur = Il2CppNative.ReadInstanceFloat(gameSave, hpField); }
        catch (Exception) { return false; }

        // MaxHP()：Player 上的无参静态方法
        float max = -1f;
        IntPtr maxHpMethod = Il2CppNative.GetMethod(playerClass, cfgMaxHpMethod.Value, 0);
        if (maxHpMethod != IntPtr.Zero)
        {
            try { max = Il2CppNative.InvokeStaticFloat(maxHpMethod); }
            catch (Exception) { }
        }

        if (max <= 0f)
        {
            if (deadKnown && dead) { percent = 0f; return true; }
            return false;
        }
        percent = Clamp(cur / max * 100f);
        if (!deadKnown) dead = percent <= 0f;
        return true;
    }

    // ===== 扩展状态读取 =====
    private bool TryReadExtras(out GameExtras e)
    {
        e = new GameExtras();
        try
        {
            IntPtr dataClass = Il2CppNative.GetClass(cfgDataClass.Value);
            IntPtr gameSave = Il2CppNative.GetGameSave(dataClass,
                cfgSaveFileField.Value, cfgCurrentGameSaveField.Value);

            // marks
            if (gameSave != IntPtr.Zero)
            {
                IntPtr marksField = Il2CppNative.GetField(Il2CppNative.GetObjectClass(gameSave), cfgMarksField.Value);
                if (marksField != IntPtr.Zero) e.marks = Il2CppNative.ReadInstanceInt(gameSave, marksField);
            }

            // MainManager.I -> boss 状态
            IntPtr mainClass = Il2CppNative.GetClass(cfgMainManagerClass.Value);
            IntPtr mainMgr = Il2CppNative.GetStaticObjectField(mainClass, cfgInstanceField.Value);
            if (mainMgr != IntPtr.Zero)
            {
                IntPtr mainCls = Il2CppNative.GetObjectClass(mainMgr);
                IntPtr bossField = Il2CppNative.GetField(mainCls, cfgCurrentBossField.Value);
                if (bossField != IntPtr.Zero)
                    e.bossActive = Il2CppNative.ReadInstanceObject(mainMgr, bossField) != IntPtr.Zero;
                IntPtr bossKillsField = Il2CppNative.GetField(mainCls, cfgBossKillCountField.Value);
                if (bossKillsField != IntPtr.Zero) e.bossKills = Il2CppNative.ReadInstanceInt(mainMgr, bossKillsField);
                IntPtr phaseField = Il2CppNative.GetField(mainCls, cfgBossPhase2Field.Value);
                if (phaseField != IntPtr.Zero) e.bossPhase2 = Il2CppNative.ReadInstanceBool(mainMgr, phaseField);
            }

            // OpponentsManager.I -> 击杀数、敌人数
            IntPtr oppClass = Il2CppNative.GetClass(cfgOpponentsClass.Value);
            IntPtr opponents = Il2CppNative.GetStaticObjectField(oppClass, cfgInstanceField.Value);
            if (opponents != IntPtr.Zero)
            {
                IntPtr oppCls = Il2CppNative.GetObjectClass(opponents);
                IntPtr killArrField = Il2CppNative.GetField(oppCls, cfgKillCountPerSegmentField.Value);
                if (killArrField != IntPtr.Zero)
                {
                    IntPtr arr = Il2CppNative.ReadInstanceObject(opponents, killArrField);
                    if (arr != IntPtr.Zero) e.kills = Il2CppNative.SumIntArray(arr);
                }
                IntPtr activeField = Il2CppNative.GetField(oppCls, cfgActiveOpponentsField.Value);
                if (activeField != IntPtr.Zero)
                {
                    IntPtr list = Il2CppNative.ReadInstanceObject(opponents, activeField);
                    if (list != IntPtr.Zero) e.enemies = Il2CppNative.CountCollection(list);
                }
            }
            return true;
        }
        catch (Exception)
        {
            return false; // 游戏未就绪时静默，沿用上次值，不影响血量主线
        }
    }

    // ===== HTTP 推送 =====
    private void EnqueueState(float percent, bool dead, GameExtras extras)
    {
        long ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        string json = $"{{\"hpPercent\":{percent.ToString("F2", CultureInfo.InvariantCulture)}," +
                      $"\"dead\":{(dead ? "true" : "false")}," +
                      $"\"marks\":{extras.marks},\"kills\":{extras.kills}," +
                      $"\"bossActive\":{(extras.bossActive ? "true" : "false")}," +
                      $"\"bossKills\":{extras.bossKills}," +
                      $"\"bossPhase2\":{(extras.bossPhase2 ? "true" : "false")}," +
                      $"\"enemies\":{extras.enemies},\"ts\":{ts}}}";
        pushQueue.Enqueue(json);
        BridgeLog.LogDebug($"状态：HP {percent:F1}% dead={dead} marks={extras.marks} kills={extras.kills} boss={extras.bossActive} 敌人数={extras.enemies}");
    }

    private void PushLoop()
    {
        while (running)
        {
            string json;
            if (!pushQueue.TryDequeue(out json)) { Thread.Sleep(20); continue; }
            string latest;
            while (pushQueue.TryDequeue(out latest)) json = latest;

            for (int attempt = 0; attempt < 3 && running; attempt++)
            {
                try { HttpPost(cfgPushUrl.Value, json, cfgApiKey.Value); break; }
                catch (Exception ex)
                {
                    BridgeLog.LogWarning($"推送失败（第 {attempt + 1} 次）：{ex.Message}");
                    string newer;
                    while (pushQueue.TryDequeue(out newer)) json = newer;
                    Thread.Sleep(200);
                }
            }
        }
    }

    private static void HttpPost(string url, string json, string apiKey)
    {
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = "POST";
        req.ContentType = "application/json";
        req.Timeout = 3000;
        req.ReadWriteTimeout = 3000;
        if (!string.IsNullOrEmpty(apiKey)) req.Headers["X-API-Key"] = apiKey;
        byte[] bytes = Encoding.UTF8.GetBytes(json);
        req.ContentLength = bytes.Length;
        using (System.IO.Stream stream = req.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
        using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            if ((int)resp.StatusCode >= 400) throw new Exception($"HTTP {(int)resp.StatusCode}");
    }

    private static float Clamp(float v)
    {
        if (float.IsNaN(v)) return 0f;
        return v < 0f ? 0f : (v > 100f ? 100f : v);
    }

    // 供 Il2CppNative.ProbeAll 读取当前配置
    internal string Asm => cfgAssembly.Value;
    internal string PlayerClass => cfgPlayerClass.Value;
    internal string DataClass => cfgDataClass.Value;
    internal string MainManagerClass => cfgMainManagerClass.Value;
    internal string OpponentsClass => cfgOpponentsClass.Value;
    internal string DeadField => cfgDeadField.Value;
    internal string MaxHpMethod => cfgMaxHpMethod.Value;
    internal string SaveFileField => cfgSaveFileField.Value;
    internal string CurrentGameSaveField => cfgCurrentGameSaveField.Value;
    internal string HpField => cfgHpField.Value;
    internal string MarksField => cfgMarksField.Value;
    internal string InstanceField => cfgInstanceField.Value;
    internal string CurrentBossField => cfgCurrentBossField.Value;
    internal string BossKillCountField => cfgBossKillCountField.Value;
    internal string BossPhase2Field => cfgBossPhase2Field.Value;
    internal string KillCountPerSegmentField => cfgKillCountPerSegmentField.Value;
    internal string ActiveOpponentsField => cfgActiveOpponentsField.Value;
    internal bool VerboseProbe => cfgVerboseProbe.Value;
}
