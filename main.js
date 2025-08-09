// main.js - Electron Main Process
const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");

let mainWindow;

app.whenReady().then(() => {
  createMainWindow();
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
    backgroundColor: "#1a1a1a",
  });

  mainWindow.loadFile("index.html");

  // Open DevTools for debugging
  // mainWindow.webContents.openDevTools();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
