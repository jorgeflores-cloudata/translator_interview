"""Restart the local app, releasing its configured TCP port on Windows."""
import json
import os
import subprocess
import time

import server


def validate_port(port):
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('PORT must be a number between 1 and 65535.')
    return port


def powershell(script):
    try:
        result = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
             "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); "
             "$ErrorActionPreference = 'Stop'; " + script],
            capture_output=True, text=True, encoding='utf-8', timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError('Could not inspect or close the process on Windows.') from error
    if result.returncode:
        raise RuntimeError('Windows could not inspect or close the process. Check your permissions.')
    return result.stdout.strip()


def listener_pids(port):
    validate_port(port)
    result = powershell(
        f'$owners = @(Get-NetTCPConnection -State Listen | Where-Object {{ $_.LocalPort -eq {port} }} '
        '| Select-Object -ExpandProperty OwningProcess -Unique); '
        'ConvertTo-Json -InputObject $owners -Compress'
    )
    try:
        owners = json.loads(result)
        if not isinstance(owners, list):
            owners = [owners]
        if any(type(pid) is not int or pid < 0 for pid in owners):
            raise ValueError('Invalid PID')
        return set(owners)
    except (ValueError, TypeError) as error:
        raise RuntimeError('Windows returned an invalid process list.') from error


def stop_process(pid):
    if type(pid) is not int or pid <= 4 or pid in (os.getpid(), os.getppid()):
        raise RuntimeError('Cannot close a system process or the launcher itself.')
    powershell(
        f'$targetProcess = Get-Process -Id {pid} -ErrorAction SilentlyContinue; '
        'if ($null -ne $targetProcess) { $targetProcess | Stop-Process -Force -ErrorAction Stop }'
    )


def release_port(port, timeout=10):
    validate_port(port)
    deadline = time.monotonic() + timeout
    stopped = set()
    while True:
        owners = listener_pids(port)
        if not owners:
            return
        if owners & {0, 4, os.getpid(), os.getppid()}:
            raise RuntimeError(f'Port {port} belongs to a protected process and cannot be restarted.')
        if time.monotonic() >= deadline:
            raise RuntimeError(f'Port {port} is still in use. The app was not started.')
        for pid in sorted(owners - stopped):
            # Recheck ownership immediately before closing a process.
            if pid not in listener_pids(port):
                continue
            print(f'Closing PID {pid}, which is using port {port}...', flush=True)
            stop_process(pid)
            stopped.add(pid)
        time.sleep(0.15)


def main():
    try:
        server.load_env()
        port = server.port_from_env()
        server.find_chrome()
        release_port(port)
        return server.main()
    except (OSError, ValueError, RuntimeError) as error:
        print(f'Could not restart the app: {error}', flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
