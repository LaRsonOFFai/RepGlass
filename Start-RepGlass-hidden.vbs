Option Explicit

Dim shell
Dim fso
Dim projectRoot
Dim command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectRoot = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = projectRoot

command = "cmd.exe /d /s /c """ & projectRoot & "\scripts\start-hidden.cmd"""
shell.Run command, 0, False
