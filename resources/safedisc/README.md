# SafeDisc support files

Used by `electron/safedisc.ts` to run SafeDisc 2.x–4.x games under Wine/Proton. Bundled into the
AppImage as `resources/safedisc` (electron-builder `extraResources`).

| File | What |
|---|---|
| `drvmgt.dll` | [SafeDiscShim](https://github.com/RibShark/SafeDiscShim) v0.9.0 (from `SafeDiscShim_Setup_0.9.0.exe`, released 2025-09-29). Emulates the `secdrv.sys` driver in user mode. GPLv3 with a SafeDisc linking exception, see `LICENSE-SafeDiscShim.md`; source at the link above. Not a crack: the original disc is still checked. |
| `safedisc-run.exe` | Loads the shim, calls its `Setup()` (hooks CreateProcess) and starts the game, so the shim is injected. Wine ignores the AppCompat database SafeDiscShim uses on Windows. Source: `safedisc-run.c`. |

Rebuild `safedisc-run.exe`: `i686-w64-mingw32-gcc -O2 -municode -mwindows -o safedisc-run.exe safedisc-run.c`
