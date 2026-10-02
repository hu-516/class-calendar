<#
Window z-order helper for the desktop layer mode.

The widget should sit on the desktop and not cover other applications, so in
"desktop" mode we push its window to the bottom of the z-order. Electron has no
API for that, so this script does it through SetWindowPos(HWND_BOTTOM).

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File win32-layer.ps1 -Hwnd <handle> -Action bottom

Prints a small JSON result: {"ok":true|false}[,"reason":"..."]
ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
#>
param(
  [Parameter(Mandatory = $true)][long]$Hwnd,
  [ValidateSet('bottom')][string]$Action = 'bottom'
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Layer -Name Win -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[DllImport("user32.dll")]
public static extern bool IsWindow(IntPtr hWnd);
'@

$target = [IntPtr]$Hwnd
if (-not [Layer.Win]::IsWindow($target)) {
  Write-Output '{"ok":false,"reason":"invalid-hwnd"}'
  exit 1
}

$HWND_BOTTOM = [IntPtr]1
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOACTIVATE = 0x0010
$flags = $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE

$ok = [Layer.Win]::SetWindowPos($target, $HWND_BOTTOM, 0, 0, 0, 0, $flags)
if ($ok) {
  Write-Output '{"ok":true}'
} else {
  Write-Output ('{"ok":false,"reason":"setwindowpos-failed","code":' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() + '}')
  exit 1
}
