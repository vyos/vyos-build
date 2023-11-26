# VyOS as Docker container

VyOS can be run as a Docker container on a Linux host with a compatible kernel.

## Build Container

To build a Docker image you need to have the whole `vyos-build` repository, not
only a folder with Dockerfile, because some files from this repository are
required for building.

Docker image with VyOS can be built on Linux host with the next command:

```console
docker build --compress --file Dockerfile \
  --tag vyos:version-`date -u +%Y%m%d%H%M%S` \
  --build-arg BUILD_DATE="`date -u --rfc-3339=seconds`" \
  --build-arg VYOS_VERSION=version \
  --build-arg DEBIAN_VERSION=debian \
  --progress plain ..
```

Or, if you want to rebuild completely from the scratch (without cache):

```console
docker build --no-cache --pull --compress --file Dockerfile \
  --tag vyos:version-`date -u +%Y%m%d%H%M%S` \
  --build-arg BUILD_DATE="`date -u --rfc-3339=seconds`" \
  --build-arg VYOS_VERSION=version \
  --build-arg DEBIAN_VERSION=debian \
  --progress plain ..
```

> **_NOTE:_** You must use proper version value for `DEBIAN_VERSION` variable.
  It can be only `jessie` (for VyOS 1.2) or `buster` (for VyOS 1.3).

## Run Container

Docker container with VyOS can be running with the next command:

```console
docker run --privileged --detach \
  --volume /lib/modules:/lib/modules \
  --name vyos_inside_docker vyos:version
```

You need to use the `--privileged` flag because the system actively interacts
with a host kernel to perform routing operations and tune networking options.

**Experimantal:** You can limit access to some system resources with:

```console
docker run --privileged --detach \
   --tmpfs /tmp \
   --tmpfs /run \
   --tmpfs /run/lock \
   --volume /lib/modules:/lib/modules:ro \
   --volume /sys/fs/cgroup:/sys/fs/cgroup:ro \
   --name vyos_inside_docker vyos:version
```

### Log into container

To open VyOS CLI, you can use SSH connection to the Docker container or run
on host:

```console
docker exec -it vyos_inside_docker su vyos
```

## Troubleshooting

If in VyOS appears IPv6-related errors, for example, it cannot assign an IPv6
address for an interface, it is necessary to enable IPv6 support in Docker.

This can be done, by editing `/etc/docker/daemon.json`:

```console
{
    "ipv6": true,
    "fixed-cidr-v6": "fe80::/64"
}
```
