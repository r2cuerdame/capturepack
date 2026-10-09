// A single owned PDH query avoids rebuilding the GPU counter set every sample.
// References: Microsoft PdhCollectQueryData and PdhGetFormattedCounterArrayW.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public sealed class CapturePackGpuCounter : IDisposable {
  [DllImport("pdh.dll", CharSet=CharSet.Unicode)]
  static extern uint PdhOpenQueryW(IntPtr source, IntPtr data, out IntPtr query);
  [DllImport("pdh.dll", CharSet=CharSet.Unicode)]
  static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr data, out IntPtr counter);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr query);
  [DllImport("pdh.dll")] static extern uint PdhCloseQuery(IntPtr query);
  [DllImport("pdh.dll", CharSet=CharSet.Unicode)]
  static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint bytes, out uint count, IntPtr items);
  [StructLayout(LayoutKind.Sequential)] struct CounterValue { public uint Status; public double Value; }
  [StructLayout(LayoutKind.Sequential)] struct CounterItem { public IntPtr Name; public CounterValue Value; }
  public sealed class Reading {
    public string InstanceName { get; set; }
    public double CookedValue { get; set; }
  }
  IntPtr query;
  IntPtr counter;
  const uint MoreData = 0x800007D2;
  const uint FormatDouble = 0x00000200;
  const uint MaximumBytes = 4 * 1024 * 1024;
  static void Require(uint code, string operation) {
    if (code != 0) throw new InvalidOperationException(operation + " failed: 0x" + code.ToString("X8"));
  }
  public CapturePackGpuCounter() {
    try {
      Require(PdhOpenQueryW(IntPtr.Zero, IntPtr.Zero, out query), "PdhOpenQuery");
      Require(PdhAddEnglishCounterW(query, @"\GPU Engine(*)\Utilization Percentage", IntPtr.Zero, out counter), "PdhAddEnglishCounter");
      // Rate counters need a previous observation; subsequent reads collect once.
      Require(PdhCollectQueryData(query), "PdhCollectQueryData baseline");
    } catch { Dispose(); throw; }
  }
  public Reading[] Read() {
    if (query == IntPtr.Zero) throw new ObjectDisposedException("CapturePackGpuCounter");
    Require(PdhCollectQueryData(query), "PdhCollectQueryData");
    uint bytes = 0, count;
    uint status = PdhGetFormattedCounterArrayW(counter, FormatDouble, ref bytes, out count, IntPtr.Zero);
    if (status == 0 && bytes == 0) return new Reading[0];
    if (status != MoreData) Require(status, "PdhGetFormattedCounterArray size");
    for (int attempt = 0; attempt < 3; attempt++) {
      if (bytes == 0 || bytes > MaximumBytes) throw new InvalidOperationException("GPU counter buffer outside bounds");
      uint allocated = bytes;
      IntPtr buffer = Marshal.AllocHGlobal((int)allocated);
      try {
        status = PdhGetFormattedCounterArrayW(counter, FormatDouble, ref bytes, out count, buffer);
        if (status == MoreData) continue;
        Require(status, "PdhGetFormattedCounterArray");
        int stride = Marshal.SizeOf(typeof(CounterItem));
        if ((ulong)count * (uint)stride > allocated) throw new InvalidOperationException("GPU counter item count outside buffer");
        var result = new List<Reading>((int)count);
        for (uint i = 0; i < count; i++) {
          var item = (CounterItem)Marshal.PtrToStructure(IntPtr.Add(buffer, checked((int)i * stride)), typeof(CounterItem));
          if (item.Value.Status > 1 || double.IsNaN(item.Value.Value) || double.IsInfinity(item.Value.Value)) continue;
          long offset = item.Name.ToInt64() - buffer.ToInt64();
          if (offset < 0 || offset >= allocated || (offset & 1) != 0) throw new InvalidOperationException("GPU counter name outside buffer");
          string name = Marshal.PtrToStringUni(item.Name);
          if (String.IsNullOrEmpty(name)) continue;
          result.Add(new Reading { InstanceName = name, CookedValue = item.Value.Value });
        }
        if (count > 0 && result.Count == 0) throw new InvalidOperationException("GPU counters have no valid rate observations yet");
        return result.ToArray();
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    throw new InvalidOperationException("GPU counter instances changed beyond retry bound");
  }
  public void Dispose() {
    if (query != IntPtr.Zero) { PdhCloseQuery(query); query = IntPtr.Zero; counter = IntPtr.Zero; }
  }
}
