# Windows PowerShell 5.1. Resolve the caller's database before any directory change.
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
try {
    if ($Arguments.Count) { throw 'Usage: start-app.bat (no arguments; source installs in repository/ore-portable).' }
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    if (Test-Path -LiteralPath (Join-Path $source 'package-lock.json')) {
        $installation = Join-Path $source 'ore-portable'
        $env:ORE_DATABASE_DEFAULT = 'repository'
    } else {
        $installation = $PSScriptRoot
        $source = ''
    }
    if ((Test-Path -LiteralPath $installation) -and ((Get-Item -LiteralPath $installation).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'ore-portable must be a real directory, not a link or junction.' }
    if (Test-Path Env:ROLEPLAY_DATABASE) {
        if ([string]::IsNullOrWhiteSpace($env:ROLEPLAY_DATABASE)) { throw 'ROLEPLAY_DATABASE must name a database file.' }
        $env:ROLEPLAY_DATABASE = [IO.Path]::GetFullPath($env:ROLEPLAY_DATABASE)
    }
    # Installed updater fixes take effect on the next source start.
    $updater = Join-Path $PSScriptRoot 'update-and-start.ps1'
    $pointer = Join-Path $installation 'current'
    if (Test-Path -LiteralPath $pointer) {
        $selection = [IO.File]::ReadAllLines($pointer)
        if ($selection.Count -ne 2 -or $selection[0] -notmatch '^(release|dev)-[a-z0-9-]+$' -or $selection[1] -notmatch '^node-v[0-9.]+-win32-x64$') { throw 'Invalid application/runtime selection.' }
        $candidate = Join-Path $installation ('app/' + $selection[0] + '/scripts/release/update-and-start.ps1')
        $protocol = Join-Path $installation ('app/' + $selection[0] + '/scripts/release/launcher-protocol')
        if ((Test-Path -LiteralPath $candidate) -and (Test-Path -LiteralPath $protocol) -and [IO.File]::ReadAllText($protocol).Trim() -eq '2') { $updater = $candidate }
        elseif (!$source) {
            $toolkit = [IO.File]::ReadAllLines((Join-Path $installation 'recovery/current'))
            if ($toolkit.Count -ne 2 -or $toolkit[0] -notmatch '^(release|dev)-[a-z0-9-]+$') { throw 'Invalid recovery toolkit pointer.' }
            $updater = Join-Path $installation ('recovery/' + $toolkit[0] + '/update-and-start.ps1')
        }
    }
    & $updater -Installation $installation -SourceHint $source
    exit $LASTEXITCODE
} catch { [Console]::Error.WriteLine('ORE: ' + $_.Exception.Message); exit 1 }
