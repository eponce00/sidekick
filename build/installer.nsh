; Puts the sidekick command line tool on the current user's PATH. The edit runs through the
; installed app's own runtime (src/cli/windowsPath.ts), which keeps the registry value's type and
; never writes after a read it could not understand.

!macro sidekickUpdateCliPath ACTION
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\app.asar\out\main\cli.js" __windows-path ${ACTION} "$INSTDIR\bin"'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", i 0)'
  ; Open terminals keep their PATH; new ones started from Explorer pick up the change.
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customInstall
  !insertmacro sidekickUpdateCliPath add
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; the new installer adds the same folder again.
  ${ifNot} ${isUpdated}
    !insertmacro sidekickUpdateCliPath remove
  ${endIf}
!macroend
