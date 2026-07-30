// CapturePack emergency replay source for Windows.
//
// This executable is deliberately tiny and dependency-free: Windows GDI
// captures one physical monitor, JPEG-encodes each observed frame, and writes a
// length-delimited binary stream to stdout. It is NOT the normal capture path.
// Chromium's desktop capture remains primary; this process is started only
// after that stream explicitly fails or proves that it delivers no frames.
//
// Protocol (little endian), repeated until stdin closes:
//   "CPRF" u32(version=2) i64(sequence) i64(captured_qpc)
//   i64(qpc_frequency) i64(captured_unix_ms)
//   i32(width) i32(height) i32(jpeg_length) i32(reserved) jpeg_bytes
//
// stderr is human-readable diagnostics. stdout contains protocol bytes only.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

internal static class NativeReplayCapture
{
    private const int SRCCOPY = 0x00CC0020;
    private const int CAPTUREBLT = unchecked((int)0x40000000);
    private const int HALFTONE = 4;
    private const uint MONITORINFOF_PRIMARY = 1;
    private static volatile bool stopping;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    private sealed class Monitor
    {
        public IntPtr Handle;
        public RECT Rect;
        public bool Primary;
        public string Device = "";
    }

    private sealed class CapturedFrame
    {
        public byte[] Jpeg = new byte[0];
        public long Qpc;
        public long EpochMs;
    }

    private delegate bool MonitorEnumProc(
        IntPtr monitor,
        IntPtr hdc,
        IntPtr rect,
        IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(
        IntPtr hdc,
        IntPtr clip,
        MonitorEnumProc callback,
        IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern bool StretchBlt(
        IntPtr dest,
        int xDest,
        int yDest,
        int widthDest,
        int heightDest,
        IntPtr source,
        int xSource,
        int ySource,
        int widthSource,
        int heightSource,
        int rop);

    [DllImport("gdi32.dll")]
    private static extern int SetStretchBltMode(IntPtr hdc, int mode);

    private static int IntArg(string[] args, string name, int fallback)
    {
        for (var i = 0; i + 1 < args.Length; i++)
        {
            if (!string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) continue;
            int parsed;
            if (int.TryParse(args[i + 1], out parsed)) return parsed;
        }
        return fallback;
    }

    private static List<Monitor> Monitors()
    {
        var result = new List<Monitor>();
        EnumDisplayMonitors(
            IntPtr.Zero,
            IntPtr.Zero,
            delegate(IntPtr handle, IntPtr hdc, IntPtr rect, IntPtr data)
            {
                var info = new MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
                if (!GetMonitorInfo(handle, ref info)) return true;
                result.Add(new Monitor
                {
                    Handle = handle,
                    Rect = info.rcMonitor,
                    Primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0,
                    Device = info.szDevice ?? ""
                });
                return true;
            },
            IntPtr.Zero);
        return result
            .OrderBy(m => m.Rect.Left)
            .ThenBy(m => m.Rect.Top)
            .ThenBy(m => m.Rect.Right - m.Rect.Left)
            .ThenBy(m => m.Rect.Bottom - m.Rect.Top)
            .ToList();
    }

    private static ImageCodecInfo JpegCodec()
    {
        return ImageCodecInfo.GetImageEncoders()
            .First(codec => codec.FormatID == ImageFormat.Jpeg.Guid);
    }

    private static CapturedFrame CaptureJpeg(
        Monitor monitor,
        int outputWidth,
        int outputHeight,
        ImageCodecInfo codec,
        EncoderParameters encoder)
    {
        var sourceWidth = monitor.Rect.Right - monitor.Rect.Left;
        var sourceHeight = monitor.Rect.Bottom - monitor.Rect.Top;
        using (var bitmap = new Bitmap(outputWidth, outputHeight, PixelFormat.Format24bppRgb))
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var dest = graphics.GetHdc();
            var screen = GetDC(IntPtr.Zero);
            long capturedQpc = 0;
            long capturedEpochMs = 0;
            try
            {
                SetStretchBltMode(dest, HALFTONE);
                if (!StretchBlt(
                    dest,
                    0,
                    0,
                    outputWidth,
                    outputHeight,
                    screen,
                    monitor.Rect.Left,
                    monitor.Rect.Top,
                    sourceWidth,
                    sourceHeight,
                    SRCCOPY | CAPTUREBLT))
                {
                    throw new System.ComponentModel.Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "StretchBlt failed");
                }
                // Timestamp the completed BitBlt, not JPEG encoding or IPC.
                capturedQpc = Stopwatch.GetTimestamp();
                capturedEpochMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, screen);
                graphics.ReleaseHdc(dest);
            }
            using (var bytes = new MemoryStream())
            {
                bitmap.Save(bytes, codec, encoder);
                return new CapturedFrame
                {
                    Jpeg = bytes.ToArray(),
                    Qpc = capturedQpc,
                    EpochMs = capturedEpochMs
                };
            }
        }
    }

    private static int Main(string[] args)
    {
        // PER_MONITOR_AWARE_V2 where available; the legacy call is the
        // compatible fallback. EnumDisplayMonitors then reports physical pixels.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { try { SetProcessDPIAware(); } catch { } }

        var monitors = Monitors();
        var expectedLeft = IntArg(args, "--left", Int32.MinValue);
        var expectedTop = IntArg(args, "--top", Int32.MinValue);
        var expectedNativeWidth = IntArg(args, "--expected-native-width", -1);
        var expectedNativeHeight = IntArg(args, "--expected-native-height", -1);
        var matches = monitors.Where(candidate =>
            candidate.Rect.Left == expectedLeft &&
            candidate.Rect.Top == expectedTop &&
            candidate.Rect.Right - candidate.Rect.Left == expectedNativeWidth &&
            candidate.Rect.Bottom - candidate.Rect.Top == expectedNativeHeight).ToList();
        if (matches.Count != 1)
        {
            Console.Error.WriteLine(
                "native monitor identity did not resolve uniquely: rect=" +
                expectedLeft + "," + expectedTop + " " +
                expectedNativeWidth + "x" + expectedNativeHeight +
                " matches=" + matches.Count + " connected=" + monitors.Count);
            return 2;
        }
        var monitor = matches[0];
        var nativeWidth = monitor.Rect.Right - monitor.Rect.Left;
        var nativeHeight = monitor.Rect.Bottom - monitor.Rect.Top;
        var outputWidth = Math.Max(1, IntArg(args, "--width", nativeWidth));
        var outputHeight = Math.Max(1, IntArg(args, "--height", nativeHeight));
        var fps = Math.Max(5, Math.Min(30, IntArg(args, "--fps", 5)));
        var intervalTicks = Stopwatch.Frequency / (double)fps;
        var stdout = new BinaryWriter(
            new BufferedStream(Console.OpenStandardOutput(), 1024 * 1024));
        var codec = JpegCodec();
        using (var encoder = new EncoderParameters(1))
        {
            encoder.Param[0] = new EncoderParameter(
                System.Drawing.Imaging.Encoder.Quality,
                80L);
            var stdinThread = new Thread(delegate()
            {
                try
                {
                    while (Console.In.Read() >= 0) { }
                }
                catch { }
                stopping = true;
            });
            stdinThread.IsBackground = true;
            stdinThread.Start();

            Console.Error.WriteLine(
                "ready backend=windows-gdi-bitblt rect=" +
                monitor.Rect.Left + "," + monitor.Rect.Top +
                " device=" + monitor.Device +
                " native=" + nativeWidth + "x" + nativeHeight +
                " output=" + outputWidth + "x" + outputHeight +
                " fps=" + fps);

            long sequence = 0;
            var clock = Stopwatch.StartNew();
            double next = 0;
            while (!stopping)
            {
                var frame = CaptureJpeg(
                    monitor,
                    outputWidth,
                    outputHeight,
                    codec,
                    encoder);
                stdout.Write(new byte[] { 0x43, 0x50, 0x52, 0x46 }); // CPRF
                stdout.Write(2);
                stdout.Write(sequence++);
                stdout.Write(frame.Qpc);
                stdout.Write(Stopwatch.Frequency);
                stdout.Write(frame.EpochMs);
                stdout.Write(outputWidth);
                stdout.Write(outputHeight);
                stdout.Write(frame.Jpeg.Length);
                stdout.Write(0); // Reserved for an additive protocol extension.
                stdout.Write(frame.Jpeg);
                stdout.Flush();

                next += intervalTicks;
                var remainingTicks = next - clock.ElapsedTicks;
                if (remainingTicks > 0)
                {
                    var sleepMs = (int)Math.Floor(remainingTicks * 1000 / Stopwatch.Frequency);
                    if (sleepMs > 0) Thread.Sleep(sleepMs);
                    while (!stopping && clock.ElapsedTicks < next) Thread.SpinWait(50);
                }
                else if (-remainingTicks > intervalTicks * 3)
                {
                    // Do not burst old frames after a slow JPEG/GDI operation.
                    next = clock.ElapsedTicks;
                }
            }
        }
        stdout.Flush();
        return 0;
    }
}
