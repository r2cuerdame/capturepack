// Preload for the About window: narrow, typed bridge over the IPC contract.
// openLink takes a KEY, never a URL — main owns the link allowlist.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { AboutInfoResult, AboutLinkKey } from '../shared/ipc'

contextBridge.exposeInMainWorld('aboutBridge', {
  get(): Promise<AboutInfoResult> {
    return ipcRenderer.invoke(IPC.aboutGet) as Promise<AboutInfoResult>
  },
  onState(cb: (info: AboutInfoResult) => void): void {
    ipcRenderer.on(IPC.aboutState, (_event, info: AboutInfoResult) => cb(info))
  },
  openLink(key: AboutLinkKey): void {
    ipcRenderer.send(IPC.aboutOpenLink, key)
  },
  restartUpdate(): void {
    ipcRenderer.send(IPC.updaterRestart)
  },
})
