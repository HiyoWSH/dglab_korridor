// Il2CppNative — IL2CPP 原生 API 封装（无代理程序集，纯 DllImport）
//
// 直接调用 GameAssembly.dll 导出的 il2cpp_* C API，按名字查找类/字段/方法并读写值。
// 这样不依赖 BepInEx 生成的 Il2CppInterop 代理程序集，游戏更新后改配置即可校正名字。
//
// 关键签名来自对 BepInEx 6 自带 Il2CppInterop.Runtime.dll 的反编译核对：
//   il2cpp_class_from_name(IntPtr image, UTF8 string ns, UTF8 string name)
//   il2cpp_field_static_get_value(IntPtr field, void* value)   // unsafe
//   il2cpp_runtime_invoke(IntPtr method, IntPtr obj, void** args, ref IntPtr exc)  // unsafe
//   il2cpp_object_unbox(IntPtr obj) -> IntPtr
//   il2cpp_array_length(IntPtr array) -> uint

using System;
using System.Runtime.InteropServices;
using BepInEx.Logging;

internal static class Il2CppNative
{
    private static string assemblyName = "Assembly-CSharp";
    private static bool verbose;
    private static ManualLogSource log;

    // 仅启动探测阶段打印字段/方法日志。运行时每 200ms 轮询若也打印，
    // 会让 LogOutput.log 疯狂膨胀（实测 21 万行 / 13MB），退出时同步 I/O 与
    // 游戏关闭流程抢锁，表现为「点退出无响应」。
    private static bool probing;

    // 缓存：类指针、image
    private static IntPtr image = IntPtr.Zero;

    internal static void Init(string asm, bool verboseProbe, ManualLogSource logger)
    {
        assemblyName = string.IsNullOrEmpty(asm) ? "Assembly-CSharp" : asm;
        verbose = verboseProbe;
        log = logger;
        image = IntPtr.Zero;
        fieldClassMap.Clear();
        fieldCache.Clear();
        methodCache.Clear();
        probing = false;
    }

    // ===== 原生导入 =====
    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr il2cpp_domain_get();

    // IL2CPP 铁律：任何从外部线程进入托管代码（runtime_invoke / 分配对象等）
    // 之前，必须先把当前线程 attach 到 il2cpp domain，否则 AccessViolation 直接带崩进程。
    // 字段读取（field_get_offset + Marshal.Read）是纯内存操作，不 attach 也能用。
    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr il2cpp_thread_attach(IntPtr domain);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern void il2cpp_thread_detach(IntPtr thread);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr il2cpp_domain_assembly_open(IntPtr domain, [MarshalAs(UnmanagedType.LPStr)] string name);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr il2cpp_assembly_get_image(IntPtr assembly);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr il2cpp_class_from_name(IntPtr image, [MarshalAs(UnmanagedType.LPUTF8Str)] string namespaze, [MarshalAs(UnmanagedType.LPUTF8Str)] string name);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern uint il2cpp_image_get_class_count(IntPtr image);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr il2cpp_image_get_class(IntPtr image, uint index);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr il2cpp_class_get_name(IntPtr klass);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr il2cpp_class_get_namespace(IntPtr klass);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr il2cpp_class_get_field_from_name(IntPtr klass, [MarshalAs(UnmanagedType.LPUTF8Str)] string name);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr il2cpp_class_get_method_from_name(IntPtr klass, [MarshalAs(UnmanagedType.LPUTF8Str)] string name, int argsCount);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern uint il2cpp_field_get_offset(IntPtr field);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern unsafe void il2cpp_field_static_get_value(IntPtr field, void* value);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern unsafe IntPtr il2cpp_runtime_invoke(IntPtr method, IntPtr obj, void** args, ref IntPtr exc);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr il2cpp_object_unbox(IntPtr obj);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr il2cpp_object_get_class(IntPtr obj);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern uint il2cpp_array_length(IntPtr array);

    [DllImport("GameAssembly", CallingConvention = CallingConvention.Cdecl)]
    private static extern uint il2cpp_class_num_fields(IntPtr klass);

    // System.String 转换（用于把字段名 trim，不涉及 il2cpp 字符串）

    // ===== 线程 attach（每个工作线程各调一次）=====
    // 返回本次 thread 句柄，线程退出时传给 DetachCurrentThread。
    // 用 [ThreadStatic] 让每个线程保存自己的句柄，互不干扰。
    [ThreadStatic]
    private static IntPtr attachedThread;

    internal static IntPtr AttachCurrentThread()
    {
        try
        {
            IntPtr domain = il2cpp_domain_get();
            if (domain == IntPtr.Zero) { Warn("thread_attach: domain=0，稍后重试"); return IntPtr.Zero; }
            IntPtr t = il2cpp_thread_attach(domain);
            if (t != IntPtr.Zero) attachedThread = t;
            return t;
        }
        catch (Exception ex) { Warn($"thread_attach 异常：{ex.Message}"); return IntPtr.Zero; }
    }

    internal static void DetachCurrentThread()
    {
        try
        {
            if (attachedThread != IntPtr.Zero) { il2cpp_thread_detach(attachedThread); attachedThread = IntPtr.Zero; }
        }
        catch (Exception) { }
    }

    // ===== image / class 查找 =====
    private static DateTime nextImageWarn = DateTime.MinValue;

    private static IntPtr GetImage()
    {
        if (image != IntPtr.Zero) return image; // 只在成功时锁定缓存
        try
        {
            IntPtr domain = il2cpp_domain_get();
            if (domain == IntPtr.Zero) { WarnThrottled("il2cpp_domain_get 返回 0（尚未就绪）"); return IntPtr.Zero; }
            IntPtr asm = il2cpp_domain_assembly_open(domain, assemblyName);
            if (asm == IntPtr.Zero) { WarnThrottled($"找不到程序集 {assemblyName}（尚未就绪）"); return IntPtr.Zero; }
            image = il2cpp_assembly_get_image(asm);
            if (image == IntPtr.Zero) WarnThrottled("il2cpp_assembly_get_image 返回 0");
        }
        catch (Exception ex) { WarnThrottled($"获取 image 异常：{ex.Message}"); }
        return image;
    }

    private static void WarnThrottled(string msg)
    {
        // 未就绪是启动期的正常现象，限频避免刷屏
        if (DateTime.UtcNow >= nextImageWarn)
        {
            Warn(msg);
            nextImageWarn = DateTime.UtcNow.AddSeconds(10);
        }
    }

    private static readonly System.Collections.Generic.Dictionary<string, IntPtr> classCache =
        new System.Collections.Generic.Dictionary<string, IntPtr>(StringComparer.Ordinal);

    internal static IntPtr GetClass(string fullName)
    {
        if (string.IsNullOrEmpty(fullName)) return IntPtr.Zero;
        IntPtr cached;
        if (classCache.TryGetValue(fullName, out cached) && cached != IntPtr.Zero) return cached;

        IntPtr result = IntPtr.Zero;
        IntPtr img = GetImage();
        if (img != IntPtr.Zero)
        {
            // 优先按 fullName 当作全局命名空间类名
            result = il2cpp_class_from_name(img, "", fullName);
            // 若 fullName 含命名空间（A.B.C），拆成 ns=A.B, name=C 再试
            if (result == IntPtr.Zero)
            {
                int dot = fullName.LastIndexOf('.');
                if (dot > 0)
                    result = il2cpp_class_from_name(img, fullName.Substring(0, dot), fullName.Substring(dot + 1));
            }
            // 兜底：遍历 image 全部类，按短名匹配（忽略大小写）
            if (result == IntPtr.Zero)
                result = FindClassByShortName(img, fullName);
        }
        // 只缓存成功结果；失败则下轮重试（游戏类可能是延迟加载的）
        if (result != IntPtr.Zero) classCache[fullName] = result;
        if (verbose && result != IntPtr.Zero)
            Info($"  类 {fullName} -> 找到 ({PtrToUtf8(il2cpp_class_get_name(result))})");
        return result;
    }

    private static IntPtr FindClassByShortName(IntPtr img, string fullName)
    {
        string target = fullName;
        int dot = fullName.LastIndexOf('.');
        if (dot > 0) target = fullName.Substring(dot + 1);
        uint count = il2cpp_image_get_class_count(img);
        for (uint i = 0; i < count; i++)
        {
            IntPtr k = il2cpp_image_get_class(img, i);
            if (k == IntPtr.Zero) continue;
            string name = PtrToUtf8(il2cpp_class_get_name(k));
            if (string.Equals(name, target, StringComparison.OrdinalIgnoreCase)) return k;
        }
        return IntPtr.Zero;
    }

    // ===== 字段 / 方法查找 =====
    // 缓存 field -> 所属 class，便于读实例字段时判断类型
    private static readonly System.Collections.Generic.Dictionary<IntPtr, IntPtr> fieldClassMap =
        new System.Collections.Generic.Dictionary<IntPtr, IntPtr>();
    // 解析结果缓存：避免每帧重复调 il2cpp_* 查找。key 带类指针，
    // 因为不同类可能有同名字段（如单例字段 I）。只缓存成功结果，失败可下轮重试。
    private static readonly System.Collections.Generic.Dictionary<(IntPtr, string), IntPtr> fieldCache =
        new System.Collections.Generic.Dictionary<(IntPtr, string), IntPtr>();
    private static readonly System.Collections.Generic.Dictionary<(IntPtr, string, int), IntPtr> methodCache =
        new System.Collections.Generic.Dictionary<(IntPtr, string, int), IntPtr>();

    internal static IntPtr GetField(IntPtr klass, string name)
    {
        if (klass == IntPtr.Zero || string.IsNullOrEmpty(name)) return IntPtr.Zero;
        var key = (klass, name);
        IntPtr f;
        if (!fieldCache.TryGetValue(key, out f))
        {
            f = il2cpp_class_get_field_from_name(klass, name);
            if (f != IntPtr.Zero) { fieldCache[key] = f; fieldClassMap[f] = klass; }
        }
        if (verbose && probing)
        {
            if (f != IntPtr.Zero) Info($"    字段 {name} -> 找到");
            else Warn($"    字段 {name} -> 未找到（可能是属性，见 README）");
        }
        return f;
    }

    internal static IntPtr GetMethod(IntPtr klass, string name, int argsCount)
    {
        if (klass == IntPtr.Zero || string.IsNullOrEmpty(name)) return IntPtr.Zero;
        var key = (klass, name, argsCount);
        IntPtr m;
        if (!methodCache.TryGetValue(key, out m))
        {
            m = il2cpp_class_get_method_from_name(klass, name, argsCount);
            if (m != IntPtr.Zero) methodCache[key] = m;
        }
        if (verbose && probing)
        {
            if (m != IntPtr.Zero) Info($"    方法 {name}({argsCount}) -> 找到");
            else Warn($"    方法 {name}({argsCount}) -> 未找到");
        }
        return m;
    }

    // ===== 对象 / 字段链 =====
    internal static IntPtr GetObjectClass(IntPtr obj) => obj == IntPtr.Zero ? IntPtr.Zero : il2cpp_object_get_class(obj);

    internal static IntPtr GetStaticObjectField(IntPtr klass, string fieldName)
    {
        IntPtr f = GetField(klass, fieldName);
        if (f == IntPtr.Zero) return IntPtr.Zero;
        return ReadStaticObject(f);
    }

    // Data.saveFile.currentGameSave -> 返回 gameSave 对象指针
    internal static IntPtr GetGameSave(IntPtr dataClass, string saveFileField, string currentGameSaveField)
    {
        IntPtr sfField = GetField(dataClass, saveFileField);
        if (sfField == IntPtr.Zero) return IntPtr.Zero;
        IntPtr saveFile = ReadStaticObject(sfField);
        if (saveFile == IntPtr.Zero) return IntPtr.Zero; // 主菜单，存档未加载
        IntPtr cgsField = GetField(GetObjectClass(saveFile), currentGameSaveField);
        if (cgsField == IntPtr.Zero) return IntPtr.Zero;
        return ReadInstanceObject(saveFile, cgsField);
    }

    // ===== 值读取 =====
    internal static unsafe bool ReadStaticBool(IntPtr field)
    {
        byte v = 0;
        il2cpp_field_static_get_value(field, &v);
        return v != 0;
    }

    internal static unsafe float ReadStaticFloat(IntPtr field)
    {
        float v = 0f;
        il2cpp_field_static_get_value(field, &v);
        return v;
    }

    internal static unsafe int ReadStaticInt(IntPtr field)
    {
        int v = 0;
        il2cpp_field_static_get_value(field, &v);
        return v;
    }

    internal static unsafe IntPtr ReadStaticObject(IntPtr field)
    {
        IntPtr v = IntPtr.Zero;
        il2cpp_field_static_get_value(field, &v);
        return v;
    }

    // 实例字段：对象指针 + 字段偏移，直接读内存
    internal static bool ReadInstanceBool(IntPtr obj, IntPtr field)
    {
        if (obj == IntPtr.Zero || field == IntPtr.Zero) return false;
        int offset = checked((int)il2cpp_field_get_offset(field));
        return Marshal.ReadByte(obj, offset) != 0;
    }

    internal static int ReadInstanceInt(IntPtr obj, IntPtr field)
    {
        if (obj == IntPtr.Zero || field == IntPtr.Zero) return 0;
        int offset = checked((int)il2cpp_field_get_offset(field));
        return Marshal.ReadInt32(obj, offset);
    }

    internal static float ReadInstanceFloat(IntPtr obj, IntPtr field)
    {
        if (obj == IntPtr.Zero || field == IntPtr.Zero) return 0f;
        int offset = checked((int)il2cpp_field_get_offset(field));
        int bits = Marshal.ReadInt32(obj, offset);
        return BitConverter.Int32BitsToSingle(bits);
    }

    internal static IntPtr ReadInstanceObject(IntPtr obj, IntPtr field)
    {
        if (obj == IntPtr.Zero || field == IntPtr.Zero) return IntPtr.Zero;
        int offset = checked((int)il2cpp_field_get_offset(field));
        return Marshal.ReadIntPtr(obj, offset);
    }

    // 调用无参静态方法，返回 float（如 Player.MaxHP()）
    internal static unsafe float InvokeStaticFloat(IntPtr method)
    {
        if (method == IntPtr.Zero) return -1f;
        IntPtr exc = IntPtr.Zero;
        IntPtr boxed = il2cpp_runtime_invoke(method, IntPtr.Zero, null, ref exc);
        if (exc != IntPtr.Zero || boxed == IntPtr.Zero) return -1f;
        IntPtr unboxed = il2cpp_object_unbox(boxed);
        if (unboxed == IntPtr.Zero) return -1f;
        return BitConverter.Int32BitsToSingle(Marshal.ReadInt32(unboxed));
    }

    // int[] 求和
    internal static int SumIntArray(IntPtr array)
    {
        if (array == IntPtr.Zero) return 0;
        uint len = il2cpp_array_length(array);
        // IL2CPP 数组布局：IntPtr klass, IntPtr monitor, then elements（一维 SZARRAY 无 bounds）
        int dataOffset = IntPtr.Size * 2;
        int sum = 0;
        for (uint i = 0; i < len; i++) sum += Marshal.ReadInt32(array, dataOffset + (int)i * 4);
        return sum;
    }

    // 数组或 List 的元素数
    internal static int CountCollection(IntPtr obj)
    {
        if (obj == IntPtr.Zero) return 0;
        // 先尝试当数组
        try
        {
            uint len = il2cpp_array_length(obj);
            if (len > 0) return (int)len;
        }
        catch (Exception) { }
        // 退回当 List<T>：读 _size 私有字段
        try
        {
            IntPtr cls = GetObjectClass(obj);
            IntPtr f = il2cpp_class_get_field_from_name(cls, "_size");
            if (f != IntPtr.Zero) return ReadInstanceInt(obj, f);
        }
        catch (Exception) { }
        return 0;
    }

    // ===== 启动探测：打印所有配置名是否解析成功 =====
    internal static void ProbeAll(KorridorHpBridgePlugin config)
    {
        if (!verbose) return;
        probing = true;
        try
        {
        Info("===== IL2CPP 字段探测开始 =====");
        IntPtr player = GetClass(config.PlayerClass);
        IntPtr data = GetClass(config.DataClass);
        IntPtr main = GetClass(config.MainManagerClass);
        IntPtr opp = GetClass(config.OpponentsClass);

        GetField(player, config.DeadField);
        GetMethod(player, config.MaxHpMethod, 0);
        IntPtr sf = GetField(data, config.SaveFileField);
        IntPtr saveFile = sf != IntPtr.Zero ? ReadStaticObject(sf) : IntPtr.Zero;
        IntPtr gameSave = IntPtr.Zero;
        if (saveFile != IntPtr.Zero)
        {
            IntPtr cgs = GetField(GetObjectClass(saveFile), config.CurrentGameSaveField);
            if (cgs != IntPtr.Zero) gameSave = ReadInstanceObject(saveFile, cgs);
        }
        if (gameSave != IntPtr.Zero)
        {
            IntPtr cls = GetObjectClass(gameSave);
            GetField(cls, config.HpField);
            GetField(cls, config.MarksField);
        }
        else Warn("  存档未加载（主菜单），跳过 hp/marks 字段探测；进关卡后若日志异常再校准");

        GetField(main, config.InstanceField);
        GetField(opp, config.InstanceField);
        GetField(main, config.CurrentBossField);
        GetField(main, config.BossKillCountField);
        GetField(main, config.BossPhase2Field);
        GetField(opp, config.KillCountPerSegmentField);
        GetField(opp, config.ActiveOpponentsField);
        Info("===== IL2CPP 字段探测结束 =====");
        }
        finally { probing = false; }
    }

    private static string PtrToUtf8(IntPtr p)
    {
        if (p == IntPtr.Zero) return "(null)";
        try { return Marshal.PtrToStringUTF8(p) ?? "(null)"; }
        catch { return "(?)"; }
    }

    private static void Info(string msg) { if (log != null) log.LogInfo(msg); }
    private static void Warn(string msg) { if (log != null) log.LogWarning(msg); }
}
