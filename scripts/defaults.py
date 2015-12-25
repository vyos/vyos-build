import os

BUILD_DIR = 'build'
BUILD_CONFIG = os.path.join(BUILD_DIR, 'build-config.json')

# The default mirror was chosen entirely at random
DEBIAN_MIRROR = 'http://ftp.nl.debian.org/debian/'

DEBIAN_DISTRIBUTION = 'jessie'

PBUILDER_CONFIG = os.path.join(BUILD_DIR, 'pbuilderrc')
PBUILDER_DIR = os.path.join(BUILD_DIR, 'pbuilder')
