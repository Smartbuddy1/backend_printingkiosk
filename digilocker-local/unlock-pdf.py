"""Linux-only bounded PDF decryption. All document/password files are anonymous RAM fds."""
import json
import os
import resource
import subprocess
import sys


def main():
    maximum = int(sys.argv[1])
    if not 1 <= maximum <= 10 * 1024 * 1024:
        return 12
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))
    length = int.from_bytes(sys.stdin.buffer.read(4), "big")
    if not 1 <= length <= 4096:
        return 11
    header = json.loads(sys.stdin.buffer.read(length))
    password = header.pop("password", None)
    if not isinstance(password, str) or not password or len(password) > 256 or any(c in password for c in "\r\n\0"):
        return 10
    data = sys.stdin.buffer.read(maximum + 1)
    if not data.startswith(b"%PDF-") or len(data) > maximum:
        return 11
    descriptors = []
    try:
        for label, content in [("kiosk-input", data), ("kiosk-password", password.encode("utf-8") + b"\n"), ("kiosk-output", b"")]:
            fd = os.memfd_create(label, os.MFD_CLOEXEC)
            descriptors.append(fd)
            with os.fdopen(os.dup(fd), "wb") as stream:
                stream.write(content)
            os.lseek(fd, 0, os.SEEK_SET)
        data = password = content = None
        source, secret, output = descriptors
        args = ["/usr/bin/qpdf", "--password-file=/proc/self/fd/" + str(secret)]
        options = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, pass_fds=descriptors, timeout=8)
        check = subprocess.run(args + ["--requires-password", "/proc/self/fd/" + str(source)], **options)
        if check.returncode == 0:
            return 10
        if check.returncode not in (2, 3):
            return 11
        os.lseek(secret, 0, os.SEEK_SET)
        result = subprocess.run(args + ["--decrypt", "/proc/self/fd/" + str(source), "/proc/self/fd/" + str(output)], **options)
        if result.returncode not in (0, 3):
            return 11
        size = os.fstat(output).st_size
        if not 0 < size <= maximum:
            return 12
        os.lseek(output, 0, os.SEEK_SET)
        while True:
            chunk = os.read(output, 65536)
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
        return 0
    finally:
        for fd in descriptors:
            os.close(fd)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except FileNotFoundError:
        sys.exit(13)
    except Exception:
        # Never emit parser errors, document metadata or submitted values.
        sys.exit(11)
