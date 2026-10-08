import { contextBridge, ipcRenderer } from "electron";
import { STEP_MINI_CHANNELS as channels } from "@zcode/shared";
contextBridge.exposeInMainWorld("stepMini", {
  read: () => ipcRenderer.invoke(channels.read),
  expand: (expanded: boolean) => ipcRenderer.invoke(channels.expand, expanded),
  hide: () => ipcRenderer.invoke(channels.hide),
  openTask: (key: string) => ipcRenderer.invoke(channels.action, { type: "open-task", key }),
  newTask: () => ipcRenderer.invoke(channels.action, { type: "new-task" }),
  onLayout: (callback: (layout: unknown) => void) => {
    const handler = (_event: unknown, layout: unknown) => callback(layout);
    ipcRenderer.on(channels.layout, handler);
    return () => ipcRenderer.removeListener(channels.layout, handler);
  },
  onSnapshot: (callback: (snapshot: unknown) => void) => {
    const handler = (_event: unknown, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on(channels.snapshot, handler);
    return () => ipcRenderer.removeListener(channels.snapshot, handler);
  },
});
