# CapturePack — Context Host (issues #64, #65).
#
# RESIDENT, READ-ONLY, NDJSON OVER STDIO. This is the process that gives Core the
# Win32 facts Electron cannot reach: `electron.screen` knows only displays,
# `getNativeWindowHandle()` only our own windows, and `desktopCapturer` gives
# neither bounds nor z-order. Lane S — the Platform Surface Timeline's sampler
# (#65) — lives here.
#
# FOUR HARD RULES, inherited from scripts/uia-dump.ps1 and extended:
#  1. A capture must NEVER fail because of this. Every failure path answers with
#     an error line and keeps the host alive; the host dying is survivable too
#     (Core restarts it, and the surface ring simply has a gap).
#  2. A capture must NEVER be slowed down by this. Sampling is a fixed cadence
#     with a measured cost, not work triggered by a capture.
#  3. IT IS READ-ONLY. It reads window geometry and identity through
#     EnumWindows / GetWindowRect / DwmGetWindowAttribute / GetClientRect /
#     GetWindowText / GetClassName / GetWindowThreadProcessId /
#     QueryFullProcessImageName and NOTHING ELSE. It never synthesizes keyboard
#     or mouse input, never moves / focuses / resizes / closes a window, never
#     invokes a control pattern, and never writes a file. The one state it
#     changes is its OWN process's DPI awareness. Run it standalone as often as
#     you like:  powershell -NoProfile -File scripts/context-host.ps1 -SelfTest 100
#  4. NEW — IT MUST BE CHEAPER THAN THE THING IT OBSERVES. It publishes its own
#     duty cycle and working set on every status event, and Core degrades or
#     stops it when the budget is exceeded (GOAL.md "Capture must stay cheap": a
#     resident tool that eats a core is a tool people quit). A lane that cannot
#     state its cost gets turned off.
#
# WHY PER-MONITOR DPI AWARENESS IS THE FIRST THING IT DOES. The protocol declares
# ONE coordinate space — virtual-desktop physical pixels — and it declares it
# because the alternative is every provider guessing (docs/temporal-protocol.md
# GAP 10). A process that is not per-monitor DPI aware is handed VIRTUALIZED
# rectangles by Windows, scaled by (system DPI / monitor DPI) and NOT uniformly
# across monitors, which is exactly the mess src/main/uia.ts carries 40 lines of
# comment about. Declaring awareness up front makes every rectangle below
# physical by construction, on every monitor, whatever their scale factors are.
#
# WHY THE DWM EXTENDED FRAME AND NOT GetWindowRect. Windows 10/11 add an
# invisible resize border outside the visible frame, and GetWindowRect includes
# it — every surface would be a few pixels too big, and every edge hit-test
# wrong. DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS) is what the user
# actually sees. GetWindowRect remains the fallback for a window DWM refuses.
#
# PROTOCOL. One JSON document per line, both directions (JSON cannot contain a
# raw newline, so a line is a frame). Requests carry an integer `id`; responses
# echo it. Unsolicited lines carry `event` instead.
#
#   -> {"id":1,"method":"hello"}
#   <- {"id":1,"ok":true,"hostMs":12.3,"pid":1234,"dpi":"per-monitor-v2","monitors":[...]}
#   -> {"id":2,"method":"surface.start","params":{"intervalMs":100}}
#   <- {"id":2,"ok":true}
#   <- {"event":"surface","t":112.7,"w":[{...}]}                    (one per sample)
#   <- {"event":"status","t":5012.4,"dutyCycle":0.0064,"ws":91750400,...}
#   -> {"id":3,"method":"ping"}          the clock probe (protocol GAP 3)
#   <- {"id":3,"ok":true,"hostMs":5120.9}
#   -> {"id":4,"method":"surface.stop"}   -> {"id":5,"method":"shutdown"}
#
# `hostMs` is a Stopwatch reading, i.e. MONOTONIC and measured from host start —
# never a wall clock. Core pairs it with its own session clock through the
# ping/pong offset estimator, exactly as it does for an external provider's
# TickAck, and the residual is folded into TemporalAccuracy.errorMs.
#
# STDIN IS THE LIFELINE: when Core exits, stdin reaches EOF and this process
# exits with it. There is no orphaned host, and no watchdog is needed for one.

param(
  # Standalone benchmark: take N samples at -Interval ms, print the cost, exit.
  # This is the measurement the design's numbers have to be checked against, and
  # it is deliberately runnable without Electron.
  [int]$SelfTest = 0,
  [int]$Interval = 100
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Window titles are routinely non-ASCII; numbers are formatted culture-invariantly
# so a comma-decimal locale can never produce malformed JSON.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture

# The whole Win32 surface pass is C#, compiled once at startup (~140 ms), for one
# reason: the pass is the only thing in this process that runs ten times a
# second, and a PowerShell loop making a dozen P/Invoke calls per window would
# cost more than the data is worth. Measured cost of the compiled pass is in the
# report; the PowerShell loop around it does one string write per sample.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace CapturePack {

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }

  public static class SurfaceLane {
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    // CharSet.Unicode is load-bearing: without it this binds GetMonitorInfoA,
    // whose MONITORINFOEX is 72 bytes against the 104 a Unicode struct reports
    // in cbSize — and the call then fails for every monitor, silently, leaving
    // the host claiming a desktop with no displays.
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetRect(IntPtr h, int attr, out RECT val, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetInt(IntPtr h, int attr, out int val, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder name, ref int size);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX {
      public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const int DWMWA_CLOAKED = 14;
    const uint GW_OWNER = 4;
    const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    // pid -> executable name. Opening a process costs ~100x a window rect read,
    // so it is done once per pid and the whole table is dropped periodically:
    // Windows recycles pids, and a stale name on a recycled pid would be a quiet
    // lie in every later sample.
    static readonly Dictionary<uint, string> ExeNames = new Dictionary<uint, string>();
    static readonly Stopwatch ExeAge = Stopwatch.StartNew();

    static readonly StringBuilder TitleBuf = new StringBuilder(512);
    static readonly StringBuilder ClassBuf = new StringBuilder(256);
    static readonly StringBuilder Out = new StringBuilder(64 * 1024);
    static readonly List<IntPtr> Handles = new List<IntPtr>(512);
    static readonly EnumWindowsProc Collect = CollectHandle;

    /// Last GetWindowRect per window, and the invisible-border inset learned
    /// from a sample where it had not moved. See the frame branch in Sample().
    /// Both are cleared wholesale when they grow past a desk's worth of windows
    /// — a handle that is gone costs one stale entry until then, and the next
    /// two samples rebuild everything that is still there.
    static readonly Dictionary<long, RECT> LastRaw = new Dictionary<long, RECT>();
    static readonly Dictionary<long, RECT> Inset = new Dictionary<long, RECT>();
    const int GEOMETRY_CACHE_LIMIT = 512;

    public static string DpiMode = "unaware";
    public static long SampleTicks;
    public static long SampleCount;
    public static int LastWindowCount;

    /// Declares this process per-monitor DPI aware, so every rectangle it reads
    /// is physical. Best available API first; each fallback is a strictly older
    /// Windows. Called once, before anything reads a rectangle.
    public static void Init() {
      try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { DpiMode = "per-monitor-v2"; return; } } catch { }
      try { if (SetProcessDpiAwareness(2) == 0) { DpiMode = "per-monitor"; return; } } catch { }
      try { if (SetProcessDPIAware()) { DpiMode = "system"; return; } } catch { }
    }

    static bool CollectHandle(IntPtr hWnd, IntPtr param) { Handles.Add(hWnd); return true; }

    static string ExeName(uint pid) {
      if (ExeAge.Elapsed.TotalSeconds > 300) { ExeNames.Clear(); ExeAge.Restart(); }
      string cached;
      if (ExeNames.TryGetValue(pid, out cached)) return cached;
      string name = "";
      IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (handle != IntPtr.Zero) {
        try {
          StringBuilder buffer = new StringBuilder(512);
          int size = buffer.Capacity;
          if (QueryFullProcessImageNameW(handle, 0, buffer, ref size)) {
            string full = buffer.ToString();
            int slash = full.LastIndexOf('\\');
            name = slash >= 0 ? full.Substring(slash + 1) : full;
          }
        } catch { } finally { CloseHandle(handle); }
      }
      ExeNames[pid] = name;
      return name;
    }

    static void AppendJsonString(StringBuilder sb, string value) {
      sb.Append('"');
      if (value != null) {
        for (int i = 0; i < value.Length; i++) {
          char c = value[i];
          if (c == '"') sb.Append("\\\"");
          else if (c == '\\') sb.Append("\\\\");
          else if (c < 0x20) sb.Append(' ');   // a control char can never break a line
          else sb.Append(c);
        }
      }
      sb.Append('"');
    }

    static void AppendRect(StringBuilder sb, int l, int t, int r, int b) {
      sb.Append('[').Append(l.ToString(CultureInfo.InvariantCulture)).Append(',')
        .Append(t.ToString(CultureInfo.InvariantCulture)).Append(',')
        .Append((r - l).ToString(CultureInfo.InvariantCulture)).Append(',')
        .Append((b - t).ToString(CultureInfo.InvariantCulture)).Append(']');
    }

    /// ONE lane S sample as a JSON line body. EnumWindows returns top-level
    /// windows in Z-ORDER, topmost first — that order IS the z-order recorded
    /// here, and it is the whole reason this pass is worth 0.6 ms.
    /// Whether the LAST dump saw any visible window's rectangle differ from the
    /// dump before it. The resident loop reads this to pick its next sleep: a
    /// desk in motion is observed at the fast cadence, a still desk at the base
    /// one — which is what keeps the fast rate inside the duty-cycle promise,
    /// because hands move windows for seconds, not hours (#110).
    public static bool MovedLastSample;

    public static string Sample(double hostMs) {
      long started = Stopwatch.GetTimestamp();
      bool anyMoved = false;
      if (LastRaw.Count > GEOMETRY_CACHE_LIMIT) { LastRaw.Clear(); Inset.Clear(); }
      Handles.Clear();
      EnumWindows(Collect, IntPtr.Zero);
      IntPtr foreground = GetForegroundWindow();
      Out.Length = 0;
      Out.Append("{\"event\":\"surface\",\"w\":[");
      int kept = 0;
      int z = 0;
      for (int i = 0; i < Handles.Count; i++) {
        IntPtr h = Handles[i];
        bool visible = IsWindowVisible(h);
        if (!visible) continue;            // invisible top-levels are 96% of the list
        int cloakedValue = 0;
        bool cloaked = DwmGetInt(h, DWMWA_CLOAKED, out cloakedValue, 4) == 0 && cloakedValue != 0;
        // THE DWM FRAME IS A CACHE, AND A DRAGGED WINDOW OUTRUNS IT.
        //
        // DWMWA_EXTENDED_FRAME_BOUNDS is what the compositor last published, so
        // it is exact on a window standing still and BEHIND one being moved.
        // GetWindowRect is the window manager's own answer and updates with the
        // drag, but it includes the invisible resize border this whole branch
        // exists to remove.
        //
        // Measured on CapturePack_2026-07-29_143319 (rc.15, every clock leg
        // already at 1 ms): while a File Explorer window was shaken, the box was
        // drawn ~300 px behind it in the direction of travel, and the recorded
        // rectangle held one position for three consecutive samples while the
        // frames showed it already elsewhere. At rest the same window matched
        // for 26 samples without a pixel of error. "흔들면 싱크가 안맞아".
        //
        // So POSITION comes from GetWindowRect and the BORDER comes from DWM —
        // and the border is only learned from samples where the window did not
        // move between the two reads, which is the only time the difference
        // between them is the border rather than the border plus however far it
        // travelled. The inset is a property of the window's frame style, so one
        // learned at rest stays right while it moves.
        RECT frame;
        RECT raw;
        RECT dwm;
        bool haveRaw = GetWindowRect(h, out raw);
        bool haveDwm = DwmGetRect(h, DWMWA_EXTENDED_FRAME_BOUNDS, out dwm, Marshal.SizeOf(typeof(RECT))) == 0;
        if (haveRaw) {
          long key = h.ToInt64();
          RECT previous;
          bool stood_still = LastRaw.TryGetValue(key, out previous) &&
            previous.Left == raw.Left && previous.Top == raw.Top &&
            previous.Right == raw.Right && previous.Bottom == raw.Bottom;
          if (!stood_still) anyMoved = true;
          if (haveDwm && stood_still) {
            RECT learned;
            learned.Left = dwm.Left - raw.Left;
            learned.Top = dwm.Top - raw.Top;
            learned.Right = dwm.Right - raw.Right;
            learned.Bottom = dwm.Bottom - raw.Bottom;
            Inset[key] = learned;
          }
          LastRaw[key] = raw;
          RECT known;
          if (Inset.TryGetValue(key, out known)) {
            frame.Left = raw.Left + known.Left;
            frame.Top = raw.Top + known.Top;
            frame.Right = raw.Right + known.Right;
            frame.Bottom = raw.Bottom + known.Bottom;
          } else if (haveDwm) {
            // Never seen at rest yet: the DWM frame is still the better of the
            // two, and one sample from now the inset will be known.
            frame = dwm;
          } else {
            frame = raw;
          }
        } else if (haveDwm) {
          frame = dwm;
        } else {
          continue;
        }
        bool minimized = IsIconic(h);
        int width = frame.Right - frame.Left, height = frame.Bottom - frame.Top;
        if (!minimized && (width <= 0 || height <= 0)) continue;
        RECT client; POINT origin;
        client.Left = 0; client.Top = 0; client.Right = 0; client.Bottom = 0;
        origin.X = 0; origin.Y = 0;
        if (GetClientRect(h, out client) && ClientToScreen(h, ref origin)) {
          client.Left += origin.X; client.Top += origin.Y;
          client.Right += origin.X; client.Bottom += origin.Y;
        } else {
          client = frame;
        }
        uint pid; GetWindowThreadProcessId(h, out pid);
        TitleBuf.Length = 0; GetWindowTextW(h, TitleBuf, TitleBuf.Capacity);
        ClassBuf.Length = 0; GetClassNameW(h, ClassBuf, ClassBuf.Capacity);
        IntPtr owner = GetWindow(h, GW_OWNER);
        if (kept > 0) Out.Append(',');
        Out.Append("{\"h\":\"").Append(((ulong)h.ToInt64()).ToString(CultureInfo.InvariantCulture))
           .Append("\",\"o\":\"").Append(((ulong)owner.ToInt64()).ToString(CultureInfo.InvariantCulture))
           .Append("\",\"p\":").Append(pid.ToString(CultureInfo.InvariantCulture))
           .Append(",\"z\":").Append(z.ToString(CultureInfo.InvariantCulture))
           .Append(",\"v\":1")
           .Append(",\"m\":").Append(minimized ? '1' : '0')
           .Append(",\"g\":").Append(h == foreground ? '1' : '0')
           .Append(",\"k\":").Append(cloaked ? '1' : '0')
           .Append(",\"b\":");
        AppendRect(Out, frame.Left, frame.Top, frame.Right, frame.Bottom);
        Out.Append(",\"c\":");
        AppendRect(Out, client.Left, client.Top, client.Right, client.Bottom);
        Out.Append(",\"t\":"); AppendJsonString(Out, TitleBuf.ToString());
        Out.Append(",\"cl\":"); AppendJsonString(Out, ClassBuf.ToString());
        Out.Append(",\"e\":"); AppendJsonString(Out, ExeName(pid));
        Out.Append('}');
        kept++; z++;
      }
      Out.Append("]}");
      long spent = Stopwatch.GetTimestamp() - started;
      // WHEN THIS SAMPLE WAS ACTUALLY TAKEN (#110).
      //
      // `t` used to be stamped by the CALLER, before this method ran — so it was
      // the instant the host DECIDED to look, not the instant it looked. Every
      // geometry read in the loop above happens after it. Core files the sample
      // at `frameMs + (t - askedAt)`, so a dump costing D ms filed every
      // rectangle D ms EARLY: a one-directional error, invisible on a still
      // desktop and exactly proportional to drag speed. The same shape of
      // mistake as #105, one layer further down.
      //
      // The dump is not an instant, it is an interval, and no single number is
      // right for every window in it — the first window read is at `started` and
      // the last at `started + D`. The MIDPOINT is the least wrong one number,
      // and it is honest: worst case half the dump instead of all of it.
      //
      // `dumpMs` goes out too, because a cost nobody can see is a cost nobody
      // fixes — that is how this one survived to be found by arithmetic.
      double dumpMs = (double)spent * 1000.0 / (double)Stopwatch.Frequency;
      Out.Insert(1, "\"t\":" +
        (hostMs + dumpMs / 2.0).ToString("F1", CultureInfo.InvariantCulture) +
        ",\"dumpMs\":" + dumpMs.ToString("F1", CultureInfo.InvariantCulture) + ",");
      SampleTicks += spent;
      SampleCount++;
      LastWindowCount = kept;
      MovedLastSample = anyMoved;
      return Out.ToString();
    }

    /// Every display's rectangle in the SAME physical space as the windows
    /// above — the yardstick that maps a surface onto one display's snapshot
    /// pixels (SPEC §8.2). Cheap and read-only; refreshed with every status
    /// event so a display hot-plug is not invisible.
    public static string Monitors() {
      StringBuilder sb = new StringBuilder(512);
      sb.Append('[');
      int count = 0;
      MonitorEnumProc cb = delegate(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data) {
        MONITORINFOEX info = new MONITORINFOEX();
        info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        if (GetMonitorInfo(hMonitor, ref info)) {
          if (count > 0) sb.Append(',');
          sb.Append("{\"d\":"); AppendJsonString(sb, info.szDevice);
          sb.Append(",\"primary\":").Append((info.dwFlags & 1) != 0 ? "true" : "false");
          sb.Append(",\"b\":");
          AppendRect(sb, info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right, info.rcMonitor.Bottom);
          sb.Append('}');
          count++;
        }
        return true;
      };
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
      sb.Append(']');
      return sb.ToString();
    }

    /// Milliseconds of CPU this process has spent INSIDE Sample(), which is the
    /// only number that can honestly be called the lane's cost.
    public static double SampleMs() {
      return (double)SampleTicks * 1000.0 / (double)Stopwatch.Frequency;
    }
  }

  /// Requests from Core, read on a BACKGROUND THREAD.
  ///
  /// This class exists because of a measured trap: Console.In in .NET Framework
  /// is a SyncTextReader whose ReadLineAsync is `Task.FromResult(ReadLine())` —
  /// it BLOCKS, despite the name and despite returning a Task. A host loop built
  /// on it stops sampling entirely and only wakes up when Core happens to send a
  /// request: measured 2 samples in 20 seconds instead of 200. One dedicated
  /// reader thread plus an event is the fix, and it also means a request is
  /// noticed the instant it arrives rather than at the next sampling tick.
  public static class HostInput {
    static readonly System.Collections.Concurrent.ConcurrentQueue<string> Lines =
      new System.Collections.Concurrent.ConcurrentQueue<string>();
    static readonly System.Threading.AutoResetEvent Signal = new System.Threading.AutoResetEvent(false);
    public static volatile bool Closed;

    public static void Start() {
      System.Threading.Thread reader = new System.Threading.Thread(delegate() {
        try {
          while (true) {
            string line = Console.In.ReadLine();
            if (line == null) break;          // Core exited: stdin is at EOF
            Lines.Enqueue(line);
            Signal.Set();
          }
        } catch { }
        Closed = true;
        Signal.Set();
      });
      reader.IsBackground = true;             // never keeps this process alive
      reader.Start();
    }

    /// True when a line is available now or arrived within `ms`.
    public static bool Wait(int ms) {
      if (!Lines.IsEmpty) return true;
      if (Closed) return true;
      return Signal.WaitOne(ms < 0 ? 0 : ms);
    }

    public static string TryRead() {
      string line;
      return Lines.TryDequeue(out line) ? line : null;
    }

    public static bool Drained() { return Lines.IsEmpty; }
  }
}
'@

[CapturePack.SurfaceLane]::Init() | Out-Null

$clock = [System.Diagnostics.Stopwatch]::StartNew()
$self = [System.Diagnostics.Process]::GetCurrentProcess()

function Write-Line([string]$line) {
  [Console]::Out.Write($line)
  [Console]::Out.Write("`n")
  [Console]::Out.Flush()
}

function Get-HostMs { return [Math]::Round($clock.Elapsed.TotalMilliseconds, 1) }

function Write-Status {
  $self.Refresh()
  $wall = $clock.Elapsed.TotalMilliseconds
  $sample = [CapturePack.SurfaceLane]::SampleMs()
  $duty = if ($wall -gt 0) { [Math]::Round($sample / $wall, 6) } else { 0 }
  Write-Line ('{"event":"status","t":' + (Get-HostMs) +
    ',"dutyCycle":' + $duty +
    ',"sampleMs":' + [Math]::Round($sample, 1) +
    ',"samples":' + [CapturePack.SurfaceLane]::SampleCount +
    ',"windows":' + [CapturePack.SurfaceLane]::LastWindowCount +
    ',"cpuMs":' + [Math]::Round($self.TotalProcessorTime.TotalMilliseconds, 0) +
    ',"ws":' + $self.WorkingSet64 +
    ',"monitors":' + [CapturePack.SurfaceLane]::Monitors() + '}')
}

# ---------------------------------------------------------------------------
# Standalone benchmark (-SelfTest N): the numbers in the report come from here
# ---------------------------------------------------------------------------
if ($SelfTest -gt 0) {
  $ticks = 0
  $bytes = 0
  for ($i = 0; $i -lt $SelfTest; $i++) {
    $startedAt = $clock.Elapsed.TotalMilliseconds
    $line = [CapturePack.SurfaceLane]::Sample((Get-HostMs))
    $bytes += $line.Length
    $ticks++
    $wait = $Interval - ($clock.Elapsed.TotalMilliseconds - $startedAt)
    if ($wait -gt 0) { [System.Threading.Thread]::Sleep([int]$wait) }
  }
  $self.Refresh()
  $wall = $clock.Elapsed.TotalMilliseconds
  $sample = [CapturePack.SurfaceLane]::SampleMs()
  Write-Line ('{"event":"selftest","samples":' + $ticks +
    ',"windows":' + [CapturePack.SurfaceLane]::LastWindowCount +
    ',"perSampleMs":' + [Math]::Round($sample / [Math]::Max(1, $ticks), 3) +
    ',"bytesPerSample":' + [int]($bytes / [Math]::Max(1, $ticks)) +
    ',"dutyCycle":' + [Math]::Round($sample / $wall, 6) +
    ',"processCpuMs":' + [Math]::Round($self.TotalProcessorTime.TotalMilliseconds, 0) +
    ',"processDutyCycle":' + [Math]::Round($self.TotalProcessorTime.TotalMilliseconds / $wall, 6) +
    ',"ws":' + $self.WorkingSet64 +
    ',"wallMs":' + [Math]::Round($wall, 0) +
    ',"dpi":"' + [CapturePack.SurfaceLane]::DpiMode + '"}')
  exit 0
}

# ---------------------------------------------------------------------------
# Resident loop
# ---------------------------------------------------------------------------

# PowerShell has one thread, so a blocking read would stall sampling and a
# sampling loop that never reads would stall requests. CapturePack.HostInput
# owns a reader thread and an event, so this loop can wait for EITHER the next
# sampling instant OR a request, whichever comes first — see the class for the
# measured trap that made a background thread necessary.
[CapturePack.HostInput]::Start()

function Get-NextLine([int]$waitMs) {
  if (-not [CapturePack.HostInput]::Wait($waitMs)) { return $null }
  return [CapturePack.HostInput]::TryRead()
}

$sampling = $false
$intervalMs = 100
# The MOTION cadence (#110): when the previous dump saw any window move, the
# next sample comes this soon instead of $intervalMs later. 0 = feature off.
# Hands move windows for seconds, not hours, so the duty-cycle promise is kept
# by construction: the fast rate only ever runs while something is moving.
$fastMs = 0
$nextSampleMs = 0
$nextStatusMs = 5000
$running = $true

while ($running) {
  $nowMs = $clock.Elapsed.TotalMilliseconds
  if ($sampling -and $nowMs -ge $nextSampleMs) {
    try {
      Write-Line ([CapturePack.SurfaceLane]::Sample((Get-HostMs)))
    } catch {
      # Rule 1: a failed sample is a gap in the ring, never the end of the host.
      Write-Line ('{"event":"error","t":' + (Get-HostMs) + ',"where":"sample","message":' +
        (ConvertTo-Json ([string]$_.Exception.Message) -Compress) + '}')
    }
    # Fixed cadence rather than sleep-after-work, so a slow sample does not
    # permanently shift the sampling grid. The STEP adapts (#110): a desk seen
    # moving is observed again at $fastMs, a still one at $intervalMs.
    $step = $intervalMs
    if ($fastMs -gt 0 -and [CapturePack.SurfaceLane]::MovedLastSample) { $step = $fastMs }
    $nextSampleMs += $step
    if ($nextSampleMs -lt $clock.Elapsed.TotalMilliseconds) {
      $nextSampleMs = $clock.Elapsed.TotalMilliseconds + $step
    }
  }
  if ($clock.Elapsed.TotalMilliseconds -ge $nextStatusMs) {
    Write-Status
    $nextStatusMs += 5000
  }

  # How long we may block waiting for a request: up to the next sample, and
  # never more than a quarter second when idle so a shutdown is prompt.
  $budget = 250
  if ($sampling) {
    $budget = [int][Math]::Max(0, [Math]::Min(250, $nextSampleMs - $clock.Elapsed.TotalMilliseconds))
  }
  $line = Get-NextLine $budget
  # EOF on stdin means Core has exited, and this process must not outlive it —
  # the lifeline that makes an orphaned host impossible. Queued requests are
  # drained first so a shutdown that raced the close is still answered.
  if ($null -eq $line -and [CapturePack.HostInput]::Closed -and [CapturePack.HostInput]::Drained()) { break }
  if ($null -eq $line -or $line.Trim() -eq '') { continue }

  $request = $null
  try { $request = $line | ConvertFrom-Json } catch { $request = $null }
  if ($null -eq $request) {
    Write-Line '{"event":"error","where":"parse","message":"not JSON"}'
    continue
  }
  $id = 0
  if ($null -ne $request.id) { $id = [int]$request.id }
  $method = [string]$request.method

  switch ($method) {
    'hello' {
      Write-Line ('{"id":' + $id + ',"ok":true,"hostMs":' + (Get-HostMs) +
        ',"pid":' + $self.Id +
        ',"dpi":"' + [CapturePack.SurfaceLane]::DpiMode + '"' +
        ',"psVersion":"' + $PSVersionTable.PSVersion.ToString() + '"' +
        ',"lanes":["surface"]' +
        ',"monitors":' + [CapturePack.SurfaceLane]::Monitors() + '}')
    }
    'ping' {
      # The clock probe (protocol GAP 3). Deliberately the cheapest possible
      # answer: anything else in this branch would be measured as clock skew.
      Write-Line ('{"id":' + $id + ',"ok":true,"hostMs":' + (Get-HostMs) + '}')
    }
    'surface.start' {
      if ($null -ne $request.params -and $null -ne $request.params.intervalMs) {
        $requested = [int]$request.params.intervalMs
        # Floor of 15 ms. This used to be 50 with the rationale "below that the
        # host samples more often than the compositor moves anything" — measured
        # false: during a real title-bar drag GetWindowRect changes every 4 ms
        # (12,161 changes across a 52 s shake, p90 6 ms). 15 Hz observation is
        # exactly why a box could not follow a shaken window (#110): the nearest
        # observation to a frame was up to 33 ms — hundreds of pixels — away.
        # At 15 ms a dump costing ~1.5 ms is ~10% of one core, which the
        # governor already watches.
        $intervalMs = [Math]::Max(15, [Math]::Min(5000, $requested))
      }
      # Optional motion cadence: absent or 0 keeps the single-rate behaviour.
      $fastMs = 0
      if ($null -ne $request.params -and $null -ne $request.params.fastMs) {
        $requestedFast = [int]$request.params.fastMs
        if ($requestedFast -gt 0) {
          $fastMs = [Math]::Max(15, [Math]::Min($intervalMs, $requestedFast))
        }
      }
      $sampling = $true
      $nextSampleMs = $clock.Elapsed.TotalMilliseconds
      Write-Line ('{"id":' + $id + ',"ok":true,"intervalMs":' + $intervalMs + ',"fastMs":' + $fastMs + '}')
    }
    'surface.tick' {
      # THE FRAME DRIVES THE OBSERVATION (#105).
      #
      # The free-running loop above samples on ITS OWN clock, and relating that
      # clock to the recorder's is arithmetic — arithmetic whose error is
      # invisible while a window is still and proportional to its speed while it
      # moves. Measured on a real capture: the box lagged the window by 232 px,
      # about 119 ms at the speed it was being dragged.
      #
      # A tick removes the arithmetic. The capture pipeline has just produced a
      # frame; it asks for a sample NOW and hands over that frame's own time, and
      # the sample goes out stamped with it. The two are then the same instant by
      # construction rather than by calculation.
      $frameMs = $null
      if ($null -ne $request.params -and $null -ne $request.params.tMs) {
        $frameMs = [double]$request.params.tMs
      }
      try {
        # `ft` is the FRAME's time; `t` stays the host's own, so the cost of the
        # round trip is still measurable rather than hidden.
        $line = [CapturePack.SurfaceLane]::Sample((Get-HostMs))
        if ($null -ne $frameMs) {
          $line = $line.Insert(1, '"ft":' + [Math]::Round($frameMs, 3) + ',')
        }
        Write-Line $line
        Write-Line ('{"id":' + $id + ',"ok":true}')
      } catch {
        Write-Line ('{"id":' + $id + ',"ok":false,"error":' +
          (ConvertTo-Json ([string]$_.Exception.Message) -Compress) + '}')
      }
    }
    'surface.stop' {
      $sampling = $false
      Write-Line ('{"id":' + $id + ',"ok":true}')
    }
    'status' {
      Write-Status
      Write-Line ('{"id":' + $id + ',"ok":true}')
    }
    'shutdown' {
      Write-Line ('{"id":' + $id + ',"ok":true}')
      $running = $false
    }
    default {
      Write-Line ('{"id":' + $id + ',"ok":false,"error":"unknown method"}')
    }
  }
}

exit 0
