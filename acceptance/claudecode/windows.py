"""Windows-only permissions and process observations for owned acceptance runs."""
import ctypes
import json
import pathlib
import subprocess


def protect_run(run, owner, node):
    subprocess.run([node, str(pathlib.Path(__file__).with_name('private-state.mjs')), str(run), owner],
                   check=True, capture_output=True, timeout=60)


def read_text(file):
    """Read one snapshot without preventing its atomic replacement."""
    import msvcrt
    import os
    import time
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                  wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    deadline = time.monotonic() + 2
    while True:
        # GENERIC_READ, sharing read/write/delete, OPEN_EXISTING. A reader keeps
        # its opened snapshot even when the publisher replaces the pathname.
        handle = kernel.CreateFileW(str(file), 0x80000000, 0x7, None, 3, 0x80, None)
        if handle != wintypes.HANDLE(-1).value:
            break
        error = ctypes.WinError(ctypes.get_last_error())
        if error.winerror not in [5, 32, 303] or time.monotonic() >= deadline:
            raise error
        time.sleep(.02)
    try:
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY)
    except BaseException:
        kernel.CloseHandle(handle)
        raise
    # The CRT descriptor owns the native handle from this point onward.
    with os.fdopen(descriptor, 'r', encoding='utf-8') as stream:
        return stream.read()


def owned_processes(run, owner):
    import psutil
    result = []
    for process in psutil.process_iter():
        try:
            environment = process.environ()
            if (environment.get('ARLO_ACCEPTANCE_ROOT') == str(run) and
                    environment.get('ARLO_ACCEPTANCE_OWNER') == owner and process.is_running()):
                result.append(process.pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return result


def terminate_owned(run, owner, pid):
    import psutil
    try:
        process = psutil.Process(pid)
        environment = process.environ()
        if (environment.get('ARLO_ACCEPTANCE_ROOT') == str(run) and
                environment.get('ARLO_ACCEPTANCE_OWNER') == owner):
            # psutil's mutating methods additionally check the process creation
            # time, preventing a reused PID from selecting another process.
            process.terminate()
    except psutil.NoSuchProcess:
        pass


def filesystem(directory):
    volume = pathlib.Path(directory).resolve().anchor
    kind = ctypes.create_unicode_buffer(64)
    if not ctypes.windll.kernel32.GetVolumeInformationW(volume, None, 0, None, None, None, kind, len(kind)):
        raise RuntimeError('ACCEPTANCE_FILESYSTEM_OBSERVATION_FAILED')
    return kind.value
