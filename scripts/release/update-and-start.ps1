param([Parameter(Mandatory=$true)][string]$Installation, [string]$SourceHint = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-common.ps1')
. (Join-Path $PSScriptRoot 'windows-snapshot.ps1')
. (Join-Path $PSScriptRoot 'windows-package-lock.ps1')
$packageLease = $null
function Read-Installed {
    $pointer = Join-Path $installation 'current'
    if (!(Test-Path -LiteralPath $pointer)) { return $null }
    $selected = [IO.File]::ReadAllLines($pointer)
    if ($selected.Count -ne 2 -or $selected[0] -notmatch '^(release|dev)-[a-z0-9-]+$' -or $selected[1] -notmatch '^node-v[0-9.]+-win32-x64$') { throw 'Invalid application/runtime selection.' }
    $app = Join-Path $installation ('app/' + $selected[0])
    $node = Join-Path $installation ('runtime/' + $selected[1] + '/node.exe')
    if (!(Test-Path -LiteralPath $node) -or !(Test-Path -LiteralPath (Join-Path $app 'scripts/release/portable-launch.mjs'))) { return $null }
    return @{ App = $app; Node = $node }
}
try {
    Import-OreEnvironment (Join-Path $Installation '.env')
    $installation = Initialize-OreHome $Installation
    Initialize-OreJob
    $packageLease = Acquire-OrePackageLease $installation
    Assert-OreLegacyQuiescent $installation
    $env:ORE_PACKAGE_LEASE_HOME = $installation
    if ($env:ORE_SKIP_UPDATE -and $env:ORE_SKIP_UPDATE -notin @('0','1')) { throw 'ORE_SKIP_UPDATE must be 0 or 1.' }
    if ($env:ORE_SKIP_UPDATE -ne '1' -and !(Test-Path -LiteralPath (Join-Path $installation 'updates-paused'))) {
        $lock = Join-Path $installation 'cache/update.lock'
        try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null }
        catch { throw 'Another startup owns cache/update.lock. After an interruption verify its processes stopped before removing the stale lock.' }
        $log = Join-Path $installation ('logs/update-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID + '.log')
        $transcriptStarted = $false
        try {
            Start-Transcript -LiteralPath $log | Out-Null
            $transcriptStarted = $true
            Write-Host ('ORE update log: ' + $log)
            Write-Host ('Installation folder: ' + $installation)
            try {
                if (!(Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required for updates. Install/configure Git separately; no global tools were installed.' }
                $repository = 'https://github.com/olegpro171/Open-Roleplay-Engine.git'
                $sourceFile = Join-Path $installation 'update-source.txt'
                if (Test-Path -LiteralPath $sourceFile) { $repository = [IO.File]::ReadAllText($sourceFile).Trim() }
                if ($SourceHint) { $repository = (Invoke-Native git @('-C',$SourceHint,'remote','get-url','origin')).Trim() }
                if (!$repository -or $repository -match '[\r\n]' -or $repository -match '^https?://[^/]*@') { throw 'Invalid update source; use Git authentication without embedded credentials.' }
                $source = Join-Path $installation 'cache/update-source'
                if (!(Test-Path -LiteralPath $source)) {
                    [IO.Directory]::CreateDirectory($source) | Out-Null
                    Invoke-Native git @('-C',$source,'init','-q','-b','main')
                    Invoke-Native git @('-C',$source,'remote','add','origin',$repository)
                }
                foreach ($path in @($source,(Join-Path $source '.git'))) {
                    if (!(Test-Path -LiteralPath $path -PathType Container) -or ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Managed checkout is incomplete or linked elsewhere. Preserve/move cache/update-source aside and retry.' }
                }
                if ([IO.Path]::GetFullPath((Invoke-Native git @('-C',$source,'rev-parse','--show-toplevel')).Trim()) -ne $source) { throw 'Managed checkout root differs.' }
                if ((Invoke-Native git @('-C',$source,'remote','get-url','origin')).Trim() -ne $repository) { throw 'Managed update source differs. Preserve/move cache/update-source aside before switching repositories.' }
                if ((Invoke-Native git @('-C',$source,'symbolic-ref','--short','HEAD')).Trim() -ne 'main') { throw 'Managed checkout must stay on main; local changes preserved.' }
                if (Invoke-Native git @('-C',$source,'status','--porcelain','--untracked-files=all')) { throw 'Managed checkout has local changes; nothing was reset.' }
                $env:GIT_TERMINAL_PROMPT = '0'
                $env:GCM_INTERACTIVE = 'never'
                if (!$env:GIT_SSH_COMMAND) { $env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=10' }
                Write-Host '[Update] Checking ORE main for updates (internet access required)...'
                Invoke-Native git @('-c','gc.auto=0','-c','http.lowSpeedLimit=1024','-c','http.lowSpeedTime=15','-C',$source,'fetch','--quiet','--no-tags','origin','main')
                $target = (Invoke-Native git @('-C',$source,'rev-parse','--verify','FETCH_HEAD^{commit}')).Trim()
                $installed = Read-Installed
                $info = $null
                if ($installed) {
                    $info = [IO.File]::ReadAllText((Join-Path $installed.App 'build-info.json')) | ConvertFrom-Json
                    if ($info.commit -notmatch '^[0-9a-f]{40}$' -or $info.kind -notin @('release','development')) { throw 'Invalid installed identity.' }
                    if ($info.kind -eq 'release') { Invoke-Native git @('-C',$source,'merge-base','--is-ancestor',$info.commit,$target) }
                }
                & git -C $source show-ref --quiet --verify refs/heads/main
                if ($LASTEXITCODE -eq 0) { Invoke-Native git @('-c','core.hooksPath=NUL','-C',$source,'merge','--quiet','--ff-only',$target) }
                else { Invoke-Native git @('-c','core.hooksPath=NUL','-C',$source,'checkout','-q','-b','main',$target) }
                if ((Invoke-Native git @('-C',$source,'rev-parse','HEAD')).Trim() -ne $target) { throw 'Managed checkout contains local commits; they were preserved.' }
                Write-Utf8 ($sourceFile + '.part') ($repository + "`n")
                Move-Item -LiteralPath ($sourceFile + '.part') -Destination $sourceFile -Force
                if ($info -and $info.kind -eq 'release' -and $info.commit -eq $target) { Write-Host ('ORE is up to date (' + $target + '). No build needed.') }
                else {
                    if (!$info) { Write-Host '[Update] No installed app found. Preparing the first installation.' }
                    else { Write-Host '[Update] A different build is needed. Preparing it before switching versions.' }
                    Write-Host ('[Update] Building ORE commit ' + $target + '...')
                    Write-Host '[Update] Downloads and building may take several minutes; detailed progress follows.'
                    Invoke-Native powershell.exe @('-NoProfile','-ExecutionPolicy','RemoteSigned','-File',(Join-Path $source 'build-portable.ps1'),'-Mode','Release','-Commit',$target,'-Destination',$installation)
                }
            } catch {
                if (!(Read-Installed)) { throw ('No usable installed version. Resolve Git/authentication/download/build error: ' + $_.Exception.Message) }
                Write-Warning ('Update unavailable or failed: ' + $_.Exception.Message + '. Starting last installed version; next launch retries.')
                Write-Host ('For details, see the error above or the update log: ' + $log)
            }
        } finally {
            try { if ($transcriptStarted) { Stop-Transcript | Out-Null } }
            finally { Remove-Item -LiteralPath $lock -Force }
        }
    } else { Write-Host 'ORE update check skipped (explicit skip or recovery pause).' }
    $installed = Read-Installed
    if (!$installed) { throw 'No usable installed application/runtime. Start online or repair the installation.' }
    Write-Host '[Start] Preparing to launch the installed app. Waiting for its ready address...'
    $controller = Join-Path $PSScriptRoot 'portable-launch.mjs'
    $protocol = Join-Path $installed.App 'scripts/release/launcher-protocol'
    if ((Test-Path -LiteralPath $protocol) -and [IO.File]::ReadAllText($protocol).Trim() -eq '2') { $controller = Join-Path $installed.App 'scripts/release/portable-launch.mjs' }
    Invoke-Native $installed.Node @($controller,$installation,$installed.App)
    exit 0
} catch { [Console]::Error.WriteLine('ORE: ' + $_.Exception.Message); exit 1 }
finally {
    [Environment]::SetEnvironmentVariable('ORE_PACKAGE_LEASE_HOME',$null,'Process')
    if ($packageLease) { $packageLease.Dispose() }
}
