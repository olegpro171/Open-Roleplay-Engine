# Protocol 2 release packages. Resolve one release, then pin every download to it.
function Read-OreJson([string]$Path, [long]$Limit = 1MB) {
    if ((New-Object IO.FileInfo $Path).Length -gt $Limit) { throw 'Oversized release metadata.' }
    return [IO.File]::ReadAllText($Path,[Text.Encoding]::UTF8) | ConvertFrom-Json
}
function Get-OreReleaseAsset([object]$Release, [string]$Name) {
    $assets = @($Release.assets | Where-Object { $_.name -ceq $Name })
    if ($assets.Count -ne 1 -or $assets[0].state -cne 'uploaded' -or $assets[0].browser_download_url -cne ('https://github.com/olegpro171/Open-Roleplay-Engine/releases/download/'+$Release.tag_name+'/'+$Name)) { throw 'Missing or invalid release asset.' }
    return $assets[0].browser_download_url
}
function Get-OreRelease([string]$StagePath) {
    $metadata = Join-Path $StagePath 'release.json'
    Get-OreHttps 'https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/releases/latest' $metadata 30
    $release = Read-OreJson $metadata
    if ($release.draft -ne $false -or $release.prerelease -ne $false -or $release.tag_name -cnotmatch '^build-[a-f0-9]{40}$') { throw 'Invalid published release identity.' }
    $descriptorPath = Join-Path $StagePath 'package.json'
    Get-OreHttps (Get-OreReleaseAsset $release 'ORE-windows-x64.json') $descriptorPath 30
    $package = Read-OreJson $descriptorPath
    if ($package.formatVersion -ne 1 -or $package.platform -cne 'win32' -or $package.arch -cne 'x64' -or $package.launcherProtocol -ne 2) { throw 'Unsupported Windows release package protocol/platform.' }
    if ($package.commit -isnot [string] -or $package.commit -cnotmatch '^[a-f0-9]{40}$' -or $release.tag_name -cne ('build-'+$package.commit)) { throw 'Package commit differs from release tag.' }
    if ($package.archive -cne 'ORE-windows-x64.zip' -or $package.sha256 -isnot [string] -or $package.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid package archive identity.' }
    $integerSize = $package.bytes -is [long] -or $package.bytes -is [int]
    if (!$integerSize -or $package.bytes -lt 1 -or $package.bytes -gt 512MB) { throw 'Package size is outside supported download bounds.' }
    return @{Commit=$package.commit; Sha256=$package.sha256; Bytes=$package.bytes; Archive=(Get-OreReleaseAsset $release 'ORE-windows-x64.zip'); Checksum=(Get-OreReleaseAsset $release 'ORE-windows-x64.zip.sha256')}
}
function Test-OrePackageFiles([string]$Directory) {
    Assert-OreLongTree $Directory
    # Desktop ConvertFrom-Json emits a top-level array as one pipeline object.
    # Capture that array directly; @() would wrap it in a second array.
    $records = Read-OreJson (Join-Path $Directory 'checksums.json') 16MB
    if ($records -isnot [array] -or !$records.Count -or $records.Count -gt 100000) { throw 'Invalid package file inventory.' }
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $records) {
        if ($file -isnot [Management.Automation.PSCustomObject]) { throw 'Invalid package file record.' }
        $integerSize = $file.bytes -is [long] -or $file.bytes -is [int]
        if ($file.path -isnot [string] -or $file.path -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or $file.path -ceq 'checksums.json' -or $file.sha256 -isnot [string] -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$' -or !$seen.Add($file.path) -or $file.link -or !$integerSize -or $file.bytes -lt 0) { throw 'Invalid package file record.' }
        $path = Assert-OreLongPath $Directory ($Directory.TrimEnd('\')+'\'+$file.path.Replace('/','\'))
        if ((Get-OreLongLength $Directory $path) -ne $file.bytes -or (Get-OreLongHash $Directory $path) -cne $file.sha256) { throw 'Package file checksum mismatch.' }
    }
    $files = @(Get-OreLongFiles $Directory)
    if ($files.Count -ne $records.Count+1) { throw 'Unlisted package files.' }
}
function Get-OrePackageHelper([string]$HomePath) {
    # Protocol-1 source updaters never regain control of a package installation.
    foreach ($pointer in @('current','recovery/current')) {
        $selection = Get-OreSelection $HomePath $pointer
        if (!$selection) { continue }
        $tools = if ($pointer -eq 'current') { Join-Path $selection.Application 'scripts/release' } else { Join-Path $HomePath ('recovery/'+$selection.Id) }
        $protocol = Assert-OrePath $HomePath (Join-Path $tools 'windows-package-protocol')
        if (![IO.File]::Exists($protocol)) { continue }
        if ([IO.File]::ReadAllText($protocol).Trim() -cne '2') { throw 'Unsupported installed package protocol.' }
        $complete = $true
        foreach ($name in @('windows-package-launcher.ps1','portable-launch.mjs','application-start.mjs','database-location.mjs','check-database.mjs','selection.mjs','application-assets.mjs','launcher-lock.mjs','launcher-messages.mjs','launcher-messages.json','windows-install-verify.mjs')) {
            $path = Assert-OrePath $HomePath (Join-Path $tools $name)
            try {
                if (![IO.File]::Exists($path) -or !(New-Object IO.FileInfo $path).Length) { $complete = $false; break }
                $readable = [IO.File]::OpenRead($path); $readable.Dispose()
            } catch [IO.IOException] { $complete = $false; break } catch [UnauthorizedAccessException] { $complete = $false; break }
        }
        if (!$complete) { continue }
        $helper = Join-Path $tools 'windows-package-launcher.ps1'
        $tokens = $null; $errors = $null
        try { [Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$errors) | Out-Null }
        catch [IO.IOException] { continue } catch [UnauthorizedAccessException] { continue }
        if (!$errors.Count) { return $helper }
    }
    return $null
}
