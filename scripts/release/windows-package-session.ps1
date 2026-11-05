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

function Assert-OreWindows {
    $script:OreFailure = 'unsupportedSystem'
    if (![Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or [Environment]::OSVersion.Version.Major -lt 10 -or $PSVersionTable.PSVersion.Major -lt 5) { throw 'Requires native Windows x64 and Windows PowerShell 5.1.' }
}
function Write-OreDiagnostic([string]$Text) {
    try { [IO.File]::AppendAllText($script:OreReport,$Text+"`n",(New-Object Text.UTF8Encoding $false)) }
    catch { $script:OreFailure = 'logFailed'; throw }
}
function Open-OrePackageReport {
    $script:OreFailure = 'logFailed'
    $reportPath = Assert-OrePath $Installation (Join-Path $Installation ('logs/launcher-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid()+'.txt'))
    $reportStream = [IO.File]::Open($reportPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    $reportStream.Dispose()
    $script:OreReport = $reportPath
    Show-OreMessage 'logFile' @{absolutePath=$reportPath}
    Write-OreDiagnostic ('Windows package protocol 2; PowerShell '+$PSVersionTable.PSVersion+'; x64; language '+$script:OreLanguage)
}
function Initialize-OrePackageEnvironment {
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
}
function New-OrePackageStage {
    $stage = Join-Path $Installation ('cache/p'+[guid]::NewGuid().ToString('N').Substring(0,8))
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    return $stage
}
function Show-OrePackageFailure($Failure) {
    if ($script:OreFailure -eq 'folderCollision' -and ($Failure.Exception -is [UnauthorizedAccessException] -or $Failure.Exception.InnerException -is [UnauthorizedAccessException])) { $script:OreFailure = 'notWritable' }
    if ($script:OreReport -and $script:OreFailure -ne 'logFailed') {
        try { Write-OreDiagnostic ($Failure.Exception.ToString()) } catch { $script:OreFailure = 'logFailed' }
    }
    Show-OreMessage $script:OreFailure @{folder='ORE-internal';line=$script:OreEnvLine}
    if ($script:OreReport -and $script:OreFailure -ne 'logFailed') { Show-OreMessage 'assistance'; [Console]::WriteLine($script:OreReport) }
}
function Remove-OrePackageStage([string]$Stage) {
    if (!$Stage) { return }
    try { Remove-OreLongTree $Stage }
    catch { if ($script:OreReport) { Write-OreDiagnostic ('Temporary cleanup: '+$_.Exception.Message) } }
}
function Wait-OreFailure([int]$Result) {
    if ($Result -ne 0 -and $env:ORE_NO_PAUSE -ne '1' -and ![Console]::IsInputRedirected) {
        try { [Console]::ReadKey($true) | Out-Null } catch { }
    }
}
