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

# Create UNIX group on the fly if it does not exist
if ! grep -q $NEW_GID /etc/group; then
    groupadd --gid $NEW_GID $USER_NAME
fi

useradd --shell /bin/bash --uid $NEW_UID --gid $NEW_GID --non-unique --create-home $USER_NAME
sudo chown $NEW_UID:$NEW_GID /home/$USER_NAME
export HOME=/home/$USER_NAME

if [ "$(id -u)" == "0" ]; then
    exec gosu $USER_NAME "$@"
fi

# Execute process
exec "$@"
