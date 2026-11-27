# The foreground presenter alone moves the cursor. Redirected callers keep the
# line-oriented transcript, including the original ready URL and log messages.
function New-OreTerminal([switch]$InteractiveMenu) {
    $vt = $Host.UI.SupportsVirtualTerminal -and $env:TERM -ne 'dumb'
    if ([Console]::IsOutputRedirected -or (!$vt -and !$InteractiveMenu)) { return }
    try { if ([Console]::WindowWidth -lt 1) { return } } catch { return }
    $light = [Console]::BackgroundColor -in @('White','Gray','Yellow','Cyan','Green','Magenta')
    # ORE Dark and Light text roles, against the terminal's own background.
    $colors = if ($light) {
        @{accent='127;96;71'; muted='89;97;110'; success='57;70;71'; danger='173;53;51'}
    } else {
        @{accent='228;170;127'; muted='159;168;182'; success='142;182;152'; danger='212;124;122'}
    }
    return @{Colors=$colors; Color=($vt -and $null -eq $env:NO_COLOR); PlainConsole=!$vt; Start=-1; End=-1; Width=0;
        Title='launching'; Role='accent'; Symbol='◐'; Primary=''; Update=''; Notice=''; Log=''; Footer=''}
}

function Format-OreTerminalText([string]$Text, [string]$Role) {
    if (!$script:OreTerminal.Color) { return $Text }
    $escape = [char]27
    return "${escape}[38;2;$($script:OreTerminal.Colors[$Role])m$Text${escape}[39m"
}

function Show-OreGreeting([int]$Version) {
    $versionLine = Get-OreMessage 'launcherVersion' @{version=$Version}
    if (!$script:OreTerminal) { [Console]::WriteLine("Open Roleplay Engine  ·  $versionLine"); return }
    $mark = @('█▀▀█ █▀▀█ █▀▀','█  █ █▄▄▀ █▀▀','▀▀▀▀ ▀  ▀ ▀▀▀')
    $labels = @('Open Roleplay Engine',(Format-OreTerminalText $versionLine 'muted'),'')
    [Console]::WriteLine()
    if ([Console]::WindowWidth -lt 40) {
        foreach ($row in $mark) { [Console]::WriteLine('  '+(Format-OreTerminalText $row 'accent')) }
        [Console]::WriteLine('  '+$labels[0]); [Console]::WriteLine('  '+$labels[1])
    } else {
        for ($i=0; $i -lt $mark.Count; $i++) {
            [Console]::WriteLine('  '+(Format-OreTerminalText $mark[$i] 'accent')+'   '+$labels[$i])
        }
    }
    [Console]::WriteLine()
}

function Clear-OreTerminalPanel {
    $t = $script:OreTerminal
    if (!$t -or $t.Start -lt 0) { return }
    try {
        $width = [Console]::BufferWidth
        $start = $t.Start
        $rows = $t.End-$start
        if ($t.MenuAnchor) {
            # ReadKey does not echo. Windows keeps this cursor on the menu's
            # first cell when a resize reflows the greeting or earlier output.
            $start = [Console]::CursorTop
            if ($t.PlainConsole -and $width -ne $t.Width) {
                $reflowed = 0
                foreach ($length in $t.MenuLineWidths) { $reflowed += 1+[Math]::Floor($length/$width) }
                $rows = [Math]::Max($rows,$reflowed)
            }
        }
        # Status panels can share the console with process output. Only clear
        # one if the cursor still marks its recorded end.
        if ($t.MenuAnchor -or ($t.Width -eq $width -and $t.End -eq [Console]::CursorTop -and [Console]::CursorLeft -eq 0)) {
            [Console]::SetCursorPosition(0,$start)
            if ($t.PlainConsole) {
                $bottom = [Math]::Min([Console]::BufferHeight-1,$start+$rows-1)
                if ($bottom -ge $start) {
                    $area = [Management.Automation.Host.Rectangle]::new(0,$start,$width-1,$bottom)
                    $blank = [Management.Automation.Host.BufferCell]::new(' ',[Console]::ForegroundColor,[Console]::BackgroundColor,'Complete')
                    $Host.UI.RawUI.SetBufferContents($area,$blank)
                }
            } else { [Console]::Write(([string][char]27)+'[J') }
        }
    } catch [ArgumentOutOfRangeException] { } # Resized between measurement and write.
    $t.Start = -1
    $t.MenuAnchor = $false
}

function Get-OreTerminalLines([int]$Width) {
    $t = $script:OreTerminal
    $title = Get-OreMessage $t.Title
    $rail = Format-OreTerminalText '│' $t.Role
    $lines = @('  '+$rail+'  '+(Format-OreTerminalText ($t.Symbol+' '+$title) $t.Role))
    if ($t.Primary) { $lines += '  '+$rail+'  '+$t.Primary }
    if ($t.Notice) { $lines += ''; $lines += '  '+$t.Notice }
    if ($t.Choices) {
        $lines += ''
        for ($i=0; $i -lt $t.Choices.Count; $i++) {
            $label = $t.Choices[$i]
            if ($i -eq $t.Focus) { $lines += '  '+(Format-OreTerminalText ('› '+$label) 'accent') }
            else { $lines += '    '+$label }
        }
    }
    if ($t.Update) {
        $label = if ($t.Title -eq 'firstInstall') { 'nextLabel' } else { 'updatesLabel' }
        $label = Format-OreTerminalText (Get-OreMessage $label) 'muted'
        $lines += ''
        if ($Width -lt 52) { $lines += '  '+$label; $lines += '  '+$t.Update }
        else { $lines += '  '+$label+'   '+$t.Update }
    }
    if ($t.Log) { $lines += ''; $lines += '  '+(Get-OreMessage 'logFile' @{absolutePath=$t.Log}) }
    if ($t.Footer) {
        $lines += ''; $lines += '  '+(Format-OreTerminalText ('─' * [Math]::Max(1,[Math]::Min(58,$Width-5))) 'muted')
        $lines += '  '+(Format-OreTerminalText $t.Footer 'muted')
    }
    return $lines
}

function Write-OreTerminalPanel {
    $t = $script:OreTerminal
    $lines = @(Get-OreTerminalLines ([Console]::WindowWidth))
    Clear-OreTerminalPanel
    $t.Width = [Math]::Max(1,[Console]::BufferWidth)
    $start = [Console]::CursorTop
    $rows = 0
    $t.MenuLineWidths = foreach ($line in $lines) {
        $visible = $line -replace '\x1b\[[0-9;]+m',''
        $length = $Host.UI.RawUI.LengthInBufferCells($visible)
        $rows += 1 + [Math]::Floor($length / $t.Width)
        $length
        [Console]::WriteLine([string]$line)
    }
    $t.End = [Console]::CursorTop
    $t.Start = if ($t.End -lt [Console]::BufferHeight-1) { $start } else { [Math]::Max(0,[Math]::Min($start,$t.End-$rows)) }
    if ($t.Choices) {
        [Console]::SetCursorPosition(0,$t.Start)
        $t.MenuAnchor = $true
    }
}

function Show-OreTerminalFailure([string]$Id, [hashtable]$Parameters = @{}) {
    $t = $script:OreTerminal
    $t.Failed = $true
    $wasRunning = $t.Title -in @('running','sessionEnded')
    $t.Title = if ($wasRunning) { 'sessionEnded' } else { 'launchStopped' }
    $t.Role = if ($Id -eq 'cancelled') { 'muted' } else { 'danger' }
    $t.Symbol = '×'
    $t.Primary = if ($wasRunning -and $Id -eq 'startupFailed') { Get-OreMessage 'sessionFailed' } else { Get-OreMessage $Id $Parameters }
    $t.Update = ''; $t.Notice = ''; $t.Footer = ''
    $t.Log = if ($Id -ne 'logFailed') { $script:OreReport }
    Write-OreTerminalPanel
}

# Only the controller's identifiers and validated ready URL enter this screen.
function Receive-OreTerminalEvent([string]$Line) {
    $t = $script:OreTerminal
    if ($t.Failed) { return }
    if ($Line.StartsWith('openUrl ')) {
        if ($t.Title -eq 'running') { return } # The browser fallback repeats the ready address.
        $address = $Line.Substring(8)
        $uri = $null
        if ($address -match '[\s\p{Cc}]' -or ![Uri]::TryCreate($address,[UriKind]::Absolute,[ref]$uri) -or
            $uri.Scheme -notin @('http','https') -or $uri.UserInfo) { return }
        $t.Title = 'running'; $t.Symbol = '●'; $t.Role = 'success'; $t.Primary = $address
        $t.Footer = Get-OreMessage 'sessionHint'
    } elseif ($Line -eq 'starting') {
        if ($t.Title -eq 'firstInstall') { $t.Update = ''; $t.Footer = '' }
        $t.Title = 'launching'; $t.Primary = Get-OreMessage 'starting'
    } elseif ($Line -eq 'browserFailed') { $t.Footer = (Get-OreMessage $Line)+'  '+(Get-OreMessage 'sessionHint') }
    elseif ($Line -in @('stopping','stopped')) {
        $t.Title = 'sessionEnded'; $t.Role = 'muted'; $t.Symbol = '○'; $t.Primary = Get-OreMessage $Line
        $t.Update = ''; $t.Notice = ''; $t.Footer = ''; $t.Log = ''
    } elseif ($Line -in @('portConflict','alreadyRunning','startupFailed','logFailed','cancelled')) {
        Show-OreTerminalFailure $Line
        return
    } else { return }
    Write-OreTerminalPanel
}

function Show-OreTerminalUpdate([string]$Id, [string]$Text, [hashtable]$Parameters) {
    $t = $script:OreTerminal
    if ($t.Title -in @('sessionEnded','launchStopped')) { return }
    if ($Id -eq 'logFile') { $t.Log = $Parameters.absolutePath }
    elseif ($Id -eq 'launcherUpdateRequired' -and $t.Title -eq 'firstInstall') { Show-OreTerminalFailure $Id $Parameters; return }
    elseif ($Id -in @('launcherUpdateRequired','preparedUpdateFailed')) { $t.Notice = $Text; $t.Update = '' }
    elseif ($Id -eq 'firstInstall') {
        $t.Title = $Id
        if ($env:ORE_OPEN_BROWSER -ne '0') { $t.Footer = Get-OreMessage 'browserWhenReady' }
    }
    elseif ($t.Title -eq 'running' -or $Id -eq 'updatesPaused') { $t.Update = $Text }
    else {
        $t.Primary = $Text
        $t.Update = if ($t.Title -eq 'firstInstall' -and $Id -eq 'downloadingVersion') { Get-OreMessage 'verifyNext' }
    }
    Write-OreTerminalPanel
}
