#!/bin/bash
set -e

USER_NAME="vyos_bld"
NEW_UID=$(stat -c "%u" .)
NEW_GID=$(stat -c "%g" .)

# Change effective UID to the one specified via "-e GOSU_UID=`id -u $USER`"
if [ -n "$GOSU_UID" ]; then
    NEW_UID=$GOSU_UID
fi

# Change effective UID to the one specified via "-e GOSU_GID=`id -g $USER`"
if [ -n "$GOSU_GID" ]; then
    NEW_GID=$GOSU_GID
fi

# Notify user about selected UID/GID
echo "Current UID/GID: $NEW_UID/$NEW_GID"

# Create user called "docker" with selected UID
useradd --shell /bin/bash -u $NEW_UID -g $NEW_GID -o -m $USER_NAME
usermod -aG sudo $USER_NAME
sudo chown $NEW_UID:$NEW_GID /home/$USER_NAME
export HOME=/home/$USER_NAME

# Execute process
exec /usr/sbin/gosu $USER_NAME "$@"
