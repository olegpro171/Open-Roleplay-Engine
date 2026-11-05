# Private runtime preparation for the Windows source builder.
function Move-OreRuntimeDirectory([string]$SourcePath, [string]$Destination) {
    # Windows can briefly retain executable/AV handles after validation exits.
    # Retry the rename without deleting either directory or replacing a runtime.
    for ($attempt = 0; ; $attempt++) {
        try { [IO.Directory]::Move($SourcePath,$Destination); return }
        catch [IO.IOException] {
            if ($attempt -ge 10) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
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
        Move-OreRuntimeDirectory $unpacked $runtimePath
    }
    Assert-OreTree $runtimePath
    $node = Join-Path $runtimePath 'node.exe'
    if ((Invoke-OreProcess $node $validateArguments $runtimeReport) -ne 0) { throw 'Installed runtime differs from pin.' }
    return @{Id=$runtimeId; Directory=$runtimePath; Node=$node; Npm=(Join-Path $runtimePath 'node_modules/npm/bin/npm-cli.js'); Checksum=$expected}
}
