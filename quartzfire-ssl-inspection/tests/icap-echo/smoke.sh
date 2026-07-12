#!/usr/bin/env bash
# Prove the SSL-inspection ICAP seam locally with real squid-openssl.
#
# Stands up (in one throwaway debian:bookworm container) a squid-openssl bump
# proxy + a no-op ICAP echo + a local HTTPS origin, drives a bumped request,
# and asserts the echo received DECRYPTED plaintext for REQMOD and RESPMOD —
# then that a down filter with bypass=off fails closed. Tears everything down
# (--rm). Nothing touches the host.
#
# Requires Docker. On Windows run under WSL:  wsl bash smoke.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

echo "==> Running the ICAP-seam smoke test in debian:bookworm (squid-openssl)"
# Pipe the harness in as a tar over stdin so no host-path bind-mount is needed
# (works the same from git-bash + Docker Desktop and from native WSL/Linux).
tar -C "$here" -cf - icap_echo.py run-in-container.sh \
  | docker run --rm -i debian:bookworm bash -c '
      set -e
      mkdir -p /harness
      tar -C /harness -xf -
      bash /harness/run-in-container.sh
    '
