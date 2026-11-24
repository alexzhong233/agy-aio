# Adds --remote-debugging-port=0 to Antigravity shortcuts so the footer capsule can attach.
# Newer Antigravity builds no longer open this port on their own (issue #5).
# -Undo removes the switch again. -Ask (used by install.bat) only asks when a shortcut
# still lacks the switch and never changes anything without an interactive yes.
# Restart Antigravity afterwards.
param(
    [switch]$Undo,
    [switch]$Ask,
    [string[]]$ShortcutDirectories = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('StartMenu'),
        [Environment]::GetFolderPath('CommonStartMenu'),
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
    )
)

$ErrorActionPreference = 'Stop'
$switchName = '--remote-debugging-port'
$switchText = "$switchName=0"
$switchPattern = "(^|\s)$([regex]::Escape($switchName))(=\S*)?(?=\s|$)"
# Also pin the debug port to loopback. A user's own --remote-debugging-address is never replaced.
$addressName = '--remote-debugging-address'
$addressText = "$addressName=127.0.0.1"
$addressAnyPattern = "(^|\s)$([regex]::Escape($addressName))(=|\s|$)"
$addressOwnPattern = "(^|\s)$([regex]::Escape($addressText))(?=\s|$)"
# Never switch a debug port on next to a bind address that is not loopback; same rule as the IDE extension.
function Test-NonLoopbackAddress([string]$arguments) {
    $flags = [regex]::Matches($arguments, '(?i)(^|\s)--remote-debugging-address(?=\s|=|$)')
    $values = [regex]::Matches($arguments, '(?i)(^|\s)--remote-debugging-address(?:=|\s+)([^\s]+)')
    if ($flags.Count -ne $values.Count) { return $true }
    foreach ($match in $values) {
        if ($match.Groups[2].Value.Trim([char[]]@([char]34, [char]39)) -notin @('127.0.0.1', 'localhost', '::1', '[::1]')) { return $true }
    }
    return $false
}
$shell = New-Object -ComObject WScript.Shell

# Messages are collected per language and printed as an [English] block, then a [中文] block.
# Keep this file UTF-8 with BOM so Windows PowerShell 5.1 reads the Chinese correctly.
$script:en = [Collections.Generic.List[string]]::new()
$script:zh = [Collections.Generic.List[string]]::new()
function Say([string]$english, [string]$chinese) { $script:en.Add($english); $script:zh.Add($chinese) }
function Flush {
    if ($script:en.Count -eq 0) { return }
    Write-Host '[English]'; $script:en | ForEach-Object { Write-Host $_ }
    Write-Host '[中文]'; $script:zh | ForEach-Object { Write-Host $_ }
    $script:en.Clear(); $script:zh.Clear()
}

$shortcuts = @(foreach ($directory in $ShortcutDirectories | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique) {
    foreach ($file in Get-ChildItem -LiteralPath $directory -Recurse -Filter *.lnk -ErrorAction SilentlyContinue) {
        $link = $shell.CreateShortcut($file.FullName)
        if ($link.TargetPath -and (Split-Path -Leaf $link.TargetPath) -eq 'Antigravity.exe') {
            [pscustomobject]@{ Path = $file.FullName; Link = $link; HasSwitch = ([string]$link.Arguments -match $switchPattern); Unsafe = (Test-NonLoopbackAddress ([string]$link.Arguments)) }
        }
    }
})

if ($Ask) {
    $missing = @($shortcuts | Where-Object { -not $_.HasSwitch -and -not $_.Unsafe })
    if ($shortcuts.Count -eq 0) {
        Say "Footer capsule: if it doesn't appear, start Antigravity with $switchText (see README)." "底栏胶囊：如果没有显示，请带上 $switchText 启动 Antigravity（见 README）。"
        Flush
        exit 0
    }
    if ($missing.Count -eq 0) { exit 0 }
    Write-Host ''
    Say "Newer Antigravity versions need $switchText for the footer capsule under the input box." "新版 Antigravity 需要带上 $switchText 启动，输入框下方的底栏胶囊才能显示。"
    Say "This adds it, plus $addressText (loopback only), to these Antigravity shortcuts (undo with scripts\enable-cdp.ps1 -Undo):" "将给以下 Antigravity 快捷方式加上这个参数和 $addressText（仅限本机），可用 scripts\enable-cdp.ps1 -Undo 撤销："
    $missing | ForEach-Object { Say "  $($_.Path)" "  $($_.Path)" }
    Flush
    if ([Console]::IsInputRedirected) {
        Say 'Not interactive, skipped. Run scripts\enable-cdp.ps1 to set it up later.' '当前无法交互，已跳过。之后可运行 scripts\enable-cdp.ps1 设置。'
        Flush
        exit 0
    }
    $answer = Read-Host 'Add it now? / 现在添加吗？[Y/n]'
    if ($answer -and $answer.Trim() -notmatch '^(y|yes)$') {
        Say 'Skipped. Run scripts\enable-cdp.ps1 to set it up later.' '已跳过。之后可运行 scripts\enable-cdp.ps1 设置。'
        Flush
        exit 0
    }
}

if ($shortcuts.Count -eq 0) {
    Say "No Antigravity shortcuts found. Start Antigravity with: Antigravity.exe $switchText" "没有找到 Antigravity 快捷方式。请这样启动 Antigravity：Antigravity.exe $switchText"
    Flush
    exit 1
}

foreach ($shortcut in $shortcuts) {
    $arguments = [string]$shortcut.Link.Arguments
    if ($Undo) {
        if (-not $shortcut.HasSwitch) { Say "Unchanged (no switch): $($shortcut.Path)" "未带参数，无需改动：$($shortcut.Path)"; continue }
        $next = (($arguments -replace $switchPattern, '') -replace $addressOwnPattern, '').Trim()
    } else {
        if ($shortcut.HasSwitch) { Say "Already set: $($shortcut.Path)" "已设置：$($shortcut.Path)"; continue }
        if (Test-NonLoopbackAddress $arguments) { Say "Skipped (it has a non-loopback $addressName; change that yourself first): $($shortcut.Path)" "已跳过（里面有非本机的 $addressName，请先自行修改）：$($shortcut.Path)"; continue }
        $address = if ($arguments -match $addressAnyPattern) { '' } else { " $addressText" }
        $next = "$arguments $switchText$address".Trim()
    }
    try {
        $shortcut.Link.Arguments = $next
        $shortcut.Link.Save()
        Say "Updated: $($shortcut.Path)" "已更新：$($shortcut.Path)"
    } catch {
        # All-users shortcuts need an elevated prompt; leave them and say so.
        Say "Could not update (try an administrator PowerShell): $($shortcut.Path)" "无法修改（请用管理员 PowerShell 重试）：$($shortcut.Path)"
    }
}

if (Get-Process -Name Antigravity -ErrorAction SilentlyContinue) {
    Say 'Antigravity is running. Quit it completely, then open it from one of these shortcuts.' 'Antigravity 正在运行。请完全退出后，再从上面的快捷方式打开。'
} else {
    Say 'Done. Open Antigravity from one of these shortcuts.' '完成。请从上面的快捷方式打开 Antigravity。'
}
Flush
exit 0
