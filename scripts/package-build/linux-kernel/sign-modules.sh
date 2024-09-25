#!/bin/sh

BASE_DIR=$(dirname $0)
MODULE_DIR=$1
. ${BASE_DIR}/kernel-vars

SIGN_FILE="${KERNEL_DIR}/scripts/sign-file"

if [ -f ${EPHEMERAL_KEY} ] && [ -f ${EPHEMERAL_CERT} ]; then
    find ${MODULE_DIR} -type f -name \*.ko | while read MODULE; do
      echo "I: Signing ${MODULE} ..."
      ${SIGN_FILE} sha512 ${EPHEMERAL_KEY} ${EPHEMERAL_CERT} ${MODULE}
    done
fi

