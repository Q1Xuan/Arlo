param([string]$Name)
$ErrorActionPreference = 'Stop'
$mutex = [System.Threading.Mutex]::new($false, $Name)
$held = $false
try {
    try { $held = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) {
        [Console]::Out.WriteLine('BUSY')
        exit 0
    }
    [Console]::Out.WriteLine('ACQUIRED')
    [Console]::Out.Flush()
    # EOF also releases the mutex if the owning Node process crashes.
    $null = [Console]::In.ReadLine()
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
