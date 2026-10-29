# All package startup/recovery controllers hold this OS lease until exit.
# Its file may survive a crash; its exclusive handle cannot survive one.
function Initialize-OrePackageJobType {
    if ('OrePackageJob' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class OrePackageJob {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static IntPtr ownedJob;
    static bool IsQuiescent(string name) {
        IntPtr job = OpenJobObject(4, false, name); // JOB_OBJECT_QUERY
        if (job == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 2) return true; // No job object survives without workers.
            throw new System.ComponentModel.Win32Exception(error);
        }
        IntPtr info = Marshal.AllocHGlobal(48);
        try {
            // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: ActiveProcesses at 40.
            if (!QueryInformationJobObject(job, 1, info, 48, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
            return Marshal.ReadInt32(info, 40) == 0;
        } finally {
            Marshal.FreeHGlobal(info);
            // Do not retain a query handle across waits: the previous owner's
            // KILL_ON_JOB_CLOSE must reach its last handle to stop its workers.
            CloseHandle(job);
        }
    }
    public static bool WaitForQuiescence(string name, int milliseconds) {
        Stopwatch clock = Stopwatch.StartNew();
        do {
            if (IsQuiescent(name)) return true;
            Thread.Sleep(25);
        } while (clock.ElapsedMilliseconds < milliseconds);
        return IsQuiescent(name);
    }
    public static void Attach(string name) {
        if (ownedJob != IntPtr.Zero) throw new InvalidOperationException("This controller already owns a package job.");
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        int creationError = Marshal.GetLastWin32Error();
        if (creationError == 183) { CloseHandle(job); throw new InvalidOperationException("Package job identity collision."); }
        IntPtr info = Marshal.AllocHGlobal(144);
        bool attached = false;
        try {
            for (int i = 0; i < 144; i++) Marshal.WriteByte(info, i, 0);
            Marshal.WriteInt32(info, 16, 0x2000); // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, info, 144) || !AssignProcessToJobObject(job, GetCurrentProcess())) throw new System.ComponentModel.Win32Exception();
            ownedJob = job;
            attached = true;
        } finally {
            Marshal.FreeHGlobal(info);
            if (!attached) CloseHandle(job);
        }
        // Retain this sole non-inherited handle until the controller exits.
    }
}
'@
}
function Acquire-OrePackageLease([string]$HomePath) {
    $cache = Assert-OrePath $HomePath (Join-Path $HomePath 'cache')
    [IO.Directory]::CreateDirectory($cache) | Out-Null
    $path = Assert-OrePath $HomePath (Join-Path $cache 'launcher.lease')
    $script:OreFailure = 'installationLocked'
    $lease = [IO.File]::Open($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $temporary = $null
    try {
        Initialize-OrePackageJobType
        $ownerPath = Assert-OrePath $HomePath (Join-Path $cache 'package-owner.json')
        if ([IO.Directory]::Exists($ownerPath)) { throw 'Invalid package ownership metadata.' }
        if ([IO.File]::Exists($ownerPath)) {
            if ((New-Object IO.FileInfo $ownerPath).Length -gt 1KB) { throw 'Oversized package ownership metadata.' }
            $previous = [IO.File]::ReadAllText($ownerPath,[Text.Encoding]::UTF8) | ConvertFrom-Json
            $properties = @($previous.PSObject.Properties.Name | Sort-Object)
            if (($properties -join ',') -cne 'job,version' -or $previous.version -ne 1 -or $previous.job -isnot [string] -or $previous.job -cnotmatch '^Global\\ORE-package-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Invalid package ownership metadata.' }
            if (![OrePackageJob]::WaitForQuiescence($previous.job,5000)) { throw 'Previous package workers are still stopping.' }
        }
        $jobName = 'Global\ORE-package-'+[guid]::NewGuid().ToString()
        [OrePackageJob]::Attach($jobName)
        $temporary = Assert-OrePath $HomePath (Join-Path $cache ('package-owner-'+[guid]::NewGuid().ToString()+'.tmp'))
        $record = @{version=1;job=$jobName} | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($temporary,$record,(New-Object Text.UTF8Encoding $false))
        if ([IO.File]::Exists($ownerPath)) { [IO.File]::Replace($temporary,$ownerPath,$null) }
        else { [IO.File]::Move($temporary,$ownerPath) }
        $temporary = $null
        return $lease
    } catch {
        $lease.Dispose()
        if ($temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        throw
    }
}
function Test-OrePackageLeaseHome([string]$HomePath) {
    $leasedHome = $env:ORE_PACKAGE_LEASE_HOME
    return $leasedHome -and [IO.Path]::IsPathRooted($leasedHome) -and [IO.Path]::GetFullPath($leasedHome).Equals([IO.Path]::GetFullPath($HomePath),[StringComparison]::OrdinalIgnoreCase)
}
function Get-OreWindowsBootTime {
    # A reboot proves that a legacy lock's owner and every worker have stopped.
    # Elapsed age or an absent/reused PID cannot establish that invariant.
    return (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime()
}
function Assert-OreLegacyQuiescent([string]$HomePath) {
    $locks = @()
    foreach ($name in @('update.lock','build.lock','database-location.lock')) {
        $path = Assert-OrePath $HomePath (Join-Path $HomePath ('cache/'+$name))
        if ([IO.File]::Exists($path)) { throw 'Legacy lock must be a directory.' }
        if ([IO.Directory]::Exists($path)) { $locks += $path }
    }
    if (!$locks.Count) { return }
    $script:OreFailure = 'legacyRestart'
    $bootTime = Get-OreWindowsBootTime
    # Validate every lock before changing any of them. Retire only the exact
    # shapes written by the old controllers, never arbitrary directory content.
    foreach ($path in $locks) {
        if ([IO.Directory]::GetLastWriteTimeUtc($path) -ge $bootTime) { throw 'Legacy ownership cannot be disproved within the current Windows session.' }
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($path)) {
            Assert-OrePath $HomePath $entry | Out-Null
            if ([IO.Path]::GetFileName($path) -cne 'update.lock' -or [IO.Path]::GetFileName($entry) -cne 'owner' -or ![IO.File]::Exists($entry)) { throw 'Unrecognized legacy lock contents were preserved.' }
            $owner = [IO.File]::ReadAllText($entry)
            if ($owner -cnotmatch '^[1-9][0-9]*\r?\n[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\r?\n$') { throw 'Unrecognized legacy ownership record was preserved.' }
        }
    }
    foreach ($path in $locks) {
        $owner = Join-Path $path 'owner'
        if ([IO.File]::Exists($owner)) { [IO.File]::Delete($owner) }
        # Non-recursive deletion refuses any content added after validation.
        [IO.Directory]::Delete($path)
    }
}
