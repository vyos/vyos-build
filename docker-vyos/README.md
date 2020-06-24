# VyOS as Docker container

VyOS can be run as a Docker container on a Linux host with a compatible kernel.


## Building Docker image

To build a Docker image you need to have the whole `vyos-build` repository, not only a folder with Dockerfile, because some files from this repository are required for building.
Docker image with VyOS can be built on Linux host with the next command:

```
docker build --compress -f Dockerfile -t vyos:version-`date -u +%Y%m%d%H%M%S` --build-arg BUILD_DATE="`date -u --rfc-3339=seconds`" --build-arg VYOS_VERSION=version --build-arg DEBIAN_VERSION=debian --progress plain ..
```

Or, if you want to rebuild completely from the scratch (without cache):

```
docker build --no-cache --pull --compress -f Dockerfile -t vyos:version-`date -u +%Y%m%d%H%M%S` --build-arg BUILD_DATE="`date -u --rfc-3339=seconds`" --build-arg VYOS_VERSION=version --build-arg DEBIAN_VERSION=debian --progress plain ..
```

> **NOTE:** You must use proper version value for `DEBIAN_VERSION` variable. It can be only `jessie` (for VyOS 1.2) or `buster` (for VyOS 1.3).

## Running Docker image

Docker container with VyOS can be running with the next command:

```
docker run -v /lib/modules:/lib/modules --privileged --name vyos_inside_docker -d vyos:version
```

You need to use the `--privileged` flag because the system actively interacts with a host kernel to perform routing operations and tune networking options.


**Experimantal:** You can limit access to some system resources with:

```
docker run --tmpfs /tmp --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:ro -v /lib/modules:/lib/modules --privileged --name vyos_inside_docker -d vyos:version
```

## Logging into a VyOS container

To open VyOS CLI, you can use SSH connection to the Docker container or run on host:

```
docker exec -it vyos_inside_docker su vyos
```


## Troubleshooting

If in VyOS appears IPv6-related errors, for example, it cannot assign an IPv6 for an interface, it is necessary to enable IPv6 support in Docker. This can be done, by editing `/etc/docker/daemon.json`:

```
{
    "ipv6": true,
    "fixed-cidr-v6": "fe80::/64"
}

```
