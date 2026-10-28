param([ValidateSet('Release','Development','Snapshot')][string]$Mode, [string]$Commit, [string]$Destination, [string]$Snapshot)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$buildStatus = 1
$stage = $null; $lock = $null
try {
    . (Join-Path $PSScriptRoot 'scripts/release/windows-common.ps1')
    . (Join-Path $PSScriptRoot 'scripts/release/windows-snapshot.ps1')
    . (Join-Path $PSScriptRoot 'scripts/release/windows-standalone-common.ps1')
    if (!$Mode -or !$Destination) { throw 'Choose Release with exact Commit, Development, or Snapshot with downloaded archive/provenance, and a separate Destination.' }
    if (![Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This builder targets Windows x64 only. Use 64-bit Windows PowerShell.' }
    $source = $PSScriptRoot
    if ($Mode -eq 'Development') { $Commit = (Invoke-Native git @('-C',$source,'rev-parse','HEAD')).Trim() }
    if ($Mode -eq 'Release') {
        if ($Commit -cnotmatch '^[0-9a-f]{40}$') { throw 'Release requires the exact full checked-out commit.' }
        if (Invoke-Native git @('-C',$source,'status','--porcelain','--untracked-files=all')) { throw 'Release source must be clean, including untracked files.' }
        if ($Commit -cne (Invoke-Native git @('-C',$source,'rev-parse','HEAD')).Trim()) { throw 'Release requires the exact full checked-out commit.' }
        Invoke-Native git @('-C',$source,'merge-base','--is-ancestor',$Commit,'main')
    }
    if ($Mode -eq 'Snapshot') {
        if ($Commit -cnotmatch '^[0-9a-f]{40}$' -or $env:ORE_SNAPSHOT_SOURCE -cne ('https://github.com/olegpro171/Roleplay-Engine/archive/'+$Commit+'.zip') -or $env:ORE_SNAPSHOT_SHA256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Snapshot requires exact downloaded-main provenance and digest.' }
        if (!$Snapshot -or (Get-OreHash $Snapshot) -cne $env:ORE_SNAPSHOT_SHA256) { throw 'Snapshot bytes changed after download.' }
    }
    if ([IO.Path]::GetFullPath($Destination) -eq $source) { throw 'Use a separate installation directory.' }
    Assert-OrePath $Destination $Destination | Out-Null
    foreach ($name in @('cache','runtime','app','logs','languages','data','recovery','current','previous','working','recovery/current')) { Assert-OrePath $Destination (Join-Path $Destination $name) | Out-Null }
    $installation = if ($Mode -eq 'Snapshot') { Initialize-OreStandaloneHome $Destination } else { Initialize-OreHome $Destination }
    Initialize-OreJob
    Initialize-OreCancellation
    $lockPath = Join-Path $installation 'cache/build.lock'
    New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null
    $lock = $lockPath
    $stage = Join-Path $installation ('cache/build-'+[guid]::NewGuid())
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $runtime = Get-OreRuntime $installation $source $stage
    $node = $runtime.Node; $npm = $runtime.Npm
    $snapshotSource = $env:ORE_SNAPSHOT_SOURCE; $snapshotDigest = $env:ORE_SNAPSHOT_SHA256
    $eventFile = $env:ORE_WINDOWS_BUILD_EVENTS
    Clear-OreInjection
    [Environment]::SetEnvironmentVariable('ORE_WINDOWS_BUILD_EVENTS',$null,'Process')
    $env:PATH = $runtime.Directory+';'+$env:SystemRoot+'\System32'
    $env:TEMP = $stage; $env:TMP = $stage
    $env:npm_config_cache = Join-Path $installation 'cache/npm'
    $env:npm_config_userconfig = Join-Path $stage 'npmrc'
    $env:npm_config_globalconfig = Join-Path $stage 'global-npmrc'
    Write-Utf8 $env:npm_config_userconfig ''
    Write-Utf8 $env:npm_config_globalconfig ''
    $env:npm_config_update_notifier = 'false'
    $env:npm_config_audit = 'false'
    $env:npm_config_fund = 'false'
    $env:npm_config_ignore_scripts = 'true'
    $env:SHARP_IGNORE_GLOBAL_LIBVIPS = '1'
    $work = Join-Path $stage 'source'
    $inputs = $OreSourceInputs
    if ($Mode -eq 'Snapshot') {
        Expand-OreZip $Snapshot ('Roleplay-Engine-'+$Commit) $work -Source
    } elseif ($Mode -eq 'Release') {
        $export = Join-Path $stage 'source.zip'
        Invoke-Native git (@('-C',$source,'archive','--format=zip',('--output='+$export),$Commit,'--')+$inputs)
        [IO.Directory]::CreateDirectory($work) | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($export,$work)
    } else {
        [IO.Directory]::CreateDirectory($work) | Out-Null
        foreach ($inputPath in $inputs) {
            $target = Join-Path $work $inputPath
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            Assert-OrePath $source (Join-Path $source $inputPath) | Out-Null
            if ([IO.Directory]::Exists((Join-Path $source $inputPath))) { Assert-OreTree (Join-Path $source $inputPath) }
            Copy-Item -LiteralPath (Join-Path $source $inputPath) -Destination $target -Recurse
        }
    }
    # Native stderr is diagnostic data, not PowerShell ErrorRecord success.
    # Each tool runs under this controller's job, with both streams in its log.
    $toolLog = Join-Path $installation ('logs/build-'+[guid]::NewGuid()+'.txt')
    Write-Utf8 $toolLog ''
    function Build-Tool([string[]]$ArgumentList) {
        $status = Invoke-OreProcess $node $ArgumentList $toolLog
        if ($status -ne 0) {
            [Console]::Error.Write([IO.File]::ReadAllText($toolLog))
            throw ('Native command failed ('+$status+').')
        }
    }
    Push-Location -LiteralPath $work
    $oldDirectory = [Environment]::CurrentDirectory
    [Environment]::CurrentDirectory = $work
    try {
        Write-Host '[Build] Installing locked build dependencies...'
        Build-Tool @($npm,'ci','--include=dev','--include=optional','--ignore-scripts')
        Build-Tool @('scripts/release/native-smoke.mjs')
        Build-Tool @('scripts/release/build-windows.mjs')
        $notices = Join-Path $stage 'notices'
        Build-Tool @('scripts/release/stage.mjs','notices',$work,$notices)
        Build-Tool @($npm,'ci','--omit=dev','--include=optional','--ignore-scripts','--prefer-offline')
        $stageMode = if ($Mode -eq 'Release') { '--release' } elseif ($Mode -eq 'Snapshot') { '--snapshot' } else { '--development' }
        $env:ORE_SNAPSHOT_SOURCE = $snapshotSource; $env:ORE_SNAPSHOT_SHA256 = $snapshotDigest
        if ($eventFile) { Assert-OrePath $installation $eventFile | Out-Null; $env:ORE_WINDOWS_BUILD_EVENTS = $eventFile }
        Build-Tool @('scripts/release/stage.mjs','install',$work,$installation,$stageMode,$Commit,$runtime.Id,$runtime.Checksum,$notices)
        [Console]::Write([IO.File]::ReadAllText($toolLog))
    } finally { [Environment]::CurrentDirectory = $oldDirectory; Pop-Location }
    $buildStatus = 0
} catch { [Console]::Error.WriteLine('ORE build: '+$_.Exception.ToString()) }
finally {
    if ($stage) {
        try {
            Assert-OrePath (Join-Path $installation 'cache') $stage | Out-Null
            Assert-OreTree $stage
            for ($attempt = 0; $attempt -lt 3; $attempt++) {
                try { Remove-Item -LiteralPath $stage -Recurse -Force; break }
                catch { if ($attempt -eq 2) { throw }; Start-Sleep -Milliseconds 200 }
            }
        } catch { [Console]::Error.WriteLine('Temporary cleanup: '+$_.Exception.Message) }
    }
    if ($lock) { try { [IO.Directory]::Delete($lock) } catch { [Console]::Error.WriteLine('Build lock cleanup: '+$_.Exception.Message); if ($buildStatus -eq 0) { $buildStatus = 75 } } }
}
exit $buildStatus
