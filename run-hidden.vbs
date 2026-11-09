' Run a command with no console window.
' Used by the scheduled task: calling node.exe directly flashes a black
' console window every night, so we go through wscript instead.
'
' Usage: wscript.exe //B run-hidden.vbs "<exe>" "<arg1>" ["<arg2>" ...]
Option Explicit

Dim shell, args, cmd, i

If WScript.Arguments.Count < 1 Then
    WScript.Quit 1
End If

Set shell = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
    If i > 0 Then cmd = cmd & " "
    cmd = cmd & """" & WScript.Arguments(i) & """"
Next

' 0 = hidden window, False = do not wait for it to finish
shell.Run cmd, 0, False
