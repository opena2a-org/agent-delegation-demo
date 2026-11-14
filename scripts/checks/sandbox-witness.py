# Read the kernel's record of other processes' sandboxes: sandbox_check from
# libsystem_sandbox, called from outside those processes.
#
# Input, one JSON object on stdin: {"queries": [[id, pid, operation, path], ...]}
# with operation and path null for the question "is this process sandboxed".
# Output, one JSON object: {"self": n, "results": {id: n, ...}}, where n is 1
# (refused, or sandboxed), 0 (allowed, or not sandboxed) or -1 (could not
# read), and "self" is this process's own sandboxed reading.
#
# The kernel resolves each path; nothing under it is read, and no path is
# written to the output.
#
# Run with: /usr/bin/python3 -I scripts/checks/sandbox-witness.py

import ctypes
import json
import os
import sys

SANDBOX_FILTER_PATH = 1
SANDBOX_CHECK_NO_REPORT = 0x40000000


def main():
    lib = ctypes.CDLL('/usr/lib/system/libsystem_sandbox.dylib')
    check = lib.sandbox_check
    check.restype = ctypes.c_int
    # The fixed arguments; the path is passed as the variadic argument, which
    # ctypes places where the platform's calling convention puts one.
    check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]

    def read(pid, operation, path):
        if operation is None:
            n = check(int(pid), None, 0)
        else:
            n = check(int(pid), operation.encode(), SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, path.encode())
        return n if n in (0, 1) else -1

    request = json.load(sys.stdin)
    results = {}
    for qid, pid, operation, path in request['queries']:
        results[qid] = read(pid, operation, path)
    json.dump({'self': read(os.getpid(), None, None), 'results': results}, sys.stdout)
    sys.stdout.write('\n')


main()
