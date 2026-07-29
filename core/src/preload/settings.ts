// Preload for the settings window: narrow, typed bridge over the IPC contract.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  SettingsGetResult,
  SettingsPatch,
  SettingsSetResult,
  SettingsStatusResult,
} from '../shared/ipc'

contextBridge.exposeInMainWorld('settingsBridge', {
  get(): Promise<SettingsGetResult> {
    return ipcRenderer.invoke(IPC.settingsGet) as Promise<SettingsGetResult>
  },
  set(patch: SettingsPatch): Promise<SettingsSetResult> {
    return ipcRenderer.invoke(IPC.settingsSet, patch) as Promise<SettingsSetResult>
  },
  pickOutputDir(): Promise<string | null> {
    return ipcRenderer.invoke(IPC.settingsPickOutputDir) as Promise<string | null>
  },
  // The online manual (GOAL "First-Run Tutorial"). Main owns the address.
  openGuide(): void {
    ipcRenderer.send(IPC.settingsOpenGuide)
  },
  openOutput(): Promise<void> {
    return ipcRenderer.invoke(IPC.settingsOpenOutput) as Promise<void>
  },
  // Live MCP / plugin state (issues #54, #57) — reality, not settings.
  status(): Promise<SettingsStatusResult> {
    return ipcRenderer.invoke(IPC.settingsStatus) as Promise<SettingsStatusResult>
  },
  restartMcp(): Promise<SettingsStatusResult> {
    return ipcRenderer.invoke(IPC.settingsMcpRestart) as Promise<SettingsStatusResult>
  },
})
