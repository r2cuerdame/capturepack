using System;
using System.Runtime.InteropServices;

internal static class MoveNoReplace
{
    private const int ErrorFileExists = 80;
    private const int ErrorAlreadyExists = 183;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileW(string existingPath, string newPath);

    private static string ExtendedPath(string value)
    {
        string normalized = value.Replace('/', '\\');
        if (normalized.StartsWith(@"\\?\", StringComparison.Ordinal))
        {
            return normalized;
        }
        if (normalized.StartsWith(@"\\", StringComparison.Ordinal))
        {
            return @"\\?\UNC\" + normalized.Substring(2);
        }
        if (
            normalized.Length >= 3 &&
            char.IsLetter(normalized[0]) &&
            normalized[1] == ':' &&
            normalized[2] == '\\'
        )
        {
            return @"\\?\" + normalized;
        }
        return normalized;
    }

    public static int Main(string[] args)
    {
        if (args.Length != 2 || args[0].Length == 0 || args[1].Length == 0)
        {
            return 64;
        }

        if (MoveFileW(ExtendedPath(args[0]), ExtendedPath(args[1])))
        {
            return 0;
        }

        int error = Marshal.GetLastWin32Error();
        Console.Error.WriteLine("WIN32_ERROR=" + error);
        return error == ErrorFileExists || error == ErrorAlreadyExists ? 2 : 3;
    }
}
