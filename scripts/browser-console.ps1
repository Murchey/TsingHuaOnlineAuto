param([Parameter(Mandatory=$true)][int]$BrowserProcessId,[string]$Expression,[switch]$Read)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$w=[System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$BrowserProcessId))
if(-not $w){throw 'Target browser is unavailable'}
if($Expression){
 $shellAutomation=New-Object -ComObject WScript.Shell
 $null=$shellAutomation.AppActivate($BrowserProcessId)
 $p=$w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'Console prompt'))
 $p.SetFocus()
 [System.Windows.Forms.SendKeys]::SendWait('^a')
 $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Expression))
 $command="eval(new TextDecoder().decode(Uint8Array.from(atob('$encoded'),c=>c.charCodeAt(0))))"
 $p.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($command)
 [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}
if($Read){
 $docs=$w.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'DevTools'))
 foreach($d in $docs){$tp=$null;if($d.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$tp)){$tp.DocumentRange.GetText(24000)}}
}
