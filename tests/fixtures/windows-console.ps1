param([string]$Action, [string]$NodePath, [string]$CliPath, [string]$StateDir, [int]$TargetPid)
$ErrorActionPreference = 'Stop'
if ($Action -eq 'start') {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StartupConsoleSignal {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
}
'@
    # Non-interactive launchers can inherit the ignore-Ctrl+C flag. Clear it
    # before spawning so the child behaves like an interactive CLI process.
    if (-not [StartupConsoleSignal]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)) {
        throw 'Cannot enable Ctrl+C for the test console'
    }
    $arguments = @(('"' + $CliPath + '"'), 'serve', '--state-dir', ('"' + $StateDir + '"'))
    $child = Start-Process -FilePath $NodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $StateDir 'cli.stdout') -RedirectStandardError (Join-Path $StateDir 'cli.stderr')
    [Console]::Out.WriteLine($child.Id)
    [Console]::Out.Flush()
    $child.WaitForExit()
    exit $child.ExitCode
}
if ($Action -eq 'interrupt') {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleSignal {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint signal, uint group);
}
'@
    $null = [ConsoleSignal]::FreeConsole()
    if (-not [ConsoleSignal]::AttachConsole($TargetPid)) { throw 'Cannot attach to test console' }
    try {
        $null = [ConsoleSignal]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
        if (-not [ConsoleSignal]::GenerateConsoleCtrlEvent(0, 0)) { throw 'Cannot deliver Ctrl+C' }
        Start-Sleep -Milliseconds 100
    } finally { $null = [ConsoleSignal]::FreeConsole() }
}
