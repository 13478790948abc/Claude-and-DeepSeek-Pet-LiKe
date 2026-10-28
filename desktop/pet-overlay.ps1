#requires -Version 5.1
<#
Claude x DeepSeek pet - desktop overlay (WPF / Windows PowerShell 5.1, run with -STA).

Spawned by the Host half of @local/dsh-duo-pet. It polls the DSH web endpoint
/duo-pet/state and draws a transparent, always-on-top pet in the lower-right
corner of the desktop. When the DSH main window is visible the overlay hides
itself (the in-window pet already shows there); when the DSH window is minimized
or hidden the desktop pet appears. Right-click menu: topmost / always show /
exit; drag to move and the position is remembered.

This file is intentionally ASCII-only: Windows PowerShell 5.1 decodes scripts
as ANSI, so localized display text lives in desktop/messages.json (UTF-8) and
window probing lives in window-probe.ps1.

Sprite contract (same art as the in-window pet): 12 columns x 5 rows, cell
440x480, displayed at 0.65 scale = 286x312. Row 0 = idle (8 frames x 250ms,
loop), rows 1-3 = snuggle (36 frames x 83ms, frame i -> row 1+floor(i/12),
col i%12), row 4 = done (12 frames x 100ms). Auto cycle: idle 2.0s, snuggle
3.0s, repeat. Host waitingSeq/celebrateSeq drive the sally and done reactions.

Parameters:
  -Origin         DSH web origin, e.g. http://127.0.0.1:41810
  -HostPid        PID of the DSH Host process that spawned us; when it exits,
                  this overlay closes too
  -DshPid         DSH main process PID (0 means: resolve by process name/title)
  -DshProcessName DSH main window process name, default "DeepSeek Harness"
  -TitleHint      DSH window title marker(s), comma separated; default
                  "DeepSeek Harness,DSH"
  -LogPath        Runtime log file (UTF-8, appended)
  -DryRun         Self-check only (assets / state / window probe), no window
  -DebugPaint     Paint the window and grid with opaque magenta and force the
                  window visible; used to prove the WPF layered window reaches
                  the screen independently of the sprite content
  -DebugBubble    Test-only: show the localized sally/done bubble at startup for
                  screenshots (e.g. -DebugBubble done), no state event needed
  -DebugEvent     Test-only: trigger Show-Sally / Show-Done after startup to verify
                  hidden-state sound suppression (sally|done)
  -DebugEventHidden  Test-only: keep the window hidden before -DebugEvent fires
  -DebugPageVisible  Test-only override for the page-visibility coordination:
                     true | false | unknown (default: use /duo-pet/state)
  -DebugIdleMs    Test-only: override the idle-to-snuggle delay (e.g. 600000 to
                  freeze the idle animation while testing pixel hit testing)
  -DebugFreeze    Test-only: stop the frame timer after the first frame so the tight
                  window geometry stays stable for drag/right-click tests
  -DebugAutoDrag  Test-only: run a 40-step synthetic drag through the same Begin/Update/
                  End drag functions after startup (freeze/resume + 300+ px test)
#>
param(
  [string]$Origin = 'http://127.0.0.1:41810',
  [int]$HostPid = 0,
  [int]$DshPid = 0,
  [string]$DshProcessName = 'DeepSeek Harness',
  [string]$TitleHint = 'DeepSeek Harness,DSH',
  [string]$InstanceName = 'DuoPetDesktopOverlay',
  [string]$LogPath = '',
  [switch]$DryRun,
  [switch]$DebugPaint,
  [string]$DebugBubble = '',
  [string]$DebugEvent = '',
  [switch]$DebugEventHidden,
  [string]$DebugPageVisible = '',
  [int]$DebugIdleMs = 0,
  [switch]$DebugFreeze,
  [switch]$DebugAutoDrag
)

$ErrorActionPreference = 'Stop'
$Origin = $Origin.TrimEnd('/')
$script:DebugPaint = [bool]$DebugPaint
$script:DebugEventHidden = [bool]$DebugEventHidden
$script:DebugEventName = $DebugEvent
$script:DebugPageVisibleOverride = $null
if ($DebugPageVisible -eq 'true') { $script:DebugPageVisibleOverride = $true }
elseif ($DebugPageVisible -eq 'false') { $script:DebugPageVisibleOverride = $false }

# Native helpers for the WM_NCHITTEST hit region. AlphaBounds scans one 440x480 cell
# (C# so the per-pixel loop stays fast) and returns its (alpha > 16) bbox; the overlay
# caches one result per cell and uses the bbox of the frame that is currently shown.
if (-not ('DuoPetHitNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DuoPetHitNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    public static int[] AlphaBounds(byte[] pixels, int width, int height, int threshold)
    {
        int minX = width;
        int minY = height;
        int maxX = -1;
        int maxY = -1;
        for (int y = 0; y < height; y++)
        {
            int rowOffset = y * width * 4;
            for (int x = 0; x < width; x++)
            {
                if (pixels[rowOffset + (x * 4) + 3] > threshold)
                {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return new int[] { 0, 0, width - 1, height - 1 };
        return new int[] { minX, minY, maxX, maxY };
    }

    // WM_NCHITTEST hook: the PowerShell scriptblock sets HitTest, and the strongly
    // typed C# delegate below returns HTCLIENT/HTTRANSPARENT plus the ref `handled`.
    // (A pure PowerShell HwndSourceHook scriptblock does not marshal the ref bool and
    // its return value reliably, so the hook itself lives in C#.)
    public delegate bool HitTestCallback(IntPtr hwnd, int screenX, int screenY);
    public static HitTestCallback HitTest = null;

    public static IntPtr WindowHook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != 0x0084) return IntPtr.Zero;
        bool inside = false;
        try
        {
            if (HitTest != null)
            {
                int raw = lParam.ToInt32();
                int sx = (short)(raw & 0xFFFF);
                int sy = (short)((raw >> 16) & 0xFFFF);
                inside = HitTest(hwnd, sx, sy);
            }
        }
        catch
        {
            inside = false;
        }
        handled = true;
        return (IntPtr)(inside ? 1 : -1);
    }
}
'@
}

$DesktopDir = $PSScriptRoot
# Per-cell alpha bbox cache for the current sprite sheet generation (keyed by
# spriteKey|row|col); only bounds arrays are kept, never pixel planes.
$script:SpriteKey = ''
$script:CellBoundsCache = @{}
$script:LastHitCellKey = ''
$BundleDir = Split-Path -Parent $DesktopDir
$AssetsDir = Join-Path $BundleDir 'assets'
$LocalSpritePath = Join-Path $AssetsDir 'spritesheet.png'
$MessagesPath = Join-Path $DesktopDir 'messages.json'
$PosPath = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-duo-pet-overlay-pos.json'

$script:LogPath = $LogPath
function Write-Log([string]$Message) {
  if ([string]::IsNullOrEmpty($script:LogPath)) { return }
  try {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Message)
    Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
  } catch {
    # logging must never break the pet
  }
}

# ---------------- sprite contract: 12 columns x 5 rows, 440x480 per cell ----------------
# Displayed size is 0.65 scale: 440*0.65 = 286 wide and 480*0.65 = 312 tall.
# Equivalent CSS background-size for the whole sheet: 12*286 = 3432 x 5*312 = 1560.
$script:CellW = 440
$script:CellH = 480
$script:Cols = 12
$script:Rows = 5
$script:Scale = 0.65
$script:PetW = [int]($script:CellW * $script:Scale)   # 286
$script:PetH = [int]($script:CellH * $script:Scale)   # 312
$script:BubbleRow = 52
# Bubble geometry: the tail's tip sits BubbleHeadGap px above Claude's head top,
# the tail stays BubbleTailOffset px from the bubble's left edge, and the bubble
# root spans both grid rows so it can overlap into the pet area.
$script:BubbleTailWidth = 14
$script:BubbleTailHeight = 8
$script:BubbleTailOffset = 24
$script:BubbleHeadGap = 5
# Window geometry: the window is exactly the current frame's character bbox plus a
# 2 DIP tolerance. BubbleExtra is the temporary extra height added while a bubble is
# shown (window grows upward, person stays anchored at the same screen position).
$script:HitTolerance = 2
$script:PersonW = $script:PetW
$script:PersonH = $script:PetH
$script:ImageLeft = 0
$script:ImageTop = 0
$script:BubbleExtra = 0
$script:BubbleHeight = 0
$script:FrameCellRow = -1
$script:FrameCellCol = -1
# Host-shared overlay options (GET /duo-pet/state, POST /duo-pet/overlay-option).
$script:OverlayTopmost = $true
# Absolute screen anchor = person bbox bottom-centre in DIP. Frame changes only compute
# Left = AnchorX - W/2 and Top = AnchorY - H from this; no incremental corrections (the
# old delta approach accumulated WPF rounding error and drifted the window off screen).
$script:AnchorX = $null
$script:AnchorY = $null
$script:GeometryUpdateCount = 0

$script:Animations = @{}
$idleFrames = @()
for ($index = 0; $index -lt 8; $index++) {
  $idleFrames += [pscustomobject]@{ Row = 0; Col = $index; Ms = 250 }
}
$snuggleFrames = @()
for ($index = 0; $index -lt 36; $index++) {
  $row = [int](1 + [Math]::Floor($index / 12))
  $col = [int]($index % 12)
  $snuggleFrames += [pscustomobject]@{ Row = $row; Col = $col; Ms = 83 }
}
$doneFrames = @()
for ($index = 0; $index -lt 12; $index++) {
  $doneFrames += [pscustomobject]@{ Row = 4; Col = $index; Ms = 100 }
}
$script:Animations['idle'] = $idleFrames
$script:Animations['snuggle'] = $snuggleFrames
$script:Animations['done'] = $doneFrames

$script:IdleMs = 2000
if ($DebugIdleMs -gt 0) { $script:IdleMs = $DebugIdleMs }
$script:BubbleSallyMs = 4500
$script:BubbleSallyMaxMs = 8000
$script:BubbleSallyEndHoldMs = 1200
$script:BubbleDoneMs = 2800

# Display strings come from UTF-8 JSON so this script stays ASCII-only.
$script:Bubbles = @{}
$script:MenuLabels = @{}
try {
  $messages = Get-Content -LiteralPath $MessagesPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -ne $messages.bubble) {
    foreach ($property in $messages.bubble.PSObject.Properties) {
      $script:Bubbles[$property.Name] = [string]$property.Value
    }
  }
  if ($null -ne $messages.menu) {
    foreach ($property in $messages.menu.PSObject.Properties) {
      $script:MenuLabels[$property.Name] = [string]$property.Value
    }
  }
} catch {
  Write-Log ('messages load failed: ' + $_.Exception.Message)
}
if (-not $script:Bubbles.ContainsKey('sally')) { $script:Bubbles['sally'] = 'Yanjin xia ma!' }
if (-not $script:Bubbles.ContainsKey('done')) { $script:Bubbles['done'] = 'Mission complete!' }

function Get-MenuLabel([string]$Key, [string]$Fallback) {
  if ($script:MenuLabels.ContainsKey($Key)) { return [string]$script:MenuLabels[$Key] }
  return $Fallback
}

# WPF assemblies are needed for the bitmap probe even in -DryRun.
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

# Shared Win32 window probe (defines Test-DshWindowVisible).
. (Join-Path $DesktopDir 'window-probe.ps1')

# Diagnostics: one line with hwnd, WPF position, Win32 rect, extended style and
# visibility, written on load / show / hide so an invisible overlay can be debugged.
function Get-WindowStateText {
  try {
    if ($null -eq $script:Window) { return 'window=(not created)' }
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($script:Window)
    $hwnd = $helper.Handle
    $rect = New-Object DuoPetWin32+RECT
    $ok = [DuoPetWin32]::GetWindowRect($hwnd, [ref]$rect)
    $exStyle = 'n/a'
    try { $exStyle = ('0x{0:X8}' -f [DuoPetWin32]::GetWindowLong($hwnd, -16)) } catch { }
    $dpi = 1.0
    try { $dpi = [System.Windows.Media.VisualTreeHelper]::GetDpi($script:Window).PixelsPerDip } catch { }
    $screenWidth = [DuoPetWin32]::GetSystemMetrics(0)
    $screenHeight = [DuoPetWin32]::GetSystemMetrics(1)
    return ('hwnd={0} wpf=({1},{2},{3},{4}) win32=({5},{6},{7},{8}) exStyle={9} isVisible={10} topmost={11} dpi={12} screen={13}x{14} content={15}' -f
      $hwnd, [int]$script:Window.Left, [int]$script:Window.Top, [int]$script:Window.Width, [int]$script:Window.Height,
      $rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top), $exStyle,
      $script:Window.IsVisible, $script:Window.Topmost, $dpi, $screenWidth, $screenHeight,
      $(if ($null -eq $script:Window.Content) { 'null' } else { $script:Window.Content.GetType().Name }))
  } catch {
    return ('window state failed: ' + $_.Exception.Message)
  }
}

function Write-WindowState([string]$Label) {
  if ($null -eq $script:Window) { Write-Log ($Label + ': window=(not created)'); return }
  try {
    if (-not $script:Window.IsLoaded) {
      Write-Log ($Label + ': window=(not loaded yet)')
      return
    }
    Write-Log ($Label + ': ' + (Get-WindowStateText))
  } catch {
    Write-Log ($Label + ': window state failed: ' + $_.Exception.Message)
  }
}

function Get-StateSnapshot {
  try {
    $request = [System.Net.WebRequest]::Create("$Origin/duo-pet/state")
    $request.Proxy = $null
    $request.Timeout = 1200
    $request.Method = 'GET'
    $response = $request.GetResponse()
    try {
      $stream = $response.GetResponseStream()
      $reader = New-Object System.IO.StreamReader($stream)
      try {
        $payload = $reader.ReadToEnd()
      } finally {
        $reader.Dispose()
      }
    } finally {
      $response.Dispose()
    }
    if ([string]::IsNullOrWhiteSpace($payload)) { return $null }
    return ($payload | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Get-StateInt($State, [string]$Name) {
  try {
    $value = $State.$Name
    if ($null -eq $value) { return 0 }
    return [int]$value
  } catch {
    return 0
  }
}

function Get-StateString($State, [string]$Name) {
  try {
    $value = $State.$Name
    if ($null -eq $value) { return '' }
    return [string]$value
  } catch {
    return ''
  }
}

# Returns $true / $false / $null (null = field missing or not a JSON boolean, i.e. an
# older Host that does not report page visibility).
function Get-StateBool($State, [string]$Name) {
  try {
    if ($null -eq $State) { return $null }
    $property = $State.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    $value = $property.Value
    if ($value -is [bool]) { return $value }
    if ($value -eq 'true') { return $true }
    if ($value -eq 'false') { return $false }
    return $null
  } catch {
    return $null
  }
}

function Format-PageVisibleText($Value) {
  if ($null -eq $Value) { return 'unknown' }
  if ($Value) { return 'True' }
  return 'False'
}

function Resolve-SpriteUri([string]$SpriteUrl) {
  if ([string]::IsNullOrWhiteSpace($SpriteUrl)) { return $null }
  try {
    if ($SpriteUrl -match '^https?://') { return [Uri]::new($SpriteUrl) }
    return [Uri]::new($Origin + $SpriteUrl)
  } catch {
    return $null
  }
}

function Load-SheetFromUri([Uri]$Uri, [string]$Label) {
  try {
    $memory = New-Object System.IO.MemoryStream
    if ($Uri.IsFile) {
      $bytes = [System.IO.File]::ReadAllBytes($Uri.LocalPath)
      $memory.Write($bytes, 0, $bytes.Length)
    } else {
      # BitmapImage's own downloader may go through the system proxy and fail on
      # 127.0.0.1 (HRESULT 0x80072EE4), so fetch the bytes with an explicit
      # proxy-less WebRequest and decode them ourselves.
      $request = [System.Net.WebRequest]::Create($Uri)
      $request.Proxy = $null
      $request.Timeout = 4000
      $response = $request.GetResponse()
      try {
        $responseStream = $response.GetResponseStream()
        try {
          $buffer = [byte[]]::new(81920)
          while (($read = $responseStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $memory.Write($buffer, 0, $read)
          }
        } finally {
          $responseStream.Dispose()
        }
      } finally {
        $response.Dispose()
      }
    }
    $memory.Position = 0
    $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create(
      $memory,
      [System.Windows.Media.Imaging.BitmapCreateOptions]::IgnoreImageCache,
      [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    )
    $frame = $decoder.Frames[0]
    if ($frame.CanFreeze) { $frame.Freeze() }
    # Keep the backing stream alive for the lifetime of the frame (replaced on reload).
    $script:SheetStream = $memory
    $expectedW = $script:CellW * $script:Cols
    $expectedH = $script:CellH * $script:Rows
    if ($frame.PixelWidth -ne $expectedW -or $frame.PixelHeight -ne $expectedH) {
      Write-Log ('unexpected sprite size {0}x{1}; expected {2}x{3}' -f $frame.PixelWidth, $frame.PixelHeight, $expectedW, $expectedH)
    }
    $script:Sheet = $frame
    # New sheet generation: invalidate per-cell hit bbox cache.
    $script:SpriteKey = ('{0}x{1}:{2}' -f $frame.PixelWidth, $frame.PixelHeight, $frame.GetHashCode())
    $script:CellBoundsCache = @{}
    $script:LastHitCellKey = ''
    Write-Log ('sprite loaded from {0}: {1}x{2} format={3} frames={4}' -f $Label, $frame.PixelWidth, $frame.PixelHeight, $frame.Format, $decoder.Frames.Count)
    return $true
  } catch {
    Write-Log ('sprite load failed ({0}): {1}' -f $Label, $_.Exception.Message)
    return $false
  }
}

function Load-Sheet([string]$SpriteUrl) {
  $uri = Resolve-SpriteUri $SpriteUrl
  if ($null -ne $uri) {
    if (Load-SheetFromUri $uri $SpriteUrl) {
      $script:SpriteSource = 'remote'
      return $true
    }
  }
  if (Test-Path -LiteralPath $LocalSpritePath) {
    if (Load-SheetFromUri ([Uri]::new($LocalSpritePath)) 'local') {
      $script:SpriteSource = 'local'
      return $true
    }
  }
  return $false
}

# Measure Claude (left character) inside the idle cell (row 0, col 0): the first row
# with a solid pixel and the horizontal centre of that top band. The bubble tail is
# then placed just above that point. Falls back to the values measured on the v2 art.
function Measure-ClaudeHead {
  $fallback = [pscustomobject]@{ Top = 149; Center = 120 }
  try {
    if ($null -eq $script:Sheet) { return $fallback }
    $rect = New-Object System.Windows.Int32Rect(0, 0, $script:CellW, $script:CellH)
    $cell = New-Object System.Windows.Media.Imaging.CroppedBitmap($script:Sheet, $rect)
    $converted = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($cell, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
    $stride = $script:CellW * 4
    $pixels = [byte[]]::new($stride * $script:CellH)
    $converted.CopyPixels($pixels, $stride, 0)
    $leftEdge = 20
    $rightEdge = [int]($script:CellW * 0.49)
    $alphaThreshold = 16
    for ($y = 0; $y -lt $script:CellH; $y++) {
      $rowOffset = $y * $stride
      $minX = -1
      $maxX = -1
      for ($x = $leftEdge; $x -le $rightEdge; $x++) {
        if ($pixels[$rowOffset + ($x * 4) + 3] -gt $alphaThreshold) {
          if ($minX -lt 0) { $minX = $x }
          $maxX = $x
        }
      }
      if ($minX -ge 0) {
        return [pscustomobject]@{ Top = $y; Center = [int](($minX + $maxX) / 2) }
      }
    }
  } catch {
    Write-Log ('claude head measure failed: ' + $_.Exception.Message)
  }
  return $fallback
}

# Place the (collapsed by default) bubble root so its tail tip is BubbleHeadGap px
# above Claude's head, horizontally centred on the tail.
function Update-BubbleGeometry {
  if ($script:Dragging) { return }
  if ($null -eq $script:BubbleRoot -or $null -eq $script:Window) { return }
  try {
    $head = Measure-ClaudeHead
    # Row 1 (the person) starts after BubbleExtra; inside it the pet image is shifted
    # by ImageTop/ImageLeft so the frame bbox sits at the window's top-left tolerance.
    $headTopWindow = [double]$script:BubbleExtra + [double]$script:ImageTop + ([double]$head.Top * $script:Scale)
    $tailTipY = $headTopWindow - [double]$script:BubbleHeadGap
    $bottomMargin = [double]$script:Window.Height - $tailTipY
    $minimumBottom = [double]$script:BubbleTailHeight + 2
    if ($bottomMargin -lt $minimumBottom) { $bottomMargin = $minimumBottom }
    $headXWindow = [double]$script:ImageLeft + ([double]$head.Center * $script:Scale)
    $left = $headXWindow - [double]$script:BubbleTailOffset - ([double]$script:BubbleTailWidth / 2)
    $minimumLeft = 4
    $maximumLeft = [Math]::Max([double]$minimumLeft, [double]$script:Window.Width - [double]$script:BubbleTailWidth - $minimumLeft)
    if ($left -lt $minimumLeft) { $left = $minimumLeft }
    if ($left -gt $maximumLeft) { $left = $maximumLeft }
    $script:BubbleRoot.Margin = [System.Windows.Thickness]::new($left, 0, 0, $bottomMargin)
    Write-Log ('bubble geometry: headTop={0}px center={1}px -> left={2} bottomMargin={3}' -f
      [int]$head.Top, [int]$head.Center, [int]$left, [int]$bottomMargin)
  } catch {
    Write-Log ('bubble geometry failed: ' + $_.Exception.Message)
  }
}

# Clamp a window rectangle into the virtual screen. Used on every geometry/position
# update so the pet can never be moved off screen by frame changes.
function Get-ClampedWindowPosition([double]$Left, [double]$Top, [double]$Width, [double]$Height) {
  $vsLeft = [double][System.Windows.SystemParameters]::VirtualScreenLeft
  $vsTop = [double][System.Windows.SystemParameters]::VirtualScreenTop
  $vsRight = $vsLeft + [double][System.Windows.SystemParameters]::VirtualScreenWidth
  $vsBottom = $vsTop + [double][System.Windows.SystemParameters]::VirtualScreenHeight
  $maxLeft = $vsRight - $Width
  $maxTop = $vsBottom - $Height
  if ($maxLeft -lt $vsLeft) { $maxLeft = $vsLeft }
  if ($maxTop -lt $vsTop) { $maxTop = $vsTop }
  if ($Left -lt $vsLeft) { $Left = $vsLeft }
  if ($Left -gt $maxLeft) { $Left = $maxLeft }
  if ($Top -lt $vsTop) { $Top = $vsTop }
  if ($Top -gt $maxTop) { $Top = $maxTop }
  return @($Left, $Top)
}

# Absolute anchor = person bbox bottom-centre in screen DIP. Updated only on initial
# placement, drag end and show/restore; frame resizes derive Left/Top from it.
function Update-AnchorFromWindow {
  if ($null -eq $script:Window) { return }
  try {
    $personTop = [double]$script:Window.Top + [double]$script:BubbleExtra
    $script:AnchorX = [double]$script:Window.Left + ([double]$script:PersonW / 2)
    $script:AnchorY = $personTop + [double]$script:PersonH
    Write-Log ('anchor set: x={0} y={1} (left={2} top={3} extra={4} person={5}x{6})' -f
      [int]$script:AnchorX, [int]$script:AnchorY, [int]$script:Window.Left, [int]$script:Window.Top,
      $script:BubbleExtra, [int]$script:PersonW, [int]$script:PersonH)
  } catch {
    # anchor update is best-effort
  }
}

# Resize/move the window so it is exactly the person bbox (+ tolerance), or that plus
# BubbleExtra while a bubble is shown. Left/Top are always computed absolutely from the
# anchor (never by accumulating deltas), then clamped into the virtual screen.
function Apply-WindowGeometry([string]$Reason) {
  try {
    # During a user drag the window follows the mouse; applying the absolute anchor
    # here would fight the drag. Resize again on the next frame after drag end.
    if ($script:Dragging) { return $true }
    $personW = [int][Math]::Round($script:PersonW)
    $personH = [int][Math]::Round($script:PersonH)
    $extra = [int][Math]::Round($script:BubbleExtra)
    if ($personW -lt 20) { $personW = 20 }
    if ($personH -lt 20) { $personH = 20 }
    if ($extra -lt 0) { $extra = 0 }
    $totalH = $personH + $extra
    if ($null -ne $script:RowBubble) { $script:RowBubble.Height = [System.Windows.GridLength]::new([double]$extra) }
    if ($null -ne $script:RowPerson) { $script:RowPerson.Height = [System.Windows.GridLength]::new([double]$personH) }
    if ($null -ne $script:FrameImage) {
      $script:FrameImage.Margin = [System.Windows.Thickness]::new($script:ImageLeft, $script:ImageTop, 0, 0)
      $script:FrameImage.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
      $script:FrameImage.VerticalAlignment = [System.Windows.VerticalAlignment]::Top
    }
    if ($null -ne $script:Bubble) { $script:Bubble.MaxWidth = [Math]::Max([double]80, [double]($personW - 8)) }
    $logLeft = 0
    $logTop = 0
    $logAnchorX = 0
    $logAnchorY = 0
    if ($null -ne $script:Window) {
      if ($null -eq $script:AnchorX -or $null -eq $script:AnchorY) { Update-AnchorFromWindow }
      $newW = [double]$personW
      $newH = [double]$totalH
      if ([Math]::Abs([double]$script:Window.Width - $newW) -ge 0.01) {
        $script:Window.Width = $newW
      }
      if ([Math]::Abs([double]$script:Window.Height - $newH) -ge 0.01) {
        $script:Window.Height = $newH
      }
      if ($null -ne $script:AnchorX -and $null -ne $script:AnchorY) {
        # Absolute placement from the anchor: no incremental delta, so WPF rounding
        # can never accumulate into a drift.
        $targetLeft = [double]$script:AnchorX - ($newW / 2)
        $targetTop = [double]$script:AnchorY - $newH
        $clamped = Get-ClampedWindowPosition $targetLeft $targetTop $newW $newH
        if ([Math]::Abs([double]$script:Window.Left - [double]$clamped[0]) -ge 0.01) {
          $script:Window.Left = [double]$clamped[0]
        }
        if ([Math]::Abs([double]$script:Window.Top - [double]$clamped[1]) -ge 0.01) {
          $script:Window.Top = [double]$clamped[1]
        }
      }
      $script:Window.UpdateLayout()
      $script:PetHitRect = [System.Windows.Rect]::new(0, 0, [double]$script:Window.Width, [double]$script:Window.Height)
      $logLeft = [int]$script:Window.Left
      $logTop = [int]$script:Window.Top
      $logAnchorX = [int]$script:AnchorX
      $logAnchorY = [int]$script:AnchorY
      $script:GeometryUpdateCount++
      if (($script:GeometryUpdateCount % 50) -eq 0) {
        Write-Log ('drift-check frame={0} left={1} top={2} anchor={3},{4} width={5} height={6}' -f
          $script:GeometryUpdateCount, $logLeft, $logTop,
          $logAnchorX, $logAnchorY, [int]$script:Window.Width, [int]$script:Window.Height)
      }
    } else {
      $script:PetHitRect = [System.Windows.Rect]::new(0, 0, [double]$personW, [double]$totalH)
    }
    if ($null -ne $script:HitSurface) {
      $script:HitSurface.Margin = [System.Windows.Thickness]::new(0, 0, 0, 0)
      $script:HitSurface.Width = $script:PetHitRect.Width
      $script:HitSurface.Height = $script:PetHitRect.Height
    }
    if ($null -ne $script:BubbleRoot -and $null -ne $script:Window -and
        $script:BubbleRoot.Visibility -eq [System.Windows.Visibility]::Visible) {
      # Keep the bubble tail above the (possibly new) head position.
      Update-BubbleGeometry
    }
    Write-Log ('window-size ({0}): w={1} h={2} person={3}x{4} extra={5} imageLeft={6} imageTop={7} left={8} top={9} anchor={10},{11} frame={12},{13}' -f
      $Reason, [int]$script:PetHitRect.Width, [int]$script:PetHitRect.Height,
      $personW, $personH, $extra, [Math]::Round($script:ImageLeft, 1), [Math]::Round($script:ImageTop, 1),
      $logLeft, $logTop, $logAnchorX, $logAnchorY,
      $script:FrameCellRow, $script:FrameCellCol)
    return $true
  } catch {
    Write-Log ('window geometry failed: ' + $_.Exception.Message)
    return $false
  }
}

# The window is the current frame's cell bbox (+ 2 DIP tolerance). Each new cell is
# measured once (AlphaBounds), cached, then the window geometry is updated. Same cell
# repeats are a no-op, so animation frames that share a cell do not resize at all.
function Update-PetHitRect {
  try {
    if ($null -eq $script:Sheet) { return $false }
    $animationName = $script:CurrentAnim
    if ([string]::IsNullOrEmpty($animationName) -or -not $script:Animations.ContainsKey($animationName)) { $animationName = 'idle' }
    $spec = $script:Animations[$animationName]
    if ($null -eq $spec) { $spec = $script:Animations['idle'] }
    $count = $spec.Count
    if ($count -lt 1) { return $false }
    $frameIndex = 0
    if ($null -ne $script:FrameIndex) { $frameIndex = [int]$script:FrameIndex }
    $index = $frameIndex % $count
    if ($index -lt 0) { $index += $count }
    $cell = $spec[$index]
    $cellKey = ('{0}|{1}|{2}' -f $script:SpriteKey, $cell.Row, $cell.Col)
    if ($script:LastHitCellKey -eq $cellKey -and $null -ne $script:PetHitRect) { return $true }
    $bounds = $script:CellBoundsCache[$cellKey]
    if ($null -eq $bounds) {
      $rect = New-Object System.Windows.Int32Rect(($cell.Col * $script:CellW), ($cell.Row * $script:CellH), $script:CellW, $script:CellH)
      $cropped = New-Object System.Windows.Media.Imaging.CroppedBitmap($script:Sheet, $rect)
      $converted = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($cropped, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
      $stride = $script:CellW * 4
      $pixels = [byte[]]::new($stride * $script:CellH)
      $converted.CopyPixels($pixels, $stride, 0)
      $bounds = [DuoPetHitNative]::AlphaBounds($pixels, $script:CellW, $script:CellH, 16)
      $script:CellBoundsCache[$cellKey] = $bounds
    }
    $tolerance = [double]$script:HitTolerance
    $bboxW = ([double]($bounds[2] - $bounds[0] + 1)) * $script:Scale
    $bboxH = ([double]($bounds[3] - $bounds[1] + 1)) * $script:Scale
    $script:PersonW = [int][Math]::Round($bboxW + (2 * $tolerance))
    $script:PersonH = [int][Math]::Round($bboxH + (2 * $tolerance))
    # Shift the 286x312 pet image so the bbox top-left lands at (tolerance,tolerance)
    # inside the person row; the image extends beyond the window and is clipped.
    $script:ImageLeft = $tolerance - ([double]$bounds[0] * $script:Scale)
    $script:ImageTop = $tolerance - ([double]$bounds[1] * $script:Scale)
    $script:FrameCellRow = $cell.Row
    $script:FrameCellCol = $cell.Col
    $script:LastHitCellKey = $cellKey
    [void](Apply-WindowGeometry ('frame {0},{1}' -f $cell.Row, $cell.Col))
    return $true
  } catch {
    Write-Log ('hit-region measure failed: ' + $_.Exception.Message)
    return $false
  }
}

function Get-EffectiveHitRect {
  try {
    if ($null -ne $script:Window) {
      return [System.Windows.Rect]::new(0, 0, [double]$script:Window.Width, [double]$script:Window.Height)
    }
  } catch {
    # fall through to the stored size
  }
  return [System.Windows.Rect]::new(0, 0, [double]$script:PersonW, [double]($script:PersonH + $script:BubbleExtra))
}

function Test-InHitRegion([double]$X, [double]$Y) {
  try {
    $rect = Get-EffectiveHitRect
    return ($X -ge $rect.X -and $X -le ($rect.X + $rect.Width) -and $Y -ge $rect.Y -and $Y -le ($rect.Y + $rect.Height))
  } catch {
    return $true
  }
}

# The window is now content-sized, so the alpha=1 hit surface simply covers the whole
# window (person bbox + optional bubble area); there is no large blank frame to block.
function Update-HitSurface {
  if ($null -eq $script:HitSurface) { return }
  try {
    $rect = Get-EffectiveHitRect
    if ($rect.Width -le 0 -or $rect.Height -le 0) { return }
    $script:HitSurface.Margin = [System.Windows.Thickness]::new(0, 0, 0, 0)
    $script:HitSurface.Width = $rect.Width
    $script:HitSurface.Height = $rect.Height
    Write-Log ('hit-surface: w={0} h={1}' -f [int]$rect.Width, [int]$rect.Height)
  } catch {
    # geometry update is best-effort
  }
}

function Write-HitRegionLog([string]$Label) {
  try {
    $rect = Get-EffectiveHitRect
    Write-Log ('hit-region ({0}): x={1} y={2} w={3} h={4}' -f $Label, [int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height)
  } catch {
    # logging only
  }
}

function Install-NcHitTestHook {
  try {
    if ($null -eq $script:Window) { return }
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($script:Window)
    $hwnd = $helper.Handle
    if ($hwnd -eq [IntPtr]::Zero) {
      Write-Log 'WM_NCHITTEST hook skipped: window handle not available'
      return
    }
    $source = [System.Windows.Interop.HwndSource]::FromHwnd($hwnd)
    if ($null -eq $source) {
      Write-Log 'WM_NCHITTEST hook skipped: HwndSource unavailable'
      return
    }
    $script:HwndSource = $source
    # The C# WindowHook delegate calls this scriptblock for every WM_NCHITTEST; the
    # scriptblock returns the "inside hit region" boolean and the C# side owns the
    # ref-bool/IntPtr marshaling (a pure PowerShell hook lost both).
    $script:HitTestCallback = [DuoPetHitNative+HitTestCallback]{
      param($hookHwnd, $screenX, $screenY)
      try {
        $point = New-Object DuoPetHitNative+POINT
        $point.X = $screenX
        $point.Y = $screenY
        [void][DuoPetHitNative]::ScreenToClient($hookHwnd, [ref]$point)
        $dpiScale = 1.0
        try { $dpiScale = [System.Windows.Media.VisualTreeHelper]::GetDpi($script:Window).DpiScaleX } catch { }
        if ($dpiScale -le 0) { $dpiScale = 1.0 }
        $dipX = [double]$point.X / $dpiScale
        $dipY = [double]$point.Y / $dpiScale
        $inside = Test-InHitRegion $dipX $dipY
        $label = 'HTTRANSPARENT'
        if ($inside) { $label = 'HTCLIENT' }
        if ($script:LastNcHitResult -ne $label) {
          $script:LastNcHitResult = $label
          Write-Log ('nchittest: {0} at {1},{2}' -f $label, [int]$dipX, [int]$dipY)
        }
        return [bool]$inside
      } catch {
        return $false
      }
    }
    [DuoPetHitNative]::HitTest = $script:HitTestCallback
    $method = [DuoPetHitNative].GetMethod('WindowHook')
    $script:NcHitTestHook = [System.Delegate]::CreateDelegate([System.Windows.Interop.HwndSourceHook], $method)
    $script:HwndSource.AddHook($script:NcHitTestHook)
    Write-Log 'WM_NCHITTEST hook installed'
  } catch {
    Write-Log ('WM_NCHITTEST hook failed: ' + $_.Exception.Message)
  }
}

# ---------------- dry run: self-check without any window ----------------
if ($DryRun) {
  try {
    $state = Get-StateSnapshot
    $spriteUrl = ''
    if ($null -ne $state) { $spriteUrl = Get-StateString $state 'spriteUrl' }
    $sheetInfo = 'missing'
    if (Load-Sheet $spriteUrl) {
      $sheetInfo = ('{0}x{1}' -f $script:Sheet.PixelWidth, $script:Sheet.PixelHeight)
    }
    $visible = Test-DshWindowVisible -DshPid $DshPid -DshProcessName $DshProcessName -TitleHint $TitleHint
    Write-Output ('origin: ' + $Origin)
    Write-Output ('sprite: ' + $sheetInfo + ' from ' + $(if ($null -eq $script:SpriteSource) { 'none' } else { $script:SpriteSource }))
    Write-Output ('sprite-url: ' + $(if ([string]::IsNullOrEmpty($spriteUrl)) { '(none)' } else { $spriteUrl }))
    Write-Output ('sprite-local: ' + (Test-Path -LiteralPath $LocalSpritePath) + ' ' + $LocalSpritePath)
    Write-Output ('animations: idle=' + $script:Animations['idle'].Count + ' snuggle=' + $script:Animations['snuggle'].Count + ' done=' + $script:Animations['done'].Count)
    Write-Output ('pet-size: ' + $script:PetW + 'x' + $script:PetH)
    $head = Measure-ClaudeHead
    Write-Output ('bubble-head: top={0}px center={1}px (sprite cell px)' -f [int]$head.Top, [int]$head.Center)
    [void](Update-PetHitRect)
    if ($null -ne $script:PetHitRect) {
      Write-Output ('window-size (frame {0},{1}): w={2} h={3} imageLeft={4} imageTop={5}' -f
        $script:FrameCellRow, $script:FrameCellCol, [int]$script:PetHitRect.Width, [int]$script:PetHitRect.Height,
        [Math]::Round($script:ImageLeft, 1), [Math]::Round($script:ImageTop, 1))
    }
    Write-Output ('debug-paint: ' + $script:DebugPaint)
    Write-Output ('debug-bubble: ' + $(if ([string]::IsNullOrEmpty($DebugBubble)) { '(none)' } else { $DebugBubble }))
    Write-Output ('debug-event: ' + $(if ([string]::IsNullOrEmpty($DebugEvent)) { '(none)' } else { $DebugEvent + ' hidden=' + $script:DebugEventHidden }))
    Write-Output ('screen: virtual={0}x{1} at {2},{3} work={4}x{5} at {6},{7}' -f
      [System.Windows.SystemParameters]::VirtualScreenWidth, [System.Windows.SystemParameters]::VirtualScreenHeight,
      [System.Windows.SystemParameters]::VirtualScreenLeft, [System.Windows.SystemParameters]::VirtualScreenTop,
      [System.Windows.SystemParameters]::WorkArea.Width, [System.Windows.SystemParameters]::WorkArea.Height,
      [System.Windows.SystemParameters]::WorkArea.Left, [System.Windows.SystemParameters]::WorkArea.Top)
    Write-Output ('sally-audio-local: ' + (Test-Path -LiteralPath (Join-Path $AssetsDir 'sally.mp3')))
    Write-Output ('done-audio-local: ' + (Test-Path -LiteralPath (Join-Path $AssetsDir 'done.mp3')))
    Write-Output ('messages: bubbles=' + $script:Bubbles.Count + ' menu=' + $script:MenuLabels.Count)
    $dryPageVisible = Get-StateBool $state 'pageVisible'
    Write-Output ('page-visible: ' + (Format-PageVisibleText $dryPageVisible))
    Write-Output ('debug-page-visible: ' + (Format-PageVisibleText $script:DebugPageVisibleOverride))
    $requiredMenuKeys = @('openDsh', 'action', 'actionSnuggle', 'actionCelebrate', 'actionIdle', 'topmostOn', 'topmostOff', 'alwaysShowOn', 'alwaysShowOff', 'closePet')
    $missingMenuKeys = @($requiredMenuKeys | Where-Object { -not $script:MenuLabels.ContainsKey($_) })
    Write-Output ('menu-keys: ' + (($script:MenuLabels.Keys | Sort-Object) -join ','))
    Write-Output ('menu-required: ' + ($requiredMenuKeys -join ','))
    Write-Output ('menu-missing: ' + $(if ($missingMenuKeys.Count -eq 0) { '(none)' } else { $missingMenuKeys -join ',' }))
    $dshHandle = Find-DshWindowHandle -DshPid $DshPid -DshProcessName $DshProcessName -TitleHint $TitleHint
    Write-Output ('dsh-window-handle: ' + $(if ($dshHandle -eq [IntPtr]::Zero) { '(none)' } else { $dshHandle.ToString() }))
    if ($null -eq $state) {
      Write-Output 'state: unreachable'
    } else {
      Write-Output ('state: mode={0} seq={1} waitingSeq={2} celebrateSeq={3}' -f (Get-StateString $state 'mode'), (Get-StateInt $state 'seq'), (Get-StateInt $state 'waitingSeq'), (Get-StateInt $state 'celebrateSeq'))
    }
    Write-Output ('dsh-pid: ' + $DshPid)
    Write-Output ('dsh-window-visible: ' + $visible)
    Write-Output ('overlay-would-show: ' + (-not $visible))
    Write-Output ('position-file: ' + $PosPath)
    Write-Output ('log-file: ' + $(if ([string]::IsNullOrEmpty($LogPath)) { '(none)' } else { $LogPath }))
  } catch {
    Write-Output ('dryrun-error: ' + $_.Exception.Message)
  }
  exit 0
}

# ---------------- single instance ----------------
$script:Mutex = New-Object System.Threading.Mutex($false, ('Local\' + $InstanceName))
$acquired = $false
try {
  $acquired = $script:Mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $acquired = $true
}
if (-not $acquired) {
  Write-Log 'another overlay instance already runs; exiting'
  exit 0
}

# ---------------- initial state + sprite (retry briefly while the Host serves routes) ----------------
$script:InitialState = $null
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  $script:InitialState = Get-StateSnapshot
  if ($null -ne $script:InitialState) { break }
  Start-Sleep -Milliseconds 250
}
$initialSpriteUrl = ''
if ($null -ne $script:InitialState) { $initialSpriteUrl = Get-StateString $script:InitialState 'spriteUrl' }
$script:SpriteSource = ''
if (-not (Load-Sheet $initialSpriteUrl)) {
  Write-Log 'no spritesheet available (neither state.spriteUrl nor assets/spritesheet.png); exiting'
  exit 1
}
# Measure the characters' union bbox before the window is created, so the very first
# WM_NCHITTEST already uses the reduced hit region.
[void](Update-PetHitRect)

# ---------------- window ----------------
$script:App = $null
$script:Window = $null
$script:FrameImage = $null
$script:Bubble = $null
$script:BubbleText = $null
$script:BubbleRoot = $null
$script:BubbleTail = $null
$script:HitSurface = $null

try {
  $script:App = New-Object System.Windows.Application
  $script:App.ShutdownMode = [System.Windows.ShutdownMode]::OnMainWindowClose

  $script:Window = New-Object System.Windows.Window
  $script:Window.Title = 'Claude x DeepSeek Pet'
  $script:Window.WindowStyle = [System.Windows.WindowStyle]::None
  $script:Window.AllowsTransparency = $true
  # The window itself stays fully transparent (alpha 0) so WindowFromPoint/DWM let
  # clicks fall through outside the characters. A separate alpha=1 "hit surface" below
  # covers only the measured character/bubble rectangle and makes that part clickable.
  $script:HitTestBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(1, 255, 255, 255))
  $script:Window.Background = [System.Windows.Media.Brushes]::Transparent
  $script:Window.Topmost = $true
  $script:Window.ShowInTaskbar = $false
  $script:Window.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $script:Window.ShowActivated = $false
  $script:Window.Width = [double]$script:PersonW
  $script:Window.Height = [double]$script:PersonH
  if ($script:DebugPaint) {
    # Opaque magenta proves whether the layered window itself reaches the screen.
    $debugBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(255, 0, 255))
    $script:Window.Background = $debugBrush
    Write-Log 'debug paint enabled: opaque magenta window background'
  }

  $script:FrameImage = New-Object System.Windows.Controls.Image
  $script:FrameImage.Width = $script:PetW
  $script:FrameImage.Height = $script:PetH
  $script:FrameImage.Stretch = [System.Windows.Media.Stretch]::Fill
  $script:FrameImage.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
  $script:FrameImage.VerticalAlignment = [System.Windows.VerticalAlignment]::Top
  $script:FrameImage.Margin = [System.Windows.Thickness]::new($script:ImageLeft, $script:ImageTop, 0, 0)
  [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($script:FrameImage, [System.Windows.Media.BitmapScalingMode]::HighQuality)
  $script:FrameImage.Cursor = [System.Windows.Input.Cursors]::Hand

  $script:BubbleText = New-Object System.Windows.Controls.TextBlock
  $script:BubbleText.Text = ''
  $script:BubbleText.FontSize = 13
  $script:BubbleText.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(43, 43, 51))
  $script:BubbleText.FontFamily = New-Object System.Windows.Media.FontFamily('Microsoft YaHei UI, Segoe UI')
  $script:BubbleText.TextWrapping = [System.Windows.TextWrapping]::Wrap
  $script:BubbleText.TextAlignment = [System.Windows.TextAlignment]::Center

  $script:Bubble = New-Object System.Windows.Controls.Border
  $script:Bubble.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(247, 255, 255, 255))
  $script:Bubble.BorderBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(30, 0, 0, 0))
  $script:Bubble.BorderThickness = [System.Windows.Thickness]::new(1)
  $script:Bubble.CornerRadius = [System.Windows.CornerRadius]::new(12)
  $script:Bubble.Padding = [System.Windows.Thickness]::new(10, 5, 10, 5)
  $script:Bubble.MaxWidth = [Math]::Max([double]80, [double]($script:PersonW - 8))
  $script:Bubble.Child = $script:BubbleText
  $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
  $shadow.BlurRadius = 8
  $shadow.Opacity = 0.18
  $shadow.ShadowDepth = 2
  $script:Bubble.Effect = $shadow

  # Small downward triangle: its tip points at Claude's head.
  $script:BubbleTail = New-Object System.Windows.Shapes.Polygon
  $tailPoints = New-Object System.Windows.Media.PointCollection
  [void]$tailPoints.Add([System.Windows.Point]::new(0, 0))
  [void]$tailPoints.Add([System.Windows.Point]::new([double]$script:BubbleTailWidth, 0))
  [void]$tailPoints.Add([System.Windows.Point]::new([double]$script:BubbleTailWidth / 2, [double]$script:BubbleTailHeight))
  $script:BubbleTail.Points = $tailPoints
  $script:BubbleTail.Fill = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(247, 255, 255, 255))
  $script:BubbleTail.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
  $script:BubbleTail.VerticalAlignment = [System.Windows.VerticalAlignment]::Top
  $script:BubbleTail.Margin = [System.Windows.Thickness]::new([double]$script:BubbleTailOffset, 0, 0, 0)
  $script:BubbleTail.IsHitTestVisible = $false

  $script:BubbleRoot = New-Object System.Windows.Controls.Grid
  $bubbleTextRow = New-Object System.Windows.Controls.RowDefinition
  $bubbleTextRow.Height = [System.Windows.GridLength]::Auto
  $bubbleTailRow = New-Object System.Windows.Controls.RowDefinition
  $bubbleTailRow.Height = [System.Windows.GridLength]::new([double]$script:BubbleTailHeight)
  [void]$script:BubbleRoot.RowDefinitions.Add($bubbleTextRow)
  [void]$script:BubbleRoot.RowDefinitions.Add($bubbleTailRow)
  [System.Windows.Controls.Grid]::SetRow($script:Bubble, 0)
  [System.Windows.Controls.Grid]::SetRow($script:BubbleTail, 1)
  [void]$script:BubbleRoot.Children.Add($script:Bubble)
  [void]$script:BubbleRoot.Children.Add($script:BubbleTail)
  $script:BubbleRoot.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
  $script:BubbleRoot.VerticalAlignment = [System.Windows.VerticalAlignment]::Bottom
  $script:BubbleRoot.IsHitTestVisible = $false
  # No text yet: the entire bubble (border, shadow and tail) must not render at all.
  $script:BubbleRoot.Visibility = [System.Windows.Visibility]::Collapsed

  $script:Layout = New-Object System.Windows.Controls.Grid
  if ($script:DebugPaint) {
    $script:Layout.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(255, 0, 255))
  }
  # Alpha=1 rectangular hit surface, sized to the measured pet/bubble union. Outside
  # this rectangle the layered window keeps alpha 0, so clicks reach the desktop.
  $script:HitSurface = New-Object System.Windows.Controls.Border
  $script:HitSurface.Background = $script:HitTestBrush
  $script:HitSurface.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
  $script:HitSurface.VerticalAlignment = [System.Windows.VerticalAlignment]::Top
  $script:HitSurface.IsHitTestVisible = $true
  $script:HitSurface.Margin = [System.Windows.Thickness]::new(0, 0, 0, 0)
  $script:RowBubble = New-Object System.Windows.Controls.RowDefinition
  $script:RowBubble.Height = [System.Windows.GridLength]::new(0.0)
  $script:RowPerson = New-Object System.Windows.Controls.RowDefinition
  $script:RowPerson.Height = [System.Windows.GridLength]::new([double]$script:PersonH)
  [void]$script:Layout.RowDefinitions.Add($script:RowBubble)
  [void]$script:Layout.RowDefinitions.Add($script:RowPerson)
  # The bubble spans both rows so it can sit directly above the character head; while
  # shown, row 0 grows and the window grows upward. The pet image lives in row 1.
  [System.Windows.Controls.Grid]::SetRowSpan($script:BubbleRoot, 2)
  [System.Windows.Controls.Grid]::SetRowSpan($script:HitSurface, 2)
  [System.Windows.Controls.Grid]::SetRow($script:FrameImage, 1)
  [void]$script:Layout.Children.Add($script:HitSurface)
  [void]$script:Layout.Children.Add($script:BubbleRoot)
  [void]$script:Layout.Children.Add($script:FrameImage)
  $script:Window.Content = $script:Layout
  $script:PetHitRect = [System.Windows.Rect]::new(0, 0, [double]$script:Window.Width, [double]$script:Window.Height)
  Update-BubbleGeometry
  Update-HitSurface
  Write-Log ('bubble initial visibility: {0}' -f $script:BubbleRoot.Visibility)
} catch {
  Write-Log ('overlay window creation failed: ' + $_.Exception.Message)
  exit 1
}

# ---------------- runtime state ----------------
$script:CurrentAnim = 'idle'
$script:FrameIndex = 0
$script:Dragging = $false
$script:DragStart = $null
$script:WindowStart = $null
$script:DragMoved = $false
# While dragging, the frame/auto timers are stopped so no sprite, hit-region or window
# geometry work runs between mouse moves (that per-frame re-layout caused jank at 150%).
$script:FrameTimerWasEnabled = $false
$script:AutoTimerWasEnabled = $false
$script:AlwaysShow = $false
$script:Baseline = $false
$script:LastWaitingSeq = -1
$script:LastCelebrateSeq = -1
$script:Waiting = 0
$script:PageVisible = $null
$script:LastVisibilityReason = ''
$script:LastSoundAllowed = $false
$script:SallyAvailable = $true
$script:DoneAvailable = $true
$script:LastSpriteUrl = $initialSpriteUrl
$script:SpriteSource = $(if ($script:SpriteSource -eq '') { 'none' } else { $script:SpriteSource })
$script:LastAudioKind = ''
$script:AudioTriedLocal = $false
$script:Player = $null
$script:BubbleKind = ''
$script:SallySince = [DateTime]::MinValue
$script:FirstFrameLogged = $false
$script:FrameErrorLogged = $false
if ($null -eq $script:PetHitRect) { [void](Update-PetHitRect) }
# Drag hit testing: only opaque sprite pixels start a drag. The cell alpha plane is
# built once per visible cell (row/col) on the first left-button press and cached.
$script:FrameAlpha = $null
$script:FrameAlphaKey = ''
$script:LeftPressOnPet = $false
$script:DragAlphaThreshold = 16
# WM_NCHITTEST hit region: union bbox of all sprite frames (window DIP) + visible bubble.
# NOTE: PetHitRect is measured before the window is created, so it must not be reset here.
$script:LastNcHitResult = ''
$script:HwndSource = $null
$script:NcHitTestHook = $null

if ($null -ne $script:InitialState) {
  $script:LastWaitingSeq = Get-StateInt $script:InitialState 'waitingSeq'
  $script:LastCelebrateSeq = Get-StateInt $script:InitialState 'celebrateSeq'
  $script:Waiting = Get-StateInt $script:InitialState 'waiting'
  $script:PageVisible = Get-StateBool $script:InitialState 'pageVisible'
  $initialTopmost = Get-StateBool $script:InitialState 'overlayTopmost'
  if ($null -ne $initialTopmost) { $script:OverlayTopmost = $initialTopmost }
  $initialAlways = Get-StateBool $script:InitialState 'overlayAlwaysShow'
  if ($null -ne $initialAlways) { $script:AlwaysShow = $initialAlways }
  $script:SallyAvailable = -not [string]::IsNullOrEmpty((Get-StateString $script:InitialState 'sallyUrl'))
  $script:DoneAvailable = -not [string]::IsNullOrEmpty((Get-StateString $script:InitialState 'doneUrl'))
  $script:Baseline = $true
}

# Apply persisted options to the window created above (Topmost starts true).
try { $script:Window.Topmost = [bool]$script:OverlayTopmost } catch { }

function Show-Frame {
  try {
    # Dragging must not touch Source/hit-region/window geometry at all.
    if ($script:Dragging) { return }
    if ($null -eq $script:FrameImage) { return }
    if ($null -eq $script:Sheet) {
      if (-not $script:FrameErrorLogged) {
        $script:FrameErrorLogged = $true
        Write-Log 'frame skipped: sprite sheet is null'
      }
      return
    }
    $spec = $script:Animations[$script:CurrentAnim]
    if ($null -eq $spec) { $spec = $script:Animations['idle'] }
    $count = $spec.Count
    if ($count -lt 1) { return }
    $index = $script:FrameIndex % $count
    if ($index -lt 0) { $index += $count }
    $cell = $spec[$index]
    $rect = New-Object System.Windows.Int32Rect(($cell.Col * $script:CellW), ($cell.Row * $script:CellH), $script:CellW, $script:CellH)
    $script:FrameImage.Source = New-Object System.Windows.Media.Imaging.CroppedBitmap($script:Sheet, $rect)
    if (-not $script:FirstFrameLogged) {
      $script:FirstFrameLogged = $true
      $source = $script:FrameImage.Source
      $sourceW = -1
      $sourceH = -1
      if ($null -ne $source) {
        $sourceW = $source.PixelWidth
        $sourceH = $source.PixelHeight
      }
      Write-Log ('first frame: anim={0} row={1} col={2} sourceNull={3} source={4}x{5} sheet={6}x{7}' -f
        $script:CurrentAnim, $cell.Row, $cell.Col, ($null -eq $source), $sourceW, $sourceH,
        $script:Sheet.PixelWidth, $script:Sheet.PixelHeight)
    }
    if ($null -ne $script:FrameTimer) {
      $script:FrameTimer.Interval = [TimeSpan]::FromMilliseconds([double]$cell.Ms)
    }
    # The hit region follows the currently displayed frame/cell.
    Update-PetHitRect
  } catch {
    if (-not $script:FrameErrorLogged) {
      $script:FrameErrorLogged = $true
      Write-Log ('frame render failed: ' + $_.Exception.Message)
    }
  }
}

function Start-Action([string]$Name) {
  if ([string]::IsNullOrEmpty($Name)) { return }
  if (-not $script:Animations.ContainsKey($Name)) { $Name = 'idle' }
  $script:AutoTimer.Stop()
  $script:CurrentAnim = $Name
  $script:FrameIndex = 0
  Show-Frame
  $script:FrameTimer.Start()
  if ($Name -eq 'idle') { $script:AutoTimer.Start() }
}

# Build/cache the alpha plane of the currently displayed cell (440x480, Bgra32).
# Called only on left-button down, so the copy does not run on the frame timer path.
function Get-FrameAlpha {
  try {
    if ($null -eq $script:Sheet) { return $null }
    $spec = $script:Animations[$script:CurrentAnim]
    if ($null -eq $spec) { $spec = $script:Animations['idle'] }
    $count = $spec.Count
    if ($count -lt 1) { return $null }
    $index = $script:FrameIndex % $count
    if ($index -lt 0) { $index += $count }
    $cell = $spec[$index]
    $key = ('{0}|{1}|{2}' -f $script:LastSpriteUrl, $cell.Row, $cell.Col)
    if ($script:FrameAlphaKey -eq $key -and $null -ne $script:FrameAlpha) {
      return $script:FrameAlpha
    }
    $rect = New-Object System.Windows.Int32Rect(($cell.Col * $script:CellW), ($cell.Row * $script:CellH), $script:CellW, $script:CellH)
    $cropped = New-Object System.Windows.Media.Imaging.CroppedBitmap($script:Sheet, $rect)
    $converted = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($cropped, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
    $stride = $script:CellW * 4
    $pixels = [byte[]]::new($stride * $script:CellH)
    $converted.CopyPixels($pixels, $stride, 0)
    $script:FrameAlpha = $pixels
    $script:FrameAlphaKey = $key
    return $pixels
  } catch {
    Write-Log ('frame alpha failed: ' + $_.Exception.Message)
    return $null
  }
}

# True when the window point (DIP, relative to the window) lands on an opaque sprite
# pixel (alpha > 16); transparent padding returns false and never starts a drag.
function Test-PetAlphaAtPoint([double]$X, [double]$Y) {
  try {
    # Window coordinates -> pet image coordinates: row 1 starts at BubbleExtra, the
    # image itself is shifted by ImageLeft/ImageTop inside that row.
    $imageX = $X - [double]$script:ImageLeft
    $imageY = $Y - [double]$script:BubbleExtra - [double]$script:ImageTop
    if ($imageX -lt 0 -or $imageX -ge $script:PetW) { return $false }
    if ($imageY -lt 0 -or $imageY -ge $script:PetH) { return $false }
    $pixels = Get-FrameAlpha
    if ($null -eq $pixels) { return $false }
    $cellX = [int][Math]::Floor(($imageX / [double]$script:PetW) * [double]$script:CellW)
    $cellY = [int][Math]::Floor(($imageY / [double]$script:PetH) * [double]$script:CellH)
    if ($cellX -lt 0) { $cellX = 0 } elseif ($cellX -ge $script:CellW) { $cellX = $script:CellW - 1 }
    if ($cellY -lt 0) { $cellY = 0 } elseif ($cellY -ge $script:CellH) { $cellY = $script:CellH - 1 }
    $offset = (($cellY * $script:CellW) + $cellX) * 4 + 3
    return ([int]$pixels[$offset] -gt $script:DragAlphaThreshold)
  } catch {
    return $false
  }
}

function Test-OverlayVisible {
  # The desktop pet is only allowed to make noise while its window is actually shown
  # on screen. When DSH is visible the overlay is hidden, so the in-page pet owns the
  # audio; hearing both was the reported double/echoed "done" sound.
  try {
    if ($null -eq $script:Window) { return $false }
    return [bool]$script:Window.IsVisible
  } catch {
    return $false
  }
}

function Stop-OverlaySound {
  try {
    if ($null -ne $script:Player) { $script:Player.Stop() }
  } catch {
    # player may not be created yet / already disposed
  }
}

function Set-Bubble([string]$Key, [string]$Kind, [int]$Ms) {
  if (-not (Test-OverlayVisible)) {
    Write-Log ('bubble skipped (hidden): ' + $Key)
    $script:BubbleKind = ''
    if ($null -ne $script:BubbleRoot) {
      $script:BubbleRoot.Visibility = [System.Windows.Visibility]::Collapsed
    }
    return
  }
  $script:BubbleKind = $Kind
  $text = ''
  if ($script:Bubbles.ContainsKey($Key)) { $text = [string]$script:Bubbles[$Key] }
  $script:BubbleText.Text = $text
  if ($null -ne $script:BubbleRoot) {
    if ([string]::IsNullOrEmpty($text)) {
      # Collapsed (not Hidden/transparent): nothing of the bubble is rendered.
      $script:BubbleRoot.Visibility = [System.Windows.Visibility]::Collapsed
    } else {
      $script:Bubble.MaxWidth = [Math]::Max([double]80, [double]($script:PersonW - 8))
      $script:BubbleRoot.Visibility = [System.Windows.Visibility]::Visible
      Update-BubbleGeometry
      if ($null -ne $script:Window) {
        # Measure the bubble at the person-only window size, then grow the window
        # upward by bubble height + head gap so the character does not move on screen.
        $script:Window.UpdateLayout()
        $bubbleHeight = [double]$script:BubbleRoot.ActualHeight
        if ($bubbleHeight -le 0) { $bubbleHeight = 42 }
        $script:BubbleHeight = $bubbleHeight
        $script:BubbleExtra = [int][Math]::Ceiling($bubbleHeight + [double]$script:BubbleHeadGap + 6)
        [void](Apply-WindowGeometry 'bubble shown')
        Update-BubbleGeometry
        $script:Window.UpdateLayout()
        Update-HitSurface
        Write-Log ('bubble expand: bubbleH={0} extra={1} window={2}x{3}' -f
          [int]$bubbleHeight, $script:BubbleExtra, [int]$script:Window.Width, [int]$script:Window.Height)
      }
    }
  }
  $script:BubbleTimer.Stop()
  if ($Ms -gt 0) {
    $script:BubbleTimer.Interval = [TimeSpan]::FromMilliseconds([double]$Ms)
    $script:BubbleTimer.Start()
  }
}

function Hide-Bubble([string]$OnlyKind) {
  if (-not [string]::IsNullOrEmpty($OnlyKind) -and $script:BubbleKind -ne $OnlyKind) { return }
  $script:BubbleKind = ''
  $script:BubbleTimer.Stop()
  $script:SallyEndTimer.Stop()
  $script:BubbleText.Text = ''
  if ($null -ne $script:BubbleRoot) {
    $script:BubbleRoot.Visibility = [System.Windows.Visibility]::Collapsed
  }
  $script:BubbleExtra = 0
  $script:BubbleHeight = 0
  if ($null -ne $script:Window) {
    [void](Apply-WindowGeometry 'bubble hidden')
    $script:Window.UpdateLayout()
    Update-HitSurface
    Write-Log ('bubble collapse: window={0}x{1} pos={2},{3}' -f
      [int]$script:Window.Width, [int]$script:Window.Height, [int]$script:Window.Left, [int]$script:Window.Top)
  }
}

function Play-LocalSound([string]$Kind) {
  if ($script:AudioTriedLocal) { return }
  $script:AudioTriedLocal = $true
  # Only the local fallback of an already-allowed sound may play; never resurrect a
  # sound that the page-visibility decision skipped.
  if (-not $script:LastSoundAllowed) {
    Write-Log ('sound skipped (fallback): ' + $Kind)
    return
  }
  if ($null -eq $script:Player) { return }
  $path = Join-Path $AssetsDir ($Kind + '.mp3')
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Log ('local audio missing: ' + $path)
    return
  }
  try {
    $script:Player.Stop()
    $script:Player.Open([Uri]::new($path))
    $script:Player.Position = [TimeSpan]::Zero
    $script:Player.Play()
    Write-Log ('audio fallback to local ' + $Kind)
  } catch {
    Write-Log ('local audio failed: ' + $_.Exception.Message)
  }
}

# Decide which side owns audio for this event:
#   pageVisible=false  -> page cannot hear itself, overlay plays (even while hidden)
#   pageVisible=true   -> page plays, overlay stays silent
#   pageVisible=null   -> old Host / no report: fall back to "overlay only if visible"
function Get-SoundDecision([string]$Kind) {
  $overlayVisible = Test-OverlayVisible
  $pageVisible = $script:PageVisible
  if ($null -ne $script:DebugPageVisibleOverride) { $pageVisible = $script:DebugPageVisibleOverride }
  $pageText = Format-PageVisibleText $pageVisible
  $overlayText = 'False'
  if ($overlayVisible) { $overlayText = 'True' }
  $play = $false
  if ($null -eq $pageVisible) {
    $play = $overlayVisible
  } elseif ($pageVisible -eq $false) {
    $play = $true
  } else {
    $play = $false
  }
  $action = 'skip'
  if ($play) { $action = 'play' }
  Write-Log ('sound decision: pageVisible={0} overlayVisible={1} -> {2}' -f $pageText, $overlayText, $action)
  if (-not $play -and $Kind -ne '') { Write-Log ('sound skipped: ' + $Kind) }
  return $play
}

function Play-Sound([string]$Kind, [switch]$Force) {
  # There is deliberately no queue: a skipped sound is dropped, never replayed when
  # the overlay or the page becomes visible again.
  $play = $false
  if ($Force) {
    # Manual menu action: the overlay window is visible by definition; page-side
    # ownership does not apply because the page never sees this manual action.
    $overlayVisible = Test-OverlayVisible
    $play = $overlayVisible
    $pageVisible = $script:PageVisible
    if ($null -ne $script:DebugPageVisibleOverride) { $pageVisible = $script:DebugPageVisibleOverride }
    $overlayText = 'False'
    if ($overlayVisible) { $overlayText = 'True' }
    $action = 'skip'
    if ($play) { $action = 'play' }
    Write-Log ('sound decision: pageVisible={0} overlayVisible={1} -> {2} (manual)' -f
      (Format-PageVisibleText $pageVisible), $overlayText, $action)
  } else {
    $play = Get-SoundDecision $Kind
  }
  if (-not $play) {
    if (-not (Test-OverlayVisible) -and $script:PageVisible -ne $false) {
      Write-Log ('sound skipped (hidden): ' + $Kind)
    }
    $script:LastSoundAllowed = $false
    return
  }
  $script:LastSoundAllowed = $true
  Write-Log ('playing sound: ' + $Kind)
  try {
    if ($null -eq $script:Player) {
      $script:Player = New-Object System.Windows.Media.MediaPlayer
      $script:Player.Volume = 1.0
      $script:Player.Add_MediaFailed({
        param($sender, $eventArgs)
        $reason = 'media failed'
        try { $reason = $eventArgs.ErrorException.Message } catch { }
        Write-Log $reason
        Play-LocalSound $script:LastAudioKind
      })
    }
    $script:LastAudioKind = $Kind
    $script:AudioTriedLocal = $false
    $url = "$Origin/duo-pet/done.mp3?dv=2"
    if ($Kind -eq 'sally') { $url = "$Origin/duo-pet/sally.mp3?av=2" }
    $script:Player.Stop()
    $script:Player.Open([Uri]::new($url))
    $script:Player.Position = [TimeSpan]::Zero
    $script:Player.Play()
  } catch {
    Write-Log ('audio open failed: ' + $_.Exception.Message)
    Play-LocalSound $Kind
  }
}

function Show-Sally {
  $script:SallySince = Get-Date
  Set-Bubble 'sally' 'sally' $script:BubbleSallyMaxMs
  $script:SallyEndTimer.Stop()
  if ($script:Waiting -le 0) {
    $script:SallyEndTimer.Interval = [TimeSpan]::FromMilliseconds([double]$script:BubbleSallyMs)
    $script:SallyEndTimer.Start()
  }
  if ($script:SallyAvailable) { Play-Sound 'sally' }
  if ($script:CurrentAnim -ne 'done') { Start-Action 'snuggle' }
}

function Show-Done {
  Set-Bubble 'done' 'done' $script:BubbleDoneMs
  if ($script:DoneAvailable) { Play-Sound 'done' }
  Start-Action 'done'
}

# ---------------- context-menu actions ----------------
# Manual actions preempt the automatic 5s loop exactly like the Host events do:
# Start-Action stops the idle auto timer, and when a non-idle action finishes the
# frame timer starts idle again, which restarts the automatic cycle.
function Invoke-ManualSnuggle {
  Write-Log 'menu action: snuggle'
  Start-Action 'snuggle'
}

function Invoke-ManualCelebrate {
  Write-Log 'menu action: celebrate (done)'
  Set-Bubble 'done' 'done' $script:BubbleDoneMs
  if ($script:DoneAvailable) { Play-Sound 'done' -Force }
  Start-Action 'done'
}

function Invoke-ManualIdle {
  Write-Log 'menu action: idle'
  Start-Action 'idle'
}

function Invoke-OpenDsh {
  try {
    $result = Restore-DshWindow -DshPid $DshPid -DshProcessName $DshProcessName -TitleHint $TitleHint
    if (-not $result.Found) {
      Write-Log 'open-dsh: no DSH window found for the configured process name / title hints'
      return
    }
    Write-Log ('open-dsh: hwnd={0} wasVisible={1} wasIconic={2} showResult={3} foreground={4}' -f
      $result.Hwnd, $result.WasVisible, $result.WasIconic, $result.ShowResult, $result.Foreground)
  } catch {
    Write-Log ('open-dsh failed: ' + $_.Exception.Message)
  }
}

function Send-OverlayOption([hashtable]$Option) {
  try {
    $json = $Option | ConvertTo-Json -Compress
    $uri = $Origin.TrimEnd('/') + '/duo-pet/overlay-option'
    $null = Invoke-RestMethod -Uri $uri -Method Post -ContentType 'application/json' -Body $json -TimeoutSec 2
    Write-Log ('overlay-option posted: ' + $json)
  } catch {
    Write-Log ('overlay-option post failed: ' + $_.Exception.Message)
  }
}

function Apply-State($State) {
  if ($null -eq $State) { return }
  $spriteUrl = Get-StateString $State 'spriteUrl'
  $script:PageVisible = Get-StateBool $State 'pageVisible'
  $hostTopmost = Get-StateBool $State 'overlayTopmost'
  if ($null -ne $hostTopmost) {
    $script:OverlayTopmost = $hostTopmost
    if ($null -ne $script:Window -and ([bool]$script:Window.Topmost -ne [bool]$hostTopmost)) {
      $script:Window.Topmost = [bool]$hostTopmost
      Write-Log ('topmost applied from host: {0}' -f $script:OverlayTopmost)
    }
    if ($null -ne $script:TopmostItem) {
      if ($script:OverlayTopmost) {
        $script:TopmostItem.Header = Get-MenuLabel 'topmostOff' 'Unpin topmost'
      } else {
        $script:TopmostItem.Header = Get-MenuLabel 'topmostOn' 'Pin topmost'
      }
    }
  }
  $hostAlways = Get-StateBool $State 'overlayAlwaysShow'
  if ($null -ne $hostAlways -and [bool]$hostAlways -ne [bool]$script:AlwaysShow) {
    $script:AlwaysShow = [bool]$hostAlways
    if ($null -ne $script:AlwaysItem) {
      if ($script:AlwaysShow) {
        $script:AlwaysItem.Header = Get-MenuLabel 'alwaysShowOff' 'Only while minimized'
      } else {
        $script:AlwaysItem.Header = Get-MenuLabel 'alwaysShowOn' 'Always show'
      }
    }
    Write-Log ('overlay always-show applied from host: {0}' -f $script:AlwaysShow)
    Update-Visibility
  }
  $script:SallyAvailable = -not [string]::IsNullOrEmpty((Get-StateString $State 'sallyUrl'))
  $script:DoneAvailable = -not [string]::IsNullOrEmpty((Get-StateString $State 'doneUrl'))
  if (-not [string]::IsNullOrEmpty($spriteUrl) -and $spriteUrl -ne $script:LastSpriteUrl) {
    $script:LastSpriteUrl = $spriteUrl
    if (Load-Sheet $spriteUrl) {
      Show-Frame
      Update-BubbleGeometry
      [void](Update-PetHitRect)
      Update-HitSurface
    }
  }

  $waitingSeq = Get-StateInt $State 'waitingSeq'
  $celebrateSeq = Get-StateInt $State 'celebrateSeq'
  $waitingNow = Get-StateInt $State 'waiting'
  $previousWaiting = $script:Waiting
  $script:Waiting = $waitingNow

  if (-not $script:Baseline) {
    $script:LastWaitingSeq = $waitingSeq
    $script:LastCelebrateSeq = $celebrateSeq
    $script:Baseline = $true
  } else {
    if ($waitingSeq -gt $script:LastWaitingSeq) {
      $script:LastWaitingSeq = $waitingSeq
      Show-Sally
    } elseif ($waitingSeq -lt $script:LastWaitingSeq) {
      # Host restarted and reset its counters: re-baseline instead of replaying history.
      $script:LastWaitingSeq = $waitingSeq
    }
    if ($celebrateSeq -gt $script:LastCelebrateSeq) {
      $script:LastCelebrateSeq = $celebrateSeq
      Show-Done
    } elseif ($celebrateSeq -lt $script:LastCelebrateSeq) {
      $script:LastCelebrateSeq = $celebrateSeq
    }
  }

  if ($script:BubbleKind -eq 'sally') {
    if ($waitingNow -gt 0) {
      $script:SallyEndTimer.Stop()
    } elseif ($previousWaiting -gt 0) {
      $elapsed = ((Get-Date) - $script:SallySince).TotalMilliseconds
      $delay = [Math]::Max([double]$script:BubbleSallyEndHoldMs, [double]($script:BubbleSallyMs - $elapsed))
      $script:SallyEndTimer.Stop()
      $script:SallyEndTimer.Interval = [TimeSpan]::FromMilliseconds($delay)
      $script:SallyEndTimer.Start()
    }
  }
}

# ---------------- pointer interaction ----------------
# Open the context menu manually at the mouse position. Relying on the Window's
# ContextMenu property alone can be lost when the layered window's hit testing is
# unusual, so both the right-button handler and ContextMenuOpening land here.
function Open-ContextMenuAtMouse($EventArgs) {
  try {
    $position = $EventArgs.GetPosition($script:Window)
    $hit = $script:Window.InputHitTest($position)
    $hitName = 'null'
    if ($null -ne $hit) {
      try { $hitName = $hit.GetType().Name } catch { }
    }
    Write-Log ('context-menu-open requested at {0},{1} hit={2}' -f [int]$position.X, [int]$position.Y, $hitName)
    $script:Menu.PlacementTarget = $script:Window
    $script:Menu.Placement = [System.Windows.Controls.Primitives.PlacementMode]::MousePoint
    $script:Menu.IsOpen = $true
    Write-Log ('context-menu-open: isOpen={0}' -f $script:Menu.IsOpen)
  } catch {
    Write-Log ('context-menu-open failed: ' + $_.Exception.Message)
  }
}

$script:Window.Add_PreviewMouseRightButtonDown({
  param($sender, $eventArgs)
  Write-Log 'preview-mouse-right-down'
})

$script:Window.Add_PreviewMouseRightButtonUp({
  param($sender, $eventArgs)
  Write-Log 'preview-mouse-right-up'
  Open-ContextMenuAtMouse $eventArgs
  $eventArgs.Handled = $true
})

$script:Window.Add_MouseRightButtonUp({
  param($sender, $eventArgs)
  # Only reached if the preview handler did not handle the event.
  Write-Log 'mouse-right-up (unhandled by preview)'
  Open-ContextMenuAtMouse $eventArgs
  $eventArgs.Handled = $true
})

$script:Window.Add_ContextMenuOpening({
  param($sender, $eventArgs)
  Write-Log 'context-menu-opening'
})

# Shared drag implementation (mouse handlers + -DebugAutoDrag both use these).
# Positions are ABSOLUTE screen coordinates (DIP), never window-relative deltas: the
# old client-coordinate delta flipped sign each time the window moved under the cursor,
# which caused the visible oscillation/ghosting. Move events only update a target; a
# CompositionTarget-rate timer applies the latest target at most once per tick.
function Get-OverlayDpiScale {
  try {
    $scale = [System.Windows.Media.VisualTreeHelper]::GetDpi($script:Window).DpiScaleX
    if ($scale -le 0) { $scale = 1.0 }
    return [double]$scale
  } catch {
    return 1.0
  }
}

function Convert-ClientToScreenDip([System.Windows.Point]$ClientPoint) {
  try {
    $device = $script:Window.PointToScreen($ClientPoint)
    $scale = Get-OverlayDpiScale
    return @([double]($device.X / $scale), [double]($device.Y / $scale))
  } catch {
    return @(0.0, 0.0)
  }
}

function Begin-OverlayDrag([double]$ScreenX, [double]$ScreenY) {
  if ($script:Dragging) { return }
  $script:Dragging = $true
  $script:DragMoved = $false
  $script:DragStartScreenX = [double]$ScreenX
  $script:DragStartScreenY = [double]$ScreenY
  $script:DragTargetScreenX = [double]$ScreenX
  $script:DragTargetScreenY = [double]$ScreenY
  $script:DragMoveSteps = 0
  $script:DragMoveLogPending = $false
  $script:WindowStart = New-Object System.Windows.Point($script:Window.Left, $script:Window.Top)
  if ($null -ne $script:FrameTimer) {
    $script:FrameTimerWasEnabled = [bool]$script:FrameTimer.IsEnabled
    $script:FrameTimer.Stop()
  }
  if ($null -ne $script:AutoTimer) {
    $script:AutoTimerWasEnabled = [bool]$script:AutoTimer.IsEnabled
    $script:AutoTimer.Stop()
  }
  [void]$script:Window.CaptureMouse()
  if ($null -ne $script:DragCoalesceTimer) { $script:DragCoalesceTimer.Start() }
  Write-Log ('drag start at screen {0},{1} (alpha ok)' -f [int]$ScreenX, [int]$ScreenY)
}

function Apply-DragTarget {
  if (-not $script:Dragging) { return }
  $dx = [double]$script:DragTargetScreenX - [double]$script:DragStartScreenX
  $dy = [double]$script:DragTargetScreenY - [double]$script:DragStartScreenY
  if ([Math]::Abs($dx) -gt 6 -or [Math]::Abs($dy) -gt 6) { $script:DragMoved = $true }
  # Absolute target from the drag start; no per-move accumulation.
  $script:Window.Left = $script:WindowStart.X + $dx
  $script:Window.Top = $script:WindowStart.Y + $dy
  if ($script:DragMoveLogPending) {
    $script:DragMoveLogPending = $false
    Write-Log ('drag move: cursor={0},{1} left={2} top={3}' -f
      [int]$script:DragTargetScreenX, [int]$script:DragTargetScreenY,
      [int]$script:Window.Left, [int]$script:Window.Top)
  }
}

function Update-OverlayDrag([double]$ScreenX, [double]$ScreenY) {
  if (-not $script:Dragging) { return }
  $script:DragTargetScreenX = [double]$ScreenX
  $script:DragTargetScreenY = [double]$ScreenY
  $script:DragMoveSteps += 1
  if (($script:DragMoveSteps % 10) -eq 0) { $script:DragMoveLogPending = $true }
}

function End-OverlayDrag {
  if (-not $script:Dragging) { return }
  if ($null -ne $script:DragCoalesceTimer) { $script:DragCoalesceTimer.Stop() }
  Apply-DragTarget
  $script:Dragging = $false
  [void]$script:Window.ReleaseMouseCapture()
  if ($script:DragMoved) {
    # Drag/memory coordinates are the person window, not the bubble-expanded window.
    $personTop = [double]$script:Window.Top + [double]$script:BubbleExtra
    $clamped = Clamp-Position $script:Window.Left $personTop $script:PersonW $script:PersonH
    $script:Window.Left = $clamped[0]
    $script:Window.Top = $clamped[1] - [double]$script:BubbleExtra
    $totalClamped = Get-ClampedWindowPosition $script:Window.Left $script:Window.Top ([Math]::Max([double]$script:PersonW, [double]$script:Window.Width)) ([Math]::Max([double]($script:PersonH + $script:BubbleExtra), [double]$script:Window.Height))
    $script:Window.Left = $totalClamped[0]
    $script:Window.Top = $totalClamped[1]
    Update-AnchorFromWindow
    Save-Position
    Write-Log ('drag end (moved) at person={0},{1} window={2},{3} extra={4}' -f
      [int]$script:Window.Left, [int]$personTop, [int]$script:Window.Left, [int]$script:Window.Top, $script:BubbleExtra)
    [void](Apply-WindowGeometry 'drag end')
  } else {
    Write-Log 'drag end (click, no move)'
    if ($script:CurrentAnim -ne 'done') { Start-Action 'snuggle' }
  }
  if ($script:FrameTimerWasEnabled -and $null -ne $script:FrameTimer -and -not $script:FrameTimer.IsEnabled) {
    $script:FrameTimer.Start()
  }
  if ($script:AutoTimerWasEnabled -and $script:CurrentAnim -eq 'idle' -and $null -ne $script:AutoTimer -and -not $script:AutoTimer.IsEnabled) {
    $script:AutoTimer.Start()
  }
  $script:FrameTimerWasEnabled = $false
  $script:AutoTimerWasEnabled = $false
  Write-Log 'drag end: animation/geometry resumed'
}

# Mix high-frequency mouse moves down to at most one window move per ~8ms tick.
$script:DragCoalesceTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:DragCoalesceTimer.Interval = [TimeSpan]::FromMilliseconds(8)
$script:DragCoalesceTimer.Add_Tick({ Apply-DragTarget })

$script:Window.Add_MouseLeftButtonDown({
  param($sender, $eventArgs)
  $position = $eventArgs.GetPosition($script:Window)
  if (-not (Test-PetAlphaAtPoint $position.X $position.Y)) {
    # Transparent padding does not start a drag (and the later click action is skipped).
    $script:LeftPressOnPet = $false
    Write-Log ('drag skipped (transparent pixel) at {0},{1}' -f [int]$position.X, [int]$position.Y)
    return
  }
  $script:LeftPressOnPet = $true
  $screen = Convert-ClientToScreenDip $position
  Begin-OverlayDrag $screen[0] $screen[1]
})

$script:Window.Add_MouseMove({
  param($sender, $eventArgs)
  if (-not $script:Dragging) { return }
  $screen = Convert-ClientToScreenDip $eventArgs.GetPosition($script:Window)
  Update-OverlayDrag $screen[0] $screen[1]
})

$script:Window.Add_MouseLeftButtonUp({
  param($sender, $eventArgs)
  if (-not $script:Dragging) {
    if (-not $script:LeftPressOnPet) {
      Write-Log 'left click skipped (transparent pixel)'
    }
    $script:LeftPressOnPet = $false
    return
  }
  $script:LeftPressOnPet = $false
  End-OverlayDrag
})

function Clamp-Position([double]$Left, [double]$Top, [double]$Width, [double]$Height, [double]$Margin = 0) {
  $vsLeft = [double][System.Windows.SystemParameters]::VirtualScreenLeft
  $vsTop = [double][System.Windows.SystemParameters]::VirtualScreenTop
  $vsRight = $vsLeft + [double][System.Windows.SystemParameters]::VirtualScreenWidth
  $vsBottom = $vsTop + [double][System.Windows.SystemParameters]::VirtualScreenHeight
  $leftBound = $vsLeft + $Margin
  $topBound = $vsTop + $Margin
  $rightBound = $vsRight - $Margin
  $bottomBound = $vsBottom - $Margin
  if (($rightBound - $Width) -lt $leftBound) { $rightBound = $leftBound + $Width }
  if (($bottomBound - $Height) -lt $topBound) { $bottomBound = $topBound + $Height }
  if ($Left -lt $leftBound) { $Left = $leftBound }
  if ($Top -lt $topBound) { $Top = $topBound }
  if (($Left + $Width) -gt $rightBound) { $Left = $rightBound - $Width }
  if (($Top + $Height) -gt $bottomBound) { $Top = $bottomBound - $Height }
  return @($Left, $Top)
}

function Read-SavedPosition {
  try {
    if (-not (Test-Path -LiteralPath $PosPath)) { return $null }
    $raw = Get-Content -LiteralPath $PosPath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    $value = $raw | ConvertFrom-Json
    if ($null -eq $value.left -or $null -eq $value.top) { return $null }
    return @([double]$value.left, [double]$value.top)
  } catch {
    return $null
  }
}

function Save-Position {
  try {
    # Persist the person-window top-left (remove the temporary bubble expansion).
    $personTop = [double]$script:Window.Top + [double]$script:BubbleExtra
    $payload = [pscustomobject]@{
      left = [int][Math]::Round($script:Window.Left)
      top = [int][Math]::Round($personTop)
    }
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $PosPath -Encoding UTF8
  } catch {
    Write-Log ('position save failed: ' + $_.Exception.Message)
  }
}

# ---------------- context menu ----------------
$script:Menu = New-Object System.Windows.Controls.ContextMenu

$script:OpenDshItem = New-Object System.Windows.Controls.MenuItem
$script:OpenDshItem.Header = Get-MenuLabel 'openDsh' 'Open DSH'
$script:OpenDshItem.Add_Click({
  Invoke-OpenDsh
})
[void]$script:Menu.Items.Add($script:OpenDshItem)

$script:ActionItem = New-Object System.Windows.Controls.MenuItem
$script:ActionItem.Header = Get-MenuLabel 'action' 'Actions'

$script:SnuggleItem = New-Object System.Windows.Controls.MenuItem
$script:SnuggleItem.Header = Get-MenuLabel 'actionSnuggle' 'Snuggle'
$script:SnuggleItem.Add_Click({
  Invoke-ManualSnuggle
})
[void]$script:ActionItem.Items.Add($script:SnuggleItem)

$script:CelebrateItem = New-Object System.Windows.Controls.MenuItem
$script:CelebrateItem.Header = Get-MenuLabel 'actionCelebrate' 'Celebrate'
$script:CelebrateItem.Add_Click({
  Invoke-ManualCelebrate
})
[void]$script:ActionItem.Items.Add($script:CelebrateItem)

$script:IdleItem = New-Object System.Windows.Controls.MenuItem
$script:IdleItem.Header = Get-MenuLabel 'actionIdle' 'Idle'
$script:IdleItem.Add_Click({
  Invoke-ManualIdle
})
[void]$script:ActionItem.Items.Add($script:IdleItem)

[void]$script:Menu.Items.Add($script:ActionItem)
[void]$script:Menu.Items.Add((New-Object System.Windows.Controls.Separator))

$script:TopmostItem = New-Object System.Windows.Controls.MenuItem
if ($script:OverlayTopmost) {
  $script:TopmostItem.Header = Get-MenuLabel 'topmostOff' 'Unpin topmost'
} else {
  $script:TopmostItem.Header = Get-MenuLabel 'topmostOn' 'Pin topmost'
}
$script:TopmostItem.Add_Click({
  $newTopmost = -not [bool]$script:Window.Topmost
  $script:Window.Topmost = $newTopmost
  $script:OverlayTopmost = $newTopmost
  if ($newTopmost) {
    $script:TopmostItem.Header = Get-MenuLabel 'topmostOff' 'Unpin topmost'
  } else {
    $script:TopmostItem.Header = Get-MenuLabel 'topmostOn' 'Pin topmost'
  }
  Send-OverlayOption @{ topmost = $newTopmost }
})
[void]$script:Menu.Items.Add($script:TopmostItem)

$script:AlwaysItem = New-Object System.Windows.Controls.MenuItem
if ($script:AlwaysShow) {
  $script:AlwaysItem.Header = Get-MenuLabel 'alwaysShowOff' 'Only while minimized'
} else {
  $script:AlwaysItem.Header = Get-MenuLabel 'alwaysShowOn' 'Always show'
}
$script:AlwaysItem.Add_Click({
  $script:AlwaysShow = -not [bool]$script:AlwaysShow
  if ($script:AlwaysShow) {
    $script:AlwaysItem.Header = Get-MenuLabel 'alwaysShowOff' 'Only while minimized'
  } else {
    $script:AlwaysItem.Header = Get-MenuLabel 'alwaysShowOn' 'Always show'
  }
  Send-OverlayOption @{ alwaysShow = [bool]$script:AlwaysShow }
  Update-Visibility
})
[void]$script:Menu.Items.Add($script:AlwaysItem)

[void]$script:Menu.Items.Add((New-Object System.Windows.Controls.Separator))

$script:CloseItem = New-Object System.Windows.Controls.MenuItem
$script:CloseItem.Header = Get-MenuLabel 'closePet' 'Close pet'
$script:CloseItem.Add_Click({
  Write-Log 'menu action: close pet'
  Save-Position
  $script:Window.Close()
})
[void]$script:Menu.Items.Add($script:CloseItem)

$script:Menu.Add_Opened({
  Write-Log 'context menu opened'
})
$script:Menu.Add_Closed({
  Write-Log 'context menu closed'
})
# Deliberately do NOT assign $script:Window.ContextMenu: the automatic ContextMenu
# service depends on WPF hit testing that can be unreliable on layered windows. The
# PreviewMouseRightButtonUp handler above opens the menu explicitly instead.
Write-Log ('context menu ready: items={0} actions={1}' -f $script:Menu.Items.Count, $script:ActionItem.Items.Count)

# ---------------- timers ----------------
$script:FrameTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:FrameTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$script:FrameTimer.Add_Tick({
  if ($script:Dragging) { return }
  $spec = $script:Animations[$script:CurrentAnim]
  if ($null -eq $spec) { $spec = $script:Animations['idle'] }
  $script:FrameIndex++
  if ($script:FrameIndex -ge $spec.Count) {
    if ($script:CurrentAnim -eq 'idle') {
      $script:FrameIndex = 0
    } else {
      Start-Action 'idle'
      return
    }
  }
  Show-Frame
})

$script:AutoTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:AutoTimer.Interval = [TimeSpan]::FromMilliseconds([double]$script:IdleMs)
$script:AutoTimer.Add_Tick({
  $script:AutoTimer.Stop()
  if ($script:CurrentAnim -eq 'idle' -and -not $script:Dragging) { Start-Action 'snuggle' }
})

$script:BubbleTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:BubbleTimer.Interval = [TimeSpan]::FromMilliseconds([double]$script:BubbleSallyMs)
$script:BubbleTimer.Add_Tick({
  $script:BubbleTimer.Stop()
  Hide-Bubble ''
})

$script:SallyEndTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:SallyEndTimer.Interval = [TimeSpan]::FromMilliseconds([double]$script:BubbleSallyEndHoldMs)
$script:SallyEndTimer.Add_Tick({
  $script:SallyEndTimer.Stop()
  Hide-Bubble 'sally'
})

$script:StateTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:StateTimer.Interval = [TimeSpan]::FromMilliseconds(500)
$script:StateTimer.Add_Tick({
  $state = Get-StateSnapshot
  if ($null -eq $state) { return }
  Apply-State $state
})

$script:VisibilityTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:VisibilityTimer.Interval = [TimeSpan]::FromMilliseconds(700)
$script:VisibilityTimer.Add_Tick({ Update-Visibility })

$script:LifeTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:LifeTimer.Interval = [TimeSpan]::FromMilliseconds(3000)
$script:LifeTimer.Add_Tick({
  if ($HostPid -le 0) { return }
  $hostProcess = Get-Process -Id $HostPid -ErrorAction SilentlyContinue
  if ($null -eq $hostProcess) {
    Write-Log 'host process exited; closing overlay'
    $script:Window.Close()
  }
})

function Update-Visibility {
  # Visibility ownership is driven by the page first:
  #   pageVisible=true  -> overlay always hides (only ONE pet: the in-page one)
  #   pageVisible=false -> overlay shows (page hidden/minimized/tab switched)
  #   pageVisible=null  -> older Host/no report: fall back to the DSH window probe
  # -AlwaysShow / -DebugPaint are explicit user/test overrides.
  $pageVisible = $script:PageVisible
  if ($null -ne $script:DebugPageVisibleOverride) { $pageVisible = $script:DebugPageVisibleOverride }
  $shouldShow = $false
  $reason = ''
  if ($script:DebugEventHidden) {
    $shouldShow = $false
    $reason = 'debug hidden'
  } elseif ($script:DebugPaint) {
    $shouldShow = $true
    $reason = 'debug paint'
  } elseif ($script:AlwaysShow) {
    $shouldShow = $true
    $reason = 'always show'
  } elseif ($pageVisible -eq $true) {
    $shouldShow = $false
    $reason = 'page visible'
  } elseif ($pageVisible -eq $false) {
    $shouldShow = $true
    $reason = 'page hidden'
  } else {
    $shown = Test-DshWindowVisible -DshPid $DshPid -DshProcessName $DshProcessName -TitleHint $TitleHint
    if ($shown) {
      $shouldShow = $false
      $reason = 'dsh window visible (fallback)'
    } else {
      $shouldShow = $true
      $reason = 'dsh window minimized or hidden (fallback)'
    }
  }
  try {
    $wasVisible = [bool]$script:Window.IsVisible
    if ($shouldShow -and -not $wasVisible) {
      $script:Window.Show()
      Update-AnchorFromWindow
      Write-WindowState 'shown'
    } elseif (-not $shouldShow -and $wasVisible) {
      $script:Window.Hide()
      # While hidden the in-page pet normally owns audio and the bubble. When the page
      # itself reports hidden, the overlay keeps audio ownership, so only stop sounds
      # in the page-visible / unknown cases.
      if ($script:PageVisible -ne $false) {
        Stop-OverlaySound
        $script:LastSoundAllowed = $false
        Write-Log 'hidden: sound stopped, pending sounds dropped'
      } else {
        Write-Log 'hidden but pageVisible=False: keep playing sound'
      }
      Hide-Bubble ''
      Write-WindowState 'hidden'
    }
    # Log the effective reason once per change (also when the window was already in
    # that state, e.g. startup with pageVisible=true): tests/ops look for exactly
    # "hidden (page visible)" / "shown (page hidden)".
    if ($script:LastVisibilityReason -ne $reason) {
      $script:LastVisibilityReason = $reason
      if ($shouldShow) {
        Write-Log ('shown ({0}); no queued sound replay' -f $reason)
      } else {
        Write-Log ('hidden ({0})' -f $reason)
      }
    }
  } catch {
    Write-Log ('visibility update failed: ' + $_.Exception.Message)
  }
}

# ---------------- initial position ----------------
# Default to the bottom-right of the visible virtual screen with a 16px margin. The
# window is person-sized here (no bubble), and saved coordinates are person-window
# coordinates; clamp every coordinate so the whole window stays on screen.
try {
  $saved = Read-SavedPosition
  $vsLeft = [double][System.Windows.SystemParameters]::VirtualScreenLeft
  $vsTop = [double][System.Windows.SystemParameters]::VirtualScreenTop
  $vsRight = $vsLeft + [double][System.Windows.SystemParameters]::VirtualScreenWidth
  $vsBottom = $vsTop + [double][System.Windows.SystemParameters]::VirtualScreenHeight
  $margin = 16
  if ($null -ne $saved) {
    $left = $saved[0]
    $top = $saved[1]
    $positionSource = 'saved'
  } else {
    $left = $vsRight - $script:Window.Width - $margin
    $top = $vsBottom - $script:Window.Height - $margin
    $positionSource = 'default'
  }
  $clamped = Clamp-Position $left $top $script:Window.Width $script:Window.Height $margin
  $script:Window.Left = $clamped[0]
  $script:Window.Top = $clamped[1]
  Update-AnchorFromWindow
  Write-Log ('initial position ({0}): left={1} top={2} (virtual={3}x{4} at {5},{6}, margin={7})' -f
    $positionSource, [int]$script:Window.Left, [int]$script:Window.Top,
    [System.Windows.SystemParameters]::VirtualScreenWidth, [System.Windows.SystemParameters]::VirtualScreenHeight,
    [System.Windows.SystemParameters]::VirtualScreenLeft, [System.Windows.SystemParameters]::VirtualScreenTop, $margin)
} catch {
  Write-Log ('initial position failed: ' + $_.Exception.Message)
}

$script:Window.Add_Loaded({
  Write-WindowState 'loaded'
  # Hide at background priority: a synchronous Hide() here would be overridden by
  # the Show()/Run() that is still completing, leaving the window visible and the
  # "show on minimize" branch dead.
  [void]$script:Window.Dispatcher.BeginInvoke(
    [System.Windows.Threading.DispatcherPriority]::Background,
    [System.Action]{
      if ($script:DebugEventHidden) {
        $script:Window.Hide()
        Write-Log 'loaded; hidden for debug-event test'
        Write-WindowState 'loaded-hidden(debug)'
        return
      }
      if ($script:AlwaysShow -or $script:DebugPaint) {
        $script:Window.Show()
        Write-Log 'loaded; staying visible (always-show/debug-paint)'
        Write-WindowState 'loaded-visible'
        return
      }
      $script:Window.Hide()
      Write-Log 'loaded; hidden until dsh window is minimized'
      Write-WindowState 'loaded-hidden'
    }
  )
})

$script:Window.Add_Closed({
  Write-Log 'window closed; shutting down'
  try {
    if ($null -ne $script:HwndSource -and $null -ne $script:NcHitTestHook) {
      $script:HwndSource.RemoveHook($script:NcHitTestHook)
    }
  } catch {
    # hook may already be gone
  }
  try { [DuoPetHitNative]::HitTest = $null } catch { }
  try { $script:Mutex.ReleaseMutex() } catch { }
  try { $script:App.Shutdown() } catch { }
})

Write-Log ("overlay starting; origin=$Origin hostPid=$HostPid dshPid=$DshPid spriteSource=$script:SpriteSource debugPaint=$script:DebugPaint")

Start-Action 'idle'
$script:FrameTimer.Start()
if ($DebugFreeze) {
  $script:FrameTimer.Stop()
  $script:AutoTimer.Stop()
  Write-Log 'debug freeze: animation stopped on the first frame'
}
$script:StateTimer.Start()
$script:VisibilityTimer.Start()
$script:LifeTimer.Start()

$script:Window.Show()
Install-NcHitTestHook
if (-not [string]::IsNullOrEmpty($DebugBubble)) {
  # Test-only hook: render a bubble immediately so a screenshot can verify text and
  # placement without waiting for a Host waiting/celebrate event.
  Set-Bubble $DebugBubble $DebugBubble 60000
  Write-Log ('debug bubble: {0} (visible={1})' -f $DebugBubble, $script:BubbleRoot.Visibility)
}
if (-not [string]::IsNullOrEmpty($DebugEvent)) {
  # Test-only hook: fire a sally/done event after startup. With -DebugEventHidden the
  # window stays hidden, so the log must show "sound skipped (hidden)" and no bubble.
  $script:DebugEventTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:DebugEventTimer.Interval = [TimeSpan]::FromMilliseconds(1800)
  $script:DebugEventTimer.Add_Tick({
    $script:DebugEventTimer.Stop()
    if ($script:DebugEventHidden) {
      $script:Window.Hide()
      Write-Log 'debug event: window hidden before trigger'
    }
    Write-Log ('debug event: ' + $script:DebugEventName)
    if ($script:DebugEventName -eq 'sally') {
      Show-Sally
    } elseif ($script:DebugEventName -eq 'done') {
      Show-Done
    } else {
      Write-Log ('debug event: unknown event ' + $script:DebugEventName)
    }
  })
  $script:DebugEventTimer.Start()
  Write-Log ('debug event timer started: enabled={0} event={1} hidden={2}' -f $script:DebugEventTimer.IsEnabled, $script:DebugEventName, $script:DebugEventHidden)
}
if ($DebugAutoDrag) {
  # Test-only deterministic drag: 40 x 9 DIP moves through the exact same
  # Begin/Update/End drag functions the mouse handlers use, with animation running.
  $script:DebugAutoDragTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:DebugAutoDragTimer.Interval = [TimeSpan]::FromMilliseconds(15)
  $script:DebugAutoDragStep = 0
  $script:DebugAutoDragStarted = $false
  $script:DebugAutoDragTimer.Add_Tick({
    if (-not $script:DebugAutoDragStarted) {
      $dragPointX = [double]$script:ImageLeft + (222 * 0.65)
      $dragPointY = [double]$script:ImageTop + (323 * 0.65)
      if (-not (Test-PetAlphaAtPoint $dragPointX $dragPointY)) {
        Write-Log 'debug auto drag: start point is not opaque; abort'
        $script:DebugAutoDragTimer.Stop()
        return
      }
      $screenX = [double]$script:Window.Left + $dragPointX
      $screenY = [double]$script:Window.Top + $dragPointY
      Begin-OverlayDrag $screenX $screenY
      $script:DebugAutoDragScreenX = $screenX
      $script:DebugAutoDragScreenY = $screenY
      $script:DebugAutoDragStepX = 9
      if ($script:Window.Left -gt ([System.Windows.SystemParameters]::VirtualScreenWidth / 2.0)) {
        $script:DebugAutoDragStepX = -9
      }
      Write-Log ('debug auto drag start at left={0} top={1} dx={2} screen={3},{4}' -f [int]$script:Window.Left, [int]$script:Window.Top, $script:DebugAutoDragStepX, [int]$screenX, [int]$screenY)
      $script:DebugAutoDragStarted = $true
      return
    }
    $script:DebugAutoDragStep += 1
    if ($script:DebugAutoDragStep -le 40) {
      Update-OverlayDrag ($script:DebugAutoDragScreenX + ($script:DebugAutoDragStep * $script:DebugAutoDragStepX)) $script:DebugAutoDragScreenY
    } else {
      $script:DebugAutoDragTimer.Stop()
      End-OverlayDrag
      Write-Log 'debug auto drag end'
    }
  })
  $script:DebugAutoDragTimer.Start()
}
Write-WindowState 'after-show'
[void]$script:App.Run($script:Window)
Write-Log 'overlay stopped'
exit 0
