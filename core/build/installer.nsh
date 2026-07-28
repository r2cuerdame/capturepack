; Electron owns the per-user login item while CapturePack is installed. The
; app cannot run after its own files have been removed, so the NSIS uninstall
; hook removes both the Run value and Windows' StartupApproved companion value.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CapturePack"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "CapturePack"
!macroend
