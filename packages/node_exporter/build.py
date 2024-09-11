#!/usr/bin/env python3

from pathlib import Path
from subprocess import run
import requests
import tarfile

VERSION = '1.8.2'
URL = f'https://github.com/prometheus/node_exporter/releases/download/v{VERSION}/node_exporter-{VERSION}.linux-amd64.tar.gz'
TARNAME = f'node_exporter-{VERSION}.linux-amd64.tar.gz'

# download the tarball from url
response = requests.get(URL)
with open(TARNAME, 'wb') as f:
    f.write(response.content)

# create the install dir
path = Path('debian/usr/sbin')
path.mkdir(parents=True, exist_ok=True)


# extract the tarball to current directory
with tarfile.open(TARNAME, "r:gz") as tar:
    filenames = tar.getnames()
    for filename in filenames:
        if filename.endswith('node_exporter'):
            tar.extract(filename)
            break


# move the binary to install dir
Path(filename).rename(f"{path}/{filename.split('/')[1]}")

fpm_cmd = [
        'fpm', '--input-type', 'dir', '--output-type', 'deb', '--name', 'node-exporter',
        '--version', VERSION, '--deb-compression', 'gz',
        '--maintainer', 'VyOS Package Maintainers <maintainers@vyos.net>',
        '--description', 'Prometheus exporter for machine metrics',
        '--license', 'Apache-2.0', '-C', 'debian', '--package', '..'

    ]

run(fpm_cmd)
