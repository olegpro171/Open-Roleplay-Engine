# Bootstrap contract 2. The normal path runs the installed controller in this
# PowerShell process. Bootstrap updates run in a short-lived worker so its
# installation lease and named job are gone before the helper acquires them.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$script:OreLanguage = if ([Globalization.CultureInfo]::CurrentUICulture.Name -match '^ru(?:[-_][a-zA-Z0-9]{2,8})*$') { 'ru' } else { 'en' }
$script:OreReport = $null
$script:OreEnvLine = 1
$Invoking = [IO.Path]::GetFullPath((Get-Location).Path)
$Installation = Join-Path ([IO.Path]::GetDirectoryName($env:ORE_BOOTSTRAP_FILE)) 'ORE-internal'
$stage = $null
$lockStream = $null
$result = 1
$interactive = ![Console]::IsInputRedirected -and ![Console]::IsOutputRedirected
$script:OreTerminal = New-OreTerminal -InteractiveMenu:($interactive -and !$StartOnly -and !$InstallOnly)
try {
    if (!$InstallOnly -and !$StartOnly -and !$ManageOnly) { Show-OreGreeting $LauncherVersion }
    Assert-OreWindows
    $script:OreFailure = 'folderCollision'
    $Installation = Assert-OreStandaloneHome $Installation
    if ([IO.Directory]::Exists($Installation)) { Set-OrePrivate $Installation }
    if ($ManageOnly) {
        $Installation = Initialize-OreStandaloneHome $Installation
        $lockStream = Acquire-OrePackageLease $Installation
        Initialize-OreCancellation
        Open-OrePackageReport -Quiet
        Assert-OreLegacyQuiescent $Installation
        Initialize-OrePackageEnvironment
        Show-OreVersionManager
        Clear-OreTerminalPanel
        exit 0
    }
    if (!$InstallOnly -and !$StartOnly -and $interactive) {
        # A worker must exit (and release its named job) before another session
        # or recovery operation can take the installation lease.
        Initialize-OreJob
        $worker = '$s=[IO.File]::ReadAllText($env:ORE_BOOTSTRAP_FILE,[Text.Encoding]::UTF8);$m=''# ORE_POWER''+''SHELL_PAYLOAD'';$i=$s.LastIndexOf($m); & ([scriptblock]::Create($s.Substring($i+$m.Length)))'
        $env:ORE_NO_PAUSE = '1'
        $notice = ''
        $focus = 0
        while ($true) {
            $choice = Read-OreChoice 'menuHome' (Get-OreVersionSummary) @(
                (New-OreChoice (Get-OreMessage 'menuStart') 'start')
                (New-OreChoice (Get-OreMessage 'menuManage') 'manage')
            ) $notice $focus
            if ($choice.Action -eq 'back') { exit 0 }
            if ($choice.Action -eq 'manage') {
                & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy RemoteSigned -Command ($worker+' -ManageOnly; exit $LASTEXITCODE')
                $notice = ''
                $focus = 0
            } else {
                & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy RemoteSigned -Command ($worker+' -StartOnly; exit $LASTEXITCODE')
                if ($LASTEXITCODE -in @(0,130)) { exit $LASTEXITCODE }
                $notice = Get-OreMessage 'menuRecoveryHint'
                $focus = 1
            }
        }
    }
    $script:OreFailure = 'helperUnavailable'
    $helper = Get-OrePackageHelper $Installation
    if (!$InstallOnly) {
        $versioned = $helper -and (Test-OreVersionedHelper $helper)
        if (!$versioned) {
            # Contain the activation worker if the bootstrap is terminated.
            $script:OreFailure = 'setupFailed'
            Initialize-OreJob
            $worker = '$s=[IO.File]::ReadAllText($env:ORE_BOOTSTRAP_FILE,[Text.Encoding]::UTF8);$m=''# ORE_POWER''+''SHELL_PAYLOAD'';$i=$s.LastIndexOf($m); & ([scriptblock]::Create($s.Substring($i+$m.Length))) -InstallOnly'
            & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy RemoteSigned -Command $worker
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            $script:OreFailure = 'helperUnavailable'
            $helper = Get-OrePackageHelper $Installation
            if (!$helper) { throw 'No compatible helper after verified activation.' }
            $versioned = Test-OreVersionedHelper $helper
        }
        if ($versioned) {
            & $helper -Installed -Installation $Installation -Invoking $Invoking -Language $script:OreLanguage -LauncherVersion $LauncherVersion
        } else {
            # The bootstrap owns updates until a version-aware helper is installed.
            $env:ORE_SKIP_UPDATE = '1'
            & $helper -Installed -Installation $Installation -Invoking $Invoking -Language $script:OreLanguage
        }
        exit $LASTEXITCODE
    }

    $script:OreFailure = 'folderCollision'
    $Installation = Initialize-OreStandaloneHome $Installation
    Initialize-OreCancellation
    Open-OrePackageReport
    $lockStream = Acquire-OrePackageLease $Installation
    $script:OreFailure = 'legacyRestart'
    Assert-OreLegacyQuiescent $Installation
    $script:OreFailure = 'helperUnavailable'
    $helper = Get-OrePackageHelper $Installation
    $selection = Get-OreSelection $Installation
    if ($helper -and $selection -and (Test-OreVersionedHelper $helper)) { exit 0 }
    $previous = $null
    if (!$helper -and $selection) {
        # Only the former Windows source-built standalone may cross into
        # package delivery here. A damaged package home uses explicit recovery.
        $tools = Join-Path $selection.Application 'scripts/release'
        $protocol = Assert-OrePath $Installation (Join-Path $tools 'windows-launcher-protocol')
        $packageProtocol = Assert-OrePath $Installation (Join-Path $tools 'windows-package-protocol')
        if ([IO.File]::Exists($packageProtocol) -or ![IO.File]::Exists($protocol) -or (New-Object IO.FileInfo $protocol).Length -gt 16 -or [IO.File]::ReadAllText($protocol).Trim() -cne '1') { throw 'No compatible helper for the selected installation.' }
        $previous = Read-OreJson (Assert-OrePath $Installation (Join-Path $selection.Application 'build-info.json'))
        if ($previous.kind -cne 'release' -or $previous.platform -cne 'win32' -or $previous.arch -cne 'x64') { throw 'Invalid legacy standalone release.' }
    }
    Initialize-OrePackageEnvironment
    $script:OreFailure = 'helperUnavailable'
    if ($env:ORE_SKIP_UPDATE -eq '1' -or [IO.File]::Exists((Join-Path $Installation 'updates-paused'))) {
        if ($helper -and $selection) { exit 0 } # Let the installed helper handle paused startup.
        throw 'First package activation requires updates to be enabled.'
    }
    if ($helper -and $selection) {
        $script:OreFailure = 'startupFailed'
        Test-OreInstalled $selection ([IO.Path]::GetDirectoryName($helper))
        $previous = Read-OreJson (Assert-OrePath $Installation (Join-Path $selection.Application 'build-info.json'))
    }
    $stage = New-OrePackageStage
    $script:OreFailure = 'downloadFailed'
    if (!$selection) { Show-OreMessage 'firstInstall' }
    Show-OreMessage 'checkingUpdates'
    try {
        $installedCommit = if ($helper -and $selection) { $previous.commit }
        $release = Get-OreRelease $stage $LauncherVersion $installedCommit
        if ($release -and !$release.Blocked) {
            Write-OreDiagnostic ('Resolved package release '+$release.Commit)
            if ($previous) { Assert-OreForwardRelease $previous.commit $release.Commit $stage }
            Install-OreRelease $release $stage $Installation
        }
        if (!$release.Blocked -or $selection) { $result = 0 }
    } catch {
        if (!$helper -or !$selection -or (Test-OreCancellation) -or $script:OreFailure -eq 'logFailed') { throw }
        Write-OreDiagnostic ($_.Exception.ToString())
        $committed = Get-OreSelection $Installation
        if (!$committed -or $committed.Id -cne $selection.Id -or $committed.Runtime -cne $selection.Runtime) { throw 'Activation changed selection before reporting failure; startup stopped.' }
        $result = 0 # Start the verified selection through the retained helper.
    }
} catch {
    if (Test-OreCancellation) { $script:OreFailure = 'cancelled' }
    Show-OrePackageFailure $_
} finally {
    if (Test-OreCancellation) { $result = 130 }
    try { Remove-OrePackageStage $stage } catch { $result = 74 }
    if ($lockStream) { $lockStream.Dispose() }
}
if ($result -eq 0) { Clear-OreTerminalPanel }
Wait-OreFailure $result
exit $result
