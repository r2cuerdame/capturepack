; Electron owns the per-user login item while CapturePack is installed. The
; app cannot run after its own files have been removed, so the NSIS uninstall
; hook removes both the Run value and Windows' StartupApproved companion value.
;
; Issue #61 adds two more things setup has to know about, because supervision
; runs OUTSIDE the app and must never outlive it:
;
;  1. The stand-down flag. Installing or uninstalling closes the running
;     CapturePack, which to a watchdog looks exactly like a crash — and a
;     supervisor that resurrected the app in the middle of an update would be a
;     far worse bug than the one it exists to fix. The flag is written before
;     anything is closed and removed once setup is done.
;  2. The Start Menu fallback shortcut ("CapturePack Capture"), which carries
;     the shortcut key that answers the hotkey while the app is not running.
;     Whatever supervision adds, an uninstall takes away.

Var CapturePackWasRunning
Var CapturePackChromeReg
Var CapturePackEdgeReg
Var CapturePackBraveReg
Var CapturePackChromiumReg
!ifndef BUILD_UNINSTALLER
  Var CapturePackHadManifest
  Var CapturePackHadLauncher
  Var CapturePackRunValue
  Var CapturePackHadStartupApproved
  Var CapturePackHadShortcut
  Var CapturePackHadOldUninstaller
  Var CapturePackOldUninstallCompleted
  Var CapturePackLoadedPending
!endif

!macro DisableCapturePackNativeHost
  ; Chrome reconnects a native-messaging port automatically. Its host uses the
  ; same CapturePack.exe filename as the tray app, so electron-builder's normal
  ; close loop could kill one host just as Chrome spawned the next and conclude
  ; that CapturePack "cannot be closed". Remove only CapturePack's own HKCU
  ; registrations before that loop begins; no browser or extension is closed.
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.capturepack.host"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.capturepack.host"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.capturepack.host"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.capturepack.host"
!macroend

!macro SnapshotCapturePackBrowserRegistration
  ; Preserve exactly which browsers were registered. Restoring all four merely
  ; because a manifest exists would turn a failed update into a settings change.
  ReadRegStr $CapturePackChromeReg HKCU "Software\Google\Chrome\NativeMessagingHosts\com.capturepack.host" ""
  ReadRegStr $CapturePackEdgeReg HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.capturepack.host" ""
  ReadRegStr $CapturePackBraveReg HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.capturepack.host" ""
  ReadRegStr $CapturePackChromiumReg HKCU "Software\Chromium\NativeMessagingHosts\com.capturepack.host" ""
!macroend

!macro RestoreCapturePackBrowserRegistration
  ${If} ${FileExists} "$APPDATA\CapturePack\com.capturepack.host.json"
    ${If} $CapturePackChromeReg != ""
      WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.capturepack.host" "" "$CapturePackChromeReg"
    ${EndIf}
    ${If} $CapturePackEdgeReg != ""
      WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.capturepack.host" "" "$CapturePackEdgeReg"
    ${EndIf}
    ${If} $CapturePackBraveReg != ""
      WriteRegStr HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.capturepack.host" "" "$CapturePackBraveReg"
    ${EndIf}
    ${If} $CapturePackChromiumReg != ""
      WriteRegStr HKCU "Software\Chromium\NativeMessagingHosts\com.capturepack.host" "" "$CapturePackChromiumReg"
    ${EndIf}
  ${EndIf}
!macroend

!macro SnapshotCapturePackIntegration
  ; An update runs the PREVIOUS build's uninstaller. Older uninstallers remove
  ; these per-user files even for an update, so the new installer must preserve
  ; the user's working Chrome/login setup before invoking one.
  InitPluginsDir
  StrCpy $CapturePackHadManifest "0"
  StrCpy $CapturePackHadLauncher "0"
  StrCpy $CapturePackRunValue ""
  StrCpy $CapturePackHadStartupApproved "0"
  StrCpy $CapturePackHadShortcut "0"
  StrCpy $CapturePackHadOldUninstaller "0"
  StrCpy $CapturePackOldUninstallCompleted "0"
  StrCpy $CapturePackLoadedPending "0"
  ${If} ${FileExists} "$APPDATA\CapturePack\installer-pending\state.json"
    ; A previous setup already removed the old executable and then failed.
    ; That snapshot is the source of truth until a complete install consumes it;
    ; never overwrite it with the deliberately deactivated retry state.
    StrCpy $CapturePackLoadedPending "1"
    StrCpy $CapturePackOldUninstallCompleted "1"
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\CapturePack\com.capturepack.host.json"
    CopyFiles /SILENT "$APPDATA\CapturePack\com.capturepack.host.json" "$PLUGINSDIR"
    ${If} ${FileExists} "$PLUGINSDIR\com.capturepack.host.json"
      StrCpy $CapturePackHadManifest "1"
    ${EndIf}
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\CapturePack\capturepack-host.cmd"
    CopyFiles /SILENT "$APPDATA\CapturePack\capturepack-host.cmd" "$PLUGINSDIR"
    ${If} ${FileExists} "$PLUGINSDIR\capturepack-host.cmd"
      StrCpy $CapturePackHadLauncher "1"
    ${EndIf}
  ${EndIf}
  ReadRegStr $CapturePackRunValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CapturePack"
  ; StartupApproved is REG_BINARY and NSIS WriteRegBin accepts compile-time hex
  ; only. Save this ONE value as base64 through the system PowerShell, instead
  ; of exporting/importing the whole key and touching other applications.
  SetOutPath "$PLUGINSDIR"
  File /oname=capturepack-installer-state.ps1 "${BUILD_RESOURCES_DIR}\installer-state.ps1"
  SetOutPath "$INSTDIR"
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\capturepack-installer-state.ps1" -Mode save -StateFile "$PLUGINSDIR\capturepack-startup-approved.txt"`
  Pop $0
  Pop $1
  ${If} ${FileExists} "$PLUGINSDIR\capturepack-startup-approved.txt"
    StrCpy $CapturePackHadStartupApproved "1"
  ${EndIf}
  ${If} ${FileExists} "$SMPROGRAMS\CapturePack Capture.lnk"
    CopyFiles /SILENT "$SMPROGRAMS\CapturePack Capture.lnk" "$PLUGINSDIR"
    ${If} ${FileExists} "$PLUGINSDIR\CapturePack Capture.lnk"
      StrCpy $CapturePackHadShortcut "1"
    ${EndIf}
  ${EndIf}
  ; electron-builder's result hook runs even when it found no previous
  ; UninstallString. Record that distinction here, while the old registry is
  ; still intact, instead of reaching into a template-local variable.
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${If} $0 == ""
      ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
    ${EndIf}
  !endif
  ${If} $0 != ""
    StrCpy $CapturePackHadOldUninstaller "1"
  ${EndIf}

  ; Prepare an exact, self-contained snapshot before the first process is
  ; closed. It stays in $PLUGINSDIR during an ordinary install and is promoted
  ; to userData only if the old app has been removed and extraction then fails.
  ${If} $CapturePackLoadedPending != "1"
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\capturepack-installer-state.ps1" -Mode save-pending -PendingDir "$PLUGINSDIR\capturepack-pending-stage" -AppDataDir "$APPDATA\CapturePack" -StartMenuPrograms "$SMPROGRAMS"`
    Pop $0
    Pop $1
    ${If} $0 != 0
    ${OrIfNot} ${FileExists} "$PLUGINSDIR\capturepack-pending-stage\state.json"
      DetailPrint "Could not prepare the CapturePack update recovery snapshot."
      MessageBox MB_OK|MB_ICONSTOP "CapturePack could not prepare a safe update snapshot. Setup has not changed the installed app." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro RestoreCapturePackSnapshotFiles
  CreateDirectory "$APPDATA\CapturePack"
  !ifndef BUILD_UNINSTALLER
    ${If} $CapturePackHadManifest == "1"
      CopyFiles /SILENT "$PLUGINSDIR\com.capturepack.host.json" "$APPDATA\CapturePack"
    ${EndIf}
    ${If} $CapturePackHadLauncher == "1"
      CopyFiles /SILENT "$PLUGINSDIR\capturepack-host.cmd" "$APPDATA\CapturePack"
    ${EndIf}
  !endif
!macroend

!macro RestoreCapturePackIntegration
  !insertmacro RestoreCapturePackSnapshotFiles
  !ifndef BUILD_UNINSTALLER
    ${If} $CapturePackRunValue != ""
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CapturePack" "$CapturePackRunValue"
    ${EndIf}
    ${If} $CapturePackHadStartupApproved == "1"
      nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\capturepack-installer-state.ps1" -Mode restore -StateFile "$PLUGINSDIR\capturepack-startup-approved.txt"`
      Pop $0
      Pop $1
      ${If} $0 != 0
        DetailPrint "Could not restore CapturePack StartupApproved state."
      ${EndIf}
    ${EndIf}
    ${If} $CapturePackHadShortcut == "1"
      CopyFiles /SILENT "$PLUGINSDIR\CapturePack Capture.lnk" "$SMPROGRAMS"
    ${EndIf}
  !endif
  !insertmacro RestoreCapturePackBrowserRegistration
!macroend

!macro BeginCapturePackShutdown
  CreateDirectory "$APPDATA\CapturePack"
  FileOpen $0 "$APPDATA\CapturePack\supervision-standdown" w
  FileWrite $0 "installer"
  FileClose $0
  !insertmacro DisableCapturePackNativeHost
!macroend

!macro RestartCapturePackIfNeeded
  ; The close gate may have stopped the tray app and its watchdog. On a failure
  ; that leaves the old install intact, put the exact prior running state back.
  ${If} $CapturePackWasRunning == "1"
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ${If} ${FileExists} "$INSTDIR\resources\app.asar"
        Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --openAsHidden'
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro AbortCapturePackShutdown
  !insertmacro RestoreCapturePackIntegration
  Delete "$APPDATA\CapturePack\supervision-standdown"
  !insertmacro RestartCapturePackIfNeeded
!macroend

!macro DeactivateCapturePackAfterRemovedInstall
  ; The previous uninstaller completed, so an extraction failure has no old app
  ; to restart. Promote the pre-close snapshot to durable userData exactly once;
  ; a retry must never replace it with this deliberately deactivated state.
  !ifndef BUILD_UNINSTALLER
    ${If} $CapturePackLoadedPending != "1"
      nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\capturepack-installer-state.ps1" -Mode persist-pending -SourceDir "$PLUGINSDIR\capturepack-pending-stage" -PendingDir "$APPDATA\CapturePack\installer-pending"`
      Pop $0
      Pop $1
      ${If} $0 != 0
      ${OrIfNot} ${FileExists} "$APPDATA\CapturePack\installer-pending\state.json"
        DetailPrint "Could not persist the CapturePack update recovery snapshot."
      ${EndIf}
    ${EndIf}
  !endif

  ; Keep the human-readable integration files for forensics and the next retry,
  ; but never leave Chrome, login or a shortcut targeting a partial executable.
  !insertmacro RestoreCapturePackSnapshotFiles
  !insertmacro DisableCapturePackNativeHost
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CapturePack"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "CapturePack"
  Delete "$SMPROGRAMS\CapturePack Capture.lnk"
  Delete "$APPDATA\CapturePack\supervision-standdown"
!macroend

!macro customCheckAppRunning
  ; CHECK_APP_RUNNING is the only hook shared by install and uninstall that is
  ; both after the installer's single-instance mutex and before its process
  ; scan. Begin the handoff here: a second setup can no longer kill the live
  ; app before aborting on the mutex, while Chrome cannot race the close loop by
  ; immediately spawning another native host.
  !insertmacro SnapshotCapturePackBrowserRegistration
  !ifndef BUILD_UNINSTALLER
    !insertmacro SnapshotCapturePackIntegration
  !endif
  StrCpy $CapturePackWasRunning "0"
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    StrCpy $CapturePackWasRunning "1"
  ${EndIf}
  !insertmacro BeginCapturePackShutdown

  StrCpy $R1 0
  capturepack_close_retry:
    IntOp $R1 $R1 + 1
    DetailPrint `Closing running "${PRODUCT_NAME}" processes...`
    nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
    Sleep 750
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      ${If} $R1 < 3
        Goto capturepack_close_retry
      ${EndIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY capturepack_close_retry IDCANCEL capturepack_close_abort
    ${EndIf}
    Goto capturepack_close_done

  capturepack_close_abort:
    !ifndef BUILD_UNINSTALLER
      ; A retry carrying a durable post-removal snapshot has no intact old app
      ; to reactivate. Ordinary cancellation still restores and restarts now.
      Call RestoreCapturePackAfterInstallFailure
    !else
      !insertmacro AbortCapturePackShutdown
    !endif
    SetErrorLevel 2
    Quit
  capturepack_close_done:
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Function RestoreCapturePackAfterInstallFailure
      ${If} $CapturePackOldUninstallCompleted == "1"
        !insertmacro DeactivateCapturePackAfterRemovedInstall
      ${Else}
        !insertmacro AbortCapturePackShutdown
      ${EndIf}
    FunctionEnd

    ; Before old removal, restore the complete prior state. After removal, keep
    ; saved integration data but never reactivate a missing/partial executable.
    Function .onInstFailed
      Call RestoreCapturePackAfterInstallFailure
    FunctionEnd
  !else
    ; A standalone uninstall can fail after its process gate (for example when
    ; an unrelated process holds app.asar). Do not strand Chrome or supervision.
    Function un.onUninstFailed
      !insertmacro AbortCapturePackShutdown
    FunctionEnd
  !endif
!macroend

!macro customUnInstallCheck
  ; electron-builder otherwise Quit's directly on an old-uninstaller exit 2,
  ; bypassing .onInstFailed and leaving the handoff armed.
  ; Its template also calls this hook after finding NO uninstall string at all.
  ; That is a fresh/corrupt install, not proof that an old app was removed.
  ${If} $CapturePackHadOldUninstaller != "1"
    DetailPrint "No previous CapturePack uninstaller was invoked."
  ${ElseIf} ${Errors}
    Call RestoreCapturePackAfterInstallFailure
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed)"
    DetailPrint `Uninstall was not successful. The previous uninstaller could not be launched.`
    SetErrorLevel 2
    Quit
  ${ElseIf} $R0 != 0
    Call RestoreCapturePackAfterInstallFailure
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${Else}
    StrCpy $CapturePackOldUninstallCompleted "1"
  ${EndIf}
!macroend

!macro customInstall
  ; The previous uninstaller may predate the ${isUpdated} guard below and have
  ; removed app-data integration. Restore the snapshot only after replacement
  ; files are safely in place, then release the native host and watchdog.
  ${If} $CapturePackLoadedPending == "1"
    ; Consume the durable state only after every file and registry value was
    ; restored. A helper failure leaves it in place and re-enters the safe
    ; post-removal failure path via .onInstFailed.
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\capturepack-installer-state.ps1" -Mode restore-pending -PendingDir "$APPDATA\CapturePack\installer-pending" -AppDataDir "$APPDATA\CapturePack" -StartMenuPrograms "$SMPROGRAMS"`
    Pop $0
    Pop $1
    ${If} $0 != 0
    ${OrIf} ${FileExists} "$APPDATA\CapturePack\installer-pending\state.json"
      DetailPrint "Could not restore the pending CapturePack integration snapshot."
      SetErrors
      Abort
    ${EndIf}
  ${Else}
    !insertmacro RestoreCapturePackIntegration
  ${EndIf}
  Delete "$APPDATA\CapturePack\supervision-standdown"
!macroend

!macro customUnInstall
  ; Updating is not uninstalling the user's integration. The parent installer
  ; keeps stand-down armed and restores its snapshot in customInstall. Only a
  ; real uninstall removes login, fallback and native-host state.
  ${IfNot} ${isUpdated}
    !insertmacro DisableCapturePackNativeHost
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CapturePack"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "CapturePack"
    ; Per-user install, so $SMPROGRAMS is this user's Start Menu\Programs — the
    ; folder Explorer scans for shortcut keys, and the only place the fallback
    ; is ever written.
    Delete "$SMPROGRAMS\CapturePack Capture.lnk"
    Delete "$APPDATA\CapturePack\com.capturepack.host.json"
    Delete "$APPDATA\CapturePack\capturepack-host.cmd"
    ; A real uninstall also rejects any deferred update recovery. Leaving it
    ; behind would make a later fresh install resurrect integration the user
    ; explicitly removed.
    Delete "$APPDATA\CapturePack\installer-pending\state.json"
    Delete "$APPDATA\CapturePack\installer-pending\com.capturepack.host.json"
    Delete "$APPDATA\CapturePack\installer-pending\capturepack-host.cmd"
    Delete "$APPDATA\CapturePack\installer-pending\CapturePack Capture.lnk"
    RMDir "$APPDATA\CapturePack\installer-pending"
    Delete "$APPDATA\CapturePack\supervision-standdown"
  ${EndIf}
!macroend
