/* safedisc-run.exe — start a SafeDisc 2.x–4.x game under Wine/Proton with SafeDiscShim.
 *
 * SafeDiscShim (github.com/RibShark/SafeDiscShim) emulates the secdrv.sys driver in user mode.
 * On Windows it gets itself into the game through a compatibility database (.sdb) — Wine has
 * no AppCompat engine, so this launcher does the injection instead:
 *   1. loads the shim (C:\windows\syswow64\drvmgt.dll) into this 32-bit process and calls its
 *      Setup() export, which hooks CreateProcessA/W here;
 *   2. starts the target exe through the hooked CreateProcessW, so the shim gets injected into
 *      it (and, via the same hooks inside it, into every process it starts — e.g. a config
 *      launcher that starts the real protected game exe).
 * SAFEDISCSHIM_INJECTED=1 is set so the shim never does its "kill and relaunch the game from
 * the SafeDisc cleanup exe" dance (only needed for the .sdb route).
 *
 * Usage:  safedisc-run.exe [--mutex NAME]... <target.exe> [args...]
 *         relative target = relative to the folder this exe lives in. Waits for the target.
 *         --mutex NAME creates (and holds until the game exits) a named mutex first — for games
 *         whose own launcher starts them via ShellExecute (which the shim's CreateProcess hooks
 *         don't follow under Wine) and whose exe refuses to run unless the launcher's mutex
 *         exists. E.g. Sonic Riders: --mutex SonicRidersLauncher_RunGame SonicRiders.exe
 * Build:  i686-w64-mingw32-gcc -O2 -municode -mwindows -o safedisc-run.exe safedisc-run.c
 */
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <wchar.h>

typedef int (__cdecl *SetupFn)(const char *, char *);

static void fail(const wchar_t *msg, DWORD err)
{
    wchar_t buf[1024];
    swprintf(buf, 1024, L"%ls (error %lu)", msg, (unsigned long)err);
    MessageBoxW(NULL, buf, L"safedisc-run", MB_ICONERROR);
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE hp, LPWSTR cmd, int show)
{
    int argc;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    int ai = 1;
    while (argv && ai + 1 < argc && !wcscmp(argv[ai], L"--mutex")) {
        CreateMutexW(NULL, TRUE, argv[ai + 1]);   /* handle intentionally kept until we exit */
        ai += 2;
    }
    if (!argv || ai >= argc) {
        fail(L"usage: safedisc-run.exe [--mutex NAME]... <target.exe> [args...]", 0);
        return 2;
    }

    /* folder of this exe */
    wchar_t self_dir[MAX_PATH];
    GetModuleFileNameW(NULL, self_dir, MAX_PATH);
    wchar_t *slash = wcsrchr(self_dir, L'\\');
    if (slash) *slash = 0;

    /* absolute target path */
    wchar_t target[MAX_PATH];
    if (argv[ai][0] && (argv[ai][1] == L':' || argv[ai][0] == L'\\'))
        wcsncpy(target, argv[ai], MAX_PATH);
    else
        swprintf(target, MAX_PATH, L"%ls\\%ls", self_dir, argv[ai]);
    target[MAX_PATH - 1] = 0;

    wchar_t target_dir[MAX_PATH];
    wcsncpy(target_dir, target, MAX_PATH);
    slash = wcsrchr(target_dir, L'\\');
    if (slash) *slash = 0;

    /* command line: "target" + the rest of our args, quoted */
    static wchar_t cmdline[32768];
    swprintf(cmdline, 32768, L"\"%ls\"", target);
    for (int i = ai + 1; i < argc; i++) {
        wcscat(cmdline, L" \"");
        wcscat(cmdline, argv[i]);
        wcscat(cmdline, L"\"");
    }

    SetEnvironmentVariableW(L"SAFEDISCSHIM_INJECTED", L"1");

    /* load the shim from the (syswow64) system dir — the same path its injector uses */
    char shim[MAX_PATH];
    GetSystemDirectoryA(shim, MAX_PATH);
    strcat(shim, "\\drvmgt.dll");
    HMODULE h = LoadLibraryA(shim);
    if (!h) { fail(L"SafeDiscShim drvmgt.dll not found in the system folder", GetLastError()); return 3; }
    SetupFn setup = (SetupFn)GetProcAddress(h, "Setup");
    if (!setup) { fail(L"drvmgt.dll has no Setup export - not SafeDiscShim?", GetLastError()); return 3; }
    setup(NULL, NULL);   /* returns 100; installs the CreateProcess hooks in this process */

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(NULL, cmdline, NULL, NULL, FALSE, 0, NULL, target_dir, &si, &pi)) {
        fail(target, GetLastError());
        return 4;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    return (int)code;
}
