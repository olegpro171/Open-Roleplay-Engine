# Retained source-building entry points only; never embedded in the package downloader.
function Get-OreHelper([string]$HomePath) {
    foreach ($pointer in @('current','recovery/current')) {
        $selection = Get-OreSelection $HomePath $pointer
        if (!$selection) { continue }
        $directory = if ($pointer -eq 'current') { Join-Path $selection.Application 'scripts/release' } else { Join-Path $HomePath ('recovery/'+$selection.Id) }
        $protocol = Assert-OrePath $HomePath (Join-Path $directory 'windows-launcher-protocol')
        $helper = Assert-OrePath $HomePath (Join-Path $directory 'windows-launcher.ps1')
        if ([IO.Directory]::Exists($protocol)) { throw 'Invalid helper protocol.' }
        if (![IO.File]::Exists($protocol)) { continue }
        if ([IO.File]::ReadAllText($protocol).Trim() -cne '1') { throw 'Unsupported standalone helper protocol.' }
        $complete = $true
        foreach ($name in @('portable-launch.mjs','windows-install-verify.mjs','application-assets.mjs','selection.mjs','launcher-messages.mjs','launcher-messages.json','launcher-lock.mjs','application-start.mjs','database-location.mjs','check-database.mjs')) {
            $dependency = Assert-OrePath $HomePath (Join-Path $directory $name)
            try {
                if (![IO.File]::Exists($dependency) -or !(New-Object IO.FileInfo $dependency).Length) { $complete = $false; break }
                $readable = [IO.File]::OpenRead($dependency); $readable.Dispose()
            } catch [IO.IOException] { $complete = $false; break } catch [UnauthorizedAccessException] { $complete = $false; break }
        }
        if (!$complete) { continue }
        if (![IO.File]::Exists($helper)) { continue }
        try {
            $sourceText = [IO.File]::ReadAllText($helper,[Text.Encoding]::UTF8)
            $tokens = $null; $parseErrors = $null
            [Management.Automation.Language.Parser]::ParseInput($sourceText,[ref]$tokens,[ref]$parseErrors) | Out-Null
            if (!$sourceText.Trim() -or $parseErrors.Count) { continue }
        } catch [IO.IOException] { continue } catch [UnauthorizedAccessException] { continue }
        return $helper
    }
    if ([IO.File]::Exists((Join-Path $HomePath 'current')) -or [IO.File]::Exists((Join-Path $HomePath 'recovery/current'))) { throw 'No complete compatible standalone helper.' }
    return $null
}
function Get-OreRuntime([string]$HomePath, [string]$SourcePath, [string]$StagePath) {
    $config = [IO.File]::ReadAllText((Join-Path $SourcePath 'scripts/release/runtime.conf'))
    if ($config -notmatch '(?m)^ORE_NODE_VERSION=([0-9]+\.[0-9]+\.[0-9]+)\s*$') { throw 'Invalid runtime pin.' }
    $version = $Matches[1]
    $archiveRoot = 'node-v'+$version+'-win-x64'
    $runtimeId = 'node-v'+$version+'-win32-x64'
    $archiveName = $archiveRoot+'.zip'
    $pins = @([IO.File]::ReadAllLines((Join-Path $SourcePath 'scripts/release/node-SHASUMS256.txt')) | Where-Object { $_ -cmatch ('^[0-9a-f]{64}\s+'+[regex]::Escape($archiveName)+'$') })
    if ($pins.Count -ne 1) { throw 'Missing unique official runtime checksum.' }
    $expected = ($pins[0] -split '\s+')[0]
    $archive = Assert-OrePath $HomePath (Join-Path $HomePath ('cache/'+$archiveName))
    if (![IO.File]::Exists($archive)) {
        if (Get-Command Show-OreMessage -ErrorAction SilentlyContinue) { Show-OreMessage 'downloadingToolkit' }
        $partial = Join-Path $StagePath 'runtime.part'
        Get-OreHttps ('https://nodejs.org/dist/v'+$version+'/'+$archiveName) $partial 600
        if ((Get-OreHash $partial) -cne $expected) { throw 'Runtime checksum mismatch.' }
        [IO.File]::Move($partial,$archive)
    }
    if ((Get-OreHash $archive) -cne $expected) { throw 'Cached runtime checksum mismatch; retain for explicit repair.' }
    $runtimePath = Assert-OrePath $HomePath (Join-Path $HomePath ('runtime/'+$runtimeId))
    $runtimeReport = Join-Path $HomePath ('logs/runtime-'+[guid]::NewGuid()+'.txt')
    Write-Utf8 $runtimeReport ''
    $validateArguments = @('-e','if(process.version!==process.argv[1]||process.platform!=="win32"||process.arch!=="x64")process.exit(1)',('v'+$version))
    if (![IO.Directory]::Exists($runtimePath)) {
        $unpacked = Join-Path $StagePath 'runtime-unpacked'
        Expand-OreZip $archive $archiveRoot $unpacked
        Assert-OreTree $unpacked
        $candidate = Join-Path $unpacked 'node.exe'
        if ((Invoke-OreProcess $candidate $validateArguments $runtimeReport) -ne 0) { throw 'Runtime version/platform mismatch.' }
        if (![IO.File]::Exists((Join-Path $unpacked 'node_modules/npm/bin/npm-cli.js')) -or ![IO.File]::Exists((Join-Path $unpacked 'LICENSE'))) { throw 'Incomplete private toolkit.' }
        [IO.Directory]::Move($unpacked,$runtimePath)
    }
    Assert-OreTree $runtimePath
    $node = Join-Path $runtimePath 'node.exe'
    if ((Invoke-OreProcess $node $validateArguments $runtimeReport) -ne 0) { throw 'Installed runtime differs from pin.' }
    return @{Id=$runtimeId; Directory=$runtimePath; Node=$node; Npm=(Join-Path $runtimePath 'node_modules/npm/bin/npm-cli.js'); Checksum=$expected}
}
