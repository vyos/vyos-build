#!/bin/sh
set -e

BUILD_ARCH=$(dpkg-architecture -qDEB_TARGET_ARCH)

SRC=telegraf
if [ ! -d ${SRC} ]; then
    echo "Source directory does not exists, please 'git clone'"
    exit 1
fi

# T9277: Only compile in the plugins that can actually be instantiated from the
# VyOS CLI. Telegraf ships ~240 inputs and ~60 outputs, which produces a 198 MB
# binary; the list below brings that down to about 28 MB.
#
# These names are the plugins referenced by the vyos-1x telegraf templates in
# data/templates/telegraf/. When a plugin is added there, it MUST be added here
# too, otherwise telegraf fails to start with an "unknown plugin" error.
TELEGRAF_INPUTS="chrony conntrack cpu disk diskio ethtool exec internal
                 interrupts kernel linux_sysctl_fs mem net netstat nstat
                 processes syslog system systemd_units"
TELEGRAF_OUTPUTS="azure_data_explorer http influxdb_v2 loki prometheus_client"
# "influx" backs [[inputs.exec]] data_format, "splunkmetric" backs the Splunk
# [[outputs.http]] data_format.
TELEGRAF_PARSERS="influx"
TELEGRAF_SERIALIZERS="splunkmetric"

# Telegraf selects plugins via Go build tags: the "custom" tag disables the
# compile-everything default, and every plugin is then opted back in by name.
BUILDTAGS="custom"
for plugin in ${TELEGRAF_INPUTS}; do
    BUILDTAGS="${BUILDTAGS},inputs.${plugin}"
done
for plugin in ${TELEGRAF_OUTPUTS}; do
    BUILDTAGS="${BUILDTAGS},outputs.${plugin}"
done
for plugin in ${TELEGRAF_PARSERS}; do
    BUILDTAGS="${BUILDTAGS},parsers.${plugin}"
done
for plugin in ${TELEGRAF_SERIALIZERS}; do
    BUILDTAGS="${BUILDTAGS},serializers.${plugin}"
done

echo "I: Selected plugins: ${BUILDTAGS}"

echo "I: Build Debian ${BUILD_ARCH} package"
cd ${SRC}
export PATH=/opt/go/bin:$PATH

# Generate default telegraf config
go run -tags "${BUILDTAGS}" ./cmd/telegraf config > etc/telegraf.conf
make BUILDTAGS="${BUILDTAGS}" "${BUILD_ARCH}.deb"
