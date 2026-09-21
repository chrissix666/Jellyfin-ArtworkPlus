"""Audit S1-04 proof: request a plugin file endpoint while its file is locked
exclusively by another process (a writing artwork tool). Content untouched,
the lock is released at exit.

    python tools/probe_locked_file.py <file path> <endpoint url>

Prints the HTTP status the server answers while the file is locked
(before the fix: 500, after: 404) and the status once unlocked (200).
"""
import msvcrt
import os
import sys
import urllib.error
import urllib.request

path, url = sys.argv[1], sys.argv[2]


def status(u):
    try:
        return urllib.request.urlopen(u, timeout=20).status
    except urllib.error.HTTPError as e:
        return e.code


size = os.path.getsize(path)
with open(path, 'r+b') as f:
    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, size)
    try:
        locked = status(url)
    finally:
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, size)
print('locked ->', locked, '| unlocked ->', status(url))
