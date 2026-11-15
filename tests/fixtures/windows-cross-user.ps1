param([Parameter(Mandatory=$true)][string]$StateDirectory, [switch]$Cleanup)
$ErrorActionPreference = 'Stop'
if ($env:ARLO_ALLOW_TEMPORARY_USER -ne '1') { throw 'TEMPORARY_USER_AUTHORIZATION_REQUIRED' }
$state = (Resolve-Path -LiteralPath $StateDirectory).Path
$manifest = Join-Path $state '.temporary-user.json'
if ($Cleanup) {
  if (Test-Path -LiteralPath $manifest) {
    $owned = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $remaining = Get-LocalUser -Name $owned.name -ErrorAction SilentlyContinue
    if ($null -ne $remaining) {
      if ($remaining.Description -ne $owned.marker -or ($owned.sid -and $remaining.SID.Value -ne $owned.sid)) { throw 'TEMPORARY_ACCOUNT_OWNERSHIP_CHANGED' }
      Remove-LocalUser -SID $remaining.SID
    }
    Remove-Item -LiteralPath $manifest
  }
  exit 0
}
$marker = 'Arlo16 ' + [guid]::NewGuid().ToString()
$name = 'kq16' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$password = [guid]::NewGuid().ToString('N') + 'aA9!'
$account = $null
$token = [IntPtr]::Zero
$impersonation = $null
$publicFile = Join-Path $state 'cross-user-public-control.txt'
$result = $null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ArloTemporaryLogon {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
try {
  # Persist intent before the OS mutation so timeout cleanup can find a user
  # even if this process dies before New-LocalUser returns its SID.
  [ordered]@{ name=$name; sid=$null; marker=$marker } | ConvertTo-Json | Set-Content -LiteralPath $manifest
  $account = New-LocalUser -Name $name -Password (ConvertTo-SecureString $password -AsPlainText -Force) -Description $marker -AccountExpires (Get-Date).AddHours(1)
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
  # Grant only the deliberately public control file to the temporary SID.
  # The real state directory and all production files keep their native ACLs.
  [IO.File]::WriteAllText($publicFile, 'public-control')
  $acl = Get-Acl -LiteralPath $publicFile
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, 'Read', 'Allow'))
  Set-Acl -LiteralPath $publicFile -AclObject $acl
  if (-not [ArloTemporaryLogon]::LogonUser($name, '.', $password, 2, 0, [ref]$token)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $identity = [Security.Principal.WindowsIdentity]::new($token)
  $impersonation = $identity.Impersonate()
  $observedSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($observedSid -ne $account.SID.Value -or $observedSid -eq $ownerSid) { throw 'DIFFERENT_NATIVE_SID_REQUIRED' }
  if ([IO.File]::ReadAllText($publicFile) -ne 'public-control') { throw 'PUBLIC_READ_POSITIVE_CONTROL_FAILED' }
  $attempts = @()
  foreach ($leaf in @('bootstrap.token', 'daemon.key', 'daemon.crt', 'discovery.json', 'daemon.lock', 'daemon.log')) {
    $stream = $null
    $denied = $false
    try {
      $stream = [IO.File]::Open((Join-Path $state $leaf), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      # Do not copy a secret into diagnostics if the ACL is unexpectedly wrong.
    } catch [UnauthorizedAccessException] { $denied = $true }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    $attempts += [ordered]@{ file=$leaf; accessDenied=$denied; bytesRead=0 }
  }
  $createDenied = $false
  try { [IO.File]::WriteAllText((Join-Path $state 'unauthorized-write'), 'public-canary') }
  catch [UnauthorizedAccessException] { $createDenied = $true }
  $result = [ordered]@{ ownerSid=$ownerSid; testSid=$observedSid; positiveControl=$true; attempts=$attempts; createDenied=$createDenied; accountRemoved=$false }
} finally {
  if ($null -ne $impersonation) { $impersonation.Undo(); $impersonation.Dispose() }
  if ($token -ne [IntPtr]::Zero) { [void][ArloTemporaryLogon]::CloseHandle($token) }
  if (Test-Path -LiteralPath $publicFile) { Remove-Item -LiteralPath $publicFile }
  if ($null -ne $account) {
    $ownedAccount = Get-LocalUser -SID $account.SID -ErrorAction SilentlyContinue
    if ($null -ne $ownedAccount) {
      if ($ownedAccount.Description -ne $marker) { throw 'TEMPORARY_ACCOUNT_OWNERSHIP_CHANGED' }
      Remove-LocalUser -SID $account.SID
    }
    if ($null -ne (Get-LocalUser -SID $account.SID -ErrorAction SilentlyContinue)) { throw 'TEMPORARY_ACCOUNT_CLEANUP_FAILED' }
    if ($null -ne $result) { $result.accountRemoved = $true }
  }
}
$result | ConvertTo-Json -Depth 5 -Compress
