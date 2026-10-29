param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
$packageLease = $null
try {
    . (Join-Path $PSScriptRoot 'windows-common.ps1')
    . (Join-Path $PSScriptRoot 'windows-snapshot.ps1')
    . (Join-Path $PSScriptRoot 'windows-package-lock.ps1')
    . (Join-Path $PSScriptRoot 'windows-standalone-common.ps1')
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    if ([IO.File]::Exists((Join-Path $PSScriptRoot '.ore-installation'))) {
        $installation = Initialize-OreStandaloneHome $PSScriptRoot
        Clear-OreInjection
        $environment = Join-Path $installation '.env'
        if ([IO.File]::Exists($environment)) { Import-OreStandaloneEnvironment $environment }
        Clear-OreInjection
        $env:ORE_HOME = $installation
        $env:TEMP = Join-Path $installation 'cache'; $env:TMP = $env:TEMP
    } else {
        if (Test-Path -LiteralPath (Join-Path $source 'package-lock.json')) { $installation = Join-Path $source 'ore-portable'; Import-OreEnvironment (Join-Path $source '.env'); $env:ORE_DATABASE_DEFAULT = 'repository' }
        else { $installation = $PSScriptRoot }
        Import-OreEnvironment (Join-Path $installation '.env')
        $installation = Initialize-OreHome $installation
    }
    Initialize-OreJob
    $packageLease = Acquire-OrePackageLease $installation
    Assert-OreLegacyQuiescent $installation
    $env:ORE_PACKAGE_LEASE_HOME = $installation
    $selection = [IO.File]::ReadAllLines((Join-Path $installation 'recovery/current'))
    if ($selection.Count -ne 2 -or $selection[0] -notmatch '^(release|dev)-[a-z0-9-]+$' -or $selection[1] -notmatch '^node-v[0-9.]+-win32-x64$') { throw 'Invalid recovery toolkit pointer.' }
    $node = Join-Path $installation ('runtime/' + $selection[1] + '/node.exe')
    Invoke-Native $node (@((Join-Path $installation ('recovery/' + $selection[0] + '/recover.mjs')),$installation) + $Arguments)
    exit 0
} catch { [Console]::Error.WriteLine('ORE recovery: ' + $_.Exception.Message); exit 1 }
finally {
    [Environment]::SetEnvironmentVariable('ORE_PACKAGE_LEASE_HOME',$null,'Process')
    if ($packageLease) { $packageLease.Dispose() }
}
