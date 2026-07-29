// Preload for the History window: narrow, typed bridge over the history:* IPC.
// Every action takes the pack's absolute path (HistoryPackSummary.path) as its
// ref; main validates it against the live pack index before acting.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  HistoryActionResult,
  HistoryListResult,
  HistoryRenameResult,
  HistoryRenderStatusPayload,
  ToastCreateZipResult,
} from '../shared/ipc'

contextBridge.exposeInMainWorld('historyBridge', {
  list(): Promise<HistoryListResult> {
    return ipcRenderer.invoke(IPC.historyList) as Promise<HistoryListResult>
  },
  thumb(packPath: string): Promise<string | null> {
    return ipcRenderer.invoke(IPC.historyThumb, packPath) as Promise<string | null>
  },
  size(packPath: string): Promise<number | null> {
    return ipcRenderer.invoke(IPC.historySize, packPath) as Promise<number | null>
  },
  searchText(packPath: string): Promise<string> {
    return ipcRenderer.invoke(IPC.historySearchText, packPath) as Promise<string>
  },
  openPack(packPath: string): void {
    ipcRenderer.send(IPC.historyOpenPack, packPath)
  },
  play(packPath: string): Promise<HistoryActionResult> {
    return ipcRenderer.invoke(IPC.historyPlay, packPath) as Promise<HistoryActionResult>
  },
  createZip(packPath: string): Promise<ToastCreateZipResult> {
    return ipcRenderer.invoke(IPC.historyCreateZip, packPath) as Promise<ToastCreateZipResult>
  },
  openFolder(packPath: string): void {
    ipcRenderer.send(IPC.historyOpenFolder, packPath)
  },
  copyPath(packPath: string): void {
    ipcRenderer.send(IPC.historyCopyPath, packPath)
  },
  copyPrompt(packPath: string): void {
    ipcRenderer.send(IPC.historyCopyPrompt, packPath)
  },
  rerender(packPath: string): Promise<HistoryActionResult> {
    return ipcRenderer.invoke(IPC.historyRerender, packPath) as Promise<HistoryActionResult>
  },
  rename(packPath: string, newName: string): Promise<HistoryRenameResult> {
    return ipcRenderer.invoke(IPC.historyRename, packPath, newName) as Promise<HistoryRenameResult>
  },
  remove(packPath: string): Promise<HistoryActionResult> {
    return ipcRenderer.invoke(IPC.historyDelete, packPath) as Promise<HistoryActionResult>
  },
  openSettings(): void {
    ipcRenderer.send(IPC.historyOpenSettings)
  },
  onChanged(cb: () => void): void {
    ipcRenderer.on(IPC.historyChanged, () => cb())
  },
  onRenderStatus(cb: (payload: HistoryRenderStatusPayload) => void): void {
    ipcRenderer.on(IPC.historyRenderStatus, (_event, payload: HistoryRenderStatusPayload) => cb(payload))
  },
})
