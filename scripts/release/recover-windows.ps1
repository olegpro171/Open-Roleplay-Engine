param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
$packageLease = $null
try {
    . (Join-Path $PSScriptRoot 'windows-common.ps1')
    . (Join-Path $PSScriptRoot 'windows-snapshot.ps1')
    . (Join-Path $PSScriptRoot 'windows-package-lock.ps1')
    . (Join-Path $PSScriptRoot 'windows-standalone-common.ps1')
    if ([IO.File]::Exists((Join-Path $PSScriptRoot '.ore-installation'))) {
        $installation = Initialize-OreStandaloneHome $PSScriptRoot
        Clear-OreInjection
        $environment = Join-Path $installation '.env'
        if ([IO.File]::Exists($environment)) { Import-OreStandaloneEnvironment $environment }
        Clear-OreInjection
        $env:ORE_HOME = $installation
        $env:TEMP = Join-Path $installation 'cache'; $env:TMP = $env:TEMP
    } else {
        $installation = Assert-OrePath $PSScriptRoot $PSScriptRoot
        Import-OreEnvironment (Join-Path $installation '.env')
        $installation = Initialize-OreHome $installation
    }
    Initialize-OreJob
    $packageLease = Acquire-OrePackageLease $installation
    Assert-OreLegacyQuiescent $installation
    $env:ORE_PACKAGE_LEASE_HOME = $installation
    $selection = Get-OreSelection $installation 'recovery/current'
    if (!$selection) { throw 'No retained recovery toolkit.' }
    $tool = Assert-OrePath $installation (Join-Path $installation ('recovery/' + $selection.Id + '/recover.mjs'))
    Invoke-Native $selection.Node (@($tool,$installation) + $Arguments)
    exit 0
} catch { [Console]::Error.WriteLine('ORE recovery: ' + $_.Exception.Message); exit 1 }
finally {
    [Environment]::SetEnvironmentVariable('ORE_PACKAGE_LEASE_HOME',$null,'Process')
    if ($packageLease) { $packageLease.Dispose() }
}
