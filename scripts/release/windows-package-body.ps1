# The installed helper owns the lease, workers, recurring updates and startup.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$script:OreLanguage = if ($Language -eq 'ru') { 'ru' } else { 'en' }
$script:OreReport = $null
$script:OreEnvLine = 1
$lockStream = $null
$script:OreUpdate = $null
$script:OreUpdateStarted = $false
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
        $selection = Install-OreInitialSelection $Installation
        $tools = Join-Path $selection.Application 'scripts/release'
        $script:OreFailure = 'startupFailed'
    }
    $prepared = Join-Path $Installation 'cache/prepared-update'
    $activation = if ($updates) { Use-OrePreparedUpdate $selection $prepared }
    if ($activation) {
        $selection = $activation.Selection
        $tools = $activation.Tools
    } else { Test-OreInstalled $selection $tools }
    if (!$updates) { Show-OreMessage 'updatesPaused' }
    $whileRunning = $null
    if ($updates -and ![IO.Directory]::Exists($prepared) -and ![IO.File]::Exists($prepared)) {
        $info = Read-OreJson (Join-Path $selection.Application 'build-info.json')
        $readyReceipt = Join-Path $Installation ('cache/ready-'+[guid]::NewGuid()+'.tmp')
        $env:ORE_LAUNCH_READY_RECEIPT = $readyReceipt
        $whileRunning = {
            if (!$script:OreUpdateStarted -and [IO.File]::Exists($readyReceipt)) {
                $script:OreUpdateStarted = $true
                try { $script:OreUpdate = Start-OreUpdateCheck $Installation $info.commit }
                catch {
                    Write-OreDiagnostic ($_.Exception.ToString())
                    Show-OreMessage 'backgroundUpdateFailed'
                }
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
    if (Test-OreCancellation) { $script:OreFailure = 'cancelled' }
    Show-OrePackageFailure $_
} finally {
    if (Test-OreCancellation) { $result = 130 }
    try {
        Stop-OreUpdateCheck $script:OreUpdate
        if ($readyReceipt) { [IO.File]::Delete($readyReceipt) }
    } catch { if ($script:OreReport) { Write-OreDiagnostic ($_.Exception.ToString()) } }
    finally { if ($lockStream) { $lockStream.Dispose() } }
}
Wait-OreFailure $result
exit $result
