# Shared by the generated external/helper entries and archive builder.
function Initialize-OreCancellation {
    if ('OreCancellation' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class OreCancellation {
    static readonly CancellationTokenSource source = new CancellationTokenSource();
    delegate bool Handler(uint type);
    static readonly Handler handler = Handle;
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetConsoleCtrlHandler(Handler callback,bool add);
    public static CancellationToken Token { get { return source.Token; } }
    public static bool IsCancelled { get { return source.IsCancellationRequested; } }
    static bool Handle(uint type) {
        if (type != 0 && type != 1) return false;
        source.Cancel();
        return true;
    }
    public static void Attach() {
        // Register after PowerShell's host handler. Console.CancelKeyPress alone
        // can be bypassed by the host's earlier native pipeline-cancel handler.
        if (!SetConsoleCtrlHandler(handler,true)) throw new System.ComponentModel.Win32Exception();
    }
}
'@
    [OreCancellation]::Attach()
}
function Test-OreCancellation {
    return ('OreCancellation' -as [type]) -and [OreCancellation]::IsCancelled
}
function Set-OrePrivate([string]$Path) {
    Assert-OrePath $Path $Path | Out-Null
    $acl = [IO.Directory]::GetAccessControl($Path,[Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    [IO.Directory]::SetAccessControl($Path,$acl)
}
function Initialize-OreStandaloneHome([string]$Path) {
    $full = Assert-OrePath $Path $Path
    $marker = Join-Path $full '.ore-installation'
    if (Test-Path -LiteralPath $full) {
        if (![IO.Directory]::Exists($full)) { throw 'folderCollision' }
        Assert-OrePath $full $marker | Out-Null
        if (![IO.File]::Exists($marker) -or [IO.File]::ReadAllText($marker).Trim() -cne 'ORE-installation:1') { throw 'folderCollision' }
    } else {
        # Refuse preexisting content; mark the partial installation immediately.
        New-Item -ItemType Directory -Path $full -ErrorAction Stop | Out-Null
        $stream = [IO.File]::Open($marker,[IO.FileMode]::CreateNew)
        try { $bytes = [Text.Encoding]::ASCII.GetBytes("ORE-installation:1`n"); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    }
    foreach ($name in @('cache','cache/npm','logs','app','runtime','recovery','data','languages')) {
        $target = Assert-OrePath $full (Join-Path $full $name)
        if ([IO.File]::Exists($target)) { throw 'folderCollision' }
    }
    foreach ($name in @('current','working','previous','recovery/current','.env','updates-paused')) {
        $target = Assert-OrePath $full (Join-Path $full $name)
        if ([IO.Directory]::Exists($target)) { throw 'folderCollision' }
    }
    Set-OrePrivate $full
    foreach ($name in @('cache','logs','app','runtime','recovery','data','languages')) { [IO.Directory]::CreateDirectory((Join-Path $full $name)) | Out-Null }
    return $full
}
function Clear-OreInjection {
    foreach ($entry in @(Get-ChildItem Env:)) {
        if ($entry.Name -match '^(NODE_.*|NPM_.*|npm_config_.*|GYP_.*|SHARP_.*|ORE_LAUNCH_.*|ORE_SNAPSHOT_.*|ORE_DATABASE_.*|ORE_WINDOWS_BUILD_EVENTS)$') { [Environment]::SetEnvironmentVariable($entry.Name,$null,'Process') }
    }
}
function Import-OreStandaloneEnvironment([string]$Path) {
    $number = 0
    foreach ($raw in [IO.File]::ReadAllLines($Path,[Text.Encoding]::UTF8)) {
        $number++
        $line = $raw.Trim()
        if (!$line -or $line.StartsWith('#')) { continue }
        $script:OreEnvLine = $number
        if ($line -cnotmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { throw 'invalidEnv' }
        $key = $Matches[1]; $value = $Matches[2]
        if ($key -match '^(?i:ore_.*|PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|TEMP|TMP|PSMODULEPATH|PSHOME|__PS.*)$' -and $key -notmatch '^(?i:ORE_SKIP_UPDATE|ORE_OPEN_BROWSER|ORE_NO_PAUSE)$') { throw 'invalidEnv' }
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) { $value = $value.Substring(1,$value.Length-2) }
        if (!(Test-Path -LiteralPath ('Env:'+$key))) {
            if ($key -ieq 'ROLEPLAY_DATABASE' -and [string]::IsNullOrWhiteSpace($value)) { throw 'invalidEnv' }
            [Environment]::SetEnvironmentVariable($key,$value,'Process')
        }
    }
}
function Get-OreSelection([string]$HomePath, [string]$Pointer = 'current') {
    $path = Assert-OrePath $HomePath (Join-Path $HomePath $Pointer)
    if (![IO.File]::Exists($path)) { return $null }
    $lines = [IO.File]::ReadAllLines($path,[Text.Encoding]::UTF8)
    if ($lines.Count -ne 2 -or $lines[0] -cnotmatch '^(release|dev)-[a-z0-9-]+$' -or $lines[1] -cnotmatch '^node-v[0-9.]+-win32-x64$') { throw 'Invalid application/runtime selection.' }
    $application = Assert-OrePath $HomePath (Join-Path $HomePath ('app/'+$lines[0]))
    $node = Assert-OrePath $HomePath (Join-Path $HomePath ('runtime/'+$lines[1]+'/node.exe'))
    return @{Id=$lines[0]; Runtime=$lines[1]; Application=$application; Node=$node}
}
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
function Get-OreHttps([string]$Url, [string]$Output, [int]$Seconds = 60) {
    # HttpClient bounds the whole transfer (including headers/body); redirects
    # are followed explicitly and may only stay on the expected HTTPS hosts.
    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object Net.Http.HttpClient $handler
    $client.Timeout = [TimeSpan]::FromSeconds($Seconds)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('ORE-launcher/1')
    $cancel = if ('OreCancellation' -as [type]) { [Threading.CancellationTokenSource]::CreateLinkedTokenSource([OreCancellation]::Token) } else { New-Object Threading.CancellationTokenSource }
    $cancel.CancelAfter([TimeSpan]::FromSeconds($Seconds))
    $response = $null
    try {
        $uri = [Uri]$Url
        for ($redirect = 0; $redirect -le 5; $redirect++) {
            if ($uri.Scheme -cne 'https' -or $uri.UserInfo -or $uri.Host -notin @('api.github.com','github.com','codeload.github.com','nodejs.org')) { throw 'Unapproved download redirect.' }
            $response = $client.GetAsync($uri,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancel.Token).GetAwaiter().GetResult()
            if ([int]$response.StatusCode -in @(301,302,303,307,308)) {
                $uri = New-Object Uri $uri,$response.Headers.Location
                $response.Dispose(); $response = $null
                continue
            }
            $response.EnsureSuccessStatusCode() | Out-Null
            $limit = if ($uri.Host -eq 'api.github.com') { 1MB } else { 512MB }
            if ($response.Content.Headers.ContentLength -gt $limit) { throw 'Download bound exceeded.' }
            $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $outputStream = [IO.File]::Open($Output,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try {
                $buffer = New-Object byte[] 65536
                [long]$total = 0
                while (($count = $inputStream.ReadAsync($buffer,0,$buffer.Length,$cancel.Token).GetAwaiter().GetResult()) -gt 0) {
                    $total += $count
                    if ($total -gt $limit) { throw 'Download bound exceeded.' }
                    $outputStream.Write($buffer,0,$count)
                }
                if ($null -ne $response.Content.Headers.ContentLength -and $total -ne $response.Content.Headers.ContentLength) { throw 'Truncated download.' }
            } finally { $outputStream.Dispose(); $inputStream.Dispose() }
            return
        }
        throw 'Redirect limit exceeded.'
    } finally { if ($response) { $response.Dispose() }; $cancel.Dispose(); $client.Dispose(); $handler.Dispose() }
}
function ConvertTo-OreArgument([string]$Value) {
    # CommandLineToArgvW quoting; paths are never evaluated as shell source.
    return '"'+[regex]::Replace([regex]::Replace($Value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'
}
function Read-OreBuildEvents([string]$Path) {
    # Readers must permit the stage writer to open/append while polling. Bound
    # the bytes actually read, including an append racing the initial read.
    $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    try {
        $buffer = New-Object byte[] 129
        $length = 0
        while ($length -lt $buffer.Length) {
            $count = $stream.Read($buffer,$length,$buffer.Length-$length)
            if ($count -eq 0) { break }
            $length += $count
        }
        if ($length -gt 128) { throw 'Oversized build event.' }
        return [Text.Encoding]::UTF8.GetString($buffer,0,$length)
    } finally { $stream.Dispose() }
}
function Get-OreCompletedBuildEvents([string]$Text) {
    # An append may be observed mid-line. Only complete frames can advance the
    # presenter, and polling/final reads enforce the same ordered protocol.
    $complete = $Text.Substring(0,$Text.LastIndexOf("`n")+1)
    $events = @($complete.Split("`n") | Where-Object { $_ })
    $expected = @('checkingVersion','activatingVersion')
    for ($index = 0; $index -lt $events.Count; $index++) {
        if ($index -ge $expected.Count -or $events[$index] -cne $expected[$index]) { throw 'Unexpected build phase.' }
    }
    return $events
}
function Invoke-OreProcess([string]$Executable, [string[]]$Arguments, [string]$Report, [switch]$Console, [string]$PhaseFile) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = (($Arguments | ForEach-Object { ConvertTo-OreArgument $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = !$Console
    $start.RedirectStandardOutput = !$Console
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    $started = $false
    $outputs = @(); $tasks = @(); $paths = @()
    try {
        if (!$process.Start()) { throw 'Could not start owned process.' }
        $started = $true
        $streams = @($process.StandardError.BaseStream)
        if (!$Console) { $streams += $process.StandardOutput.BaseStream }
        foreach ($stream in $streams) {
            $path = Join-Path ([IO.Path]::GetDirectoryName($Report)) ('tool-'+[guid]::NewGuid()+'.tmp')
            $outputStream = [IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
            $paths += $path; $outputs += $outputStream; $tasks += $stream.CopyToAsync($outputStream)
        }
        $phase = 0
        do {
            if (Test-OreCancellation) { throw (New-Object OperationCanceledException 'Launcher cancelled.') }
            if ($PhaseFile -and [IO.File]::Exists($PhaseFile)) {
                $eventText = Read-OreBuildEvents $PhaseFile
                $events = @(Get-OreCompletedBuildEvents $eventText)
                while ($phase -lt $events.Count) {
                    Show-OreMessage $events[$phase]
                    $phase++
                }
            }
            foreach ($task in $tasks) { if ($task.IsFaulted) { $task.GetAwaiter().GetResult() | Out-Null } }
        } while (!$process.WaitForExit(100))
        foreach ($task in $tasks) { $task.GetAwaiter().GetResult() | Out-Null }
        # Read final phases after the process and its output have drained.
        if ($PhaseFile) {
            $finalEvents = Read-OreBuildEvents $PhaseFile
            foreach ($id in @(Get-OreCompletedBuildEvents $finalEvents) | Select-Object -Skip $phase) {
                Show-OreMessage $id
                $phase++
            }
            if ($process.ExitCode -eq 0 -and $finalEvents -cne "checkingVersion`nactivatingVersion`n") { throw 'Incomplete build event sequence.' }
            if ($process.ExitCode -ne 0 -and $finalEvents.Contains('activatingVersion')) { $script:OreFailure = 'activationFailed' }
        }
        return $process.ExitCode
    } finally {
        # Never leave workers running after presenter/log/phase failure.
        if ($started -and !$process.HasExited) {
            if ($Console -and (Test-OreCancellation)) { $process.WaitForExit(5000) | Out-Null }
            if (!$process.HasExited) { $process.Kill(); $process.WaitForExit() }
        }
        foreach ($task in $tasks) { try { $task.GetAwaiter().GetResult() | Out-Null } catch { } }
        foreach ($outputStream in $outputs) { $outputStream.Dispose() }
        foreach ($path in $paths) {
            $log = [IO.File]::Open($Report,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
            $inputStream = [IO.File]::OpenRead($path)
            try { $inputStream.CopyTo($log) } finally { $inputStream.Dispose(); $log.Dispose() }
            [IO.File]::Delete($path)
        }
        $process.Dispose()
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
