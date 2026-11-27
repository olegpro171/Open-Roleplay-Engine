# Interactive screens live in the external batch, independent of the selected app.
function New-OreChoice([string]$Label, [string]$Action, $Value = $null, [switch]$Disabled, [string[]]$Columns) {
    return @{Label=$Label; Action=$Action; Value=$Value; Disabled=$Disabled.IsPresent; Columns=$Columns}
}
function Format-OreVersionRows([array]$Choices) {
    $rows = @($Choices | Where-Object { $_.Columns })
    if (!$rows.Count) { return }
    $widths = New-Object 'int[]' $rows[0].Columns.Count
    foreach ($row in $rows) {
        for ($i=0; $i -lt $widths.Length; $i++) {
            $widths[$i] = [Math]::Max($widths[$i],$row.Columns[$i].Length)
        }
    }
    foreach ($row in $rows) {
        $last = $widths.Length-1
        while ($last -gt 0 -and !$row.Columns[$last]) { $last-- }
        $fields = for ($i=0; $i -le $last; $i++) {
            if ($i -eq $last) { $row.Columns[$i] }
            elseif ($widths[$i]) { ([string]$row.Columns[$i]).PadRight($widths[$i]) }
        }
        $row.Label = $fields -join '  ·  '
    }
}
function Read-OreMenuKey { return [Console]::ReadKey($true).Key }
function Test-OreMenuKey { return [Console]::KeyAvailable }
function Read-OreChoice([string]$Title, [string]$Primary, [array]$Choices, [string]$Notice = '', [int]$Focus = 0, [int]$AutoStartSeconds = 0, $Refresh) {
    $t = $script:OreTerminal
    $seconds = $AutoStartSeconds
    $clock = $null
    $hideCursor = $t -and ![Console]::IsOutputRedirected -and [Console]::CursorVisible
    try {
        if ($hideCursor) { [Console]::CursorVisible=$false }
        while ($true) {
            try { $count = [Math]::Max(1,[Math]::Min(9,[Console]::WindowHeight-10)) }
            catch [IO.IOException] { $count = 9 }
            $first = [Math]::Max(0,$Focus-$count+1)
            $labels = @($Choices | Select-Object -Skip $first -First $count | ForEach-Object { $_.Label })
            if ($seconds) { $labels[0] = Get-OreMessage 'menuStartCountdown' @{seconds=$seconds} }
            $hint = $Notice
            if (!$hint -and $Choices[$Focus].Action -eq 'database') { $hint = Get-OreMessage 'menuDatabaseHint' }
            if ($t) {
                $t.Title=$Title; $t.Role='accent'; $t.Symbol='◇'; $t.Primary=$Primary
                $t.Notice=$hint; $t.Log=''; $t.Update=''; $t.Footer=Get-OreMessage 'menuKeys'
                $t.Choices=$labels; $t.Focus=$Focus-$first
                Write-OreTerminalPanel
            } else {
                [Console]::WriteLine((Get-OreMessage $Title))
                if ($Primary) { [Console]::WriteLine($Primary) }
                if ($hint) { [Console]::WriteLine($hint) }
                for ($i=0; $i -lt $labels.Count; $i++) {
                    $prefix = if ($i+$first -eq $Focus) { '> ' } else { '  ' }
                    [Console]::WriteLine($prefix+$labels[$i])
                }
                [Console]::WriteLine((Get-OreMessage 'menuKeys'))
            }
            if ($seconds) {
                if (!$clock) { $clock = [Diagnostics.Stopwatch]::StartNew() }
                $shown = $seconds
                while (!(Test-OreMenuKey) -and $seconds -eq $shown) {
                    Start-Sleep -Milliseconds 40
                    $seconds = [Math]::Max(0,$AutoStartSeconds-[int][Math]::Floor($clock.Elapsed.TotalSeconds))
                }
                if (!(Test-OreMenuKey)) {
                    if (!$seconds) { return $Choices[0] }
                    continue
                }
                $seconds = 0
            }
            if ($Refresh) {
                while (!(Test-OreMenuKey)) {
                    if ($Refresh.Wait(80)) { return (New-OreChoice '' 'refresh' $Focus) }
                }
            }
            switch (Read-OreMenuKey) {
                'UpArrow'   { $Focus = ($Focus+$Choices.Count-1) % $Choices.Count }
                'DownArrow' { $Focus = ($Focus+1) % $Choices.Count }
                'Escape'    { return (New-OreChoice '' 'back') }
                'Enter'     { if (!$Choices[$Focus].Disabled) { return $Choices[$Focus] } }
            }
        }
    } finally {
        try {
            if ($t) { Clear-OreTerminalPanel; $t.Choices=$null; $t.Footer=''; $t.Notice=''; $t.Primary='' }
        } finally { if ($hideCursor) { [Console]::CursorVisible=$true } }
    }
}

function Get-OreMenuSelection([string]$Pointer = 'current') {
    try { Get-OreSelection $Installation $Pointer }
    catch { if ($script:OreReport) { Write-OreDiagnostic $_.Exception.Message } }
}
function Get-OreInstalledName([string]$Commit) {
    if ($Commit -cnotmatch '^[a-f0-9]{40}\z') { return }
    try {
        $path = Assert-OrePath $Installation (Join-Path $Installation ('cache/release-name-'+$Commit))
        if ([IO.File]::Exists($path) -and (New-Object IO.FileInfo $path).Length -le 4KB) {
            $name = ([IO.File]::ReadAllText($path) -replace '[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]',' ').Trim()
            if ($name) { return $name }
        }
    } catch { if ($script:OreReport) { Write-OreDiagnostic $_.Exception.Message } }
    return $Commit.Substring(0,12)
}
function Get-OreVersionSummary {
    $current = Get-OreMenuSelection
    if (!$current) {
        if ([IO.File]::Exists((Join-Path $Installation 'current'))) { return (Get-OreMessage 'menuNoSelection') }
        return (Get-OreMessage 'menuFirst')
    }
    $version = $current.Id -replace '^release-','' -replace '^([a-f0-9]{12})-.*$','$1'
    try {
        $info = Read-OreJson (Assert-OrePath $Installation (Join-Path $current.Application 'build-info.json')) 16KB
        if ($info.commit -cmatch '^[a-f0-9]{40}\z') { $version = Get-OreInstalledName $info.commit }
    } catch { if ($script:OreReport) { Write-OreDiagnostic $_.Exception.Message } }
    $mode = if ([IO.File]::Exists((Join-Path $Installation 'updates-paused'))) { 'menuFixed' } else { 'menuLatest' }
    return ((Get-OreMessage $mode)+'  ·  '+$version)
}

function Get-OreLocalVersions {
    $directory = Assert-OrePath $Installation (Join-Path $Installation 'app')
    if (![IO.Directory]::Exists($directory)) { return }
    $prepared = Get-OreMenuSelection 'cache/prepared-update/current'
    foreach ($path in [IO.Directory]::EnumerateDirectories($directory)) {
        $id = [IO.Path]::GetFileName($path)
        if ($id -cnotmatch '^release-[a-z0-9-]+$') { continue }
        try {
            $info = Read-OreJson (Assert-OrePath $Installation (Join-Path $path 'build-info.json')) 16KB
            if ($info.kind -cne 'release' -or $info.platform -cne 'win32' -or $info.arch -cne 'x64' -or
                $info.commit -cnotmatch '^[a-f0-9]{40}$' -or $info.node -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { continue }
            $runtime = 'node-v'+$info.node+'-win32-x64'
            $minimum = 0
            $file = Assert-OrePath $Installation (Join-Path $path 'scripts/release/windows-launcher-version.mjs')
            if ([IO.File]::Exists($file)) {
                if ((New-Object IO.FileInfo $file).Length -gt 16KB) { continue }
                if ([IO.File]::ReadAllText($file) -cnotmatch '(?m)^export const minimumLauncherVersion = ([0-9]+);') { continue }
                $minimum = [int]$Matches[1]
            }
            if ($prepared.Id -ceq $id) {
                $receipt = Assert-OrePath $Installation (Join-Path $Installation 'cache/prepared-update')
                Assert-OreLongTree $receipt
                $minimum = [Math]::Max($minimum,(Read-OrePreparedMinimumLauncherVersion $receipt))
            }
            @{Id=$id; Commit=$info.commit; Runtime=$runtime; Application=$path; MinimumLauncherVersion=$minimum;
              Node=(Assert-OrePath $Installation (Join-Path $Installation ('runtime/'+$runtime+'/node.exe')))}
        } catch { Write-OreDiagnostic ('Cannot list installed version '+$id+': '+$_.Exception.Message) }
    }
}

function Test-OreFixedVersion($Candidate, [string]$Stage) {
    $script:OreFailure = 'verificationFailed'
    $tools = Join-Path $Candidate.Application 'scripts/release'
    Test-OreInstalled $Candidate $tools
    $info = Read-OreJson (Join-Path $Candidate.Application 'build-info.json') 16KB
    $probe = Join-Path $Stage 'verify-fixed.mjs'
    [IO.File]::WriteAllText($probe,$OreVersionProbe,(New-Object Text.UTF8Encoding $false))
    $status = Invoke-OreProcess $Candidate.Node @($probe,$Installation,$Candidate.Application,[string]$info.schema) $script:OreReport
    if ($status -eq 2) { $script:OreFailure='menuDatabaseBlocked' }
    if ($status -ne 0) { throw 'Fixed version preflight failed.' }
}

function Set-OreFixedSelection([scriptblock]$Publish) {
    # Every package helper recognizes this pause, including after an interrupted switch.
    $marker = Assert-OrePath $Installation (Join-Path $Installation 'updates-paused')
    $alreadyPaused = [IO.File]::Exists($marker)
    $currentFile = Assert-OrePath $Installation (Join-Path $Installation 'current')
    $before = Read-OrePointerBytes $currentFile
    if (!$alreadyPaused) { [IO.File]::Open($marker,[IO.FileMode]::CreateNew).Dispose() }
    try { & $Publish }
    catch {
        if (!$alreadyPaused -and $before -ceq (Read-OrePointerBytes $currentFile)) { [IO.File]::Delete($marker) }
        throw
    }
}
function Read-OrePointerBytes([string]$Path) {
    if (![IO.File]::Exists($Path)) { return }
    # A damaged pointer can still be replaced. Every committed selection fits
    # within 512 bytes, so this sentinel also distinguishes a successful write.
    if ((New-Object IO.FileInfo $Path).Length -gt 512) { return '<oversized>' }
    return [Convert]::ToBase64String([IO.File]::ReadAllBytes($Path))
}
function Set-OreInstalledVersion($Candidate, [string]$Stage) {
    if ($Candidate.MinimumLauncherVersion -gt $LauncherVersion) { throw 'Incompatible installed version.' }
    if (!(Get-OrePackageHelper $Installation @('current') $Candidate)) { throw 'Installed helper is unavailable.' }
    Test-OreFixedVersion $Candidate $Stage
    $working = Get-OreMenuSelection 'working'
    Set-OreFixedSelection {
        if ($working -and $working.Id -cne $Candidate.Id) { Write-OreVersionSelection $working 'previous' $Stage }
        Write-OreVersionSelection $Candidate 'current' $Stage
    }
}
function Write-OreVersionSelection($Selection, [string]$Pointer, [string]$Stage) {
    $temp = Join-Path $Stage $Pointer
    # The installed Node readers use LF on every OS.
    [IO.File]::WriteAllText($temp,(@($Selection.Id,$Selection.Runtime,'') -join [char]10),(New-Object Text.UTF8Encoding $false))
    $path = Assert-OrePath $Installation (Join-Path $Installation $Pointer)
    if ([IO.File]::Exists($path)) { [IO.File]::Replace($temp,$path,[NullString]::Value) }
    else { [IO.File]::Move($temp,$path) }
}
function Get-OreReleasePage([string]$Stage, [int]$Page, [string[]]$InstalledCommits, $NamesReady) {
    $file = Join-Path $Stage 'releases.json'
    Get-OreHttps ('https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/releases?per_page=5&page='+$Page) $file 12
    # Windows PowerShell preserves the outer JSON array as a single object.
    $records = Read-OreJson $file
    if ($records -isnot [array] -or $records.Count -gt 5) { throw 'Invalid release page.' }
    foreach ($release in $records) { Save-OreReleaseName $Installation $release $Stage }
    # Retained builds may predate this page. Resolve their exact tags once on entry.
    foreach ($commit in $InstalledCommits) {
        $tag = 'build-'+$commit
        if ($commit -cnotmatch '^[a-f0-9]{40}\z' -or $records.tag_name -ccontains $tag) { continue }
        try {
            $older = Join-Path $Stage ($tag+'-metadata.json')
            Get-OreHttps ('https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/releases/tags/'+$tag) $older 8
            $release = Read-OreJson $older
            if ($release.tag_name -ceq $tag) { Save-OreReleaseName $Installation $release $Stage }
        } catch {
            if ($script:OreCatalogueStop.IsCancellationRequested) { throw }
            Write-OreDiagnostic ('Cannot refresh release title for '+$tag+': '+$_.Exception.Message)
        }
    }
    if ($NamesReady) { $NamesReady.Set() }
    foreach ($release in $records) {
        if ($release.draft -ne $false) { continue }
        $name = Get-OreReleaseName $release
        $date = if ($release.published_at -match '^(\d{4}-\d{2}-\d{2})T') { $Matches[1] } else { '' }
        $descriptor = $null
        $status = 'menuUnsupported'
        if ($release.tag_name -cmatch '^build-[a-f0-9]{40}$' -and $release.prerelease -eq $false) {
            try {
                $descriptor = Read-OreReleaseDescriptor $Stage $release
                $status = if ($descriptor.MinimumLauncherVersion -gt $LauncherVersion) { 'menuNewer' } else { 'menuAvailable' }
            } catch {
                if ($script:OreCatalogueStop -and $script:OreCatalogueStop.IsCancellationRequested) { throw }
                $status='menuUnverified'
                Write-OreDiagnostic $_.Exception.Message
            }
        }
        @{Name=$name; Date=$date; Status=$status; Release=$descriptor}
    }
}
function Start-OreCataloguePage([int]$Page, [string[]]$InstalledCommits) {
    $stage = New-OrePackageStage
    $stop = New-Object Threading.CancellationTokenSource
    $ready = New-Object Threading.ManualResetEventSlim
    $state = [Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    foreach ($name in @('Get-OreReleasePage','Get-OreReleaseName','Save-OreReleaseName','Assert-OrePath','Read-OreReleaseDescriptor','Get-OreReleaseAsset','Get-OreHttps','Read-OreJson','Write-OreDiagnostic')) {
        $state.Commands.Add((New-Object Management.Automation.Runspaces.SessionStateFunctionEntry($name,(Get-Command $name).Definition)))
    }
    $worker = [PowerShell]::Create($state)
    try {
        $null = $worker.AddScript({
            param($stage,$page,$stop,$report,$LauncherVersion,$Installation,$commits,$ready)
            $ErrorActionPreference='Stop'
            $script:OreCatalogueStop=$stop
            $script:OreReport=$report
            try { Get-OreReleasePage $stage $page $commits $ready } finally { $ready.Set() }
        }).AddArgument($stage).AddArgument($Page).AddArgument($stop).AddArgument($script:OreReport).AddArgument($LauncherVersion).AddArgument($Installation).AddArgument($InstalledCommits).AddArgument($ready)
        return @{Worker=$worker; Async=$worker.BeginInvoke(); Stop=$stop; Stage=$stage; NamesReady=$ready}
    } catch { $worker.Dispose(); $stop.Dispose(); $ready.Dispose(); Remove-OrePackageStage $stage; throw }
}
function Close-OreCataloguePage($Request) {
    if (!$Request -or $Request.Closed) { return }
    try {
        $Request.Stop.Cancel()
        if (!$Request.Async.IsCompleted) { $Request.Worker.Stop() }
    } finally {
        $Request.Worker.Dispose(); $Request.Stop.Dispose(); $Request.NamesReady.Dispose(); $Request.Closed=$true
        Remove-OrePackageStage $Request.Stage
    }
}
function Select-OrePublishedVersion([array]$Installed, $Request) {
    $page = 1
    while ($true) {
        $stage = New-OrePackageStage
        try {
            $script:OreFailure = 'menuCatalogueFailed'
            Show-OreMessage 'menuLoading'
            if (!$Request) { $Request = Start-OreCataloguePage $page }
            while (!$Request.Async.AsyncWaitHandle.WaitOne(80)) {
                if (![Console]::IsInputRedirected -and [Console]::KeyAvailable -and [Console]::ReadKey($true).Key -eq 'Escape') { return $false }
            }
            $rows = @($Request.Worker.EndInvoke($Request.Async))
            $options = @()
            foreach ($row in $rows) {
                $local = $Installed | Where-Object { $_.Commit -ceq $row.Release.Commit } | Select-Object -First 1
                $status = Get-OreMessage $row.Status @{version=$row.Release.MinimumLauncherVersion}
                $installedLabel = if ($local) { Get-OreMessage 'menuInstalled' }
                $options += New-OreChoice $row.Name $row.Status @{Local=$local; Release=$row.Release; Label=$row.Name} -Columns @($row.Name,$row.Date,$status,$installedLabel) -Disabled:($row.Status -ne 'menuAvailable')
            }
            Format-OreVersionRows $options
            if ($rows.Count -eq 5) { $options += New-OreChoice (Get-OreMessage 'menuNext') 'next' }
            if ($page -gt 1) { $options += New-OreChoice (Get-OreMessage 'menuPrev') 'prev' }
            $options += New-OreChoice (Get-OreMessage 'menuBack') 'back'
            $notice = if (!$rows.Count) { Get-OreMessage 'menuNoReleases' }
            $choice = Read-OreChoice 'menuGithub' (Get-OreMessage 'menuPage' @{page=$page}) $options $notice
            switch ($choice.Action) {
                'back' { return $false }
                'next' { $page++ }
                'prev' { $page-- }
                'menuAvailable' {
                    if (!(Confirm-OrePin $choice.Value.Label)) { continue }
                    Show-OreMessage 'menuVerifying'
                    if ($choice.Value.Local) { Set-OreInstalledVersion $choice.Value.Local $stage }
                    else {
                        $release = $choice.Value.Release
                        $script:OreFailure = 'downloadFailed'
                        $candidate = Expand-OreRelease $release $stage
                        Test-OreFixedVersion $candidate $stage
                        Set-OreFixedSelection { Publish-OreRelease $candidate $release $stage $Installation }
                    }
                    return $true
                }
            }
        } finally { Close-OreCataloguePage $Request; $Request=$null; Remove-OrePackageStage $stage }
    }
}
function Confirm-OrePin([string]$Name) {
    $confirm = Read-OreChoice 'menuFixed' $Name @(
        (New-OreChoice (Get-OreMessage 'menuPin') 'pin')
        (New-OreChoice (Get-OreMessage 'menuBack') 'back')
    ) (Get-OreMessage 'menuPinHint')
    return $confirm.Action -eq 'pin'
}
function Read-OreDatabaseFile {
    Add-Type -AssemblyName System.Windows.Forms
    $picker = New-Object Windows.Forms.OpenFileDialog
    try {
        $picker.Title = Get-OreMessage 'menuLocate'
        $picker.Filter = 'SQLite (*.sqlite;*.db)|*.sqlite;*.db|*.*|*.*'
        $picker.InitialDirectory = Join-Path $Installation 'data'
        if ($picker.ShowDialog() -eq 'OK') { return $picker.FileName }
    } finally { $picker.Dispose() }
}
function Select-OreRecoveryDatabase {
    $script:OreFailure = 'menuDatabaseBlocked'
    if ($env:ROLEPLAY_DATABASE) { $script:OreFailure='menuDatabaseOverride'; throw 'Database override in effect.' }
    $toolkit = Get-OreSelection $Installation 'recovery/current'
    if (!$toolkit) { throw 'Missing recovery toolkit.' }
    $directory = Assert-OrePath $Installation (Join-Path $Installation ('recovery/'+$toolkit.Id))
    Assert-OreLongTree $directory
    Assert-OreLongTree ([IO.Path]::GetDirectoryName($toolkit.Node))
    $file = Read-OreDatabaseFile
    if (!$file) { return $false }
    $argsList = @((Join-Path $directory 'recover.mjs'),$Installation,'--database','external',$file)
    if ((Invoke-OreProcess $toolkit.Node $argsList $script:OreReport) -ne 0) { throw 'Database selection failed.' }
    return $true
}

function Show-OreVersionManager {
    $notice = ''
    $installed = @(Get-OreLocalVersions | Sort-Object { $_.Id })
    $request = Start-OreCataloguePage 1 @($installed | ForEach-Object { $_.Commit } | Select-Object -Unique)
    $refresh = if ($installed.Count) { $request.NamesReady }
    $focus = 0
    try {
        while ($true) {
            $current = Get-OreMenuSelection
            $working = Get-OreMenuSelection 'working'
            $previous = Get-OreMenuSelection 'previous'
            $options = @((New-OreChoice (Get-OreMessage 'menuLatest') 'latest'))
            foreach ($entry in $installed) {
                $status = if ($entry.Id -ceq $working.Id) { 'menuLastWorking' } elseif ($entry.Id -ceq $previous.Id) { 'menuPreviousWorking' } else { 'menuInstalled' }
                $label = Get-OreInstalledName $entry.Commit
                $selected = if ($entry.Id -ceq $current.Id) { Get-OreMessage 'menuSelected' }
                $requirement = ''
                $action = 'local'
                if ($entry.MinimumLauncherVersion -gt $LauncherVersion) {
                    $requirement = Get-OreMessage 'menuNewer' @{version=$entry.MinimumLauncherVersion}; $action='blocked'
                }
                $options += New-OreChoice $label $action $entry -Columns @($label,(Get-OreMessage $status),$selected,$requirement) -Disabled:($action -eq 'blocked')
            }
            Format-OreVersionRows $options
            $options += New-OreChoice (Get-OreMessage 'menuGithub') 'github'
            if (Get-OreMenuSelection 'recovery/current') { $options += New-OreChoice (Get-OreMessage 'menuLocate') 'database' }
            $options += New-OreChoice (Get-OreMessage 'menuBack') 'back'
            $choice = Read-OreChoice 'menuManage' (Get-OreVersionSummary) $options $notice $focus 0 $refresh
            if ($choice.Action -eq 'refresh') { $refresh=$null; $focus=$choice.Value; continue }
            $focus = 0
            $notice = ''
            $stage = $null
            try {
                $script:OreFailure = 'verificationFailed'
                switch ($choice.Action) {
                    'back' { return }
                    'latest' {
                        [IO.File]::Delete((Assert-OrePath $Installation (Join-Path $Installation 'updates-paused')))
                        return
                    }
                    'local' {
                        if (Confirm-OrePin $choice.Columns[0]) {
                            $stage = New-OrePackageStage
                            Show-OreMessage 'menuVerifying'
                            Set-OreInstalledVersion $choice.Value $stage
                            return
                        }
                    }
                    'github' {
                        $refresh=$null
                        if ($request.Closed) { $request=$null }
                        if (Select-OrePublishedVersion $installed $request) { return }
                    }
                    'database' { if (Select-OreRecoveryDatabase) { return } }
                }
            } catch {
                if (Test-OreCancellation) { throw }
                Write-OreDiagnostic $_.Exception.ToString()
                $notice = (Get-OreMessage $script:OreFailure)+'  '+(Get-OreMessage 'logFile' @{absolutePath=$script:OreReport})
            } finally { Remove-OrePackageStage $stage }
        }
    } finally { Close-OreCataloguePage $request }
}
