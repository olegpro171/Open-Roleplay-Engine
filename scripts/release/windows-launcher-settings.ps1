# Launcher preferences belong to the installation, across app versions.
function Test-OreShortcutPath($Path) {
    return $Path -is [string] -and $Path -match '^[a-z]:\\' -and
        $Path.Substring(2) -notmatch '[:\p{Cc}\p{Cf}]' -and [IO.Path]::GetExtension($Path) -ieq '.lnk'
}
function Get-OreBrowserSetting {
    try {
        $path = Assert-OrePath $Installation (Join-Path $Installation 'launcher-settings.json')
        if (![IO.File]::Exists($path)) { return @{Mode='default'} }
        $record = Read-OreJson $path 16KB
        if ($record.version -ne 1 -or $record.mode -cnotin @('default','shortcut','none')) { throw 'Invalid browser preference.' }
        if ($record.mode -ceq 'shortcut' -and !(Test-OreShortcutPath $record.shortcut)) { throw 'Invalid shortcut path.' }
        return @{Mode=$record.mode; Shortcut=$record.shortcut}
    } catch { return @{Mode='none'; Invalid=$true} }
}
function Save-OreBrowserSetting([string]$Mode, [string]$Shortcut) {
    $record = @{version=1; mode=$Mode}
    if ($Mode -ceq 'shortcut') {
        if (!(Test-OreShortcutPath $Shortcut) -or ![IO.File]::Exists($Shortcut)) { throw 'Choose an existing Windows shortcut.' }
        $record.shortcut = [IO.Path]::GetFullPath($Shortcut)
    } elseif ($Mode -cnotin @('default','none')) { throw 'Invalid browser preference.' }
    $path = Assert-OrePath $Installation (Join-Path $Installation 'launcher-settings.json')
    $temporary = Assert-OrePath $Installation (Join-Path $Installation ('cache/settings-'+[guid]::NewGuid()+'.tmp'))
    try {
        [IO.File]::WriteAllText($temporary,($record | ConvertTo-Json -Compress))
        if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary,$path,[NullString]::Value) }
        else { [IO.File]::Move($temporary,$path) }
    } finally { [IO.File]::Delete($temporary) }
}
function Read-OreWebAppShortcut {
    Add-Type -AssemblyName System.Windows.Forms
    $picker = New-Object Windows.Forms.OpenFileDialog
    try {
        $picker.Title = Get-OreMessage 'menuChooseShortcut'
        $picker.Filter = (Get-OreMessage 'menuShortcutFilter')+' (*.lnk)|*.lnk'
        $picker.DereferenceLinks = $false
        $picker.InitialDirectory = [Environment]::GetFolderPath('DesktopDirectory')
        if ($picker.ShowDialog() -eq 'OK') { return $picker.FileName }
    } finally { $picker.Dispose() }
}
function Show-OreLauncherSettings {
    $notice = ''
    $focus = 0
    while ($true) {
        $saved = Get-OreBrowserSetting
        $choices = foreach ($mode in @('default','shortcut','none')) {
            $label = Get-OreMessage ('menuBrowser'+$mode)
            if ($saved.Mode -ceq $mode) { $label += '  ✓' }
            New-OreChoice $label $mode
        }
        $choices += New-OreChoice (Get-OreMessage 'menuBack') 'back'
        $hint = if ($notice) { $notice } elseif ($saved.Invalid) { Get-OreMessage 'menuSettingsInvalid' }
            elseif ($env:ORE_OPEN_BROWSER -eq '0') { Get-OreMessage 'menuBrowserOverride' }
            elseif ($saved.Mode -ceq 'shortcut') { $saved.Shortcut }
        $choice = Read-OreChoice 'menuSettings' (Get-OreMessage 'menuBrowserWhenReady') $choices $hint $focus
        if ($choice.Action -eq 'back') { return }
        $focus = [array]::IndexOf($choices,$choice)
        $notice = ''
        try {
            $shortcut = if ($choice.Action -eq 'shortcut') { Read-OreWebAppShortcut }
            if ($choice.Action -eq 'shortcut' -and !$shortcut) { continue }
            Save-OreBrowserSetting $choice.Action $shortcut
        } catch { $notice = Get-OreMessage 'menuSettingsSaveFailed' }
    }
}

function Open-OreWebAppShortcut([string]$Shortcut) {
    # Explorer owns the web app. A browser started directly from this helper
    # would inherit the server's kill-on-close job.
    $shell = New-Object -ComObject Shell.Application
    $location = 0; $empty = $null; $handle = 0
    $desktop = $shell.Windows().FindWindowSW([ref]$location,[ref]$empty,8,[ref]$handle,1)
    $desktop.Document.Application.ShellExecute($Shortcut,'','','open',1)
}

# The installed helper allocates its own private receipt in this PowerShell
# process, including when running an older pinned package. Only its controller
# can announce a successful saved-data start for this launch.
function Start-OreShortcutWatcher([string]$Shortcut) {
    $directory = Assert-OrePath $Installation (Join-Path $Installation 'cache')
    $watcher = [IO.FileSystemWatcher]::new($directory,'ready-*.tmp')
    $id = 'ORE-shortcut-'+[guid]::NewGuid()
    try {
        $state = @{Shortcut=$Shortcut; Opened=$false; Open=${function:Open-OreWebAppShortcut}; Failure=(Get-OreMessage 'menuShortcutFailed')}
        $job = Register-ObjectEvent $watcher Created -SourceIdentifier $id -MessageData $state -Action {
            $state = $event.MessageData
            $receipt = $event.SourceEventArgs.FullPath
            if ($state.Opened -or $receipt -ine $env:ORE_LAUNCH_READY_RECEIPT -or ![IO.File]::Exists($receipt)) { return }
            $state.Opened = $true
            try {
                if (![IO.File]::Exists($state.Shortcut)) { throw 'Shortcut unavailable.' }
                & $state.Open $state.Shortcut
            } catch { [Console]::WriteLine($state.Failure) }
        }
        $watcher.EnableRaisingEvents = $true
        return @{Watcher=$watcher; Id=$id; Job=$job}
    } catch {
        if ($job) { Unregister-Event -SourceIdentifier $id; Remove-Job $job -Force }
        $watcher.Dispose()
        throw
    }
}
function Stop-OreShortcutWatcher($Subscription) {
    if (!$Subscription) { return }
    $Subscription.Watcher.Dispose()
    Unregister-Event -SourceIdentifier $Subscription.Id
    Remove-Job $Subscription.Job -Force
}
