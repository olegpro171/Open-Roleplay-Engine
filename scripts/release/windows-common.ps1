$ErrorActionPreference = 'Stop'
function Invoke-Native([string]$Executable, [string[]]$ArgumentList) {
    & $Executable @ArgumentList
    if ($LASTEXITCODE -ne 0) { throw ('Native command failed ({0}): {1}' -f $LASTEXITCODE, $Executable) }
}
function Write-Utf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}
function Get-OreHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}
function Initialize-OreHome([string]$Installation) {
    $resolved = [IO.Path]::GetFullPath($Installation)
    foreach ($name in @('', 'cache', 'logs', 'runtime', 'app', 'data', 'languages')) {
        [IO.Directory]::CreateDirectory((Join-Path $resolved $name)) | Out-Null
    }
    # A user-owned installation must not inherit broad readable ACLs. Children,
    # including SQLite snapshots, inherit this ACL rather than POSIX mode bits.
    $acl = [IO.Directory]::GetAccessControl($resolved, [Security.AccessControl.AccessControlSections]::Access)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($existing) }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    [IO.Directory]::SetAccessControl($resolved, $acl)
    $env:ORE_HOME = $resolved
    $env:TEMP = Join-Path $resolved 'cache'
    $env:TMP = $env:TEMP
    Remove-Item Env:NODE_OPTIONS,Env:NODE_PATH -ErrorAction SilentlyContinue
    return $resolved
}
function Initialize-OreJob {
    if ('OreJob' -as [type]) { return }
    # Built-in .NET interop only. Assign this controller before spawning any
    # tools: descendants inherit the job without a spawn/assignment race.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OreJob {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr p, uint s);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    static IntPtr handle;
    public static void Attach() {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64 layout; LimitFlags at 16.
        IntPtr info = Marshal.AllocHGlobal(144);
        try {
            for (int i=0;i<144;i++) Marshal.WriteByte(info,i,0);
            Marshal.WriteInt32(info,16,0x2000); // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(handle,9,info,144) || !AssignProcessToJobObject(handle,GetCurrentProcess()))
                throw new System.ComponentModel.Win32Exception();
        } finally { Marshal.FreeHGlobal(info); }
        // Keep the sole non-inherited handle open until controller exit.
    }
}
'@
    [OreJob]::Attach()
}
