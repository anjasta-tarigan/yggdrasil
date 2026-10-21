param(
    [Parameter(Mandatory = $true)][string]$BaseDir,
    [ValidateSet('start', 'restart', 'check-update', 'update')][string]$Action
)

$ErrorActionPreference = 'Stop'

if ($Action) {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $entry = Join-Path $BaseDir 'app\bin\yggdrasil.mjs'
    $logDir = Join-Path $BaseDir 'data\logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $logPath = Join-Path $logDir "tray-$Action-last.log"
    $output = & $node $entry $Action --dir $BaseDir 2>&1
    $exitCode = $LASTEXITCODE
    $output | Out-File -FilePath $logPath -Encoding utf8
    exit $exitCode
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$mutexCreated = $false
$trayMutex = New-Object Threading.Mutex($true, 'Local\YggdrasilTray', [ref]$mutexCreated)
if (-not $mutexCreated) {
    $trayMutex.Dispose()
    exit 0
}
$eventCreated = $false
$stopEvent = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, 'Local\YggdrasilTrayStop', [ref]$eventCreated)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open Yggdrasil')
[void]$menu.Items.Add('-')
$startItem = $menu.Items.Add('Start service')
$restartItem = $menu.Items.Add('Restart service')
$checkItem = $menu.Items.Add('Check for updates')
$updateItem = $menu.Items.Add('Update Yggdrasil')
[void]$menu.Items.Add('-')
$exitItem = $menu.Items.Add('Exit tray app')

$iconPath = Join-Path $BaseDir 'app\src\app\favicon.ico'
$hasCustomIcon = Test-Path -LiteralPath $iconPath
if ($hasCustomIcon) {
    $icon = New-Object System.Drawing.Icon($iconPath)
} else {
    $icon = [System.Drawing.SystemIcons]::Application
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Text = 'Yggdrasil'
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

$script:activeAction = $null
$script:actionProcess = $null
$script:trayScriptPath = $PSCommandPath
$script:trayBaseDir = $BaseDir
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
    if ($stopEvent.WaitOne(0)) {
        $timer.Stop()
        $tray.Visible = $false
        [System.Windows.Forms.Application]::ExitThread()
        return
    }
    if ($script:actionProcess -and $script:actionProcess.HasExited) {
        $code = $script:actionProcess.ExitCode
        $label = switch ($script:activeAction) {
            'check-update' { if ($code -eq 0) { 'Yggdrasil is up to date.' } elseif ($code -eq 1) { 'An update is available.' } else { 'Update check failed. See data\logs.' } }
            'update' { if ($code -eq 0) { 'Yggdrasil updated successfully.' } else { 'Update failed. See data\logs.' } }
            'restart' { if ($code -eq 0) { 'Yggdrasil restarted.' } else { 'Restart failed. See data\logs.' } }
            'start' { if ($code -eq 0) { 'Yggdrasil started.' } else { 'Start failed. See data\logs.' } }
        }
        $tray.BalloonTipTitle = 'Yggdrasil'
        $tray.BalloonTipText = $label
        $tray.ShowBalloonTip(5000)
        $script:actionProcess.Dispose()
        $script:actionProcess = $null
        $script:activeAction = $null
        foreach ($item in @($startItem, $restartItem, $checkItem, $updateItem)) { $item.Enabled = $true }
    }
})
$timer.Start()

$launchAction = {
    param([string]$ActionName)
    if ($script:actionProcess) { return }
    foreach ($item in @($startItem, $restartItem, $checkItem, $updateItem)) { $item.Enabled = $false }
    $script:activeAction = $ActionName
    $scriptPath = $script:trayScriptPath.Replace("'", "''")
    $basePath = $script:trayBaseDir.Replace("'", "''")
    $payload = "& '$scriptPath' -BaseDir '$basePath' -Action '$ActionName'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
    $script:actionProcess = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded
    )
}

$openItem.add_Click({
    $port = 2302
    $envPath = Join-Path $BaseDir '.env'
    if (Test-Path -LiteralPath $envPath) {
        $portLine = Select-String -Path $envPath -Pattern '^PORT=(\d{1,5})$' | Select-Object -First 1
        if ($portLine -and [int]$portLine.Matches[0].Groups[1].Value -in 1..65535) {
            $port = [int]$portLine.Matches[0].Groups[1].Value
        }
    }
    Start-Process "http://127.0.0.1:$port"
})
$startItem.add_Click({ & $launchAction 'start' })
$restartItem.add_Click({ & $launchAction 'restart' })
$checkItem.add_Click({ & $launchAction 'check-update' })
$updateItem.add_Click({ & $launchAction 'update' })
$exitItem.add_Click({ $timer.Stop(); $tray.Visible = $false; [System.Windows.Forms.Application]::ExitThread() })
$tray.add_DoubleClick({ $openItem.PerformClick() })

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Dispose()
    $stopEvent.Dispose()
    $tray.Visible = $false
    $tray.Dispose()
    $menu.Dispose()
    if ($hasCustomIcon) { $icon.Dispose() }
    $trayMutex.ReleaseMutex()
    $trayMutex.Dispose()
}
