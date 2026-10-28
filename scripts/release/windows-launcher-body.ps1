# Installed mode never delegates again. External mode may delegate exactly once.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$script:OreLanguage = 'en'
if ($Installed) {
    if ($Language -eq 'ru') { $script:OreLanguage = 'ru' }
} else {
    $Invoking = [IO.Path]::GetFullPath((Get-Location).Path)
    $Installation = Join-Path ([IO.Path]::GetDirectoryName($env:ORE_BOOTSTRAP_FILE)) 'ORE-internal'
    $preference = [Globalization.CultureInfo]::CurrentUICulture.Name
    if ($preference -match '^ru(?:[-_][a-zA-Z0-9]{2,8})*$') { $script:OreLanguage = 'ru' }
}
function Show-OreMessage([string]$Id, [hashtable]$Parameters = @{}) {
    $entry = $OreMessages[$Id]
    if (!$entry) { throw 'Unknown launcher message.' }
    $value = $entry[$script:OreLanguage]
    if (!$value) { $value = $entry.en }
    $text = [regex]::Replace($value,'\{([A-Za-z]+)\}',[Text.RegularExpressions.MatchEvaluator]{
        param($match)
        $key = $match.Groups[1].Value
        if (!$Parameters.ContainsKey($key)) { throw 'Missing literal launcher parameter.' }
        return [string]$Parameters[$key]
    })
    [Console]::WriteLine($text)
}
$script:OreReport = $null
$script:OreFailure = 'setupFailed'
$script:OreEnvLine = 1
$stage = $null; $lockStream = $null; $lockOwner = $null; $result = 1
function Write-OreDiagnostic([string]$Text) {
    try { [IO.File]::AppendAllText($script:OreReport,$Text+"`n",(New-Object Text.UTF8Encoding $false)) }
    catch { $script:OreFailure = 'logFailed'; throw }
}
function Test-OreInstalled([hashtable]$Selection, [string]$Tools) {
    if (!$Selection -or ![IO.File]::Exists($Selection.Node)) { throw 'No usable installed runtime.' }
    Assert-OreTree $Selection.Application
    Assert-OreTree ([IO.Path]::GetDirectoryName($Selection.Node))
    $verify = Assert-OrePath $Installation (Join-Path $Tools 'windows-install-verify.mjs')
    if ((Invoke-OreProcess $Selection.Node @($verify,$Selection.Application) $script:OreReport) -ne 0) { throw 'Installed application verification failed.' }
}
try {
    if (!$Installed) { Show-OreMessage 'heading' }
    $script:OreFailure = 'unsupportedSystem'
    if (![Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or [Environment]::OSVersion.Version.Major -lt 10 -or $PSVersionTable.PSVersion.Major -lt 5) { throw 'Requires native Windows x64 and Windows PowerShell 5.1.' }
    $script:OreFailure = 'folderCollision'
    $Installation = Initialize-OreStandaloneHome $Installation
    $env:TEMP = Join-Path $Installation 'cache'
    $env:TMP = $env:TEMP
    # The external parent also owns delegated descendants. Closing/killing it
    # must not orphan an installed controller before that controller's job ends.
    Initialize-OreJob
    Initialize-OreCancellation
    if (!$Installed) {
        $script:OreFailure = 'setupFailed'
        $helper = Get-OreHelper $Installation
        if ($helper) {
            # Invoke a saved file under RemoteSigned; keep organization policy.
            # The installed controller acquires the lifetime lease itself.
            & (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -NoProfile -ExecutionPolicy RemoteSigned -File $helper -Installed -Installation $Installation -Invoking $Invoking -Language $script:OreLanguage
            exit $LASTEXITCODE
        }
    }
    $script:OreFailure = 'logFailed'
    $reportPath = Assert-OrePath $Installation (Join-Path $Installation ('logs/launcher-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid()+'.txt'))
    $reportStream = [IO.File]::Open($reportPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    $reportStream.Dispose()
    $script:OreReport = $reportPath
    Show-OreMessage 'logFile' @{absolutePath=$reportPath}
    Write-OreDiagnostic ('Windows standalone protocol 1; PowerShell '+$PSVersionTable.PSVersion+'; OS '+[Environment]::OSVersion.Version+'; x64; language '+$script:OreLanguage)
    $script:OreFailure = 'setupFailed'
    Initialize-OreJob
    Clear-OreInjection
    $env:ORE_HOME = $Installation
    $env:TEMP = Join-Path $Installation 'cache'; $env:TMP = $env:TEMP
    $script:OreFailure = 'installationLocked'
    # FileShare.None is a lifetime lease. It is released by the OS even after
    # abrupt owner loss; stale directory locks are never guessed away.
    $leasePath = Assert-OrePath $Installation (Join-Path $Installation 'cache/launcher.lease')
    $lockStream = [IO.File]::Open($leasePath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $lockPath = Assert-OrePath $Installation (Join-Path $Installation 'cache/update.lock')
    New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null
    $lockOwner = Join-Path $lockPath 'owner'
    $token = [guid]::NewGuid().ToString()
    $ownerText = [string]$PID+"`n"+$token+"`n"
    Write-Utf8 $lockOwner $ownerText
    if (Test-Path -LiteralPath (Assert-OrePath $Installation (Join-Path $Installation 'cache/build.lock'))) { throw 'Build lock already exists.' }
    $script:OreFailure = 'notWritable'
    $envPath = Join-Path $Installation '.env'
    if (![IO.File]::Exists($envPath)) { $empty = [IO.File]::Open($envPath,[IO.FileMode]::CreateNew); $empty.Dispose() }
    $script:OreFailure = 'invalidEnv'
    Import-OreStandaloneEnvironment $envPath
    Clear-OreInjection
    $script:OreFailure = 'setupFailed'
    if ($env:ORE_SKIP_UPDATE -and $env:ORE_SKIP_UPDATE -notin @('0','1')) { throw 'Invalid skip-update setting.' }
    foreach ($key in @('ROLEPLAY_DATABASE','ROLEPLAY_TLS_CERT','ROLEPLAY_TLS_KEY')) {
        $value = [Environment]::GetEnvironmentVariable($key,'Process')
        if ($null -ne $value) {
            if ([string]::IsNullOrWhiteSpace($value)) { throw 'Empty database/TLS override.' }
            if (![IO.Path]::IsPathRooted($value)) { $value = Join-Path $Invoking $value }
            [Environment]::SetEnvironmentVariable($key,[IO.Path]::GetFullPath($value),'Process')
        }
    }
    $stage = Join-Path $Installation ('cache/bootstrap-'+[guid]::NewGuid())
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $selection = Get-OreSelection $Installation
    $tools = if ($Installed) { $PSScriptRoot } elseif ($selection) { Join-Path $selection.Application 'scripts/release' } else { $null }
    if ($selection) { $script:OreFailure = 'startupFailed'; Test-OreInstalled $selection $tools }
    if ($env:ORE_SKIP_UPDATE -eq '1' -or [IO.File]::Exists((Join-Path $Installation 'updates-paused'))) {
        if (!$selection) { throw 'Skip-update requires a verified installation.' }
        Show-OreMessage 'updatesPaused'
    } else {
        if (!$selection) { Show-OreMessage 'firstSetup' }
        $fallback = 'checkFallback'
        try {
            $script:OreFailure = 'downloadFailed'
            Show-OreMessage 'checkingUpdates'
            $mainFile = Join-Path $stage 'main.json'
            Write-OreDiagnostic 'HTTPS request: https://api.github.com/repos/olegpro171/Roleplay-Engine/commits/main'
            Get-OreHttps 'https://api.github.com/repos/olegpro171/Roleplay-Engine/commits/main' $mainFile 30
            $main = [IO.File]::ReadAllText($mainFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
            $commit = $main.sha
            if ($commit -isnot [string] -or $commit -cnotmatch '^[0-9a-f]{40}$') { throw 'Malformed main identity.' }
            Write-OreDiagnostic ('Resolved exact main '+$commit)
            $same = $false
            if ($selection) {
                $info = [IO.File]::ReadAllText((Join-Path $selection.Application 'build-info.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json
                $same = $info.commit -ceq $commit
                if (!$same) {
                    $compareFile = Join-Path $stage 'compare.json'
                    $compareUrl = 'https://api.github.com/repos/olegpro171/Roleplay-Engine/compare/'+$info.commit+'...'+$commit+'?per_page=1'
                    Write-OreDiagnostic ('HTTPS request: '+$compareUrl)
                    Get-OreHttps $compareUrl $compareFile 30
                    $compare = [IO.File]::ReadAllText($compareFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
                    if ($compare.status -cne 'ahead' -or $compare.base_commit.sha -cne $info.commit -or $compare.merge_base_commit.sha -cne $info.commit) { throw 'Main is not a proven forward continuation.' }
                }
            }
            if ($same) { Show-OreMessage 'upToDate' } else {
                $fallback = 'updateFallback'
                Show-OreMessage 'downloadingVersion'
                $archive = Join-Path $stage 'source.zip'
                $sourceUrl = 'https://github.com/olegpro171/Roleplay-Engine/archive/'+$commit+'.zip'
                Write-OreDiagnostic ('HTTPS request: '+$sourceUrl)
                Get-OreHttps $sourceUrl $archive 300
                $script:OreFailure = 'verificationFailed'
                Show-OreMessage 'preparingVersion'
                $sourcePath = Join-Path $stage 'source'
                Expand-OreZip $archive ('Roleplay-Engine-'+$commit) $sourcePath -Source
                if ([IO.File]::ReadAllText((Join-Path $sourcePath 'scripts/release/windows-launcher-protocol')).Trim() -cne '1') { throw 'Unsupported source helper protocol.' }
                $runtime = Get-OreRuntime $Installation $sourcePath $stage
                $digest = Get-OreHash $archive
                Write-OreDiagnostic ('Source '+$commit+'; archive SHA256 '+$digest+'; runtime '+$runtime.Id+'; official SHA256 '+$runtime.Checksum)
                $env:ORE_SNAPSHOT_SOURCE = $sourceUrl; $env:ORE_SNAPSHOT_SHA256 = $digest
                $env:ORE_WINDOWS_BUILD_EVENTS = Join-Path $stage 'build-events'
                Write-Utf8 $env:ORE_WINDOWS_BUILD_EVENTS ''
                $script:OreFailure = 'buildFailed'
                Show-OreMessage 'buildingVersion'
                $buildStatus = Invoke-OreProcess (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') @('-NoProfile','-ExecutionPolicy','RemoteSigned','-File',(Join-Path $sourcePath 'build-portable.ps1'),'-Mode','Snapshot','-Commit',$commit,'-Destination',$Installation,'-Snapshot',$archive) $script:OreReport -PhaseFile $env:ORE_WINDOWS_BUILD_EVENTS
                if ($buildStatus -in @(75,129,130,143)) { $script:OreFailure = if ($buildStatus -eq 75) { 'installationLocked' } else { 'cancelled' }; throw 'Build interrupted/locked.' }
                if ($buildStatus -ne 0) { throw ('Builder exit '+$buildStatus) }
                $selection = Get-OreSelection $Installation
                $tools = Join-Path $selection.Application 'scripts/release'
            }
        } catch {
            if (Test-OreCancellation) { $script:OreFailure = 'cancelled' }
            Write-OreDiagnostic ($_.Exception.ToString())
            if (!$selection -or $script:OreFailure -in @('installationLocked','cancelled','logFailed')) { throw }
            Test-OreInstalled $selection $tools
            Show-OreMessage $fallback
        }
    }
    # No automatic fallback is possible past this live-start boundary.
    $script:OreFailure = 'startupFailed'
    $selection = Get-OreSelection $Installation
    Test-OreInstalled $selection $tools
    $env:ORE_LAUNCH_REPORT = $script:OreReport
    $env:ORE_LAUNCH_LANGUAGE = $script:OreLanguage
    Write-OreDiagnostic ('Starting selected '+$selection.Id+'; automatic fallback ends here.')
    $result = Invoke-OreProcess $selection.Node @((Join-Path $tools 'portable-launch.mjs'),$Installation,$selection.Application) $script:OreReport -Console
} catch {
    if (Test-OreCancellation) { $script:OreFailure = 'cancelled' }
    if ($script:OreFailure -eq 'folderCollision' -and ($_.Exception -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [UnauthorizedAccessException])) { $script:OreFailure = 'notWritable' }
    if ($script:OreReport -and $script:OreFailure -ne 'logFailed') {
        try { Write-OreDiagnostic ($_.Exception.ToString()) } catch { $script:OreFailure = 'logFailed' }
    }
    Show-OreMessage $script:OreFailure @{folder='ORE-internal';line=$script:OreEnvLine}
    if ($script:OreReport -and $script:OreFailure -ne 'logFailed') { Show-OreMessage 'assistance'; [Console]::WriteLine($script:OreReport) }
    $result = 1
} finally {
    if (Test-OreCancellation) {
        if ($script:OreFailure -ne 'cancelled') { Show-OreMessage 'cancelled' }
        $result = 130
    }
    if ($stage) {
        try {
            Assert-OrePath $Installation $stage | Out-Null
            Assert-OreTree $stage
            Remove-Item -LiteralPath $stage -Recurse -Force
        } catch { if ($script:OreReport) { try { Write-OreDiagnostic ('Temporary cleanup: '+$_.Exception.Message) } catch { $result = 74 } } }
    }
    if ($lockOwner) {
        try {
            Assert-OrePath $Installation $lockOwner | Out-Null
            if ([IO.File]::ReadAllText($lockOwner) -cne $ownerText) { throw 'Lock owner changed; preserving lock.' }
            [IO.File]::Delete($lockOwner)
            [IO.Directory]::Delete([IO.Path]::GetDirectoryName($lockOwner))
        } catch { $result = 75; if ($script:OreReport) { try { Write-OreDiagnostic $_.Exception.Message } catch { } } }
    }
    if ($lockStream) { $lockStream.Dispose() }
}
if ($result -ne 0 -and $env:ORE_NO_PAUSE -ne '1' -and ![Console]::IsInputRedirected) { try { [Console]::ReadKey($true) | Out-Null } catch { } }
exit $result
