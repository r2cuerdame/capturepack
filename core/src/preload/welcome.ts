// Preload for the first-launch welcome window: narrow, typed bridge over the
// IPC contract. The renderer asks for the values it prints and sends two
// intentions — [Try it now] and [Settings]; [Done]/Esc are window.close().
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { WelcomeInfoResult } from '../shared/ipc'

contextBridge.exposeInMainWorld('welcomeBridge', {
  get(): Promise<WelcomeInfoResult> {
    return ipcRenderer.invoke(IPC.welcomeGet) as Promise<WelcomeInfoResult>
  },
  tryNow(): void {
    ipcRenderer.send(IPC.welcomeTryNow)
  },
  openSettings(): void {
    ipcRenderer.send(IPC.welcomeOpenSettings)
  },
})
