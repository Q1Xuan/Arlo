using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// Only processes created by this helper are terminated, using their original
// handles. Every candidate stays suspended: no application code, configuration,
// provider client or network request is executed while seeking PID recycling.
public static class WindowsPidReuse
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb;
        public string reserved, desktop, title;
        public uint x, y, width, height, xChars, yChars, fill, flags;
        public ushort show, reservedBytes;
        public IntPtr reservedPointer, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static long Created(IntPtr process)
    {
        long created, exited, kernel, user;
        if (!GetProcessTimes(process, out created, out exited, out kernel, out user))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return created;
    }
    static void Stop(ref ProcessInfo info)
    {
        if (info.process == IntPtr.Zero) return;
        try
        {
            if (WaitForSingleObject(info.process, 0) == 258 && !TerminateProcess(info.process, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (WaitForSingleObject(info.process, 5000) != 0) throw new Exception("OWNED_PROCESS_DID_NOT_EXIT");
        }
        finally
        {
            CloseHandle(info.thread);
            CloseHandle(info.process);
            info = new ProcessInfo();
        }
    }
    public static int Main(string[] args)
    {
        try
        {
            uint target = uint.Parse(args[1]);
            if (args[0] == "inspect")
            {
                IntPtr process = OpenProcess(0x1000, false, target);
                if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                try { Console.WriteLine("{\"pid\":" + target + ",\"created\":\"" + Created(process) + "\"}"); }
                finally { CloseHandle(process); }
                return 0;
            }
            string executable = args[2];
            int maximum = int.Parse(args[3]), milliseconds = int.Parse(args[4]);
            Stopwatch clock = Stopwatch.StartNew();
            int attempts = 0;
            ProcessInfo candidate = new ProcessInfo();
            try
            {
                while (attempts < maximum && clock.ElapsedMilliseconds < milliseconds)
                {
                    StartupInfo startup = new StartupInfo();
                    startup.cb = Marshal.SizeOf(startup);
                    // CREATE_SUSPENDED | CREATE_NO_WINDOW, with no inherited handles.
                    if (!CreateProcess(executable, new StringBuilder("\"" + executable + "\""),
                        IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, null, ref startup, out candidate))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    attempts++;
                    if (candidate.pid == target)
                    {
                        Console.WriteLine("{\"reused\":true,\"pid\":" + target + ",\"created\":\"" + Created(candidate.process) +
                            "\",\"attempts\":" + attempts + ",\"elapsedMs\":" + clock.ElapsedMilliseconds + "}");
                        string command;
                        while ((command = Console.ReadLine()) == "inspect")
                            Console.WriteLine("{\"alive\":" + (WaitForSingleObject(candidate.process, 0) == 258 ? "true" : "false") +
                                ",\"created\":\"" + Created(candidate.process) + "\"}");
                        return 0;
                    }
                    Stop(ref candidate);
                }
                Console.WriteLine("{\"reused\":false,\"attempts\":" + attempts + ",\"elapsedMs\":" + clock.ElapsedMilliseconds + "}");
                return 0;
            }
            finally { Stop(ref candidate); }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}
