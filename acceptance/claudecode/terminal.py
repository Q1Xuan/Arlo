"""Native acceptance terminals. No host, bridge or message behavior is simulated."""
import codecs
import os
import select
import subprocess
import time


class _ConPtyChild:
    """The small Popen interface used by the shared scenario driver."""
    def __init__(self, terminal):
        import psutil
        self.terminal = terminal
        self.pid = terminal.pid
        self.native = psutil.Process(self.pid)
        self.returncode = None

    def poll(self):
        if self.returncode is None and not self.terminal.pty.isalive():
            self.returncode = self.terminal.exitstatus
        return self.returncode

    def wait(self, timeout=None):
        end = None if timeout is None else time.monotonic() + timeout
        while self.poll() is None:
            if end is not None and time.monotonic() >= end:
                raise subprocess.TimeoutExpired('ConPTY child', timeout)
            time.sleep(.02)
        return self.returncode

    def terminate(self):
        if self.poll() is None:
            self.native.terminate()

    kill = terminate


class Terminal:
    def __init__(self, argv, *, cwd, env):
        self.eof = False
        self.closed = False
        self._screen = None
        self._screen_pending = bytearray()
        self._screen_pending_overflow = False
        if os.name == 'nt':
            from winpty import PtyProcess
            from winpty.enums import Backend
            # No legacy WinPTY fallback: this evidence specifically uses ConPTY.
            self.native = PtyProcess.spawn(argv, cwd=str(cwd), env=env,
                                           dimensions=(48, 170), backend=Backend.ConPTY)
            self.process = _ConPtyChild(self.native)
        else:
            import fcntl
            import pty
            import struct
            import termios
            self.master, slave = pty.openpty()
            try:
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 170, 0, 0))
                self.process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=slave,
                                                stdout=slave, stderr=slave, start_new_session=True)
            except BaseException:
                os.close(self.master)
                raise
            finally:
                os.close(slave)

    def read(self):
        output = bytearray()
        if self.eof or self.closed:
            return output
        stream = self.native if os.name == 'nt' else self.master
        while select.select([stream], [], [], 0)[0]:
            try:
                data = self.native.read(65536).encode('utf-8') if os.name == 'nt' else os.read(self.master, 65536)
                if not data:
                    self.eof = True
                    break
                output.extend(data)
            except EOFError:
                self.eof = True
                break
            except OSError as error:
                # Unix PTYs report EIO once their last slave is closed.
                import errno
                if os.name != 'nt' and error.errno == errno.EIO:
                    self.eof = True
                    break
                raise
        if self._screen is None:
            self._screen_pending.extend(output)
            if len(self._screen_pending) > 1048576:
                del self._screen_pending[:-1048576]
                self._screen_pending_overflow = True
        else:
            self._screen_stream.feed(self._screen_decoder.decode(output, final=self.eof))
        return output

    def screen_text(self):
        """Current 48x170 screen after read(); does not consume terminal I/O.

        Screen observation loads its optional parser only when requested. Start
        observing during startup, before the bounded pending capture fills.
        """
        if self._screen is None:
            if self._screen_pending_overflow:
                raise RuntimeError('Native screen observation began after capture bound')
            import pyte
            self._screen = pyte.Screen(170, 48)
            self._screen_stream = pyte.Stream(self._screen)
            self._screen_decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
            self._screen_stream.feed(self._screen_decoder.decode(self._screen_pending, final=self.eof))
            self._screen_pending.clear()
        return '\n'.join(line.rstrip() for line in self._screen.display).rstrip()

    def write(self, data):
        if os.name == 'nt':
            self.native.write(data.decode('utf-8'))
        else:
            os.write(self.master, data)

    def close(self):
        if self.closed:
            return
        if self.process.poll() is None:
            raise RuntimeError('Live acceptance process prevents terminal cleanup')
        if os.name == 'nt':
            self.native.close()
        else:
            os.close(self.master)
        self.closed = True
