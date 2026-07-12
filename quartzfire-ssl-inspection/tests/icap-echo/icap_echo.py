#!/usr/bin/env python3
"""A throwaway, no-op ICAP server for proving the SSL-inspection ICAP seam.

It answers OPTIONS/REQMOD/RESPMOD, logs the *plaintext* HTTP it receives from
Squid (which is the whole point — Squid bumps BEFORE adaptation, so an ICAP
engine sees decrypted traffic and needs no TLS of its own), and returns 204 No
Content so the traffic passes through unmodified. This stands in for the future
e2guardian/c-icap engine to demonstrate it is a genuine drop-in.

Not for production — no preview accounting, no keep-alive (Connection: close
per request keeps framing trivially correct).
"""
import argparse
import datetime
import socket
import sys
import threading


def handle(conn, logf):
    conn.settimeout(0.8)
    data = b""
    try:
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:
                return
            data += chunk
        header_part, _, rest = data.partition(b"\r\n\r\n")
        request_line = header_part.split(b"\r\n", 1)[0].decode("latin1", "replace")
        parts = request_line.split(" ")
        method = parts[0].upper()
        path = parts[1] if len(parts) > 1 else ""

        # Best-effort read of the encapsulated HTTP (+ body) for logging. Squid
        # may withhold the body until we answer a preview; the short timeout
        # bounds the wait, then we respond anyway.
        try:
            while b"0\r\n\r\n" not in rest:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                rest += chunk
        except socket.timeout:
            pass

        if method == "OPTIONS":
            allow = "RESPMOD" if path.endswith("response") else "REQMOD"
            conn.sendall(
                (
                    "ICAP/1.0 200 OK\r\n"
                    f"Methods: {allow}\r\n"
                    'ISTag: "qzssl-echo"\r\n'
                    "Allow: 204\r\n"
                    "Preview: 0\r\n"
                    "Encapsulated: null-body=0\r\n"
                    "Connection: close\r\n\r\n"
                ).encode()
            )
        elif method in ("REQMOD", "RESPMOD"):
            ts = datetime.datetime.utcnow().isoformat()
            with open(logf, "a") as f:
                f.write(f"=== {method} {ts} ===\n")
                f.write(header_part.decode("latin1", "replace"))
                f.write("\n--- encapsulated (decrypted plaintext) ---\n")
                f.write(rest.decode("latin1", "replace"))
                f.write("\n\n")
                f.flush()
            conn.sendall(
                (
                    "ICAP/1.0 204 No Content\r\n"
                    'ISTag: "qzssl-echo"\r\n'
                    "Connection: close\r\n\r\n"
                ).encode()
            )
        else:
            conn.sendall(b"ICAP/1.0 405 Method Not Allowed\r\nConnection: close\r\n\r\n")
    except Exception:  # noqa: BLE001 — a test helper; never crash the accept loop
        try:
            conn.sendall(b"ICAP/1.0 500 Server Error\r\nConnection: close\r\n\r\n")
        except Exception:
            pass
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=1344)
    ap.add_argument("--log", default="/tmp/icap.log")
    a = ap.parse_args()

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((a.host, a.port))
    s.listen(16)
    sys.stderr.write(f"icap-echo listening on {a.host}:{a.port}, logging to {a.log}\n")
    sys.stderr.flush()
    while True:
        conn, _ = s.accept()
        threading.Thread(target=handle, args=(conn, a.log), daemon=True).start()


if __name__ == "__main__":
    main()
