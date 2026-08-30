// Preload for the History window: narrow, typed bridge over the history:* IPC.
// Every action takes the pack's absolute path (HistoryPackSummary.path) as its
// ref; main validates it against the live pack index before acting.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  HistoryActionResult,
  HistoryCreateShareResult,
  HistoryCreateZipResult,
  HistoryListResult,
  HistoryRenameResult,
  HistoryRenderStatusPayload,
  HistorySharePlanResult,
  StorageUsage,
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
  // The whole folder, for the header bar — not a sum of the per-card sizes.
  usage(): Promise<StorageUsage | null> {
    return ipcRenderer.invoke(IPC.historyUsage) as Promise<StorageUsage | null>
  },
  searchText(packPath: string): Promise<string> {
    return ipcRenderer.invoke(IPC.historySearchText, packPath) as Promise<string>
  },
  openPack(packPath: string): Promise<HistoryActionResult> {
    return ipcRenderer.invoke(IPC.historyOpenPack, packPath) as Promise<HistoryActionResult>
  },
  play(packPath: string): Promise<HistoryActionResult> {
    return ipcRenderer.invoke(IPC.historyPlay, packPath) as Promise<HistoryActionResult>
  },
  createZip(packPath: string): Promise<HistoryCreateZipResult> {
    return ipcRenderer.invoke(IPC.historyCreateZip, packPath) as Promise<HistoryCreateZipResult>
  },
  planShare(packPath: string): Promise<HistorySharePlanResult> {
    return ipcRenderer.invoke(IPC.historyPlanShare, packPath) as Promise<HistorySharePlanResult>
  },
  createShare(packPath: string, revision: string): Promise<HistoryCreateShareResult> {
    return ipcRenderer.invoke(IPC.historyCreateShare, packPath, revision) as Promise<HistoryCreateShareResult>
  },
  openFolder(packPath: string): void {
    ipcRenderer.send(IPC.historyOpenFolder, packPath)
  },
  copyPath(packPath: string): void {
    ipcRenderer.send(IPC.historyCopyPath, packPath)
  },
  copyPrompt(packPath: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC.historyCopyPrompt, packPath) as Promise<boolean>
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
