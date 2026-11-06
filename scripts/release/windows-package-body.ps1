# The installed helper owns the lease, workers, recurring updates and startup.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$script:OreLanguage = if ($Language -eq 'ru') { 'ru' } else { 'en' }
$script:OreReport = $null
$script:OreEnvLine = 1
$stage = $null
$lockStream = $null
$result = 1
try {
    Assert-OreWindows
    $script:OreFailure = 'folderCollision'
    if (!$Installed -or ![IO.Directory]::Exists($Installation) -or ![IO.Path]::IsPathRooted($Invoking)) { throw 'Invalid installed helper invocation.' }
    $Installation = Initialize-OreStandaloneHome $Installation
    Open-OrePackageReport
    $script:OreFailure = 'installationLocked'
    $lockStream = Acquire-OrePackageLease $Installation
    Initialize-OreCancellation
    $script:OreFailure = 'legacyRestart'
    Assert-OreLegacyQuiescent $Installation
    Initialize-OrePackageEnvironment
    $stage = New-OrePackageStage
    $selection = Get-OreSelection $Installation
    $tools = $PSScriptRoot
    $script:OreFailure = 'startupFailed'
    if ($selection) { Test-OreInstalled $selection $tools }
    if ($env:ORE_SKIP_UPDATE -eq '1' -or [IO.File]::Exists((Join-Path $Installation 'updates-paused'))) {
        if (!$selection) { throw 'Skip-update requires a verified installation.' }
        Show-OreMessage 'updatesPaused'
    } else {
        $fallback = 'checkFallback'
        try {
            $script:OreFailure = 'downloadFailed'
            Show-OreMessage 'checkingUpdates'
            $release = Get-OreRelease $stage
            Write-OreDiagnostic ('Resolved package release '+$release.Commit)
            $same = $false
            if ($selection) {
                $info = Read-OreJson (Join-Path $selection.Application 'build-info.json')
                $same = $info.commit -ceq $release.Commit
                if (!$same) { Assert-OreForwardRelease $info.commit $release.Commit $stage }
            }
            if ($same) { Show-OreMessage 'upToDate' } else {
                $fallback = 'updateFallback'
                Install-OreRelease $release $stage $Installation
                $selection = Get-OreSelection $Installation
                $tools = Join-Path $selection.Application 'scripts/release'
            }
        } catch {
            if (Test-OreCancellation) { $script:OreFailure = 'cancelled' }
            Write-OreDiagnostic ($_.Exception.ToString())
            if (!$selection -or $script:OreFailure -in @('installationLocked','cancelled','logFailed')) { throw }
            $committed = Get-OreSelection $Installation
            if (!$committed -or $committed.Id -cne $selection.Id -or $committed.Runtime -cne $selection.Runtime) { throw 'Activation changed selection before reporting failure; startup stopped.' }
            Test-OreInstalled $selection $tools
            Show-OreMessage $fallback
        }
    }
    # Saved-data startup retains its own compatibility/recovery boundary.
    $script:OreFailure = 'startupFailed'
    $selection = Get-OreSelection $Installation
    Test-OreInstalled $selection $tools
    $env:ORE_LAUNCH_REPORT = $script:OreReport
    $env:ORE_LAUNCH_LANGUAGE = $script:OreLanguage
    Write-OreDiagnostic ('Starting selected '+$selection.Id+'; automatic fallback ends here.')
    $result = Invoke-OreProcess $selection.Node @((Join-Path $tools 'portable-launch.mjs'),$Installation,$selection.Application) $script:OreReport -Console
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
