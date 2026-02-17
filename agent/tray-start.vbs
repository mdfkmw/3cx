Option Explicit

Dim sh, cmd
Set sh = CreateObject("WScript.Shell")

' pornim electron direct (nu npm), ascuns
cmd = "cmd.exe /c """"C:\agent\node_modules\.bin\electron.cmd"" ""C:\agent\tray.js"""" "

sh.Run cmd, 0, False
