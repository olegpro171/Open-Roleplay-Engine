param([ValidateSet('Release','Development')][string]$Mode, [string]$Commit, [string]$Destination)
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'scripts/release/windows-common.ps1')
    if (!$Mode -or !$Destination) { throw 'Usage: build-portable.ps1 -Mode Release -Commit FULL_COMMIT -Destination DIRECTORY | -Mode Development -Destination DIRECTORY' }
    if (![Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This builder targets Windows x64 only. Use 64-bit Windows PowerShell.' }
    $source = $PSScriptRoot
    if ($Mode -eq 'Development') { $Commit = (Invoke-Native git @('-C',$source,'rev-parse','HEAD')).Trim() }
    if ($Mode -eq 'Release') {
        if ($Commit -cnotmatch '^[0-9a-f]{40}$') { throw 'Release requires the exact full checked-out commit.' }
        if (Invoke-Native git @('-C',$source,'status','--porcelain','--untracked-files=all')) { throw 'Release source must be clean, including untracked files.' }
        if ($Commit -cne (Invoke-Native git @('-C',$source,'rev-parse','HEAD')).Trim()) { throw 'Release requires the exact full checked-out commit.' }
        Invoke-Native git @('-C',$source,'merge-base','--is-ancestor',$Commit,'main')
    }
    if ([IO.Path]::GetFullPath($Destination) -eq $source) { throw 'Use a separate installation directory.' }
    $installation = Initialize-OreHome $Destination
    Initialize-OreJob
    $lock = Join-Path $installation 'cache/build.lock'
    # New-Item -Force would silently accept an existing lock.
    New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
    $stage = Join-Path $installation ('cache/build-' + [guid]::NewGuid())
    try {
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        $version = (([IO.File]::ReadAllText((Join-Path $source 'scripts/release/runtime.conf')) -split 'ORE_NODE_VERSION=')[1]).Trim()
        $runtime = 'node-v' + $version + '-win-x64'
        $runtimeId = 'node-v' + $version + '-win32-x64'
        $archive = $runtime + '.zip'
        $pin = [IO.File]::ReadAllLines((Join-Path $source 'scripts/release/node-SHASUMS256.txt')) | Where-Object { ($_ -split '\s+')[1] -eq $archive }
        if (@($pin).Count -ne 1) { throw 'Pinned Windows runtime checksum is missing.' }
        $expected = ($pin -split '\s+')[0]
        $download = Join-Path $installation ('cache/' + $archive)
        Write-Host ("[Build 1/6] Preparing ORE's private Node.js " + $version + ' runtime...')
        if (!(Test-Path -LiteralPath $download)) {
            Write-Host '[Build 1/6] Downloading the official runtime. This may take a few minutes...'
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/v' + $version + '/' + $archive) -OutFile (Join-Path $stage 'runtime.part') -TimeoutSec 600
            if ((Get-OreHash (Join-Path $stage 'runtime.part')) -ne $expected) { throw 'Runtime checksum mismatch; nothing activated.' }
            Move-Item -LiteralPath (Join-Path $stage 'runtime.part') -Destination $download
        }
        Write-Host '[Build 1/6] Verifying the runtime download...'
        if ((Get-OreHash $download) -ne $expected) { throw 'Cached runtime checksum mismatch. Remove only that archive and retry.' }
        $runtimeDirectory = Join-Path $installation ('runtime/' + $runtimeId)
        if (!(Test-Path -LiteralPath $runtimeDirectory)) {
            Write-Host '[Build 1/6] Unpacking the private runtime...'
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::ExtractToDirectory($download, $stage)
            Move-Item -LiteralPath (Join-Path $stage $runtime) -Destination $runtimeDirectory
        } else { Write-Host '[Build 1/6] Reusing the runtime already installed for ORE.' }
        $node = Join-Path $runtimeDirectory 'node.exe'
        $npm = Join-Path $runtimeDirectory 'node_modules/npm/bin/npm-cli.js'
        if ((Invoke-Native $node @('--version')).Trim() -ne ('v' + $version)) { throw 'Private runtime version differs; restore it from the verified archive.' }
        $env:PATH = $runtimeDirectory + ';' + $env:PATH
        Get-ChildItem Env: | Where-Object { $_.Name -match '^npm_config_' } | ForEach-Object { Remove-Item ('Env:' + $_.Name) }
        $env:npm_config_cache = Join-Path $installation 'cache/npm'
        $env:npm_config_userconfig = Join-Path $stage 'npmrc'
        $env:npm_config_globalconfig = Join-Path $stage 'global-npmrc'
        Write-Utf8 $env:npm_config_userconfig ''
        Write-Utf8 $env:npm_config_globalconfig ''
        $env:npm_config_update_notifier = 'false'
        $env:npm_config_audit = 'false'
        $env:npm_config_fund = 'false'
        $env:npm_config_ignore_scripts = 'true'
        $env:SHARP_IGNORE_GLOBAL_LIBVIPS = '1'
        $work = Join-Path $stage 'source'
        [IO.Directory]::CreateDirectory($work) | Out-Null
        $inputs = @('package.json','package-lock.json','tsconfig.json','tsconfig.server.json','vite.config.ts','vitest.config.ts','playwright.config.ts','index.html','src','public','migrations','scripts/release','docs/RELEASES.md','docs/RELEASE_IMPLEMENTATION_BRIEF.md','docs/RELEASE_VERIFICATION.md','docs/WINDOWS_RELEASE_HANDOFF.md','docs/WINDOWS_RELEASE_VERIFICATION.md','docs/TEST_RELEASE.md')
        if ($Mode -eq 'Release') {
            $export = Join-Path $stage 'source.zip'
            Invoke-Native git (@('-C',$source,'archive','--format=zip',('--output=' + $export),$Commit,'--') + $inputs)
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::ExtractToDirectory($export,$work)
        } else {
            foreach ($inputPath in $inputs) {
                $target = Join-Path $work $inputPath
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
                Copy-Item -LiteralPath (Join-Path $source $inputPath) -Destination $target -Recurse
            }
        }
        Push-Location -LiteralPath $work
        try {
            Write-Host '[Build 2/6] Installing the packages needed to build ORE. Downloads may take a few minutes...'
            Invoke-Native $node @($npm,'ci','--include=dev','--include=optional','--ignore-scripts')
            Write-Host '[Build 3/6] Checking database/image support, then building the interface and server...'
            Invoke-Native $node @('scripts/release/native-smoke.mjs')
            Invoke-Native $node @($npm,'--silent','run','build')
            Write-Host '[Build 4/6] Collecting third-party licenses and notices...'
            $notices = Join-Path $stage 'notices'
            Invoke-Native $node @('scripts/release/stage.mjs','notices',$work,$notices)
            Write-Host '[Build 5/6] Preparing the packages needed to run the finished app...'
            Invoke-Native $node @($npm,'ci','--omit=dev','--include=optional','--ignore-scripts','--prefer-offline')
            $stageMode = if ($Mode -eq 'Release') { '--release' } else { '--development' }
            Write-Host '[Build 6/6] Staging and verifying the new app before activation...'
            Invoke-Native $node @('scripts/release/stage.mjs','install',$work,$installation,$stageMode,$Commit,$runtimeId,$expected,$notices)
        } finally { Pop-Location }
        Write-Host ('ORE installed: ' + $installation + '. Start start-app.bat; Ctrl+C stops ORE.')
    } finally {
        # Both paths are fixed children of the resolved ORE cache; no caller
        # supplied path is recursively removed.
        if ($stage -and $stage.StartsWith((Join-Path $installation 'cache/'),[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Continue }
        Remove-Item -LiteralPath $lock -Force -ErrorAction Continue
    }
    exit 0
} catch { [Console]::Error.WriteLine('ORE build: ' + $_.Exception.Message); exit 1 }
