# Claude x DeepSeek pet - shared Win32 window probe (ASCII-only).
#
# Dot-source this file to get Test-DshWindowVisible. It answers one question:
# is the DSH main window currently on screen (visible, not minimized)?
#
# Detection uses two independent channels because a sandboxed/normal shell may
# not be allowed to translate the window's PID into a process name:
#   1. the window's PID belongs to the DSH main PID / a process named like DSH;
#   2. the window title contains the DSH title hint (Electron windows are titled
#      "<session title> - <app name>").
# A minimized window is visible to Win32 but IsIconic() is true, so it does not
# count as on-screen.

if (-not ('DuoPetWin32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DuoPetWin32
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static IntPtr[] AllWindows()
    {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            found.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }

    public static uint PidOf(IntPtr hWnd)
    {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }

    public static string TitleOf(IntPtr hWnd)
    {
        StringBuilder builder = new StringBuilder(512);
        GetWindowText(hWnd, builder, builder.Capacity);
        return builder.ToString();
    }
}
'@
}

function Test-DshWindowVisible {
  param(
    [int]$DshPid = 0,
    [string]$DshProcessName = 'DeepSeek Harness',
    [string]$TitleHint = 'DeepSeek Harness'
  )

  try {
    $processIds = New-Object 'System.Collections.Generic.HashSet[uint32]'
    if ($DshPid -gt 0) { [void]$processIds.Add([uint32]$DshPid) }

    if (-not [string]::IsNullOrEmpty($DshProcessName)) {
      foreach ($item in @(Get-Process -Name $DshProcessName -ErrorAction SilentlyContinue)) {
        if ($null -ne $item) { [void]$processIds.Add([uint32]$item.Id) }
      }
    }

    # Windows may or may not translate the window PID into a process name, and a
    # skin can rewrite the window title, so accept any comma-separated hint.
    $hints = @()
    if (-not [string]::IsNullOrEmpty($TitleHint)) {
      $hints = @($TitleHint -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    }
    if ($processIds.Count -eq 0 -and $hints.Count -eq 0) { return $false }

    $shown = 0
    foreach ($handle in [DuoPetWin32]::AllWindows()) {
      if (-not [DuoPetWin32]::IsWindowVisible($handle)) { continue }
      if ([DuoPetWin32]::IsIconic($handle)) { continue }

      $rect = New-Object DuoPetWin32+RECT
      if (-not [DuoPetWin32]::GetWindowRect($handle, [ref]$rect)) { continue }
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      if ($width -lt 500 -or $height -lt 400) { continue }

      $windowPid = [DuoPetWin32]::PidOf($handle)
      $isTarget = $processIds.Contains($windowPid)
      if (-not $isTarget -and $hints.Count -gt 0) {
        $title = [DuoPetWin32]::TitleOf($handle)
        if (-not [string]::IsNullOrEmpty($title)) {
          foreach ($hint in $hints) {
            if ($title.Contains($hint)) { $isTarget = $true; break }
          }
        }
      }
      if ($isTarget) { $shown++ }
    }

    return ($shown -gt 0)
  } catch {
    return $false
  }
}

# Find the DSH main window even when it is minimized or hidden, so the overlay's
# context menu can bring it back (ShowWindow(SW_RESTORE) + SetForegroundWindow).
# Returns [IntPtr]::Zero when no candidate matches.
function Find-DshWindowHandle {
  param(
    [int]$DshPid = 0,
    [string]$DshProcessName = 'DeepSeek Harness',
    [string]$TitleHint = 'DeepSeek Harness'
  )

  try {
    $processIds = New-Object 'System.Collections.Generic.HashSet[uint32]'
    if ($DshPid -gt 0) { [void]$processIds.Add([uint32]$DshPid) }

    if (-not [string]::IsNullOrEmpty($DshProcessName)) {
      foreach ($item in @(Get-Process -Name $DshProcessName -ErrorAction SilentlyContinue)) {
        if ($null -ne $item) { [void]$processIds.Add([uint32]$item.Id) }
      }
    }

    $hints = @()
    if (-not [string]::IsNullOrEmpty($TitleHint)) {
      $hints = @($TitleHint -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    }
    if ($processIds.Count -eq 0 -and $hints.Count -eq 0) { return [IntPtr]::Zero }

    $bestHandle = [IntPtr]::Zero
    $bestScore = 0
    foreach ($handle in [DuoPetWin32]::AllWindows()) {
      if (-not [DuoPetWin32]::IsWindow($handle)) { continue }
      $windowPid = [DuoPetWin32]::PidOf($handle)
      $isTarget = $processIds.Contains($windowPid)
      if (-not $isTarget -and $hints.Count -gt 0) {
        $title = [DuoPetWin32]::TitleOf($handle)
        if (-not [string]::IsNullOrEmpty($title)) {
          foreach ($hint in $hints) {
            if ($title.Contains($hint)) { $isTarget = $true; break }
          }
        }
      }
      if (-not $isTarget) { continue }

      # GetWindowRect on a minimized window can return a tiny/normalized rect, so
      # only apply the large-window filter for non-minimized candidates.
      if (-not [DuoPetWin32]::IsIconic($handle)) {
        $rect = New-Object DuoPetWin32+RECT
        if (-not [DuoPetWin32]::GetWindowRect($handle, [ref]$rect)) { continue }
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top
        if ($width -lt 500 -or $height -lt 400) { continue }
      }

      # Prefer a normal visible window, then a minimized one, then a hidden one.
      $score = 1
      if ([DuoPetWin32]::IsWindowVisible($handle)) { $score = 3 }
      if ([DuoPetWin32]::IsIconic($handle)) { $score = 2 }
      if ($score -gt $bestScore) {
        $bestScore = $score
        $bestHandle = $handle
      }
    }
    return $bestHandle
  } catch {
    return [IntPtr]::Zero
  }
}

function Restore-DshWindow {
  param(
    [int]$DshPid = 0,
    [string]$DshProcessName = 'DeepSeek Harness',
    [string]$TitleHint = 'DeepSeek Harness'
  )

  $result = [pscustomobject]@{
    Found = $false
    Hwnd = [IntPtr]::Zero
    WasVisible = $false
    WasIconic = $false
    ShowResult = $false
    Foreground = $false
  }

  $handle = Find-DshWindowHandle -DshPid $DshPid -DshProcessName $DshProcessName -TitleHint $TitleHint
  if ($handle -eq [IntPtr]::Zero) { return $result }

  try {
    $result.Found = $true
    $result.Hwnd = $handle
    $result.WasVisible = [DuoPetWin32]::IsWindowVisible($handle)
    $result.WasIconic = [DuoPetWin32]::IsIconic($handle)
    # SW_RESTORE = 9 restores a minimized/hidden window and activates it.
    $result.ShowResult = [DuoPetWin32]::ShowWindow($handle, 9)
    [void][DuoPetWin32]::BringWindowToTop($handle)
    $result.Foreground = [DuoPetWin32]::SetForegroundWindow($handle)
  } catch {
    # status is reported through the result object; never throw from a menu action
  }
  return $result
}

# ---------------- CLI action mode (used by the Host minimize route) ----------------
# The Host runs: powershell -File window-probe.ps1 -Action minimize -DshPid 0
#                -TitleHint "DeepSeek Harness,DSH"
# Dot-sourcing this file (the overlay does that) passes no -Action, so this block is a
# no-op there. Named arguments are parsed from $args to avoid a param block overriding
# the overlay's own $DshPid/$TitleHint variables when this file is dot-sourced.
$probeAction = ''
$probeDshPid = 0
$probeDshProcessName = 'DeepSeek Harness'
$probeTitleHint = 'DeepSeek Harness'
$probeResultPath = ''
if ($null -ne $args -and $args.Count -gt 0) {
  for ($probeIndex = 0; $probeIndex -lt $args.Count; $probeIndex++) {
    $probeName = [string]$args[$probeIndex]
    $probeValue = ''
    if (($probeIndex + 1) -lt $args.Count) { $probeValue = [string]$args[$probeIndex + 1] }
    switch ($probeName) {
      '-Action' { $probeAction = $probeValue; $probeIndex += 1 }
      '-DshPid' { if ($probeValue -match '^\d+$') { $probeDshPid = [int]$probeValue }; $probeIndex += 1 }
      '-DshProcessName' { $probeDshProcessName = $probeValue; $probeIndex += 1 }
      '-TitleHint' { $probeTitleHint = $probeValue; $probeIndex += 1 }
      '-ResultPath' { $probeResultPath = $probeValue; $probeIndex += 1 }
    }
  }
}

if (-not [string]::IsNullOrEmpty($probeAction)) {
  $actionResult = [pscustomobject]@{
    ok = $false
    found = $false
    minimized = $false
    restored = $false
    error = ''
  }
  try {
    $actionHandle = Find-DshWindowHandle -DshPid $probeDshPid -DshProcessName $probeDshProcessName -TitleHint $probeTitleHint
    if ($actionHandle -eq [IntPtr]::Zero) {
      $actionResult.error = 'window not found'
    } else {
      $actionResult.found = $true
      if ($probeAction -eq 'minimize') {
        [void][DuoPetWin32]::ShowWindow($actionHandle, 6) # SW_MINIMIZE
        Start-Sleep -Milliseconds 120
        $actionResult.minimized = [DuoPetWin32]::IsIconic($actionHandle)
        $actionResult.ok = $actionResult.minimized
      } elseif ($probeAction -eq 'restore') {
        [void][DuoPetWin32]::ShowWindow($actionHandle, 9) # SW_RESTORE
        Start-Sleep -Milliseconds 120
        $actionResult.restored = -not [DuoPetWin32]::IsIconic($actionHandle)
        $actionResult.ok = $actionResult.restored
      } else {
        $actionResult.error = 'unknown action'
      }
    }
  } catch {
    $actionResult.error = $_.Exception.Message
  }
  Write-Output ($actionResult | ConvertTo-Json -Compress)
  if (-not [string]::IsNullOrEmpty($probeResultPath)) {
    try {
      $probeJson = $actionResult | ConvertTo-Json -Compress
      # Write without a UTF-8 BOM: the Host JSON.parse() must not see it.
      [System.IO.File]::WriteAllText($probeResultPath, $probeJson, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
      # result file is best-effort (Host falls back to ok:false)
    }
  }
  if ($actionResult.ok) { exit 0 } else { exit 1 }
}
