# Windows PowerShell 5.1 archive policy, also embedded in the standalone asset.
$OreSourceInputs = @('build-portable.ps1','package.json','package-lock.json','tsconfig.json','tsconfig.server.json','vite.config.ts','vitest.config.ts','playwright.config.ts','index.html','src','public','migrations','scripts/release','LICENSE','docs/RELEASES.md')
function Assert-OrePath([string]$Root, [string]$Path) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $full = [IO.Path]::GetFullPath($Path)
    if (!$full.Equals($rootPath,[StringComparison]::OrdinalIgnoreCase) -and !$full.StartsWith($rootPath+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Managed path escapes installation.' }
    $cursor = $full
    while ($cursor) {
        # GetAttributes also detects dangling reparse points, unlike Test-Path.
        try { $attributes = [IO.File]::GetAttributes($cursor) }
        catch [IO.FileNotFoundException] { $attributes = 0 }
        catch [IO.DirectoryNotFoundException] { $attributes = 0 }
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in managed path.' }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}
function Assert-OreTree([string]$Root) {
    Assert-OrePath $Root $Root | Out-Null
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Root)) {
        Assert-OrePath $Root $entry | Out-Null
        if ([IO.Directory]::Exists($entry)) { Assert-OreTree $entry }
    }
}
function Expand-OreZip([string]$Archive, [string]$ExpectedRoot, [string]$Destination, [switch]$Source) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Assert-OrePath $Destination $Destination | Out-Null
    if ([IO.Directory]::Exists($Destination) -or [IO.File]::Exists($Destination)) { throw 'Extraction destination must be new.' }
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $files = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $entries = New-Object 'Collections.Generic.List[IO.Compression.ZipArchiveEntry]'
        [long]$total = 0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            $directory = $name.EndsWith('/')
            $parts = $name.TrimEnd('/').Split('/')
            if ($parts.Count -lt 1 -or $parts[0] -cne $ExpectedRoot -or $name.Length -gt 240 -or $name.EndsWith('//')) { throw ('Unexpected ZIP root/path length: '+$name) }
            foreach ($part in $parts) {
                if (!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[\\:<>"|?*~\x00-\x1f]' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match '^(?i:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)') { throw 'Unsafe Windows ZIP name.' }
            }
            $kind = (($entry.ExternalAttributes -shr 16) -band 0xf000)
            if (($kind -ne 0 -and $kind -ne 0x8000 -and $kind -ne 0x4000) -or ($entry.ExternalAttributes -band 0x400) -or ($kind -eq 0x4000 -and !$directory) -or ($kind -eq 0x8000 -and $directory)) { throw 'Unsupported ZIP entry type.' }
            $key = $parts -join '/'
            if (!$seen.Add($key)) { throw 'Duplicate/case-equivalent ZIP entry.' }
            if (!$directory) { $files.Add($key) | Out-Null }
            $total += $entry.Length
            if ($total -gt 2GB -or $zip.Entries.Count -gt 100000 -or ($directory -and $entry.Length -ne 0)) { throw 'ZIP extraction bounds exceeded.' }
            $entries.Add($entry)
        }
        if (!$entries.Count) { throw 'Empty ZIP.' }
        foreach ($key in $seen) {
            $ancestor = $key
            while ($ancestor.Contains('/')) {
                $ancestor = $ancestor.Substring(0,$ancestor.LastIndexOf('/'))
                if ($files.Contains($ancestor)) { throw 'ZIP file/directory collision.' }
            }
        }
        # The complete listing has passed before the first output is created.
        [IO.Directory]::CreateDirectory($Destination) | Out-Null
        foreach ($entry in $entries) {
            $relative = $entry.FullName.Substring($ExpectedRoot.Length).TrimStart('/')
            if (!$relative) { continue }
            if ($Source) {
                $allowed = $false
                foreach ($inputPath in $OreSourceInputs) {
                    if ($relative -ceq $inputPath -or $relative.StartsWith($inputPath+'/',[StringComparison]::Ordinal)) { $allowed = $true; break }
                }
                if (!$allowed) { continue }
            }
            $target = Assert-OrePath $Destination (Join-Path $Destination $relative.Replace('/','\'))
            if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            $inputStream = $entry.Open()
            $outputStream = [IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
        if ($Source) {
            foreach ($inputPath in $OreSourceInputs) {
                if (!(Test-Path -LiteralPath (Join-Path $Destination $inputPath))) { throw ('Missing archive build input: '+$inputPath) }
            }
        }
    } finally { $zip.Dispose() }
}
