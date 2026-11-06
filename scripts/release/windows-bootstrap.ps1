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
try {
    if (!$InstallOnly) { Show-OreMessage 'heading' }
    Assert-OreWindows
    $script:OreFailure = 'folderCollision'
    $Installation = Assert-OreStandaloneHome $Installation
    if ([IO.Directory]::Exists($Installation)) { Set-OrePrivate $Installation }
    $script:OreFailure = 'helperUnavailable'
    $helper = Get-OrePackageHelper $Installation
    if (!$InstallOnly) {
        if (!$helper -or (!(Test-OreBoundedComparison $helper) -and (Get-OreSelection $Installation))) {
            # Contain the activation worker if the bootstrap is terminated.
            $script:OreFailure = 'setupFailed'
            Initialize-OreJob
            $worker = '$s=[IO.File]::ReadAllText($env:ORE_BOOTSTRAP_FILE,[Text.Encoding]::UTF8);$m=''# ORE_POWER''+''SHELL_PAYLOAD'';$i=$s.LastIndexOf($m); & ([scriptblock]::Create($s.Substring($i+$m.Length))) -InstallOnly'
            & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy RemoteSigned -Command $worker
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            $script:OreFailure = 'helperUnavailable'
            $helper = Get-OrePackageHelper $Installation
            if (!$helper) { throw 'No compatible helper after verified activation.' }
        }
        & $helper -Installed -Installation $Installation -Invoking $Invoking -Language $script:OreLanguage
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
    if ($helper -and (!$selection -or (Test-OreBoundedComparison $helper))) { exit 0 }
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
        if ($helper) { exit 0 } # Let the installed helper handle paused startup.
        throw 'First package activation requires updates to be enabled.'
    }
    if ($helper) {
        $script:OreFailure = 'startupFailed'
        Test-OreInstalled $selection ([IO.Path]::GetDirectoryName($helper))
        $previous = Read-OreJson (Assert-OrePath $Installation (Join-Path $selection.Application 'build-info.json'))
    }
    $stage = New-OrePackageStage
    $script:OreFailure = 'downloadFailed'
    Show-OreMessage 'checkingUpdates'
    try {
        $release = Get-OreRelease $stage
        Write-OreDiagnostic ('Resolved package release '+$release.Commit)
        if (!$helper -or $previous.commit -cne $release.Commit) {
            if ($previous) { Assert-OreForwardRelease $previous.commit $release.Commit $stage }
            Install-OreRelease $release $stage $Installation
        }
    } catch {
        if (!$helper -or (Test-OreCancellation) -or $script:OreFailure -eq 'logFailed') { throw }
        Write-OreDiagnostic ($_.Exception.ToString())
        $committed = Get-OreSelection $Installation
        if (!$committed -or $committed.Id -cne $selection.Id -or $committed.Runtime -cne $selection.Runtime) { throw 'Activation changed selection before reporting failure; startup stopped.' }
        # The installed controller still owns normal update/fallback and startup.
    }
    $result = 0
} catch {
    if (Test-OreCancellation) { $script:OreFailure = 'cancelled' }
    Show-OrePackageFailure $_
} finally {
    if (Test-OreCancellation) { $result = 130 }
    try { Remove-OrePackageStage $stage } catch { $result = 74 }
    if ($lockStream) { $lockStream.Dispose() }
}
Wait-OreFailure $result
exit $result
