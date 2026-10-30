# neko-capture

A small recorder for two jobs:

- **Web page:** open any URL in a real browser window whose page is exactly the pixel size you choose
  (1920×1080, 1080×1920, …), play or click around in it normally, and record it.
- **App window:** record any app window, or a whole screen.

Recordings are MP4 (H.264 video, AAC or Opus audio) at a steady 30 or 60 fps.

## Run

- **Windows:** double-click `start.bat`
- **Linux (Omarchy/Hyprland):** `./start.sh`

The first run does `npm install` (needs [Node.js](https://nodejs.org) 20+).
There is nothing to compile: these scripts run the code straight from `src/`, so edits show up the next time you start it.

## Build a standalone app (optional)

- **Windows:** `build.bat` creates `dist\neko-capture-win32-x64\neko-capture.exe`
- **Linux:** `./build.sh` creates `dist/neko-capture-linux-x64/neko-capture`

Copy that whole folder anywhere and run the exe. It doesn't need Node.js.
Run the build again after changing the code.

## Use

1. **Web page tab:** type the URL, pick a size, then press **Open**. Click into the stage window to play.
   Keys, mouse and dropdowns work as in a normal browser.
   F5 reloads the page and F12 opens DevTools.
2. **App window tab:** press **Choose window…** and click a thumbnail. On Wayland the system picker opens instead.
3. Press **Record**, or **Ctrl+Alt+R** from anywhere. Press it again to stop.
   Files go to `Videos/neko-capture` unless you change the folder.
4. **Trim:** when a recording stops, the **Clip** box opens below it (or press **Edit** next to any recording).
   Drag the two handles to set the start and end. The times show in seconds as you drag.
   **Play clip** plays just that part. **Export clip** saves `<recording> clip.mp4` next to the original and leaves the original as it was.

## How it works

| Part | What it does |
| --- | --- |
| `src/main.js` | Windows, settings, capture-source plumbing, writing files |
| `src/renderer/control.*` | The control panel UI |
| `src/renderer/recorder.js` | MediaStream → WebCodecs encoder → [Mediabunny](https://mediabunny.dev) MP4 muxer |
| `src/renderer/editor.js` | Clip editor: start/end slider, preview, trimmed export (Mediabunny `Conversion`) |

- **Exact page size:** the window's content is sized `W/scale × H/scale` and page zoom is set to `1/scale`.
  The page then sees `innerWidth = W` and `devicePixelRatio = 1` on any monitor scaling.
  The panel shows the size the page actually got.
- **Recording the stage:** uses tab capture of the stage's page, not a screen grab of the window.
  Window borders, other windows on top, or the window hanging off-screen never show up in the video.
  The page's own audio is recorded.
- **Window capture:** uses Electron's `desktopCapturer`. That is Windows Graphics Capture on Windows
  and PipeWire plus the desktop portal on Wayland.
  System audio is recorded on Windows only.
- **Background throttling:** off for the stage, so a game keeps full speed while the control window has focus.

## Hyprland

Tiling will resize the stage window. If the panel warns that the page isn't the size you asked for,
make the stage float. On current Hyprland:

    windowrule = float on, match:title ^(neko-capture stage)$

On older versions (`windowrulev2` syntax):

    windowrulev2 = float, title:^(neko-capture stage)$

## Self-test

`npm run smoke` opens a test page, records 3 seconds and prints the result.
