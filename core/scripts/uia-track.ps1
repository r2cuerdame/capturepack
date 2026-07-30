# CapturePack — Lane A, the resident UI Automation tracker (#65, #111).
#
# WHAT THIS IS FOR. Lane S (scripts/context-host.ps1) records where WINDOWS are,
# 100 times a second, for 0.111 ms a sample. Lane A records where the CONTROLS
# INSIDE them are. Until this file existed, controls were read exactly once — at
# the capture instant — and every earlier frame was served that one reading,
# translated by how far the window had moved (provider.ts `anchored`). That is
# right for a window being dragged and wrong for everything else: a list that
# scrolled, a pane that resized, a dialog that opened. "매프레임 하위 컨트롤러도
# 저장해야지".
#
# WHY IT IS RESIDENT, AND WHY IT IS A SEPARATE PROCESS FROM LANE S.
#
# Resident, because THE ENTIRE WIN IS HOLDING ELEMENT REFERENCES. Measured on
# this machine today:
#
#   full desktop walk, 3 props/elem, 3111 elements       1580.6 ms
#   refresh 2782 HELD refs, BoundingRectangle only        227.2 ms   (7.0x)
#   Explorer: re-find 234 elements                        482.8 ms
#   Explorer: refresh its 234 HELD refs                    17.6 ms   (27x)
#
# A short-lived helper cannot hold anything, so it can only ever pay the walk.
# Per-element refresh cost is also UNIFORM at 55-105 us across Qt, Chromium and
# Explorer, where the walk varies 20x by provider — the incremental path is
# predictable, the walk is not.
#
# A SEPARATE PROCESS, because UI Automation can block for seconds and lane S
# must not. Measured: Docker Desktop, TEN elements, ~2050 ms per pass,
# reproducible across three passes — that one window costs more than the whole
# rest of the desktop combined. Folded into the context host, a single hung
# provider would freeze window geometry sampling, which is the one lane the box
# actually follows. Separate processes mean lane A can hang, be governed, or be
# killed outright while lane S keeps its 10 ms cadence. Rule 1 (a capture never
# fails because of this) and Rule 4 (cheaper than what it observes) both survive
# only at this seam.
#
# WHAT IT DELIBERATELY DOES NOT DO.
#  - No FindAllBuildCache. Measured a NET LOSS: ChatGPT 147.2 -> 652.8 ms (4.4x
#    worse), Explorer 98.7 -> 445.8 (4.5x), desktop-wide 1580 -> 6787 (4.3x). It
#    optimises property round trips, and property round trips are the minority
#    of the cost — a BARE FindAll(Subtree) reading nothing at all is already
#    95.1 of Explorer's 98.7 ms. It wins in exactly one case (an in-process Qt
#    provider) and loses everywhere else.
#  - No window geometry. Win32 GetWindowRect over 17 top-level windows is
#    0.177 ms against 13.05 ms for the UIA top-level enumeration — 74x. Windows
#    are lane S's job and stay there. This lane only ever looks INSIDE a window
#    it is told about.
#  - No input, ever. It reads BoundingRectangle, Name, ControlType, AutomationId
#    and ClassName. It never invokes a pattern, never focuses, never moves
#    anything.
#
# PROTOCOL — NDJSON over stdio, the same shape lane S uses.
#   -> {"id":1,"method":"hello"}
#   <- {"id":1,"ok":true,"hostMs":12.3,"pid":1234}
#   -> {"id":2,"method":"track","params":{"hwnds":["123","456"],"focus":"123"}}
#   <- {"id":2,"ok":true}
#   <- {"event":"tree","t":140.2,"h":"123","v":3,"e":[{...}]}    a fresh walk
#   <- {"event":"rects","t":171.9,"h":"123","v":3,"e":[[7,10,20,30,40]]}  deltas
#   <- {"event":"gone","t":260.0,"h":"123","v":3,"e":[12,13]}    dead refs
#   <- {"event":"status","t":5000,"dutyCycle":0.041,"tracked":4,"elements":612}
#   -> {"id":9,"method":"shutdown"}
#
# `v` is the window's TREE VERSION: it increments on every re-walk, so a `rects`
# line can never be applied to a tree it does not belong to. Core drops any
# delta whose version it does not hold.
#
# STDIN IS THE LIFELINE, exactly as in lane S: EOF means Core is gone and this
# process exits with it.

param(
  # Standalone benchmark: track the foreground window, refresh N times, print
  # the cost, exit. This is how the numbers in this header are checked.
  [int]$SelfTest = 0,
  # Deterministic protocol-wake check. No window, UIA provider, or input.
  [switch]$WakeSelfTest,
  # Deterministic walk-budget check. Exercises the exact production helpers
  # without depending on a live accessibility provider.
  [switch]$BudgetSelfTest
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture

# Assembly loading only — never Add-Type -MemberDefinition, which invokes the
# C# compiler on a code path a capture waits behind.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace CapturePack {

  /// One window's held control tree.
  public class TrackedWindow {
    public long Hwnd;
    public int Version;
    /// The held references. THIS is the asset: re-reading a rectangle off one of
    /// these is 55-105 us, re-finding it is 20-30x that.
    public List<AutomationElement> Elements = new List<AutomationElement>();
    /// Last rectangle emitted per element, so only CHANGES go on the wire.
    public List<double[]> LastRects = new List<double[]>();
    /// Indices whose reference has died and which Core has already been told of.
    public HashSet<int> Dead = new HashSet<int>();
    /// Set by the StructureChanged handler; the loop re-walks when it sees it.
    public volatile bool Dirty;
    /// Consecutive passes that ran past the per-window timeout.
    public int Strikes;
    public double LastPassMs;
    /// When this window was last walked, on the lane's own clock — the floor
    /// between re-walks is enforced against this.
    public double LastWalkMs = -1e9;
    /// Per-window CPU debt. A hostile provider delays only itself; healthy
    /// foreground/peers remain independently eligible.
    public double NextPassMs;
  }

  public static class ControlLane {
    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")]
    static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")]
    static extern IntPtr SetWinEventHook(
      uint eventMin,
      uint eventMax,
      IntPtr module,
      WinEventDelegate callback,
      uint processId,
      uint threadId,
      uint flags);
    [DllImport("user32.dll")]
    static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    static extern int GetMessage(out NativeMessage message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")]
    static extern bool PeekMessage(
      out NativeMessage message,
      IntPtr hwnd,
      uint min,
      uint max,
      uint remove);
    [DllImport("user32.dll")]
    static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);

    delegate void WinEventDelegate(
      IntPtr hook,
      uint eventType,
      IntPtr hwnd,
      int objectId,
      int childId,
      uint eventThread,
      uint eventTime);

    [StructLayout(LayoutKind.Sequential)]
    struct NativePoint {
      public int X;
      public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct NativeMessage {
      public IntPtr Hwnd;
      public uint Message;
      public UIntPtr WParam;
      public IntPtr LParam;
      public uint Time;
      public NativePoint Point;
    }

    static readonly Dictionary<long, TrackedWindow> Tracked = new Dictionary<long, TrackedWindow>();
    /// Windows that repeatedly blew the timeout. Measured motivation: Docker
    /// Desktop, 10 elements, ~2050 ms per pass, every pass. One provider like
    /// that defines the whole lane's latency unless it is dropped.
    /// Quarantine is deliberately time-bounded. A visible-set omission can be
    /// mere occlusion, so only TTL expiry pardons it; unlike a session-long
    /// HashSet this also bounds harm if Windows later reuses the handle value.
    static readonly Dictionary<long, double> BlockedUntil =
      new Dictionary<long, double>();
    /// Virtual finish time for the whole lane's 3% CPU budget. Every UIA
    /// operation adds its full cost here. Event-driven/initial structure walks
    /// may temporarily borrow against it after their per-window 3 s floor, but
    /// idle refresh and safety polling repay the debt before doing more work.
    static double GlobalNextPassMs;
    // Dirty work can borrow a bounded one-second CPU burst. Credit refills
    // continuously at the lane duty rate; a storm therefore converges back to
    // 3% instead of either running forever or freezing changes for the whole
    // (possibly minutes-long) global debt horizon.
    const double UrgentTokenCapacityMs = 1000.0;
    const double UrgentAdmissionMs = 100.0;
    static double UrgentTokensMs = UrgentTokenCapacityMs;
    static double UrgentTokenRefillRate = 0.03;
    static double LastUrgentTokenMs;
    /// Native accessibility events replace UIA's managed StructureChanged
    /// callback. Field crash evidence from rc.37:
    ///
    ///   System.ArgumentNullException
    ///   Windows.Automation.StructureChangedEventArgs..ctor
    ///
    /// That exception happens while UIAutomationClient constructs the callback
    /// argument, before our delegate can catch it, and terminates powershell.exe.
    /// SetWinEventHook only delivers primitive Win32 values, so a malformed UIA
    /// provider cannot construct an object in this process at all.
    static readonly ConcurrentDictionary<long, byte> Wanted =
      new ConcurrentDictionary<long, byte>();
    /// The last complete visible set lane S requested. Unlike Wanted this keeps
    /// quarantined handles, so the owner loop can retry one after its TTL
    /// without requiring Core to resend an otherwise identical track command.
    static readonly HashSet<long> Desired = new HashSet<long>();
    static readonly ConcurrentDictionary<long, byte> DirtySignals =
      new ConcurrentDictionary<long, byte>();
    static readonly AutoResetEvent DirtyWake = new AutoResetEvent(false);
    static readonly ManualResetEventSlim WinEventReady = new ManualResetEventSlim(false);
    static readonly WinEventDelegate WinEventCallback = OnWinEvent;
    static GCHandle WinEventCallbackHandle;
    static Thread WinEventThread;
    static IntPtr WinEventHook;
    static uint WinEventThreadId;
    const uint EventObjectCreate = 0x8000;
    const uint EventObjectDestroy = 0x8001;
    const uint EventObjectShow = 0x8002;
    const uint EventObjectHide = 0x8003;
    const uint EventObjectReorder = 0x8004;
    const uint EventObjectLocationChange = 0x800B;
    const uint EventObjectNameChange = 0x800C;
    const uint WineventOutOfContext = 0x0000;
    const uint WineventSkipOwnProcess = 0x0002;
    const uint GaRoot = 2;
    const uint WmQuit = 0x0012;
    const uint PmNoRemove = 0x0000;
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    /// Total time spent INSIDE walks and refreshes — the only number that can
    /// honestly be called this lane's cost, and what the duty cycle divides.
    static double BusyMs;
    static readonly StringBuilder Out = new StringBuilder(1 << 16);
    static int ReleasedReferences;
    static double LastReferenceCollectionMs;
    static int ReferenceCollections;

    public static double NowMs { get { return Math.Round(Clock.Elapsed.TotalMilliseconds, 1); } }
    public static double Busy { get { return BusyMs; } }
    public static int TrackedCount { get { return Tracked.Count; } }
    public static int BlockedCount { get { return BlockedUntil.Count; } }
    public static string DpiMode = "unaware";
    public static volatile string ChangeSignalMode = "starting";
    public static int ReferenceCollectionCount { get { return ReferenceCollections; } }

    /// UIA BoundingRectangle follows this PROCESS's DPI coordinate space.
    ///
    /// Lane S is PMv2 and ringObservations combines its physical window
    /// rectangles with Lane A controls. If Lane A stays unaware, Windows
    /// virtualizes every control through the primary monitor's scale: on the
    /// reported 1x left / 1.5x primary desk, the real (-580,51,153,24) became
    /// (-870,77,230,36), and subtracting the physical -1200 monitor origin
    /// wrote the exact bad annotation (330,77,230,36). Declare the same
    /// coordinate contract before the first AutomationElement access.
    public static void InitDpi() {
      try {
        if (SetProcessDpiAwarenessContext(new IntPtr(-4))) {
          DpiMode = "per-monitor-v2";
          return;
        }
      } catch { }
      try {
        if (SetProcessDpiAwareness(2) == 0) {
          DpiMode = "per-monitor";
          return;
        }
      } catch { }
      try {
        if (SetProcessDPIAware()) {
          DpiMode = "system";
          return;
        }
      } catch { }
    }

    public static void StartChangeSignal() {
      if (WinEventThread != null) return;
      WinEventReady.Reset();
      WinEventThread = new Thread(delegate() {
        try {
          WinEventThreadId = GetCurrentThreadId();
          // Microsoft requires managed WinEvent delegates to be held by a
          // GCHandle for the entire native hook lifetime.
          WinEventCallbackHandle = GCHandle.Alloc(WinEventCallback);
          // PostThreadMessage is only reliable after the target created its queue.
          NativeMessage ignored;
          PeekMessage(out ignored, IntPtr.Zero, 0, 0, PmNoRemove);
          WinEventHook = SetWinEventHook(
            EventObjectCreate,
            EventObjectNameChange,
            IntPtr.Zero,
            WinEventCallback,
            0,
            0,
            WineventOutOfContext | WineventSkipOwnProcess);
          ChangeSignalMode = WinEventHook == IntPtr.Zero ? "poll" : "winevent";
          WinEventReady.Set();
          if (WinEventHook == IntPtr.Zero) return;
          NativeMessage message;
          while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
        } catch {
          // A missing/blocked Win32 facility degrades to sparse polling. No
          // exception is allowed to escape a background thread: .NET Framework
          // would terminate the entire PowerShell helper.
          ChangeSignalMode = "poll";
        } finally {
          if (WinEventHook != IntPtr.Zero) {
            try { UnhookWinEvent(WinEventHook); } catch { }
          }
          WinEventHook = IntPtr.Zero;
          if (WinEventCallbackHandle.IsAllocated) WinEventCallbackHandle.Free();
          WinEventReady.Set();
        }
      });
      WinEventThread.IsBackground = true;
      WinEventThread.Name = "CapturePack lane A WinEvent";
      WinEventThread.SetApartmentState(ApartmentState.STA);
      WinEventThread.Start();
      if (!WinEventReady.Wait(1000)) ChangeSignalMode = "poll";
    }

    static void OnWinEvent(
      IntPtr hook,
      uint eventType,
      IntPtr hwnd,
      int objectId,
      int childId,
      uint eventThread,
      uint eventTime) {
      try {
        if (hwnd == IntPtr.Zero) return;
        IntPtr root = GetAncestor(hwnd, GaRoot);
        bool isTopLevel = root == IntPtr.Zero || root == hwnd;
        if (!ShouldQueueWinEvent(eventType, objectId, childId, isTopLevel)) return;
        long target = (root == IntPtr.Zero ? hwnd : root).ToInt64();
        if (Wanted.ContainsKey(target)) {
          DirtySignals[target] = 0;
          // Wake only the resident owner thread. UIA remains exclusively on
          // that thread; the callback never walks or refreshes a control.
          NotifyChangeWaiters();
        }
      } catch {
        // A native notification is only a hint. It can never take down lane A.
      }
    }

    /// Top-level OBJID_WINDOW location events are ordinary window drags and
    /// lane S already anchors every control to those deltas. Child/client
    /// location changes are scroll/layout changes inside the window and must
    /// wake lane A or historical picking goes stale.
    public static bool ShouldQueueWinEvent(
      uint eventType, int objectId, int childId, bool isTopLevel) {
      if (eventType == EventObjectLocationChange) {
        // Only the root HWND's own OBJID_WINDOW move is lane-S territory.
        // A child HWND also reports OBJID_WINDOW/CHILDID_SELF, but its movement
        // changes control geometry inside the root and must dirty lane A.
        return !(objectId == 0 && childId == 0 && isTopLevel);
      }
      return eventType == EventObjectCreate ||
        eventType == EventObjectDestroy ||
        eventType == EventObjectShow ||
        eventType == EventObjectHide ||
        eventType == EventObjectReorder ||
        eventType == EventObjectNameChange;
    }

    public static void DrainChangeSignals() {
      foreach (long hwnd in DirtySignals.Keys) {
        byte ignored;
        if (!DirtySignals.TryRemove(hwnd, out ignored)) continue;
        MarkDirty(hwnd);
      }
    }

    public static void MarkDirty(long hwnd) {
      TrackedWindow window;
      if (Tracked.TryGetValue(hwnd, out window)) window.Dirty = true;
    }

    public static int NextWalkDueInMs(int floorMs) {
      double now = NowMs;
      int next = Int32.MaxValue;
      foreach (TrackedWindow window in Tracked.Values) {
        if (!window.Dirty && window.Elements.Count > 0) continue;
        if (window.LastWalkMs < 0) return 0;
        int retryFloor = WalkRetryDelayMs(floorMs, window.Strikes);
        double remaining = retryFloor - (now - window.LastWalkMs);
        if (remaining <= 0) return 0;
        next = Math.Min(next, (int)Math.Ceiling(remaining));
      }
      return next;
    }

    public static WaitHandle ChangeWakeHandle { get { return DirtyWake; } }

    public static void NotifyChangeWaiters() {
      DirtyWake.Set();
    }

    static void StopChangeSignal() {
      Thread thread = WinEventThread;
      if (thread == null) return;
      uint threadId = WinEventThreadId;
      if (threadId != 0) {
        try { PostThreadMessage(threadId, WmQuit, UIntPtr.Zero, IntPtr.Zero); } catch { }
      }
      if (thread != Thread.CurrentThread) {
        try { thread.Join(1000); } catch { }
      }
      WinEventThread = null;
      WinEventThreadId = 0;
      WinEventHook = IntPtr.Zero;
      Wanted.Clear();
      DirtySignals.Clear();
      ChangeSignalMode = "stopped";
    }

    static void NoteReleasedReferences(int count) {
      if (count <= 0) return;
      if (ReleasedReferences > Int32.MaxValue - count) ReleasedReferences = Int32.MaxValue;
      else ReleasedReferences += count;
    }

    /// AutomationElement wrappers are tiny managed objects around comparatively
    /// expensive COM/UIA state. A re-walk can release thousands of wrappers
    /// without creating enough managed pressure for the CLR to collect them.
    /// Collect only after both a reference and time floor; current trees remain
    /// strongly held, so this cannot change a historical control observation.
    public static bool CollectReleasedReferences(int threshold, int floorMs) {
      double now = NowMs;
      if (ReleasedReferences < threshold || now - LastReferenceCollectionMs < floorMs) {
        return false;
      }
      GC.Collect(2, GCCollectionMode.Forced, false);
      ReleasedReferences = 0;
      LastReferenceCollectionMs = now;
      ReferenceCollections++;
      return true;
    }

    public static int ElementCount {
      get {
        int n = 0;
        foreach (TrackedWindow w in Tracked.Values) n += w.Elements.Count - w.Dead.Count;
        return n;
      }
    }

    static bool IsBlocked(long hwnd) {
      double until;
      if (!BlockedUntil.TryGetValue(hwnd, out until)) return false;
      if (NowMs < until) return true;
      BlockedUntil.Remove(hwnd);
      return false;
    }

    /// The tracked set, replaced wholesale. Lane S owns the question of which
    /// windows the user can actually see, so this lane never enumerates: it is
    /// TOLD, which is the design's "the expensive lane is driven by the cheap
    /// lane's dirty signal, never the other way round".
    public static void SetTracked(long[] hwnds) {
      HashSet<long> wanted = new HashSet<long>(hwnds);
      Desired.Clear();
      foreach (long h in hwnds) Desired.Add(h);
      // A visible-set omission can mean occlusion, not destruction. Never
      // pardon a pathological provider on omission alone; the bounded TTL is
      // the reuse-safe authority when Win32 identity is unavailable here.
      foreach (long h in Wanted.Keys) {
        byte ignored;
        if (!wanted.Contains(h)) Wanted.TryRemove(h, out ignored);
      }
      foreach (long h in hwnds) if (!IsBlocked(h)) Wanted[h] = 0;
      List<long> drop = new List<long>();
      foreach (long h in Tracked.Keys) if (!wanted.Contains(h)) drop.Add(h);
      foreach (long h in drop) Untrack(h);
      foreach (long h in hwnds) {
        if (IsBlocked(h) || Tracked.ContainsKey(h)) continue;
        TrackedWindow w = new TrackedWindow();
        w.Hwnd = h;
        w.Dirty = true;              // walked on the next pass
        Tracked[h] = w;
      }
    }

    /// Re-admits expired quarantines from the last lane-S desired set. Core
    /// intentionally suppresses duplicate visible-set messages, so TTL expiry
    /// must be owned here rather than hidden inside SetTracked/IsBlocked.
    public static int RestoreExpiredQuarantines() {
      double now = NowMs;
      List<long> restore = new List<long>();
      foreach (KeyValuePair<long, double> entry in BlockedUntil) {
        if (entry.Value <= now) restore.Add(entry.Key);
      }
      foreach (long h in restore) {
        BlockedUntil.Remove(h);
        if (!Desired.Contains(h)) continue;
        Wanted[h] = 0;
        if (Tracked.ContainsKey(h)) continue;
        TrackedWindow w = new TrackedWindow();
        w.Hwnd = h;
        w.Dirty = true;
        Tracked[h] = w;
      }
      return restore.Count;
    }

    static void Untrack(long h) {
      byte ignored;
      Wanted.TryRemove(h, out ignored);
      TrackedWindow window;
      if (Tracked.TryGetValue(h, out window)) {
        NoteReleasedReferences(window.Elements.Count);
        window.Elements.Clear();
        window.LastRects.Clear();
        window.Dead.Clear();
      }
      Tracked.Remove(h);
    }

    public static void Shutdown() {
      List<long> all = new List<long>(Tracked.Keys);
      foreach (long h in all) Untrack(h);
      Desired.Clear();
      BlockedUntil.Clear();
      GlobalNextPassMs = 0;
      UrgentTokensMs = UrgentTokenCapacityMs;
      UrgentTokenRefillRate = 0.03;
      LastUrgentTokenMs = NowMs;
      StopChangeSignal();
    }

    /// Walks ONE window and HOLDS what it finds. Returns the `tree` line, or
    /// null when the window gave nothing.
    ///
    /// FindAll with no cache request on purpose — see the file header for the
    /// A/B that rules FindAllBuildCache out.
    public static string Walk(long hwnd, int maxElements, int timeoutMs, int maxStrikes) {
      TrackedWindow w;
      if (!Tracked.TryGetValue(hwnd, out w)) return null;
      long t0 = Stopwatch.GetTimestamp();
      w.Dirty = false;
      AutomationElementCollection found = null;
      AutomationElement root = null;
      try {
        root = AutomationElement.FromHandle(new IntPtr(hwnd));
      } catch {
        double failedMs = Elapsed(t0);
        RecordWalkOutcome(hwnd, failedMs, timeoutMs, true, false, 0, maxStrikes);
        Charge(t0);
        return null;
      }
      if (root == null) {
        double failedMs = Elapsed(t0);
        RecordWalkOutcome(hwnd, failedMs, timeoutMs, true, false, 0, maxStrikes);
        Charge(t0);
        return null;
      }
      long findAllStart = Stopwatch.GetTimestamp();
      double findAllMs;
      try {
        found = root.FindAll(TreeScope.Subtree, Condition.TrueCondition);
      } catch {
        findAllMs = Elapsed(findAllStart);
        double failedMs = Elapsed(t0);
        RecordWalkOutcome(
          hwnd, failedMs, timeoutMs, true, false, findAllMs, maxStrikes);
        Charge(t0);
        return null;
      }
      findAllMs = Elapsed(findAllStart);
      double walkMs = Elapsed(t0);
      int n;
      try {
        n = found.Count;
      } catch {
        double failedMs = Elapsed(t0);
        RecordWalkOutcome(
          hwnd, failedMs, timeoutMs, true, false, findAllMs, maxStrikes);
        Charge(t0);
        return null;
      }
      w.Version++;
      NoteReleasedReferences(w.Elements.Count);
      w.Elements.Clear();
      w.LastRects.Clear();
      w.Dead.Clear();

      Out.Length = 0;
      Out.Append("{\"event\":\"tree\",\"t\":").Append(F(NowMs))
         .Append(",\"h\":\"").Append(hwnd.ToString(CultureInfo.InvariantCulture))
         .Append("\",\"v\":").Append(w.Version)
         .Append(",\"e\":[");
      int kept = 0;
      int scanned = 0;
      bool scanTimedOut = false;
      // FindAll is a provider call and cannot be interrupted safely in this
      // process. Once it returns over budget, do not compound the stall with
      // hundreds or thousands of property reads.
      bool walkTimedOut = walkMs > timeoutMs;
      for (int i = 0; !walkTimedOut && i < n && kept < maxElements; i++) {
        // This is deliberately based on SCANNED elements, not kept elements.
        // Offscreen, invalid, and throwing wrappers do not increment `kept`;
        // checking kept every 32 let pathological trees run to completion.
        if (ScanBudgetExpired(scanned, Elapsed(t0), timeoutMs)) {
          scanTimedOut = true;
          break;
        }
        scanned = i + 1;
        AutomationElement el;
        try { el = found[i]; } catch { continue; }
        if (el == null) continue;
        double[] r;
        string name, ctrl, autoId, cls;
        try {
          System.Windows.Rect b = el.Current.BoundingRectangle;
          if (b.IsEmpty || b.Width < 1 || b.Height < 1) continue;
          if (el.Current.IsOffscreen) continue;
          r = new double[] { b.X, b.Y, b.Width, b.Height };
          name = el.Current.Name ?? "";
          ctrl = el.Current.ControlType == null ? "" : el.Current.ControlType.ProgrammaticName;
          autoId = el.Current.AutomationId ?? "";
          cls = el.Current.ClassName ?? "";
        } catch { continue; }
        if (kept > 0) Out.Append(',');
        Out.Append("{\"b\":["); AppendRect(r);
        Out.Append("],\"n\":"); AppendString(name);
        Out.Append(",\"c\":"); AppendString(ShortControlType(ctrl));
        Out.Append(",\"a\":"); AppendString(autoId);
        Out.Append(",\"k\":"); AppendString(cls);
        Out.Append('}');
        w.Elements.Add(el);
        w.LastRects.Add(r);
        kept++;
      }
      // FindAll materialises wrappers for every result. Only `kept` remains in
      // the live tree; the suffix is unmanaged pressure the CLR cannot measure.
      NoteReleasedReferences(Math.Max(0, n - kept));
      double totalMs = Elapsed(t0);
      string reason = WalkTruncationReason(
        walkMs,
        totalMs,
        timeoutMs,
        scanTimedOut,
        scanned,
        n,
        kept,
        maxElements);
      bool truncated = reason.Length > 0;
      // A prefix is not a complete tree. Core must be able to distinguish the
      // common 32-element timeout from an honest, fully walked window; without
      // this bit the prefix was persisted as `tree: collected` and silently
      // suppressed every later fallback for the same window.
      Out.Append("],\"truncated\":").Append(truncated ? "true" : "false")
         .Append(",\"scanned\":").Append(scanned)
         .Append(",\"total\":").Append(n)
         .Append(",\"elapsedMs\":").Append(F(totalMs));
      if (reason.Length > 0) {
        Out.Append(",\"reason\":");
        AppendString(reason);
      }
      Out.Append('}');
      // A deterministic element cap cannot improve by retrying the identical
      // tree and is not provider failure. Keep its honest truncated wire bit,
      // but reserve retry/backoff/quarantine for timeout or genuinely
      // incomplete observations.
      bool retryableTruncation = truncated && reason != "element-cap";
      RecordWalkOutcome(
        hwnd, totalMs, timeoutMs, false, retryableTruncation, findAllMs, maxStrikes);
      Charge(t0);
      return Out.ToString();
    }

    /// Re-reads BoundingRectangle off the HELD references and emits only what
    /// moved. One property, so plain Current beats GetUpdatedCache (measured:
    /// 9.27 vs 12.53 ms at K=100; the crossover is at two properties).
    ///
    /// Returns null when nothing changed — silence on the wire is the common
    /// case and it should cost a line of JSON, not a line of NDJSON.
    public static string Refresh(long hwnd, int timeoutMs) {
      TrackedWindow w;
      if (!Tracked.TryGetValue(hwnd, out w)) return null;
      if (w.Elements.Count == 0) return null;
      long t0 = Stopwatch.GetTimestamp();
      StringBuilder moved = new StringBuilder(256);
      StringBuilder died = new StringBuilder(64);
      int movedCount = 0, diedCount = 0;
      for (int i = 0; i < w.Elements.Count; i++) {
        if (w.Dead.Contains(i)) continue;
        // Current is a provider call and cannot itself be interrupted. Check
        // after every returned element so a slow one cannot authorize another
        // batch of 31 calls beyond the deadline.
        if (i > 0 && Elapsed(t0) > timeoutMs) break;
        double[] last = w.LastRects[i];
        try {
          System.Windows.Rect b = w.Elements[i].Current.BoundingRectangle;
          if (b.IsEmpty) {
            // Present but no longer laid out: it has left the picture, and
            // saying nothing would freeze it where it last was.
            w.Dead.Add(i);
            if (diedCount++ > 0) died.Append(',');
            died.Append(i);
            continue;
          }
          if (b.X == last[0] && b.Y == last[1] && b.Width == last[2] && b.Height == last[3]) continue;
          last[0] = b.X; last[1] = b.Y; last[2] = b.Width; last[3] = b.Height;
          if (movedCount++ > 0) moved.Append(',');
          moved.Append('[').Append(i).Append(',');
          AppendRectTo(moved, last);
          moved.Append(']');
        } catch (ElementNotAvailableException) {
          // HELD REFERENCES ROT. Measured with nothing driven at all: 3140 refs
          // held, dead=0 at t=0/5/20 s, dead=138 (4.4%) by ~50 s. A dead
          // reference must REMOVE its candidate — freezing it would leave a box
          // on a control that no longer exists.
          w.Dead.Add(i);
          if (diedCount++ > 0) died.Append(',');
          died.Append(i);
        } catch {
          // Any other provider failure: skip this element this pass, try again
          // next time. Not fatal, not a death.
        }
      }
      double totalMs = Elapsed(t0);
      RecordRefreshOutcome(hwnd, totalMs, timeoutMs);
      Charge(t0);
      if (movedCount == 0 && diedCount == 0) return null;
      Out.Length = 0;
      Out.Append("{\"event\":\"rects\",\"t\":").Append(F(NowMs))
         .Append(",\"h\":\"").Append(hwnd.ToString(CultureInfo.InvariantCulture))
         .Append("\",\"v\":").Append(w.Version)
         .Append(",\"e\":[").Append(moved.ToString()).Append(']');
      if (diedCount > 0) Out.Append(",\"g\":[").Append(died.ToString()).Append(']');
      Out.Append('}');
      return Out.ToString();
    }

    /// Windows to visit this pass, worst-offender-first protection applied.
    /// `focus` is visited every pass; the rest rotate.
    public static long[] Due(long focus, int rotation, int floorMs, int safetyMs) {
      List<long> order = new List<long>();
      if (focus != 0 && OperationDue(focus, focus, floorMs, safetyMs)) order.Add(focus);
      List<long> others = new List<long>();
      foreach (long h in Tracked.Keys) {
        if (h == focus) continue;
        TrackedWindow w = Tracked[h];
        if (!OperationDue(h, focus, floorMs, safetyMs)) continue;
        if (w.Dirty) order.Add(h); else others.Add(h);
      }
      if (others.Count > 0) order.Add(others[rotation % others.Count]);
      return order.ToArray();
    }

    static void RefillUrgentTokens(double now) {
      double elapsed = Math.Max(0, now - LastUrgentTokenMs);
      if (elapsed > 0) {
        UrgentTokensMs = Math.Min(
          UrgentTokenCapacityMs,
          UrgentTokensMs + elapsed * UrgentTokenRefillRate);
        LastUrgentTokenMs = now;
      }
    }

    static bool OperationDue(long hwnd, long focus, int floorMs, int safetyMs) {
      TrackedWindow w;
      double now = NowMs;
      RefillUrgentTokens(now);
      if (!Tracked.TryGetValue(hwnd, out w) || now < w.NextPassMs) return false;
      bool needsWalk = NeedsWalk(hwnd, floorMs, safetyMs);
      // A real structure signal, a never-walked window, and a due foreground
      // structure walk are latency-sensitive. They may borrow against the
      // global token debt; their measured cost is still charged afterwards.
      bool urgentWalk =
        needsWalk && (w.Dirty || w.LastWalkMs < 0 || hwnd == focus);
      if (urgentWalk && UrgentTokensMs >= UrgentAdmissionMs) return true;
      if (now < GlobalNextPassMs) return false;
      return w.Elements.Count > 0 || needsWalk;
    }

    /// Re-check a Due snapshot immediately before provider entry. A large
    /// initial dirty burst can consume its urgent allowance within one array;
    /// without this check every remaining HWND in that stale snapshot could
    /// overdraw the ceiling.
    public static bool IsOperationDue(
      long hwnd, long focus, int floorMs, int safetyMs) {
      return OperationDue(hwnd, focus, floorMs, safetyMs);
    }

    /// Earliest real UIA operation, combining per-window CPU debt with the
    /// structural retry floor for empty/failed trees.
    public static int NextOperationDueInMs(int floorMs, int safetyMs) {
      double now = NowMs;
      RefillUrgentTokens(now);
      int next = Int32.MaxValue;
      foreach (TrackedWindow w in Tracked.Values) {
        bool needsWalk = NeedsWalk(w.Hwnd, floorMs, safetyMs);
        double remaining = Math.Max(0, w.NextPassMs - now);
        bool urgentIntent = w.Dirty || w.LastWalkMs < 0;
        if ((w.Elements.Count == 0 || w.Dirty) && w.LastWalkMs >= 0) {
          int retryFloor = WalkRetryDelayMs(floorMs, w.Strikes);
          remaining = Math.Max(remaining, retryFloor - (now - w.LastWalkMs));
        }
        if (urgentIntent) {
          double tokenWait =
            Math.Max(0, UrgentAdmissionMs - UrgentTokensMs) /
            Math.Max(0.000001, UrgentTokenRefillRate);
          remaining = Math.Max(remaining, tokenWait);
        } else {
          remaining = Math.Max(remaining, GlobalNextPassMs - now);
        }
        if (remaining <= 0) return 0;
        next = Math.Min(next, (int)Math.Ceiling(remaining));
      }
      return next;
    }

    /// Charge both the provider and the lane. The per-window clock isolates a
    /// hostile provider. The global virtual finish time makes quiet
    /// refresh/safety work repay every burst at the configured aggregate duty.
    /// An event-driven structure walk can bypass this global clock, but never
    /// escapes accounting: borrowing appends its complete duty slot.
    public static int DeferWindow(long hwnd, double passMs, double dutyTarget) {
      TrackedWindow w;
      if (!Tracked.TryGetValue(hwnd, out w) || passMs <= 0) return 0;
      double now = NowMs;
      int cooldownMs = DutyCooldownMs(passMs, dutyTarget);
      RefillUrgentTokens(now);
      UrgentTokenRefillRate = dutyTarget > 0 && dutyTarget < 1
        ? dutyTarget
        : UrgentTokenRefillRate;
      w.NextPassMs = now + cooldownMs;
      if (GlobalNextPassMs > now) {
        UrgentTokensMs = Math.Max(0, UrgentTokensMs - passMs);
        GlobalNextPassMs += passMs + cooldownMs;
      } else {
        GlobalNextPassMs = now + cooldownMs;
      }
      return cooldownMs;
    }

    public static int WindowDebtRemainingMs(long hwnd) {
      TrackedWindow w;
      if (!Tracked.TryGetValue(hwnd, out w)) return 0;
      return (int)Math.Max(0, Math.Ceiling(w.NextPassMs - NowMs));
    }

    public static int GlobalDebtRemainingMs {
      get { return (int)Math.Max(0, Math.Ceiling(GlobalNextPassMs - NowMs)); }
    }

    public static double UrgentTokens {
      get {
        RefillUrgentTokens(NowMs);
        return UrgentTokensMs;
      }
    }

    public static double UrgentTokenCapacity {
      get { return UrgentTokenCapacityMs; }
    }

    public static double UrgentAdmission {
      get { return UrgentAdmissionMs; }
    }

    public static double UrgentRefillFor(double elapsedMs, double dutyTarget) {
      return Math.Max(0, elapsedMs) * Math.Max(0, dutyTarget);
    }

    /// Dirty AND allowed to be re-walked yet. A window that changed again
    /// within the floor stays dirty and is walked when the floor expires.
    public static bool NeedsWalk(long hwnd, int floorMs, int safetyMs) {
      TrackedWindow w;
      if (!Tracked.TryGetValue(hwnd, out w)) return false;
      if (w.LastWalkMs < 0) return true;               // genuinely never tried
      double age = NowMs - w.LastWalkMs;
      int retryFloor = WalkRetryDelayMs(floorMs, w.Strikes);
      // A successful empty tree and a failed provider both have no held
      // references to refresh. They still obey cadence; failures exponentially
      // back off instead of calling FromHandle/FindAll every 20 ms.
      if (w.Elements.Count == 0) return age >= retryFloor;
      if (w.Dirty) return age >= retryFloor;
      // A process where SetWinEventHook is unavailable still remains correct,
      // just slower. With the hook active, a sparse safety walk heals providers
      // that fail to raise accessibility events without turning polling into the
      // normal path again.
      return age >= (ChangeSignalMode == "winevent" ? safetyMs : floorMs);
    }

    public static bool HasTree(long hwnd) {
      TrackedWindow w;
      return Tracked.TryGetValue(hwnd, out w) && w.Elements.Count > 0;
    }

    /// THE COST THAT JUSTIFIED THE BLOCK, CAPTURED BEFORE THE BLOCK DESTROYS IT.
    ///
    /// The caller used to log `LastPassMs(blocked)` AFTER this ran — but this
    /// calls Untrack(), which removes the record that number lives in, so
    /// LastPassMs fell through to its default and every dropped window was
    /// reported as "it took 0 ms a pass". Seen in the field on four windows in
    /// one session; 0 ms is not slow, so the log accused the blocklist of
    /// misfiring on healthy windows when it may well have been right, and there
    /// was no way to tell which. A lane that cannot state its cost is exactly
    /// what Rule 4 forbids.
    public static double LastBlockedPassMs;

    /// Three strikes quarantine a window and release its handles. Only the
    /// bounded TTL clears it: omission from the visible set may be temporary
    /// occlusion rather than destruction, while TTL bounds HWND-reuse harm.
    public static long BlockIfHopeless(long hwnd, int maxStrikes, int blockTtlMs) {
      TrackedWindow w;
      if (!Tracked.TryGetValue(hwnd, out w)) return 0;
      if (w.Strikes < maxStrikes) return 0;
      LastBlockedPassMs = w.LastPassMs;
      // Do not forget a provider's earned CPU debt when Untrack destroys its
      // TrackedWindow. Otherwise a 2050 ms offender returns every fixed TTL
      // and recreates the same expensive call indefinitely.
      BlockedUntil[hwnd] = Math.Max(
        NowMs + Math.Max(1, blockTtlMs),
        w.NextPassMs);
      Untrack(hwnd);
      return hwnd;
    }

    public static int BlockedRemainingMs(long hwnd) {
      double until;
      if (!BlockedUntil.TryGetValue(hwnd, out until)) return 0;
      return (int)Math.Max(0, Math.Ceiling(until - NowMs));
    }

    public static double LastPassMs(long hwnd) {
      TrackedWindow w;
      return Tracked.TryGetValue(hwnd, out w) ? w.LastPassMs : 0;
    }

    public static int StrikeCount(long hwnd) {
      TrackedWindow w;
      return Tracked.TryGetValue(hwnd, out w) ? w.Strikes : 0;
    }

    /// A failed walk backs off exponentially. A healthy empty tree uses the
    /// ordinary re-walk floor (strike zero), so "empty" is an observation, not
    /// a synonym for "never attempted".
    public static int WalkRetryDelayMs(int floorMs, int strikes) {
      long multiplier = 1L << Math.Min(4, Math.Max(0, strikes));
      return (int)Math.Min(Int32.MaxValue, Math.Max(0L, (long)floorMs) * multiplier);
    }

    /// FindAll cannot be cancelled. If one call has already consumed the whole
    /// allowance represented by all normal strikes, repeating it cannot add
    /// enough evidence to justify the CPU cost: make it immediately hopeless.
    public static bool SevereFindAllOverrun(
      double findAllMs,
      int timeoutMs,
      int maxStrikes) {
      return findAllMs >= (double)Math.Max(1, timeoutMs) * Math.Max(1, maxStrikes);
    }

    /// Every walk outcome, including a null root and provider exception, passes
    /// through this one accounting path. It records the retry epoch as well as
    /// cost, so NeedsWalk can enforce cadence even when no tree was produced.
    public static void RecordWalkOutcome(
      long hwnd,
      double passMs,
      int timeoutMs,
      bool failed,
      bool incomplete,
      double findAllMs,
      int maxStrikes) {
      TrackedWindow w;
      if (!Tracked.TryGetValue(hwnd, out w)) return;
      w.LastWalkMs = NowMs;
      w.LastPassMs = passMs;
      int ceiling = Math.Max(1, maxStrikes);
      bool retryRequired = failed || incomplete || passMs > timeoutMs;
      // Preserve retry intent even when a failed re-walk still has an older
      // complete set of held references. Refresh may keep those rectangles
      // useful, but it cannot discover the new controls that prompted re-walk.
      w.Dirty = retryRequired;
      if (!retryRequired) {
        w.Strikes = 0;
      } else if (SevereFindAllOverrun(findAllMs, timeoutMs, ceiling)) {
        w.Strikes = ceiling;
      } else {
        w.Strikes = Math.Min(ceiling, w.Strikes + 1);
      }
    }

    /// A cheap successful rectangle refresh must not pardon a failed or
    /// incomplete structure walk: refresh can move old references but cannot
    /// discover the missing new controls. Only a complete Walk clears Dirty.
    public static void RecordRefreshOutcome(long hwnd, double passMs, int timeoutMs) {
      TrackedWindow w;
      if (!Tracked.TryGetValue(hwnd, out w)) return;
      w.LastPassMs = passMs;
      if (passMs > timeoutMs) {
        w.Strikes++;
      } else if (!w.Dirty) {
        w.Strikes = 0;
      }
    }

    public static bool RetryPending(long hwnd) {
      TrackedWindow w;
      return Tracked.TryGetValue(hwnd, out w) && w.Dirty;
    }

    /// Check after every attempted element. One provider property call itself
    /// cannot be cancelled, but once it returns no second Current access is
    /// allowed to begin after the deadline.
    public static bool ScanBudgetExpired(int scanned, double elapsedMs, int timeoutMs) {
      return scanned > 0 && elapsedMs > timeoutMs;
    }

    /// Work/sleep ratio required for an actual rolling duty target. The owner
    /// loop retains this cooldown across heartbeat-only iterations instead of
    /// losing its debt when a long wait is split to emit status.
    public static int DutyCooldownMs(double passMs, double dutyTarget) {
      if (passMs <= 0 || dutyTarget <= 0 || dutyTarget >= 1) return 0;
      return (int)Math.Ceiling(passMs * ((1.0 / dutyTarget) - 1.0));
    }

    /// One source of truth for both the wire verdict and the deterministic
    /// PowerShell probe. Earlier phases take precedence in the diagnostic.
    public static string WalkTruncationReason(
      double walkMs,
      double totalMs,
      int timeoutMs,
      bool scanTimedOut,
      int scanned,
      int total,
      int kept,
      int maxElements) {
      if (walkMs > timeoutMs) return "findall-timeout";
      if (scanTimedOut) return "scan-timeout";
      if (totalMs > timeoutMs) return "total-timeout";
      if (scanned < total && kept >= maxElements) return "element-cap";
      if (scanned < total) return "incomplete";
      return "";
    }

    static void Charge(long t0) { BusyMs += Elapsed(t0); }
    static double Elapsed(long t0) {
      return (double)(Stopwatch.GetTimestamp() - t0) * 1000.0 / (double)Stopwatch.Frequency;
    }
    static string F(double v) { return v.ToString("F1", CultureInfo.InvariantCulture); }

    /// "ControlType.Button" -> "Button": the pack's vocabulary, and what
    /// buffer.ts already compares against.
    static string ShortControlType(string programmatic) {
      if (string.IsNullOrEmpty(programmatic)) return "";
      int dot = programmatic.LastIndexOf('.');
      return dot >= 0 && dot + 1 < programmatic.Length ? programmatic.Substring(dot + 1) : programmatic;
    }

    static void AppendRect(double[] r) { AppendRectTo(Out, r); }
    static void AppendRectTo(StringBuilder sb, double[] r) {
      sb.Append(((int)Math.Round(r[0])).ToString(CultureInfo.InvariantCulture)).Append(',')
        .Append(((int)Math.Round(r[1])).ToString(CultureInfo.InvariantCulture)).Append(',')
        .Append(((int)Math.Round(r[2])).ToString(CultureInfo.InvariantCulture)).Append(',')
        .Append(((int)Math.Round(r[3])).ToString(CultureInfo.InvariantCulture));
    }

    static void AppendString(string value) {
      Out.Append('"');
      if (value != null) {
        for (int i = 0; i < value.Length && i < 200; i++) {
          char c = value[i];
          if (c == '"' || c == '\\') { Out.Append('\\').Append(c); }
          else if (c == '\n') Out.Append("\\n");
          else if (c == '\r') Out.Append("\\r");
          else if (c == '\t') Out.Append("\\t");
          else if (c < 32) Out.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
          else Out.Append(c);
        }
      }
      Out.Append('"');
    }
  }

  /// Requests from Core, read on a background thread — the same measured trap
  /// lane S documents: Console.In.ReadLineAsync BLOCKS in .NET Framework, so a
  /// loop built on it stops refreshing until Core happens to say something.
  public static class TrackInput {
    static readonly System.Collections.Concurrent.ConcurrentQueue<string> Lines =
      new System.Collections.Concurrent.ConcurrentQueue<string>();
    static readonly System.Threading.AutoResetEvent Signal =
      new System.Threading.AutoResetEvent(false);
    static readonly System.Threading.WaitHandle[] WaitSignals =
      new System.Threading.WaitHandle[] { Signal, ControlLane.ChangeWakeHandle };
    public static volatile bool Closed;

    public static void Start() {
      System.Threading.Thread reader = new System.Threading.Thread(delegate() {
        try {
          while (true) {
            string line = Console.In.ReadLine();
            if (line == null) break;
            Lines.Enqueue(line);
            Signal.Set();
          }
        } catch { }
        Closed = true;
        Signal.Set();
      });
      reader.IsBackground = true;
      reader.Start();
    }

    public static bool Wait(int ms) {
      if (!Lines.IsEmpty) return true;
      if (Closed) return true;
      return System.Threading.WaitHandle.WaitAny(
        WaitSignals,
        ms < 0 ? 0 : ms) != System.Threading.WaitHandle.WaitTimeout;
    }

    public static string TryRead() {
      string line;
      return Lines.TryDequeue(out line) ? line : null;
    }

    public static bool Drained() { return Lines.IsEmpty; }
  }
}
'@ -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, PresentationCore

[CapturePack.ControlLane]::InitDpi()

# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------

# Rule 4, made structural instead of advisory. After every pass the loop sleeps
# in PROPORTION to what that pass cost, so this lane's duty cycle is what this
# number says it is whatever the desktop does — a fast desktop is visited often,
# a slow one rarely, and neither can push the lane over its share.
#
# 3%, not 5%, and the difference is lane S. The 5% in the design is the budget
# for the WHOLE context subsystem, and lane S now spends 1.11% of it (100
# samples/s at 0.111 ms since it started sending only what moved). Taking 5%
# here would put the two lanes together over the one number the design actually
# promises. 3% leaves headroom and still buys ~2.4 refreshes a second on a
# 163-element window — and control geometry inside a window changes at human
# speed, not at drag speed, with WinEvent catching the discrete jumps
# in between.
#
# MEASURED END TO END, driving the real tracker against four real windows
# (195 held elements) for 45 s. The cumulative duty starts high because the
# one-time walks are charged to it, and converges on the target as they
# amortise:
#
#   t=5s  7.92%   t=16s 4.61%   t=26s 3.93%   t=36s 3.62%
#   t=11s 5.50%   t=21s 4.18%   t=31s 3.76%   t=41s 3.54%
#
# What matters is the MARGINAL rate — busy time added between two status
# events — which settles at 2.8-3.0% and reads 3.02% across the last interval.
# The sleep below is what makes that a property of the loop rather than a hope:
# the lane cannot exceed its budget, only fall short of its cadence.
$DutyTarget = 0.03
# A window that cannot be refreshed inside this is not worth the lane.
$WindowTimeoutMs = 120
# THE FLOOR BETWEEN RE-WALKS OF ONE WINDOW.
#
# Accessibility change events are generous: 186 arrived in 20 s at desktop root on
# an IDLE desktop. A window whose tree churns would otherwise be re-walked on
# every pass, and a walk is ~980 ms for 400 elements against ~32 ms to refresh
# the same set — three orders of magnitude of difference between the two things
# this loop can decide to do. Without a floor, one chatty tree turns the lane
# back into the full-walk design it exists to replace. A tree that really did
# change is served by the refresh in the meantime (held references survive a
# re-layout; they only die when the element does), so the cost of waiting is
# bounded and the cost of not waiting is not.
$ReWalkFloorMs = 3000
$SafetyReWalkMs = 300000
$MaxStrikes = 3
# A quarantined provider gets another chance after one minute even if lane S
# never observed a missing-handle sample between destruction and HWND reuse.
$BlockedTtlMs = 60000
$MaxElementsPerWindow = 400
$ReferenceCollectionThreshold = 2000
$ReferenceCollectionFloorMs = 15000
# The floor and ceiling on one blocking wait. Cooldown debt itself is retained
# independently and status heartbeats split a long wait, so this ceiling no
# longer weakens the 3% duty target.
$MinSleepMs = 20
$MaxSleepMs = 120000

function Write-Line([string]$line) {
  [Console]::Out.Write($line)
  [Console]::Out.Write("`n")
  [Console]::Out.Flush()
}

if ($WakeSelfTest) {
  # Signal BEFORE waiting: this pins the lost-wake race as well as latency.
  [CapturePack.ControlLane]::NotifyChangeWaiters()
  $wakeClock = [System.Diagnostics.Stopwatch]::StartNew()
  $woke = [CapturePack.TrackInput]::Wait(2000)
  $wakeClock.Stop()
  Write-Line ('{"event":"wake-selftest","woke":' +
    $(if ($woke) { 'true' } else { 'false' }) +
    ',"elapsedMs":' + [Math]::Round($wakeClock.Elapsed.TotalMilliseconds, 3) + '}')
  exit $(if ($woke) { 0 } else { 1 })
}

if ($BudgetSelfTest) {
  $cadenceBefore = [CapturePack.ControlLane]::ScanBudgetExpired(0, 121, 120)
  $cadenceAt = [CapturePack.ControlLane]::ScanBudgetExpired(1, 121, 120)
  $findAllReason = [CapturePack.ControlLane]::WalkTruncationReason(
    121, 121, 120, $false, 0, 5000, 0, 400)
  $scanReason = [CapturePack.ControlLane]::WalkTruncationReason(
    10, 121, 120, $true, 1, 5000, 0, 400)
  $totalReason = [CapturePack.ControlLane]::WalkTruncationReason(
    10, 121, 120, $false, 7, 7, 0, 400)
  $capReason = [CapturePack.ControlLane]::WalkTruncationReason(
    10, 20, 120, $false, 400, 5000, 400, 400)
  $completeReason = [CapturePack.ControlLane]::WalkTruncationReason(
    10, 20, 120, $false, 7, 7, 0, 400)
  $severeBefore = [CapturePack.ControlLane]::SevereFindAllOverrun(359, 120, 3)
  $severeAt = [CapturePack.ControlLane]::SevereFindAllOverrun(360, 120, 3)
  $cooldown100 = [CapturePack.ControlLane]::DutyCooldownMs(100, 0.03)
  $cooldown120 = [CapturePack.ControlLane]::DutyCooldownMs(120, 0.03)
  $cooldownMulti = [CapturePack.ControlLane]::DutyCooldownMs(360, 0.03)
  $duty100 = 100 / (100 + $cooldown100)
  $duty120 = 120 / (120 + $cooldown120)
  $dutyMulti = 360 / (360 + $cooldownMulti)

  # Fast FromHandle/null/throw-equivalent failures still count, back off, and
  # eventually quarantine. No real HWND or accessibility provider is touched.
  $failureHwnd = [long]910001
  [CapturePack.ControlLane]::SetTracked([long[]]@($failureHwnd))
  $firstWalkDue = [CapturePack.ControlLane]::NeedsWalk($failureHwnd, 3000, 300000)
  [CapturePack.ControlLane]::RecordWalkOutcome(
    $failureHwnd, 1, 120, $true, $false, 0, 3)
  $failedStrikesAfterOne = [CapturePack.ControlLane]::StrikeCount($failureHwnd)
  $failedLastPassMs = [CapturePack.ControlLane]::LastPassMs($failureHwnd)
  $failedDueImmediately = [CapturePack.ControlLane]::NeedsWalk(
    $failureHwnd, 3000, 300000)
  $failedRetryMs = [CapturePack.ControlLane]::WalkRetryDelayMs(
    3000, $failedStrikesAfterOne)
  $failedNextDueMs = [CapturePack.ControlLane]::NextWalkDueInMs(3000)
  [CapturePack.ControlLane]::RecordWalkOutcome(
    $failureHwnd, 1, 120, $true, $false, 0, 3)
  [CapturePack.ControlLane]::RecordWalkOutcome(
    $failureHwnd, 1, 120, $true, $false, 0, 3)
  $failureBlocked = [CapturePack.ControlLane]::BlockIfHopeless(
    $failureHwnd, 3, 1)

  # An honest empty result is a completed pass too: it retries at the ordinary
  # cadence rather than hammering NeedsWalk on every 20 ms owner loop.
  $emptyHwnd = [long]910002
  [CapturePack.ControlLane]::SetTracked([long[]]@($emptyHwnd))
  [CapturePack.ControlLane]::RecordWalkOutcome(
    $emptyHwnd, 1, 120, $false, $false, 0, 3)
  $emptyDueImmediately = [CapturePack.ControlLane]::NeedsWalk(
    $emptyHwnd, 3000, 300000)
  $emptyRetryMs = [CapturePack.ControlLane]::WalkRetryDelayMs(3000, 0)
  $emptyNextDueMs = [CapturePack.ControlLane]::NextWalkDueInMs(3000)

  # A failed/incomplete re-walk keeps retry intent even if old references can
  # still be refreshed cheaply. Refresh is not structural discovery and must
  # not clear that walk's strike.
  $retryHwnd = [long]910005
  [CapturePack.ControlLane]::SetTracked([long[]]@($retryHwnd))
  [CapturePack.ControlLane]::RecordWalkOutcome(
    $retryHwnd, 1, 120, $false, $false, 0, 3)
  [CapturePack.ControlLane]::RecordWalkOutcome(
    $retryHwnd, 20, 120, $false, $true, 20, 3)
  $incompleteRetryPending = [CapturePack.ControlLane]::RetryPending($retryHwnd)
  $incompleteStrikes = [CapturePack.ControlLane]::StrikeCount($retryHwnd)
  [CapturePack.ControlLane]::RecordRefreshOutcome($retryHwnd, 1, 120)
  $retryAfterRefresh = [CapturePack.ControlLane]::RetryPending($retryHwnd)
  $strikesAfterRefresh = [CapturePack.ControlLane]::StrikeCount($retryHwnd)
  $capHwnd = [long]910006
  [CapturePack.ControlLane]::SetTracked([long[]]@($capHwnd))
  [CapturePack.ControlLane]::RecordWalkOutcome(
    $capHwnd, 20, 120, $false, $false, 20, 3)
  $capRetryPending = [CapturePack.ControlLane]::RetryPending($capHwnd)
  $capStrikes = [CapturePack.ControlLane]::StrikeCount($capHwnd)

  # Foreground is always the first visit. Switching focus changes the next
  # pass immediately, and quarantining a hopeless foreground leaves the other
  # visible tracker due in the same owner loop.
  # Fresh handles avoid inheriting the retry/cap fixtures above.
  $foregroundHwnd = [long]920003
  $peerHwnds = [long[]](920004..920013)
  $otherHwnd = $peerHwnds[0]
  [CapturePack.ControlLane]::SetTracked(
    [long[]](@($foregroundHwnd) + $peerHwnds))
  $foregroundOrder = [CapturePack.ControlLane]::Due(
    $foregroundHwnd, 0, 3000, 300000)
  $switchedOrder = [CapturePack.ControlLane]::Due(
    $otherHwnd, 0, 3000, 300000)
  $hostilePeerSamePass =
    $foregroundOrder.Length -gt 1 -and $foregroundOrder[1] -eq $otherHwnd
  $hostileDebtMs = [CapturePack.ControlLane]::DeferWindow(
    $foregroundHwnd, 2050, 0.03)
  $peerOrderDuringHostileDebt = [CapturePack.ControlLane]::Due(
    $foregroundHwnd, 0, 3000, 300000)
  $healthyPeersDuringDebt = @(
    $peerOrderDuringHostileDebt |
      Where-Object { $_ -in $peerHwnds }
  ).Count
  $hostileExcludedDuringDebt =
    $foregroundHwnd -notin $peerOrderDuringHostileDebt
  [CapturePack.ControlLane]::RecordWalkOutcome(
    $foregroundHwnd, 500, 120, $false, $false, 500, 3)
  $severeStrikes = [CapturePack.ControlLane]::StrikeCount($foregroundHwnd)
  $severeBlocked = [CapturePack.ControlLane]::BlockIfHopeless(
    $foregroundHwnd, 3, 250)
  $hostileBlockedDebtMs =
    [CapturePack.ControlLane]::BlockedRemainingMs($foregroundHwnd)
  $remainingOrder = [CapturePack.ControlLane]::Due(
    $foregroundHwnd, 0, 3000, 300000)

  # Exercise the real scheduler with ten healthy dirty windows after the
  # 2050 ms offender has put the global lane deeply in debt. Alternating the
  # measured 32/100 ms classes pins both sides of the latency contract.
  $healthyCosts = [double[]](32,100,32,100,32,100,32,100,32,100)
  $maxHealthyWindowDebtMs = 0
  $healthyExecutedDuringHostileDebt = 0
  $healthyCostMs = 0.0
  for ($i = 0; $i -lt $peerHwnds.Length; $i++) {
    $peer = $peerHwnds[$i]
    if (-not [CapturePack.ControlLane]::IsOperationDue(
      $peer, $foregroundHwnd, 3000, 300000)) { continue }
    $cost = $healthyCosts[$i]
    $healthyCostMs += $cost
    [void][CapturePack.ControlLane]::DeferWindow($peer, $cost, 0.03)
    [CapturePack.ControlLane]::RecordWalkOutcome(
      $peer, $cost, 120, $false, $false, 0, 3)
    [CapturePack.ControlLane]::MarkDirty($peer)
    $windowDebt = [CapturePack.ControlLane]::WindowDebtRemainingMs($peer)
    $maxHealthyWindowDebtMs = [Math]::Max(
      $maxHealthyWindowDebtMs, $windowDebt)
    $healthyExecutedDuringHostileDebt++
  }
  $globalDebtAfterDirtyBurstMs =
    [CapturePack.ControlLane]::GlobalDebtRemainingMs
  $nextDirtyOperationDueMs =
    [CapturePack.ControlLane]::NextOperationDueInMs(3000, 300000)
  $burstCpuMs = 2050.0 + $healthyCostMs
  $steadyIdleDuty = $burstCpuMs / (
    $burstCpuMs + [Math]::Max(1, $globalDebtAfterDirtyBurstMs))
  $urgentTokensAfterHealthyMs =
    [CapturePack.ControlLane]::UrgentTokens
  $urgentTokenCapacityMs =
    [CapturePack.ControlLane]::UrgentTokenCapacity
  $urgentAdmissionMs =
    [CapturePack.ControlLane]::UrgentAdmission
  $urgentRefillAfter3sMs =
    [CapturePack.ControlLane]::UrgentRefillFor(3000, 0.03)
  $locationChildQueued =
    [CapturePack.ControlLane]::ShouldQueueWinEvent(0x800B, -4, 0, $true)
  $locationChildHwndQueued =
    [CapturePack.ControlLane]::ShouldQueueWinEvent(0x800B, 0, 0, $false)
  $locationWindowQueued =
    [CapturePack.ControlLane]::ShouldQueueWinEvent(0x800B, 0, 0, $true)

  # Omission may be occlusion, so it does not pardon a slow provider. With the
  # same desired set restored before expiry, the owner loop itself re-admits
  # the HWND after TTL without needing another Core track message.
  # Use a debt-free fixture here: the offender above intentionally must NOT
  # return at this short TTL because its longer per-HWND debt survives Untrack.
  [CapturePack.ControlLane]::Shutdown()
  $ttlHwnd = [long]930001
  [CapturePack.ControlLane]::SetTracked([long[]]@($ttlHwnd))
  [CapturePack.ControlLane]::RecordWalkOutcome(
    $ttlHwnd, 1, 120, $true, $false, 0, 3)
  [CapturePack.ControlLane]::RecordWalkOutcome(
    $ttlHwnd, 1, 120, $true, $false, 0, 3)
  [CapturePack.ControlLane]::RecordWalkOutcome(
    $ttlHwnd, 1, 120, $true, $false, 0, 3)
  [void][CapturePack.ControlLane]::BlockIfHopeless($ttlHwnd, 3, 250)
  [CapturePack.ControlLane]::SetTracked([long[]]@())
  $omissionKeepsQuarantine = [CapturePack.ControlLane]::BlockedCount -gt 0
  [CapturePack.ControlLane]::SetTracked([long[]]@($ttlHwnd))
  $reusedBeforeTtl = [CapturePack.ControlLane]::NeedsWalk(
    $ttlHwnd, 3000, 300000)
  Start-Sleep -Milliseconds 300
  $ttlRestored = [CapturePack.ControlLane]::RestoreExpiredQuarantines()
  $reusedAfterTtl = [CapturePack.ControlLane]::NeedsWalk(
    $ttlHwnd, 3000, 300000)

  Write-Line (([ordered]@{
    event = 'budget-selftest'
    cadenceBefore = $cadenceBefore
    cadenceAt = $cadenceAt
    findAllReason = $findAllReason
    scanReason = $scanReason
    totalReason = $totalReason
    capReason = $capReason
    completeReason = $completeReason
    severeBefore = $severeBefore
    severeAt = $severeAt
    cooldown100 = $cooldown100
    cooldown120 = $cooldown120
    cooldownMulti = $cooldownMulti
    duty100 = $duty100
    duty120 = $duty120
    dutyMulti = $dutyMulti
    firstWalkDue = $firstWalkDue
    failedStrikesAfterOne = $failedStrikesAfterOne
    failedLastPassMs = $failedLastPassMs
    failedDueImmediately = $failedDueImmediately
    failedRetryMs = $failedRetryMs
    failedNextDueMs = $failedNextDueMs
    failureBlocked = $failureBlocked
    emptyDueImmediately = $emptyDueImmediately
    emptyRetryMs = $emptyRetryMs
    emptyNextDueMs = $emptyNextDueMs
    incompleteRetryPending = $incompleteRetryPending
    incompleteStrikes = $incompleteStrikes
    retryAfterRefresh = $retryAfterRefresh
    strikesAfterRefresh = $strikesAfterRefresh
    capRetryPending = $capRetryPending
    capStrikes = $capStrikes
    foregroundFirst = $(if ($foregroundOrder.Length -gt 0) {
      $foregroundOrder[0]
    } else { 0 })
    switchedForegroundFirst = $(if ($switchedOrder.Length -gt 0) {
      $switchedOrder[0]
    } else { 0 })
    hostilePeerSamePass = $hostilePeerSamePass
    hostileDebtMs = $hostileDebtMs
    hostileBlockedDebtMs = $hostileBlockedDebtMs
    healthyPeersDuringDebt = $healthyPeersDuringDebt
    healthyExecutedDuringHostileDebt = $healthyExecutedDuringHostileDebt
    hostileExcludedDuringDebt = $hostileExcludedDuringDebt
    maxHealthyWindowDebtMs = $maxHealthyWindowDebtMs
    globalDebtAfterDirtyBurstMs = $globalDebtAfterDirtyBurstMs
    nextDirtyOperationDueMs = $nextDirtyOperationDueMs
    steadyIdleDuty = $steadyIdleDuty
    urgentTokensAfterHealthyMs = $urgentTokensAfterHealthyMs
    urgentTokenCapacityMs = $urgentTokenCapacityMs
    urgentAdmissionMs = $urgentAdmissionMs
    urgentRefillAfter3sMs = $urgentRefillAfter3sMs
    locationChildQueued = $locationChildQueued
    locationChildHwndQueued = $locationChildHwndQueued
    locationWindowQueued = $locationWindowQueued
    severeStrikes = $severeStrikes
    severeBlocked = $severeBlocked
    remainingAfterForegroundBlock = $(if ($remainingOrder.Length -gt 0) {
      $remainingOrder[0]
    } else { 0 })
    omissionKeepsQuarantine = $omissionKeepsQuarantine
    reusedBeforeTtl = $reusedBeforeTtl
    ttlRestored = $ttlRestored
    reusedAfterTtl = $reusedAfterTtl
  }) | ConvertTo-Json -Compress)
  $passed = -not $cadenceBefore -and $cadenceAt -and
    $findAllReason -eq 'findall-timeout' -and
    $scanReason -eq 'scan-timeout' -and
    $totalReason -eq 'total-timeout' -and
    $capReason -eq 'element-cap' -and
    $completeReason -eq '' -and
    -not $severeBefore -and $severeAt -and
    $duty100 -le 0.03 -and
    $duty120 -le 0.03 -and
    $dutyMulti -le 0.03 -and
    $firstWalkDue -and
    $failedStrikesAfterOne -eq 1 -and
    $failedLastPassMs -eq 1 -and
    -not $failedDueImmediately -and
    $failedRetryMs -eq 6000 -and
    $failedNextDueMs -gt 5000 -and
    $failureBlocked -eq $failureHwnd -and
    -not $emptyDueImmediately -and
    $emptyRetryMs -eq 3000 -and
    $emptyNextDueMs -gt 2000 -and
    $incompleteRetryPending -and
    $incompleteStrikes -eq 1 -and
    $retryAfterRefresh -and
    $strikesAfterRefresh -eq 1 -and
    -not $capRetryPending -and
    $capStrikes -eq 0 -and
    $foregroundOrder[0] -eq $foregroundHwnd -and
    $switchedOrder[0] -eq $otherHwnd -and
    $hostilePeerSamePass -and
    $hostileDebtMs -gt 60000 -and
    $hostileBlockedDebtMs -gt 60000 -and
    $healthyPeersDuringDebt -eq 10 -and
    $healthyExecutedDuringHostileDebt -eq 10 -and
    $hostileExcludedDuringDebt -and
    $maxHealthyWindowDebtMs -le 3500 -and
    $globalDebtAfterDirtyBurstMs -gt 80000 -and
    $nextDirtyOperationDueMs -gt 2900 -and
    $nextDirtyOperationDueMs -le 3500 -and
    $steadyIdleDuty -le 0.03 -and
    $urgentTokensAfterHealthyMs -ge $urgentAdmissionMs -and
    $urgentTokensAfterHealthyMs -lt $urgentTokenCapacityMs -and
    $urgentRefillAfter3sMs -eq 90 -and
    $locationChildQueued -and
    $locationChildHwndQueued -and
    -not $locationWindowQueued -and
    $severeStrikes -eq 3 -and
    $severeBlocked -eq $foregroundHwnd -and
    $remainingOrder[0] -eq $otherHwnd -and
    $omissionKeepsQuarantine -and
    -not $reusedBeforeTtl -and
    $ttlRestored -ge 1 -and
    $reusedAfterTtl
  [CapturePack.ControlLane]::Shutdown()
  exit $(if ($passed) { 0 } else { 1 })
}

[CapturePack.ControlLane]::StartChangeSignal()

$self = [System.Diagnostics.Process]::GetCurrentProcess()

# ---------------------------------------------------------------------------
# Standalone benchmark: the numbers in the header are checked with this.
# ---------------------------------------------------------------------------
if ($SelfTest -gt 0) {
  Add-Type -AssemblyName System.Windows.Forms
  # The foreground window WITHOUT synthesizing anything: whatever is in front.
  $root = [System.Windows.Automation.AutomationElement]::FocusedElement
  $hwnd = 0
  try {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $node = $root
    while ($null -ne $node) {
      $h = $node.Current.NativeWindowHandle
      if ($h -ne 0) { $hwnd = [long]$h }
      $node = $walker.GetParent($node)
    }
  } catch { }
  if ($hwnd -eq 0) { Write-Line '{"event":"selftest","error":"no foreground window"}'; exit 0 }
  [CapturePack.ControlLane]::SetTracked(@([long]$hwnd))
  $walkStart = [CapturePack.ControlLane]::Busy
  $tree = [CapturePack.ControlLane]::Walk(
    [long]$hwnd, $MaxElementsPerWindow, 5000, $MaxStrikes)
  $walkMs = [CapturePack.ControlLane]::Busy - $walkStart
  $elements = [CapturePack.ControlLane]::ElementCount
  $refreshStart = [CapturePack.ControlLane]::Busy
  for ($i = 0; $i -lt $SelfTest; $i++) {
    [void][CapturePack.ControlLane]::Refresh([long]$hwnd, $WindowTimeoutMs)
  }
  $refreshMs = ([CapturePack.ControlLane]::Busy - $refreshStart) / $SelfTest
  Write-Line ('{"event":"selftest"' +
    ',"hwnd":"' + $hwnd + '"' +
    ',"elements":' + $elements +
    ',"walkMs":' + [Math]::Round($walkMs, 2) +
    ',"refreshMsPerPass":' + [Math]::Round($refreshMs, 3) +
    ',"refreshUsPerElement":' + [Math]::Round(($refreshMs * 1000 / [Math]::Max(1, $elements)), 1) +
    ',"speedup":' + [Math]::Round(($walkMs / [Math]::Max(0.001, $refreshMs)), 1) +
    ',"passesPerSecondAt5Percent":' + [Math]::Round((50 / [Math]::Max(0.001, $refreshMs)), 1) +
    '}')
  [CapturePack.ControlLane]::Shutdown()
  exit 0
}

# ---------------------------------------------------------------------------
# Resident loop
# ---------------------------------------------------------------------------

[CapturePack.TrackInput]::Start()

$running = $true
$focus = [long]0
$rotation = 0
$nextStatusMs = 5000
$sleepMs = $MinSleepMs
$wallStart = [CapturePack.ControlLane]::NowMs

while ($running) {
  [void][CapturePack.ControlLane]::RestoreExpiredQuarantines()
  [CapturePack.ControlLane]::DrainChangeSignals()
  $due = [CapturePack.ControlLane]::Due(
    $focus, $rotation, $ReWalkFloorMs, $SafetyReWalkMs)
  $rotation++
  foreach ($h in $due) {
    if (-not [CapturePack.ControlLane]::IsOperationDue(
      $h, $focus, $ReWalkFloorMs, $SafetyReWalkMs)) {
      continue
    }
    $needsWalk = [CapturePack.ControlLane]::NeedsWalk(
      $h, $ReWalkFloorMs, $SafetyReWalkMs)
    $canRefresh = [CapturePack.ControlLane]::HasTree($h)
    if (-not $needsWalk -and -not $canRefresh) {
      # A failed or honestly empty tree is between retry deadlines. Do not
      # emit progress or enter UIA merely because it is foreground.
      continue
    }
    # Flush the exact provider about to be called before entering UIA. If a
    # Current/FromHandle/FindAll call never returns, Core can quarantine this
    # HWND on watchdog recovery instead of replaying the same hang forever.
    Write-Line ('{"event":"walking","t":' +
      [CapturePack.ControlLane]::NowMs + ',"h":"' + $h + '"}')
    $operationStart = [CapturePack.ControlLane]::Busy
    try {
      if ($needsWalk) {
        # The tree really changed (WinEvent) or was never read: walk it.
        $line = [CapturePack.ControlLane]::Walk(
          $h, $MaxElementsPerWindow, $WindowTimeoutMs, $MaxStrikes)
        if ($null -ne $line) { Write-Line $line }
      } else {
        $line = [CapturePack.ControlLane]::Refresh($h, $WindowTimeoutMs)
        if ($null -ne $line) { Write-Line $line }
      }
    } catch {
      Write-Line ('{"event":"error","t":' + [CapturePack.ControlLane]::NowMs +
        ',"where":"pass","h":"' + $h + '","message":' +
        (ConvertTo-Json ([string]$_.Exception.Message) -Compress) + '}')
    }
    $operationMs = [CapturePack.ControlLane]::Busy - $operationStart
    [void][CapturePack.ControlLane]::DeferWindow(
      $h, $operationMs, $DutyTarget)
    $blocked = [CapturePack.ControlLane]::BlockIfHopeless(
      $h, $MaxStrikes, $BlockedTtlMs)
    if ($blocked -ne 0) {
      Write-Line ('{"event":"blocked","t":' + [CapturePack.ControlLane]::NowMs +
        ',"h":"' + $blocked + '","lastPassMs":' +
        [Math]::Round([CapturePack.ControlLane]::LastBlockedPassMs, 1) + '}')
    }
  }
  [void][CapturePack.ControlLane]::CollectReleasedReferences(
    $ReferenceCollectionThreshold,
    $ReferenceCollectionFloorMs)

  # SELF-PACED PER HWND. Each provider owns its debt; a 2 s hostile FindAll can
  # be quarantined without imposing ~66 s silence on ten healthy windows. The
  # target is divided by tracked count, keeping aggregate steady-state budget
  # near 3% while preserving bounded foreground/dirty-peer latency.
  $now = [CapturePack.ControlLane]::NowMs
  $nextOperationDueMs = [CapturePack.ControlLane]::NextOperationDueInMs(
    $ReWalkFloorMs, $SafetyReWalkMs)
  if ($nextOperationDueMs -eq [int]::MaxValue) {
    $sleepMs = $MaxSleepMs
  } else {
    $sleepMs = [Math]::Max(
      $MinSleepMs, [Math]::Min($MaxSleepMs, $nextOperationDueMs))
  }

  if ($now -ge $nextStatusMs) {
    $self.Refresh()
    $wall = $now - $wallStart
    $duty = if ($wall -gt 0) { [Math]::Round([CapturePack.ControlLane]::Busy / $wall, 5) } else { 0 }
    Write-Line ('{"event":"status","t":' + $now +
      ',"dutyCycle":' + $duty +
      ',"busyMs":' + [Math]::Round([CapturePack.ControlLane]::Busy, 1) +
      ',"tracked":' + [CapturePack.ControlLane]::TrackedCount +
      ',"blocked":' + [CapturePack.ControlLane]::BlockedCount +
      ',"elements":' + [CapturePack.ControlLane]::ElementCount +
      ',"signal":"' + [CapturePack.ControlLane]::ChangeSignalMode + '"' +
      ',"gc":' + [CapturePack.ControlLane]::ReferenceCollectionCount +
      ',"ws":' + $self.WorkingSet64 + '}')
    $nextStatusMs = $now + 5000
  }
  # Keep the status heartbeat below Core's silence watchdog even when one pass
  # legitimately earned a long cooldown.
  $statusDueMs = [int][Math]::Max(
    0, [Math]::Ceiling($nextStatusMs - [CapturePack.ControlLane]::NowMs))
  $sleepMs = [Math]::Min($sleepMs, $statusDueMs)

  $line = [CapturePack.TrackInput]::TryRead()
  if ($null -eq $line) {
    if ([CapturePack.TrackInput]::Closed -and [CapturePack.TrackInput]::Drained()) { break }
    [void][CapturePack.TrackInput]::Wait($sleepMs)
    $line = [CapturePack.TrackInput]::TryRead()
  }
  if ($null -eq $line -or $line.Trim() -eq '') { continue }

  $request = $null
  try { $request = $line | ConvertFrom-Json } catch { $request = $null }
  if ($null -eq $request) { continue }
  $id = 0
  if ($null -ne $request.id) { $id = [int]$request.id }

  switch ([string]$request.method) {
    'hello' {
      Write-Line ('{"id":' + $id + ',"ok":true,"hostMs":' + [CapturePack.ControlLane]::NowMs +
        ',"pid":' + $self.Id + ',"lane":"A","dpi":"' + [CapturePack.ControlLane]::DpiMode +
        '","signal":"' + [CapturePack.ControlLane]::ChangeSignalMode + '"}')
    }
    'track' {
      # Lane S decides what is visible; this lane is told. An empty list is a
      # legitimate answer (nothing on screen worth walking) and clears the set.
      $hwnds = @()
      if ($null -ne $request.params -and $null -ne $request.params.hwnds) {
        foreach ($h in $request.params.hwnds) {
          $parsed = [long]0
          if ([long]::TryParse([string]$h, [ref]$parsed)) { $hwnds += $parsed }
        }
      }
      if ($null -ne $request.params -and $null -ne $request.params.focus) {
        $parsed = [long]0
        if ([long]::TryParse([string]$request.params.focus, [ref]$parsed)) { $focus = $parsed }
      }
      [CapturePack.ControlLane]::SetTracked([long[]]$hwnds)
      Write-Line ('{"id":' + $id + ',"ok":true,"tracked":' + [CapturePack.ControlLane]::TrackedCount + '}')
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

[CapturePack.ControlLane]::Shutdown()
