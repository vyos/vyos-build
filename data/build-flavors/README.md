# VyOS build flavors

VyOS supports multiple different hardware and virtual platforms.
Those platforms often need custom packages and may require custom
configs. To make maintenance of existing flavors simpler
and to allow everyone to make and maintain their own flavors,
the build scripts support storing flavor configuration in [TOML](https://toml.io) files.

Flavor files must be in `data/build-flavors`. Here's an example:

```toml
# Generic (aka "universal") ISO image

image_format = "iso"

# Include these packages in the image regardless of the architecture
packages = [
  # QEMU and Xen guest tools exist for multiple architectures
  "qemu-guest-agent",
  "vyos-xe-guest-utilities",
]

[architectures.amd64]
  # Hyper-V and VMware guest tools are x86-only
  packages = ["hyperv-daemons", "vyos-1x-vmware"]
```

## Image format

The `image_format` option specifies the default format to build.

```toml
image_format = "iso"
```

**Note:** currently, ISO is the only supported format,
support for different flavors is in progress.

## Including custom packages

If you want the build scripts to include custom packages from repositories
in the image, you can list them in the `packages` field.

For example, this is how to include the GNU Hello package:

```toml
packages = ['hello']
```

It's possible to include packages only in images with certain build architectures
by placing them in a subtable.

If you want to include GNU Hello only in AMD64 images, do this:

```toml
[architectures.amd64]
  packages = ['hello']
```

## Including custom files

You can include files inside the SquashFS filesystem by adding entries
to the `includes_chroot` array. 

```toml
[[includes_chroot]]
  path = "etc/question.txt"
  data = '''
Can you guess how this file ended up in the image?
  '''

  path = "etc/answer.txt"
  data = '''
It was in the flavor file!
  '''
```
