# Build local edits with the contained runtime; never check for source updates.
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'windows-common.ps1')
    if ($Arguments.Count) { throw 'Usage: start-dev.bat (no arguments).' }
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $installation = Join-Path $source 'ore-development'
    if ((Test-Path -LiteralPath $installation) -and ((Get-Item -LiteralPath $installation -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'ore-development must be a real directory, not a link or junction.'
    }
    Import-OreEnvironment (Join-Path $source '.env')
    Import-OreEnvironment (Join-Path $installation '.env')
    if (Test-Path Env:ROLEPLAY_DATABASE) {
        if ([string]::IsNullOrWhiteSpace($env:ROLEPLAY_DATABASE)) { throw 'ROLEPLAY_DATABASE must name a database file.' }
        $env:ROLEPLAY_DATABASE = [IO.Path]::GetFullPath($env:ROLEPLAY_DATABASE)
    }
    $env:ORE_DATABASE_DEFAULT = 'repository'
    $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    # A failed rebuild must stop here rather than launch an older installed app.
    Invoke-Native $powershell @('-NoProfile','-ExecutionPolicy','RemoteSigned','-File',(Join-Path $source 'build-portable.ps1'),'-Mode','Development','-ReuseDevelopmentDependencies','-Destination',$installation)
    $env:ORE_SKIP_UPDATE = '1'
    Invoke-Native $powershell @('-NoProfile','-ExecutionPolicy','RemoteSigned','-File',(Join-Path $PSScriptRoot 'update-and-start.ps1'),'-Installation',$installation,'-SourceHint',$source)
    exit 0
} catch { [Console]::Error.WriteLine('ORE: ' + $_.Exception.Message); exit 1 }
