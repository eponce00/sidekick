; Puts the sidekick command line tool on the current user's PATH. The edit runs through the
; installed app's own runtime (src/cli/windowsPath.ts), which keeps the registry value's type and
; never writes after a read it could not understand.

!macro sidekickUpdateCliPath ACTION
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\app.asar\out\main\cli.js" __windows-path ${ACTION} "$INSTDIR\bin"'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", i 0)'
  ; Open terminals keep their PATH; new ones started from Explorer pick up the change. Only a
  ; change (exit code 0) is announced: an update finds PATH already set. Windows that do not
  ; answer are skipped (SMTO_ABORTIFHUNG) instead of holding the installer for seconds each.
  ${if} $0 == 0
    System::Call 'user32::SendMessageTimeout(p ${HWND_BROADCAST}, i ${WM_SETTINGCHANGE}, p 0, t "Environment", i 0x2, i 1000, *p .r1)'
  ${endIf}
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
