# syntax = docker/dockerfile:1

# Copyright (C) 2020 VyOS maintainers and contributors
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License version 2 or later as
# published by the Free Software Foundation.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

# Define arguments for VyOS image
ARG VYOS_VERSION
ARG BUILD_DATE
ARG DEBIAN_VERSION

# Use Debian as base layer
FROM debian:${DEBIAN_VERSION}-slim
# Copy installer script and default build settings
COPY [ "data/defaults.json", "data/live-build-config/archives/*", "docker-vyos/vyos_install_common.sh", "docker-vyos/vyos_install_stage_01.sh", "/tmp/" ]
COPY [ "data/live-build-config/hooks/live/*", "/tmp/hooks/" ]


# Install VyOS dependencies
WORKDIR /tmp
RUN bash /tmp/vyos_install_stage_01.sh


# Install VyOS specific software
COPY [ "data/defaults.json", "docker-vyos/vyos_install_common.sh", "docker-vyos/vyos_install_stage_02.sh", "/tmp/" ]
RUN bash /tmp/vyos_install_stage_02.sh


# Tune system for VyOS
COPY [ "docker-vyos/vyos_install_common.sh", "docker-vyos/vyos_install_stage_03.sh", "/tmp/" ]
# Copy skel for bash profile
COPY data/live-build-config/includes.chroot/etc/skel/.bashrc /etc/skel/.bashrc
# Copy default config
COPY data/live-build-config/includes.chroot/opt/vyatta/etc/config.boot.default /opt/vyatta/etc/

RUN bash /tmp/vyos_install_stage_03.sh

# Delete installer scripts
RUN rm -rf /tmp/*


# Make changes specific to the container environment

# Tell systemd that we are inside container
ENV container=docker

# Set proper STOPSIGNAL
STOPSIGNAL SIGRTMIN+3

# Run VyOS
CMD [ "/lib/systemd/systemd" ]

# Describe this image
LABEL maintainer="support@vyos.io" \
      description="VyOS for Docker" \
      vendor="Sentrium S.L." \
      version=${VYOS_VERSION} \
      io.vyos.build-date=${BUILD_DATE}
