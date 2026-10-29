import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'

const electron = process.env.LINEY_DESKTOP_TARGET === 'electron'
const compat = (module: string) => path.resolve('src/lib/electron-compat',module+'.ts')
export default defineConfig({
  base: electron ? './' : '/',
  plugins: [react()],
  resolve: {
    alias: electron ? [
      {find:'@tauri-apps/api/core',replacement:compat('core')},
      {find:'@tauri-apps/api/event',replacement:compat('event')},
      {find:'@tauri-apps/api/window',replacement:compat('window')},
      {find:'@tauri-apps/api/webviewWindow',replacement:compat('webview-window')},
      {find:'@tauri-apps/plugin-dialog',replacement:compat('dialog')},
      {find:'@tauri-apps/plugin-shell',replacement:compat('shell')},
    ] : []
  }
})
