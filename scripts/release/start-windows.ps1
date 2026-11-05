# Installed entry also used by the Windows working-tree launcher after a build.
[CmdletBinding(PositionalBinding=$false)]
param([string]$DevelopmentInstallation)
$ErrorActionPreference = 'Stop'
$packageLease = $null
try {
    . (Join-Path $PSScriptRoot 'windows-common.ps1')
    . (Join-Path $PSScriptRoot 'windows-snapshot.ps1')
    . (Join-Path $PSScriptRoot 'windows-standalone-common.ps1')
    . (Join-Path $PSScriptRoot 'windows-package-lock.ps1')
    $homePath = if ($DevelopmentInstallation) { $DevelopmentInstallation } else { $PSScriptRoot }
    $Installation = Assert-OrePath $homePath $homePath
    if (!$DevelopmentInstallation -and [IO.File]::Exists((Join-Path $Installation '.ore-installation'))) {
        . (Join-Path $PSScriptRoot 'windows-package.ps1')
        $Installation = Assert-OreStandaloneHome $Installation
        Set-OrePrivate $Installation
        $helper = Get-OrePackageHelper $Installation
        if (!$helper) { throw 'No compatible package helper. Use recover-app.bat.' }
        $language = if ([Globalization.CultureInfo]::CurrentUICulture.Name -match '^ru(?:[-_]|$)') { 'ru' } else { 'en' }
        & $helper -Installed -Installation $Installation -Invoking (Get-Location).Path -Language $language
        exit $LASTEXITCODE
    }

    Import-OreEnvironment (Join-Path $Installation '.env')
    if (Test-Path Env:ROLEPLAY_DATABASE) {
        if ([string]::IsNullOrWhiteSpace($env:ROLEPLAY_DATABASE)) { throw 'ROLEPLAY_DATABASE must name a database file.' }
        $env:ROLEPLAY_DATABASE = [IO.Path]::GetFullPath($env:ROLEPLAY_DATABASE)
    }
    $Installation = Initialize-OreHome $Installation
    $packageLease = Acquire-OrePackageLease $Installation
    Assert-OreLegacyQuiescent $Installation
    $env:ORE_PACKAGE_LEASE_HOME = $Installation
    $selection = Get-OreSelection $Installation
    if (!$selection) { throw 'No installed application. Build or recover ORE first.' }
    $tools = Join-Path $selection.Application 'scripts/release'
    if (![IO.File]::Exists((Join-Path $tools 'application-start.mjs')) -or ![IO.File]::Exists((Join-Path $tools 'portable-launch.mjs'))) {
        $recovery = Get-OreSelection $Installation 'recovery/current'
        if (!$recovery) { throw 'No retained startup toolkit.' }
        $tools = Join-Path $Installation ('recovery/'+$recovery.Id)
    }
    $controller = Assert-OrePath $Installation (Join-Path $tools 'portable-launch.mjs')
    Invoke-Native $selection.Node @($controller,$Installation,$selection.Application)
    exit 0
} catch { [Console]::Error.WriteLine('ORE: ' + $_.Exception.Message); exit 1 }
finally { if ($packageLease) { $packageLease.Dispose() } }
