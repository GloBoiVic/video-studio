// The FrameHost on Electron's own Chromium: an offscreen window per job, in a fresh in-memory session (no cookies,
// no zoom memory between jobs), sized stage × scale with the zoom set to `scale`, so a 1920 × 1080 layout is drawn
// at 3840 × 2160 for 4K. Muted: the export's sound comes from the mixer, never from the page.
import { BrowserWindow } from 'electron';
import type { FrameHost } from '../server/render.js';

let n = 0;

export function electronFrameHost(): FrameHost {
  return {
    async open(url, { w, h, scale }) {
      const win = new BrowserWindow({
        show: false,
        width: Math.round(w * scale),
        height: Math.round(h * scale),
        useContentSize: true,
        enableLargerThanScreen: true,
        frame: false,
        paintWhenInitiallyHidden: true,
        backgroundColor: '#000000',
        webPreferences: {
          offscreen: true,
          zoomFactor: scale,
          partition: `vs-render-${process.pid}-${++n}`,
          backgroundThrottling: false,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          autoplayPolicy: 'no-user-gesture-required',
          spellcheck: false,
        },
      });
      win.webContents.setFrameRate(60);
      win.webContents.setAudioMuted(true);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
      await win.loadURL(url);
      win.webContents.setZoomFactor(scale);
      return {
        eval: (js) => win.webContents.executeJavaScript(js, true),
        async capture() {
          const img = await win.webContents.capturePage();
          return { size: img.getSize(), png: () => img.toPNG(), bitmap: () => img.toBitmap() };
        },
        async close() {
          if (!win.isDestroyed()) win.destroy();
        },
      };
    },
  };
}
