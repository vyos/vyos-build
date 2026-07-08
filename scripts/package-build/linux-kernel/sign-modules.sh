#!/bin/sh -x

BASE_DIR=$(dirname $0)
MODULE_DIR=$1
# Pass "--keep" as $2 to retain the uncompressed, signed .ko next to the
# .ko.xz it produces. Needed by callers whose build system tracks the
# uncompressed .ko as a build output (e.g. CMake custom commands) and
# would otherwise consider it missing and regenerate an unsigned copy.
KEEP_UNCOMPRESSED=$2
. ${BASE_DIR}/kernel-vars

SIGN_FILE="${KERNEL_DIR}/scripts/sign-file"
CONFIG_FILE="${KERNEL_DIR}/.config"

if [ -f ${EPHEMERAL_KEY} ] && [ -f ${EPHEMERAL_CERT} ]; then
    find ${MODULE_DIR} -type f -name \*.ko | while read MODULE; do
      echo "I: Signing ${MODULE} ..."
      ${SIGN_FILE} sha512 ${EPHEMERAL_KEY} ${EPHEMERAL_CERT} ${MODULE}
      if [ -f "$CONFIG_FILE" ] && grep -qx "CONFIG_MODULE_COMPRESS_XZ=y" "$CONFIG_FILE"; then
          if [ "${KEEP_UNCOMPRESSED}" = "--keep" ]; then
              xz --compress --keep ${MODULE}
          else
              xz --compress ${MODULE}
          fi
      fi
    done
    find ${MODULE_DIR}
fi
