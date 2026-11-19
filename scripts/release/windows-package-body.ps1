# The installed helper owns the lease, workers, recurring updates and startup.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$script:OreLanguage = if ($Language -eq 'ru') { 'ru' } else { 'en' }
$script:OreReport = $null
$script:OreEnvLine = 1
$lockStream = $null
$script:OreMaintenance = $null
$script:OreMaintenanceStarted = $false
$readyReceipt = $null
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
    $startup = [Diagnostics.Stopwatch]::StartNew()
    $selection = Get-OreSelection $Installation
    $tools = $PSScriptRoot
    $script:OreFailure = 'startupFailed'
    $updates = $env:ORE_SKIP_UPDATE -ne '1' -and ![IO.File]::Exists((Join-Path $Installation 'updates-paused'))
    if (!$selection) {
        if (!$updates) { throw 'First package activation requires updates to be enabled.' }
        $selection = Install-OreInitialSelection $Installation $LauncherVersion
        if (!$selection) { Wait-OreFailure 1; exit 1 }
        $tools = Join-Path $selection.Application 'scripts/release'
        $script:OreFailure = 'startupFailed'
    }
    $prepared = Join-Path $Installation 'cache/prepared-update'
    $activation = if ($updates) { Use-OrePreparedUpdate $selection $prepared $LauncherVersion }
    if ($activation) {
        $selection = $activation.Selection
        $tools = $activation.Tools
    } else { Test-OreInstalled $selection $tools }
    if (!$updates) { Show-OreMessage 'updatesPaused' }
    $checkForUpdate = $updates -and ![IO.Directory]::Exists($prepared) -and ![IO.File]::Exists($prepared)
    $readyReceipt = Join-Path $Installation ('cache/ready-'+[guid]::NewGuid()+'.tmp')
    $env:ORE_LAUNCH_READY_RECEIPT = $readyReceipt
    $whileRunning = {
        if (!$script:OreMaintenanceStarted -and [IO.File]::Exists($readyReceipt)) {
            $script:OreMaintenanceStarted = $true
            try { $script:OreMaintenance = Start-OrePackageMaintenance $Installation $selection $LauncherVersion $checkForUpdate }
            catch {
                Write-OreDiagnostic ($_.Exception.ToString())
                if ($checkForUpdate) { Show-OreMessage 'backgroundUpdateFailed' }
            }
        }
    }
    # Saved-data startup retains its own compatibility/recovery boundary.
    $env:ORE_LAUNCH_REPORT = $script:OreReport
    $env:ORE_LAUNCH_LANGUAGE = $script:OreLanguage
    Write-OreDiagnostic ('Installed startup preflight: '+$startup.ElapsedMilliseconds+' ms.')
    Write-OreDiagnostic ('Starting selected '+$selection.Id+'; automatic fallback ends here.')
    $result = Invoke-OreProcess $selection.Node @((Join-Path $tools 'portable-launch.mjs'),$Installation,$selection.Application) $script:OreReport -Console -WhileRunning $whileRunning
} catch {
    if (Test-OreCancellation) {
        $script:OreFailure = 'cancelled'
        $result = 130
    }
    Show-OrePackageFailure $_
} finally {
    try {
        Stop-OrePackageMaintenance $script:OreMaintenance
        if ($readyReceipt) { [IO.File]::Delete($readyReceipt) }
    } catch { if ($script:OreReport) { Write-OreDiagnostic ($_.Exception.ToString()) } }
    finally { if ($lockStream) { $lockStream.Dispose() } }
}
Wait-OreFailure $result
exit $result
