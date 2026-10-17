"use strict";
const electron = require("electron");
const METHODS = [
  "library.get",
  "subject.save",
  "subject.delete",
  "lecture.create",
  "lecture.get",
  "lecture.save",
  "lecture.trash",
  "lecture.restore",
  "lecture.recover",
  "trash.empty",
  "version.save",
  "version.activate",
  "settings.save",
  "folder.choose",
  "key.set",
  "key.delete",
  "key.validate",
  "models.list",
  "record.start",
  "record.chunk",
  "record.pause",
  "record.resume",
  "record.stop",
  "record.gap",
  "audio.sources",
  "audio.url",
  "import.pick",
  "import.paths",
  "material.retry",
  "material.open",
  "export.lecture",
  "backup.create",
  "backup.list",
  "backup.preview",
  "backup.restore",
  "action.run",
  "action.save",
  "action.delete",
  "transcript.improve",
  "task.retry",
  "task.cancel",
  "chat.list",
  "chat.create",
  "chat.messages",
  "chat.send",
  "shell.url"
];
electron.contextBridge.exposeInMainWorld("lecturedesk", {
  call: (method, args) => {
    if (!METHODS.includes(method)) return Promise.reject(new Error("Unsupported operation"));
    return electron.ipcRenderer.invoke("lecturedesk:call", method, args);
  },
  on: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    electron.ipcRenderer.on("lecturedesk:event", wrapped);
    return () => electron.ipcRenderer.removeListener("lecturedesk:event", wrapped);
  },
  filePath: (file) => electron.webUtils.getPathForFile(file)
});
