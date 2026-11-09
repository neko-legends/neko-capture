# Neko Capture

A screen recorder that is simpler than OBS. No scenes, sources or profiles to set up:
choose what to record, press **Record**, get an MP4.

It does two jobs:

- **Web page:** open any URL in a real browser window whose page is exactly the pixel size you choose
  (1920×1080, 1080×1920, …), play or click around in it normally, and record it.
- **App window:** record any app window, or a whole screen.

Recordings are MP4 (H.264 video, AAC or Opus audio) at a steady 30 or 60 fps.
When a recording stops you can trim it to a clip in the same window.

Built for [Omarchy](https://omarchy.org) (Arch + Hyprland, Wayland), where it works without any setup.
It also runs on Windows from source.

## Install

- **Linux (Omarchy, or any recent distro):** get `Neko-Capture_<version>_amd64.AppImage` from the
  [releases page](https://github.com/neko-legends/neko-capture/releases), or install it from
  [Neko Legends Control Center](https://github.com/neko-legends/neko-legends-control-center).
  Then `chmod +x` the file and run it. There is nothing else to install.
- **Windows:** run from source (below), or build the exe with `build.bat`.

## Run from source

- **Linux:** `./start.sh`
- **Windows:** double-click `start.bat`

The first run does `npm install` (needs [Node.js](https://nodejs.org) 20+).
There is nothing to compile: these scripts run the code straight from `src/`, so edits show up the next time you start it.

## Build

- **Linux:** `./build.sh` creates `dist/Neko-Capture_<version>_amd64.AppImage`
  (`./build.sh folder` creates a plain folder, `dist/neko-capture-linux-x64/`, instead).
- **Windows:** `build.bat` creates `dist\neko-capture-win32-x64\neko-capture.exe`. Copy that whole folder anywhere.

Neither needs Node.js to run afterwards.

## Use

1. **Web page tab:** type the URL, pick a size, then press **Open**. Click into the stage window to play.
   Keys, mouse and dropdowns work as in a normal browser.
   F5 reloads the page and F12 opens DevTools.
2. **App window tab:** press **Choose window…** and click a thumbnail. On Wayland the system picker opens instead.
3. Press **Record**, or **Ctrl+Alt+R** from anywhere (see [Hotkey](#hotkey)). Press it again to stop.
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

## Omarchy / Hyprland

Tested on Omarchy (Arch, Hyprland, Wayland, NVIDIA). The app runs as a native Wayland window.

- **Stage size:** Hyprland floats the stage by itself, because the window has a fixed size, so the page is
  exactly the size you asked for (checked up to 3840×2160 and 1080×1920). A stage larger than the monitor
  hangs off-screen and still records in full.
- **App window:** the system picker opens (Windows, Outputs or Region). Pick one, then press Record.
  Window capture has no sound on Linux; the Web page tab records the page's own sound.
- **Encoder:** H.264 is encoded in software on Linux. 1080p and 1440p at 60 fps hold; 4K at 60 fps can drop frames,
  so use 30 fps for 4K.

If a different tiling window manager resizes the stage, the panel says so. Make the window titled
`neko-capture stage` float in that window manager's rules.

## Hotkey

| Where | How Ctrl+Alt+R works |
| --- | --- |
| Windows, X11 | Registered by the app. |
| Hyprland | The app binds the key in Hyprland while it runs and removes it when it quits. Nothing to configure. If you already use Ctrl+Alt+R for something else, the app leaves it alone. |
| Other Wayland desktops | Bind a key of your choice to `neko-capture --toggle-record` (with the AppImage: `"/path/to/Neko-Capture.AppImage" --toggle-record`). |

Starting the app a second time brings the running one forward; with `--toggle-record` it starts or stops the recording there.

## Self-test

`npm run smoke` opens a test page, records 3 seconds and prints the result.
Options after `--`: `--size=1080x1920`, `--borderless`, `--window` (app-window mode: you pick the source), `--hotkey`,
`--url=<address>` (record that page instead of the test page), `--click` (click the page first, for pages that start their sound on a click).
The AppImage takes the same flags: `./Neko-Capture_<version>_amd64.AppImage --smoke`.
