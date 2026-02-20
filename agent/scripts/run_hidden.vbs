Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell -command ""Set-Clipboard -Value '" & WScript.Arguments(0) & "'""", 0, True

WshShell.Run "powershell -command ""[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(3000, 'Apel primit', 'Numar copiat: " & WScript.Arguments(0) & "', [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -s 4; $n.Dispose()""", 0, False