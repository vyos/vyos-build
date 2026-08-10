#!/bin/sh
# Shared helpers for scripts/package-build/linux-kernel/build-*.sh.
# Source this file (". ${CWD}/common.sh"); it defines functions only.

# require_amd64 <component-name>
# Soft-exits (status 0) if not running on amd64.
require_amd64() {
    if ! dpkg-architecture -iamd64; then
        echo "${1} is only buildable on amd64 platforms"
        exit 0
    fi
}

# debian_version <raw-version-string>
# Sanitizes a git-describe-style string (e.g. "5.3-5-g5aeee02") into a
# version safe for a "3.0 (native)" Debian source package:
#  - hyphens are replaced with "+", since debuild/dpkg-source treat any
#    hyphen as "this needs a separate orig tarball" even for native
#    packages, and reject the build asking for one that doesn't exist.
#  - the result is prefixed with "0~" if it doesn't start with a digit,
#    since Debian versions must start with a digit (a bare abbreviated
#    git hash can start with a letter).
debian_version() {
    v=$(echo "$1" | tr -- '-' '+')
    case "$v" in
        [0-9]*) echo "$v" ;;
        *) echo "0~$v" ;;
    esac
}
