function Test-OreSameSelection($Left, $Right) {
    return $Left -and $Right -and $Left.Id -ceq $Right.Id -and $Left.Runtime -ceq $Right.Runtime
}

function Install-OreInitialSelection([string]$Installation, [int]$LauncherVersion) {
    # An interrupted first install can leave a recovery toolkit before the
    # current pointer is committed. That toolkit can finish initial setup.
    $stage = New-OrePackageStage
    try {
        $script:OreFailure = 'downloadFailed'
        Show-OreMessage 'checkingUpdates'
        $release = Get-OreRelease $stage $LauncherVersion
        if ($release.Blocked) { return }
        Install-OreRelease $release $stage $Installation
        $selection = Get-OreSelection $Installation
        if (!$selection) { throw 'Initial package activation did not publish a selection.' }
        return $selection
    } finally { Remove-OrePackageStage $stage }
}

function Read-OrePreparedMinimumLauncherVersion([string]$Prepared) {
    $filename = 'minimum-launcher-version'
    $path = Join-Path $Prepared $filename
    if ((New-Object IO.FileInfo $path).Length -gt 10) { throw 'Invalid prepared launcher requirement.' }
    $value = [IO.File]::ReadAllText($path)
    [int]$minimum = 0
    if ($value -cnotmatch '^(0|[1-9][0-9]*)\z' -or ![int]::TryParse($value,[ref]$minimum)) { throw 'Invalid prepared launcher requirement.' }
    $records = Read-OreJson (Join-Path $Prepared 'checksums.json') 16KB
    $match = @($records | Where-Object { $_.path -ceq $filename })
    if ($match.Count -ne 1 -or $match[0].sha256 -cne (Get-OreHash $path)) { throw 'Prepared launcher requirement differs from its inventory.' }
    return $minimum
}

function Use-OrePreparedUpdate([hashtable]$Current, [string]$Prepared, [int]$LauncherVersion) {
    if (![IO.Directory]::Exists($Prepared) -and ![IO.File]::Exists($Prepared)) { return }
    $retain = $false
    try {
        Assert-OreLongTree $Prepared
        $base = Get-OreSelection $Installation 'cache/prepared-update/base'
        $candidate = Get-OreSelection $Installation 'cache/prepared-update/current'
        if (!(Test-OreSameSelection $Current $base) -or !$candidate -or $candidate.Id -ceq $Current.Id) {
            throw 'Prepared update no longer applies to this selection.'
        }
        $minimum = Read-OrePreparedMinimumLauncherVersion $Prepared
        if (!(Test-OreLauncherAllowsUpdate $LauncherVersion $minimum)) { $retain = $true; return }
        $helper = Get-OrePackageHelper $Installation @('cache/prepared-update/current')
        if (!$helper) { throw 'Prepared update is missing its startup helper.' }
        $tools = [IO.Path]::GetDirectoryName($helper)
        Assert-OreLongTree (Join-Path $Installation ('recovery/'+$candidate.Id))
        Test-OreInstalled $candidate $tools
        $installer = Assert-OrePath $Installation (Join-Path $tools 'windows-package-install.mjs')
        Show-OreMessage 'activatingVersion'
        if ((Invoke-OreProcess $candidate.Node @($installer,'--activate-prepared',$Installation,$candidate.Id,$candidate.Runtime,[string]$LauncherVersion) $script:OreReport) -ne 0) {
            throw 'Prepared update activation failed.'
        }
        return @{Selection=$candidate; Tools=$tools}
    } catch {
        # Selection is the last activation write. Never fall back after an
        # unexpected commit or a user cancellation.
        if ((Test-OreCancellation) -or !(Test-OreSameSelection $Current (Get-OreSelection $Installation))) { throw }
        Write-OreDiagnostic ($_.Exception.ToString())
        Show-OreMessage 'preparedUpdateFailed'
    } finally { if (!$retain) { Remove-OrePackageStage $Prepared } }
}

function Invoke-OreUpdateCheck([string]$Installation, [string]$Commit, [int]$LauncherVersion) {
    $stage = $null
    try {
        Open-OrePackageReport -Quiet -Prefix 'update'
        Assert-OrePath $Installation (Join-Path $Installation 'cache/prepared-update') | Out-Null
        if (Test-OreCancellation) { return }
        $stage = New-OrePackageStage
        Show-OreMessage 'checkingUpdates'
        $release = Get-OreRelease $stage $LauncherVersion $Commit
        if (!$release) { Show-OreMessage 'upToDate'; return }
        if ($release.Blocked) { return }
        Write-OreDiagnostic ('Resolved package release '+$release.Commit)
        Assert-OreForwardRelease $Commit $release.Commit $stage
        Install-OreRelease $release $stage $Installation -Prepare
        Show-OreMessage 'updateReadyOnRestart'
    } catch {
        if (!(Test-OreCancellation)) {
            if ($script:OreReport) {
                try { Write-OreDiagnostic ($_.Exception.ToString()) } catch { $script:OreReport = $null }
            }
            Show-OreMessage 'backgroundUpdateFailed'
            if ($script:OreReport) { Show-OreMessage 'logFile' @{absolutePath=$script:OreReport} }
        }
    } finally { Remove-OrePackageStage $stage }
}

function Start-OreUpdateCheck([string]$Installation, [string]$Commit, [int]$LauncherVersion) {
    # A separate runspace keeps the console controller responsive. It shares
    # the controller's OS lease, job and cancellation token, and cannot commit
    # an active selection. All spawned workers stay in the same Windows job.
    $state = [Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    foreach ($function in @(Get-Command -Name '*-Ore*' -CommandType Function)) {
        $state.Commands.Add((New-Object Management.Automation.Runspaces.SessionStateFunctionEntry($function.Name,$function.Definition)))
    }
    $state.Variables.Add((New-Object Management.Automation.Runspaces.SessionStateVariableEntry('OreMessages',$OreMessages,'')))
    $state.Variables.Add((New-Object Management.Automation.Runspaces.SessionStateVariableEntry('OreLanguage',$script:OreLanguage,'')))
    $worker = [PowerShell]::Create($state)
    try {
        $null = $worker.AddScript(@'
param($installation, $commit, $launcherVersion)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:OreReport = $null
Invoke-OreUpdateCheck $installation $commit $launcherVersion
'@).AddArgument($Installation).AddArgument($Commit).AddArgument($LauncherVersion)
        return @{Worker=$worker; Async=$worker.BeginInvoke()}
    } catch { $worker.Dispose(); throw }
}

function Stop-OreUpdateCheck([hashtable]$Update) {
    if (!$Update) { return }
    try {
        if (!$Update.Async.IsCompleted) {
            [OreCancellation]::Cancel()
            $Update.Worker.Stop()
        }
        try { $null = $Update.Worker.EndInvoke($Update.Async) }
        catch [Management.Automation.PipelineStoppedException] { }
    } finally { $Update.Worker.Dispose() }
}
