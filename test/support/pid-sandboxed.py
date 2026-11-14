# Start a process and read, from outside and while it runs, whether the
# kernel holds it in a sandbox: sandbox_check(pid, NULL, 0) is 1 for a
# sandboxed process and 0 for one outside every sandbox. The read runs in a
# tight loop from the start, and it is taken at the moment the process shows
# it runs the demo's code:
#   - hello: when the counter's hello line appears in the egress log, a
#     reading taken after it was seen, while the process still runs;
#   - answer: when the process answers the request sent on its stdin, a
#     reading taken after the answer, while it still waits for the next one.
# A process outside every sandbox can read 1 for the last moments of its
# exit, so a reading counts when the process still runs after it. Then its
# stdin is closed, which ends a process that waits for requests on it. In
# the same run, a control pid is read once: an unsandboxed process reads 0.
#
# Input on stdin, JSON: {"argv": [...], "env": {...}, "cwd": "...",
# "control": <pid>, "helloFile": "<path or null>", "ask": "<line or null>",
# "timeoutSeconds": <n>}. Output on stdout, JSON: {"hello": <reading or
# null>, "answer": <reading or null>, "readings": [<distinct readings in
# order>], "exitCode": <n>, "control": <reading>, "stderr": "<last lines>"}.
# It reads nothing under the credential store paths and prints no
# environment value.

import ctypes
import json
import os
import subprocess
import sys
import time


def main():
    lib = ctypes.CDLL('/usr/lib/system/libsystem_sandbox.dylib')
    check = lib.sandbox_check
    check.restype = ctypes.c_int
    check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    req = json.load(sys.stdin)
    hello_file = req.get('helloFile')
    ask = req.get('ask')
    control = check(int(req['control']), None, 0)
    proc = subprocess.Popen(req['argv'], env=req['env'], cwd=req['cwd'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if ask:
        proc.stdin.write((ask + '\n').encode())
        proc.stdin.flush()
    out = proc.stdout.fileno()
    os.set_blocking(out, False)
    got = b''
    hello = None
    answer = None
    readings = []
    deadline = time.monotonic() + float(req.get('timeoutSeconds', 60))
    while time.monotonic() < deadline:
        r = check(proc.pid, None, 0)
        if proc.poll() is not None:
            break
        if r in (0, 1) and (not readings or readings[-1] != r):
            readings.append(r)
        if hello_file and hello is None and os.path.exists(hello_file) and os.path.getsize(hello_file) > 0:
            seen = check(proc.pid, None, 0)
            if proc.poll() is None:
                hello = seen
        if ask and answer is None:
            try:
                got += os.read(out, 65536)
            except BlockingIOError:
                pass
            if b'\n' in got:
                after = check(proc.pid, None, 0)
                if proc.poll() is None:
                    answer = after
        if (not hello_file or hello is not None) and (not ask or answer is not None):
            break
    proc.stdin.close()
    proc.stdin = None
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    os.set_blocking(out, True)
    _, err = proc.communicate(timeout=30)
    tail = err.decode('utf-8', 'replace').strip().split('\n')[-5:]
    print(json.dumps({'hello': hello, 'answer': answer, 'readings': readings, 'exitCode': proc.returncode, 'control': control, 'stderr': '\n'.join(tail)}))


main()
