param([ValidateSet('Release','Development')][string]$Mode, [string]$Commit, [string]$Destination, [ValidateSet('main','staging')][string]$ReleaseBranch = 'main', [switch]$ReuseDevelopmentDependencies)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$buildStatus = 1
$stage = $null
$work = $null
$buildLease = $null
$packageLease = $null
$toolLog = $null
$buildClock = [Diagnostics.Stopwatch]::StartNew()
function Write-BuildTiming([string]$Phase, [long]$Started) {
    $elapsed = $buildClock.ElapsedMilliseconds - $Started
    if ($toolLog) { [IO.File]::AppendAllText($toolLog,('[Timing] '+$Phase+': '+$elapsed+" ms`n"),(New-Object Text.UTF8Encoding $false)) }
}
try {
    . (Join-Path $PSScriptRoot 'windows-common.ps1')
    . (Join-Path $PSScriptRoot 'windows-snapshot.ps1')
    . (Join-Path $PSScriptRoot 'windows-standalone-common.ps1')
    . (Join-Path $PSScriptRoot 'windows-source-tools.ps1')
    . (Join-Path $PSScriptRoot 'windows-package-lock.ps1')
    if (!$Mode -or !$Destination) { throw 'Choose Release with exact Commit, or Development, and a separate Destination.' }
    if ($ReuseDevelopmentDependencies -and $Mode -ne 'Development') { throw 'Dependency reuse is only supported for local Development builds.' }
    if (![Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This builder targets Windows x64 only. Use 64-bit Windows PowerShell.' }
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    # Capture Git before PATH is restricted to the private runtime.
    $git = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    if ($Mode -eq 'Development') { $Commit = (Invoke-Native $git @('-C',$source,'rev-parse','HEAD')).Trim() }
    if ($Mode -eq 'Release') {
        if ($Commit -cnotmatch '^[0-9a-f]{40}$') { throw 'Release requires the exact full checked-out commit.' }
        if (Invoke-Native $git @('-C',$source,'status','--porcelain','--untracked-files=all')) { throw 'Release source must be clean, including untracked files.' }
        if ($Commit -cne (Invoke-Native $git @('-C',$source,'rev-parse','HEAD')).Trim()) { throw 'Release requires the exact full checked-out commit.' }
        # Staging builds retain the real triggering SHA; only main promotion publishes them.
        $releaseReference = if ($ReleaseBranch -eq 'staging') { 'refs/remotes/origin/staging' } else { 'main' }
        Invoke-Native $git @('-C',$source,'merge-base','--is-ancestor',$Commit,$releaseReference)
    }
    if ([IO.Path]::GetFullPath($Destination) -eq $source) { throw 'Use a separate installation directory.' }
    Assert-OrePath $Destination $Destination | Out-Null
    foreach ($name in @('cache','runtime','app','logs','languages','data','recovery','current','previous','working','recovery/current')) { Assert-OrePath $Destination (Join-Path $Destination $name) | Out-Null }
    $installation = Initialize-OreHome $Destination
    $packageLease = Acquire-OrePackageLease $installation
    Assert-OreLegacyQuiescent $installation
    Initialize-OreCancellation
    # The exclusive handle and package job fence surviving source workers.
    $lockPath = Assert-OrePath $installation (Join-Path $installation 'cache/source-build.lease')
    $buildLease = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $stage = Join-Path $installation ('cache/build-'+[guid]::NewGuid())
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $toolLog = Join-Path $installation ('logs/build-'+[guid]::NewGuid()+'.txt')
    Write-Utf8 $toolLog ''
    Clear-OreInjection
    $phaseStarted = $buildClock.ElapsedMilliseconds
    $runtime = Get-OreRuntime $installation $source $stage
    Write-BuildTiming 'prepare-private-runtime' $phaseStarted
    $node = $runtime.Node; $npm = $runtime.Npm
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
    $inputs = @('package.json','package-lock.json','tsconfig.json','tsconfig.server.json','vite.config.ts','vitest.config.ts','playwright.config.ts','index.html','src','public','migrations','scripts/release','LICENSE','docs/RELEASES.md')
    $phaseStarted = $buildClock.ElapsedMilliseconds
    if ($Mode -eq 'Release') {
        $export = Join-Path $stage 'source.zip'
        Invoke-Native $git (@('-C',$source,'archive','--format=zip',('--output='+$export),$Commit,'--')+$inputs)
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
    Write-BuildTiming 'extract-build-inputs' $phaseStarted
    # Native stderr is diagnostic data, not PowerShell ErrorRecord success.
    # Each tool runs under this controller's job, with both streams in its log.
    function Build-Tool([string]$Phase, [string[]]$ArgumentList) {
        $started = $buildClock.ElapsedMilliseconds
        try { $status = Invoke-OreProcess $node $ArgumentList $toolLog }
        finally { Write-BuildTiming $Phase $started }
        if ($status -ne 0) {
            [Console]::Error.Write([IO.File]::ReadAllText($toolLog))
            throw ('Native command failed ('+$status+').')
        }
    }
    Push-Location -LiteralPath $work
    $oldDirectory = [Environment]::CurrentDirectory
    [Environment]::CurrentDirectory = $work
    try {
        if ($ReuseDevelopmentDependencies) {
            Write-Host '[Build] Preparing cached build dependencies...'
            Build-Tool 'prepare-development-dependencies' @('scripts/release/development-dependencies.mjs',$npm,$installation,$runtime.Id,$runtime.Checksum)
        } else {
            Write-Host '[Build] Installing locked build dependencies...'
            Build-Tool 'install-locked-dependencies' @($npm,'ci','--include=dev','--include=optional','--ignore-scripts')
        }
        Build-Tool 'verify-build-native-packages' @('scripts/release/native-smoke.mjs')
        $buildArguments = @('scripts/release/build-windows.mjs')
        if ($ReuseDevelopmentDependencies) { $buildArguments += '--local-development' }
        Build-Tool 'build-application' $buildArguments
        $notices = Join-Path $stage 'notices'
        Build-Tool 'collect-notices' @('scripts/release/stage.mjs','notices',$work,$notices)
        if (!$ReuseDevelopmentDependencies) { Build-Tool 'prepare-production-dependencies' @('scripts/release/prepare-windows-dependencies.mjs',$npm) }
        $stageMode = if ($Mode -eq 'Release') { '--release' } else { '--development' }
        $dependencyTransfer = if ($ReuseDevelopmentDependencies) { 'development-dependencies' } else { 'move-dependencies' }
        Build-Tool 'stage-and-verify-application' @('scripts/release/stage.mjs','install',$work,$installation,$stageMode,$Commit,$runtime.Id,$runtime.Checksum,$notices,$dependencyTransfer)
        [Console]::Write([IO.File]::ReadAllText($toolLog))
    } finally { [Environment]::CurrentDirectory = $oldDirectory; Pop-Location }
    $buildStatus = 0
} catch { [Console]::Error.WriteLine('ORE build: '+$_.Exception.ToString()) }
finally {
    $cleanupStarted = $buildClock.ElapsedMilliseconds
    if ($ReuseDevelopmentDependencies -and $work) {
        try {
            $modulesLink = Join-Path $work 'node_modules'
            if ([IO.Directory]::Exists($modulesLink) -and ((Get-Item -LiteralPath $modulesLink -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                [IO.Directory]::Delete($modulesLink)
            }
        } catch { [Console]::Error.WriteLine('Dependency link cleanup: '+$_.Exception.Message); if ($buildStatus -eq 0) { $buildStatus = 75 } }
    }
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
    if ($buildLease) { $buildLease.Dispose() }
    Write-BuildTiming 'cleanup-build-work' $cleanupStarted
    Write-BuildTiming 'total-build' 0
    if ($packageLease) { $packageLease.Dispose() }
}
exit $buildStatus
