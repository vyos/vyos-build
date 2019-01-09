#!/bin/bash

set -e

# Use GOSU_USER if its specified, else wirking dir user
if [ -n "$GOSU_USER" ]; then 
  ID=$GOSU_USER
else
  ID=$(stat -c "%u:%g" .)
fi

# Don't use GOSU if we are root
if [ ! "$ID" = "0:0" ]; then
  exec gosu $ID "$@"
else
  exec "$@"
fi
