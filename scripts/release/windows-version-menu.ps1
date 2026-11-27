# Interactive screens live in the external batch, independent of the selected app.
function New-OreChoice([string]$Label, [string]$Action, $Value = $null, [switch]$Disabled) {
    return @{Label=$Label; Action=$Action; Value=$Value; Disabled=$Disabled.IsPresent}
}
function Read-OreMenuKey { return [Console]::ReadKey($true).Key }
function Read-OreChoice([string]$Title, [string]$Primary, [array]$Choices, [string]$Notice = '', [int]$Focus = 0) {
    $t = $script:OreTerminal
    try {
        while ($true) {
            try { $count = [Math]::Max(1,[Math]::Min(9,[Console]::WindowHeight-10)) }
            catch [IO.IOException] { $count = 9 }
            $first = [Math]::Max(0,$Focus-$count+1)
            $labels = @($Choices | Select-Object -Skip $first -First $count | ForEach-Object { $_.Label })
            if ($t) {
                $t.Title=$Title; $t.Role='accent'; $t.Symbol='◇'; $t.Primary=$Primary
                $t.Notice=$Notice; $t.Log=''; $t.Update=''; $t.Footer=Get-OreMessage 'menuKeys'
                $t.Choices=$labels; $t.Focus=$Focus-$first
                Write-OreTerminalPanel
            } else {
                [Console]::WriteLine((Get-OreMessage $Title))
                if ($Primary) { [Console]::WriteLine($Primary) }
                if ($Notice) { [Console]::WriteLine($Notice) }
                for ($i=0; $i -lt $labels.Count; $i++) {
                    $prefix = if ($i+$first -eq $Focus) { '> ' } else { '  ' }
                    [Console]::WriteLine($prefix+$labels[$i])
                }
                [Console]::WriteLine((Get-OreMessage 'menuKeys'))
            }
            switch (Read-OreMenuKey) {
                'UpArrow'   { $Focus = ($Focus+$Choices.Count-1) % $Choices.Count }
                'DownArrow' { $Focus = ($Focus+1) % $Choices.Count }
                'Escape'    { return (New-OreChoice '' 'back') }
                'Enter'     { if (!$Choices[$Focus].Disabled) { return $Choices[$Focus] } }
            }
        }
    } finally {
        if ($t) { Clear-OreTerminalPanel; $t.Choices=$null; $t.Footer=''; $t.Notice=''; $t.Primary='' }
    }
}

function Get-OreMenuSelection([string]$Pointer = 'current') {
    try { Get-OreSelection $Installation $Pointer }
    catch { if ($script:OreReport) { Write-OreDiagnostic $_.Exception.Message } }
}
function Get-OreVersionSummary {
    $current = Get-OreMenuSelection
    if (!$current) {
        if ([IO.File]::Exists((Join-Path $Installation 'current'))) { return (Get-OreMessage 'menuNoSelection') }
        return (Get-OreMessage 'menuFirst')
    }
    $version = $current.Id -replace '^release-','' -replace '^([a-f0-9]{12})-.*$','$1'
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
function Get-OreReleasePage([string]$Stage, [int]$Page) {
    $file = Join-Path $Stage 'releases.json'
    Get-OreHttps ('https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/releases?per_page=5&page='+$Page) $file 12
    # Windows PowerShell preserves the outer JSON array as a single object.
    $records = Read-OreJson $file
    if ($records -isnot [array] -or $records.Count -gt 5) { throw 'Invalid release page.' }
    foreach ($release in $records) {
        if ($release.draft -ne $false) { continue }
        $name = ([string]$release.name -replace '[\p{Cc}\p{Cf}]',' ').Trim()
        if (!$name) { $name = [string]$release.tag_name -replace '[^\w.-]','' }
        $name = $name.Substring(0,[Math]::Min(60,$name.Length))
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
function Start-OreCataloguePage([int]$Page) {
    $stage = New-OrePackageStage
    $stop = New-Object Threading.CancellationTokenSource
    $state = [Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    foreach ($name in @('Get-OreReleasePage','Read-OreReleaseDescriptor','Get-OreReleaseAsset','Get-OreHttps','Read-OreJson','Write-OreDiagnostic')) {
        $state.Commands.Add((New-Object Management.Automation.Runspaces.SessionStateFunctionEntry($name,(Get-Command $name).Definition)))
    }
    $worker = [PowerShell]::Create($state)
    try {
        $null = $worker.AddScript({
            param($stage,$page,$stop,$report,$LauncherVersion)
            $ErrorActionPreference='Stop'
            $script:OreCatalogueStop=$stop
            $script:OreReport=$report
            Get-OreReleasePage $stage $page
        }).AddArgument($stage).AddArgument($Page).AddArgument($stop).AddArgument($script:OreReport).AddArgument($LauncherVersion)
        return @{Worker=$worker; Async=$worker.BeginInvoke(); Stop=$stop; Stage=$stage}
    } catch { $worker.Dispose(); $stop.Dispose(); Remove-OrePackageStage $stage; throw }
}
function Close-OreCataloguePage($Request) {
    if (!$Request -or $Request.Closed) { return }
    try {
        $Request.Stop.Cancel()
        if (!$Request.Async.IsCompleted) { $Request.Worker.Stop() }
    } finally {
        $Request.Worker.Dispose(); $Request.Stop.Dispose(); $Request.Closed=$true
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
                if ($local) { $status += ' · '+(Get-OreMessage 'menuInstalled') }
                $label = (@($row.Name,$row.Date,$status) -ne '') -join '  ·  '
                $options += New-OreChoice $label $row.Status @{Local=$local; Release=$row.Release; Label=$row.Name} -Disabled:($row.Status -ne 'menuAvailable')
            }
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
    $request = Start-OreCataloguePage 1
    try {
        while ($true) {
            $installed = @(Get-OreLocalVersions | Sort-Object Id)
            $current = Get-OreMenuSelection
            $working = Get-OreMenuSelection 'working'
            $previous = Get-OreMenuSelection 'previous'
            $options = @((New-OreChoice (Get-OreMessage 'menuLatest') 'latest'))
            foreach ($entry in $installed) {
                $status = if ($entry.Id -ceq $working.Id) { 'menuLastWorking' } elseif ($entry.Id -ceq $previous.Id) { 'menuPreviousWorking' } else { 'menuInstalled' }
                $label = $entry.Commit.Substring(0,12)+'  ·  '+(Get-OreMessage $status)
                if ($entry.Id -ceq $current.Id) { $label += ' · '+(Get-OreMessage 'menuSelected') }
                $action = 'local'
                if ($entry.MinimumLauncherVersion -gt $LauncherVersion) {
                    $label += ' · '+(Get-OreMessage 'menuNewer' @{version=$entry.MinimumLauncherVersion}); $action='blocked'
                }
                $options += New-OreChoice $label $action $entry -Disabled:($action -eq 'blocked')
            }
            $options += New-OreChoice (Get-OreMessage 'menuGithub') 'github'
            if (Get-OreMenuSelection 'recovery/current') { $options += New-OreChoice (Get-OreMessage 'menuLocate') 'database' }
            $options += New-OreChoice (Get-OreMessage 'menuBack') 'back'
            $choice = Read-OreChoice 'menuManage' (Get-OreVersionSummary) $options $notice
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
                        if (Confirm-OrePin $choice.Label) {
                            $stage = New-OrePackageStage
                            Show-OreMessage 'menuVerifying'
                            Set-OreInstalledVersion $choice.Value $stage
                            return
                        }
                    }
                    'github' {
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
