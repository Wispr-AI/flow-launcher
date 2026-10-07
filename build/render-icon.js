// Renders build/icon.svg to build/icon.png (1024²) with Electron, then builds build/icon.icns.
// Usage: npm run icon
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8')
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 } })
  win.webContents.setZoomFactor(1)
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 300))
  const img = (await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })).resize({ width: 1024, height: 1024, quality: 'best' })
  const png = path.join(__dirname, 'icon.png')
  fs.writeFileSync(png, img.toPNG())

  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-')) + '/icon.iconset'
  fs.mkdirSync(set)
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(s), String(s), png, '--out', `${set}/icon_${s}x${s}.png`])
    execFileSync('sips', ['-z', String(s * 2), String(s * 2), png, '--out', `${set}/icon_${s}x${s}@2x.png`])
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(__dirname, 'icon.icns')])
  app.quit()
})
