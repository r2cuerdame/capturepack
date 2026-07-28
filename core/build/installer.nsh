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

!macro customInit
  ; BEFORE the installer closes the running app (issue #61).
  CreateDirectory "$APPDATA\CapturePack"
  FileOpen $0 "$APPDATA\CapturePack\supervision-standdown" w
  FileWrite $0 "installer"
  FileClose $0
!macroend

!macro customInstall
  ; Setup is over: the app may supervise itself again from its next start.
  Delete "$APPDATA\CapturePack\supervision-standdown"
!macroend

!macro customUnInit
  CreateDirectory "$APPDATA\CapturePack"
  FileOpen $0 "$APPDATA\CapturePack\supervision-standdown" w
  FileWrite $0 "uninstaller"
  FileClose $0
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CapturePack"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "CapturePack"
  ; Per-user install, so $SMPROGRAMS is this user's Start Menu\Programs — the
  ; folder Explorer scans for shortcut keys, and the only place the fallback is
  ; ever written.
  Delete "$SMPROGRAMS\CapturePack Capture.lnk"
!macroend
