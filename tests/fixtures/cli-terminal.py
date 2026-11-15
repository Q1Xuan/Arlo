"""Drive an actual terminal without changing the CLI's terminal detection."""
import errno
import json
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
child = subprocess.Popen(json.loads(sys.argv[1]), stdin=slave, stdout=slave,
                         stderr=slave, close_fds=True)
os.close(slave)
output = bytearray()
steps = iter(json.loads(sys.argv[2]))
step = next(steps, None)
deadline = time.monotonic() + 10
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            output.extend(chunk)
        if step and step[0].encode() in output:
            os.write(master, step[1].encode())
            step = next(steps, None)
        if child.poll() is not None:
            # Read remaining terminal output before reporting the exit.
            while select.select([master], [], [], 0)[0]:
                try:
                    remaining = os.read(master, 65536)
                    if not remaining:
                        break
                    output.extend(remaining)
                except OSError:
                    break
            break
    if child.poll() is None:
        try:
            # Terminal EOF can precede the process becoming reapable.
            child.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
            sys.stdout.buffer.write(output)
            sys.stderr.write("CLI terminal timed out\n")
            sys.exit(2)
    sys.stdout.buffer.write(output)
    sys.exit(child.returncode)
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
