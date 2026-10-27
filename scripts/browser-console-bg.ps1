param([Parameter(Mandatory=$true)][int]$BrowserProcessId,[Parameter(Mandatory=$true)][string]$Expression)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ThoaBgMessage {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
}
"@
$process = Get-Process -Id $BrowserProcessId -ErrorAction Stop
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
  [System.Windows.Automation.TreeScope]::Children,
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $BrowserProcessId))
if (-not $window) { throw 'Target browser is unavailable' }
$prompt = $window.FindFirst(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'Console prompt'))
if (-not $prompt) { throw 'DevTools Console prompt is unavailable' }
$value = $prompt.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$value.SetValue($Expression)
Start-Sleep -Milliseconds 150
$handle = [IntPtr]$process.MainWindowHandle
[void][ThoaBgMessage]::PostMessage($handle, 0x0100, [IntPtr]0x0D, [IntPtr]0)
[void][ThoaBgMessage]::PostMessage($handle, 0x0101, [IntPtr]0x0D, [IntPtr]0)
