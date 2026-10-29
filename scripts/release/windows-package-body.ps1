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
$stage = $null; $lockStream = $null; $result = 1
function Write-OreDiagnostic([string]$Text) {
    try { [IO.File]::AppendAllText($script:OreReport,$Text+"`n",(New-Object Text.UTF8Encoding $false)) }
    catch { $script:OreFailure = 'logFailed'; throw }
}
function Test-OreInstalled([hashtable]$Selection, [string]$Tools) {
    if (!$Selection -or ![IO.File]::Exists($Selection.Node)) { throw 'No usable installed runtime.' }
    Assert-OreLongTree $Selection.Application
    Assert-OreLongTree ([IO.Path]::GetDirectoryName($Selection.Node))
    $verify = Assert-OrePath $Installation (Join-Path $Tools 'windows-install-verify.mjs')
    if ((Invoke-OreProcess $Selection.Node @($verify,$Selection.Application) $script:OreReport) -ne 0) { throw 'Installed application verification failed.' }
}
try {
    if (!$Installed) { Show-OreMessage 'heading' }
    $script:OreFailure = 'unsupportedSystem'
    if (![Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or [Environment]::OSVersion.Version.Major -lt 10 -or $PSVersionTable.PSVersion.Major -lt 5) { throw 'Requires native Windows x64 and Windows PowerShell 5.1.' }
    $script:OreFailure = 'folderCollision'
    $Installation = Initialize-OreStandaloneHome $Installation
    $script:OreFailure = 'setupFailed'
    Initialize-OreJob
    Initialize-OreCancellation
    if (!$Installed) {
        $helper = Get-OrePackageHelper $Installation
        if ($helper) {
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
    Write-OreDiagnostic ('Windows package protocol 2; PowerShell '+$PSVersionTable.PSVersion+'; x64; language '+$script:OreLanguage)
    $script:OreFailure = 'installationLocked'
    $lockStream = Acquire-OrePackageLease $Installation
    $script:OreFailure = 'legacyRestart'
    Assert-OreLegacyQuiescent $Installation
    Clear-OreInjection
    $env:ORE_HOME = $Installation
    $env:TEMP = Join-Path $Installation 'cache'; $env:TMP = $env:TEMP
    $script:OreFailure = 'notWritable'
    $envPath = Join-Path $Installation '.env'
    if (![IO.File]::Exists($envPath)) { $empty = [IO.File]::Open($envPath,[IO.FileMode]::CreateNew); $empty.Dispose() }
    $script:OreFailure = 'invalidEnv'
    Import-OreStandaloneEnvironment $envPath
    Clear-OreInjection
    $env:ORE_PACKAGE_LEASE_HOME = $Installation
    if ($env:ORE_SKIP_UPDATE -and $env:ORE_SKIP_UPDATE -notin @('0','1')) { throw 'Invalid skip-update setting.' }
    foreach ($key in @('ROLEPLAY_DATABASE','ROLEPLAY_TLS_CERT','ROLEPLAY_TLS_KEY')) {
        $value = [Environment]::GetEnvironmentVariable($key,'Process')
        if ($null -ne $value) {
            if ([string]::IsNullOrWhiteSpace($value)) { throw 'Empty database/TLS override.' }
            if (![IO.Path]::IsPathRooted($value)) { $value = Join-Path $Invoking $value }
            [Environment]::SetEnvironmentVariable($key,[IO.Path]::GetFullPath($value),'Process')
        }
    }
    $stage = Join-Path $Installation ('cache/p'+[guid]::NewGuid().ToString('N').Substring(0,8))
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $selection = Get-OreSelection $Installation
    $tools = if ($Installed) { $PSScriptRoot } elseif ($selection) { Join-Path $selection.Application 'scripts/release' } else { $null }
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
                if (!$same) {
                    $comparePath = Join-Path $stage 'compare.json'
                    Get-OreHttps ('https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/compare/'+$info.commit+'...'+$release.Commit+'?per_page=1') $comparePath 30
                    $compare = Read-OreJson $comparePath
                    if ($compare.status -cne 'ahead' -or $compare.base_commit.sha -cne $info.commit -or $compare.merge_base_commit.sha -cne $info.commit) { throw 'Release is not a proven forward continuation.' }
                }
            }
            if ($same) { Show-OreMessage 'upToDate' } else {
                $fallback = 'updateFallback'
                Show-OreMessage 'downloadingVersion'
                $checksum = Join-Path $stage 'package.sha256'
                Get-OreHttps $release.Checksum $checksum 30
                if ((New-Object IO.FileInfo $checksum).Length -gt 1KB -or [IO.File]::ReadAllText($checksum).Trim() -cne ($release.Sha256+'  ORE-windows-x64.zip')) { throw 'Release checksums disagree.' }
                $archive = Join-Path $stage 'package.zip'
                Get-OreHttps $release.Archive $archive 600
                $script:OreFailure = 'verificationFailed'
                if ((New-Object IO.FileInfo $archive).Length -ne $release.Bytes -or (Get-OreHash $archive) -cne $release.Sha256) { throw 'Package checksum/size mismatch.' }
                Show-OreMessage 'preparingVersion'
                $unpacked = Join-Path $stage 'payload'
                Expand-OreZip $archive ('ORE-'+$release.Commit.Substring(0,12)+'-release-win32-x64') $unpacked -LongPaths
                Test-OrePackageFiles $unpacked
                $candidate = Get-OreSelection $unpacked
                if (!$candidate) { throw 'Package selection is missing.' }
                $info = Read-OreJson (Join-Path $candidate.Application 'build-info.json')
                if ($info.commit -cne $release.Commit -or $info.platform -cne 'win32' -or $info.arch -cne 'x64' -or $info.kind -cne 'release') { throw 'Package identity differs from release.' }
                $candidateTools = Join-Path $candidate.Application 'scripts/release'
                if ([IO.File]::ReadAllText((Join-Path $candidateTools 'windows-package-protocol')).Trim() -cne '2') { throw 'Unsupported package protocol.' }
                $script:OreFailure = 'activationFailed'
                Show-OreMessage 'activatingVersion'
                if ((Invoke-OreProcess $candidate.Node @((Join-Path $candidateTools 'windows-package-install.mjs'),$unpacked,$Installation,$release.Commit) $script:OreReport) -ne 0) { throw 'Package activation failed.' }
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
    if ($script:OreFailure -eq 'folderCollision' -and ($_.Exception -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [UnauthorizedAccessException])) { $script:OreFailure = 'notWritable' }
    if ($script:OreReport -and $script:OreFailure -ne 'logFailed') {
        try { Write-OreDiagnostic ($_.Exception.ToString()) } catch { $script:OreFailure = 'logFailed' }
    }
    Show-OreMessage $script:OreFailure @{folder='ORE-internal';line=$script:OreEnvLine}
    if ($script:OreReport -and $script:OreFailure -ne 'logFailed') { Show-OreMessage 'assistance'; [Console]::WriteLine($script:OreReport) }
    $result = 1
} finally {
    if (Test-OreCancellation) { $result = 130 }
    if ($stage) {
        try { Remove-OreLongTree $stage }
        catch { if ($script:OreReport) { try { Write-OreDiagnostic ('Temporary cleanup: '+$_.Exception.Message) } catch { $result = 74 } } }
    }
    if ($lockStream) { $lockStream.Dispose() }
}
if ($result -ne 0 -and $env:ORE_NO_PAUSE -ne '1' -and ![Console]::IsInputRedirected) { try { [Console]::ReadKey($true) | Out-Null } catch { } }
exit $result
