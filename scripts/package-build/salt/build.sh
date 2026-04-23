#!/bin/sh

# ==============================================================================
# Script to build Salt (Onedir) for VyOS
# ==============================================================================

# Exit immediately on error
set -e

# Configuration
ARCH=$(dpkg --print-architecture)

# Uncomment SALT_REPO and ALT_VERSION variable to build Salt manually
#SALT_REPO="https://github.com/saltstack/salt.git"
#SALT_VERSION="v3006.19"
TOOLS_REPO="https://github.com/saltstack/python-tools-scripts"

# Check this page to find a correct relenv/python combination.
# https://github.com/saltstack/relenv/releases
RELENV_VERSION="0.22.3"
RELENV_PYTHON_VERSION="3.11.14"

# Specify the platform parameter, use x86_64 for amd64, arm64 for arm64
if [ "${ARCH}" = "arm64" ]; then
    BUILD_ARCH=${ARCH}
else
    BUILD_ARCH="x86_64"
fi

# Specify the Python version currently used by VyOS. This version will be used to specify the correct requirements list,
# for example: requirements/static/pkg/py3.11/tools.tx
PYTHON_VERSION="3.11"

BUILD_DIR="salt"
OUTPUT_DIR="$BUILD_DIR/artifacts"

# Prepare Build Directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

if [ ! -d "python-tools-scripts" ]; then
    git clone ${TOOLS_REPO}
fi

# Setup Python Build Environment
echo "Setting up build virtual environment..."
if [ ! -d "venv-build" ]; then
    python3 -m venv venv-build
fi

# Install Python build requirements
echo "Installing Python build requirements..."
venv-build/bin/python3 -m pip install --upgrade pip

# Install all required build tools
venv-build/bin/python3 -m pip install relenv build packaging jinja2 pyyaml msgpack-python python-tools-scripts ppbt setuptools tornado

# Install repo-specific tools if found
if [ -f "requirements/static/pkg/py${PYTHON_VERSION}/tools.txt" ]; then
    venv-build/bin/python3 -m pip install -r requirements/static/pkg/py${PYTHON_VERSION}/tools.txt
fi

# Build the package
echo "Starting Build..."
export PYTHONPATH=$PYTHONPATH:$(pwd)

# The build script below handles fetching the correct runtime version.
venv-build/bin/python3 -m tools.pkg.build deb

# Example: tools pkg build deb --relenv-version=0.22.2 --python-version=3.10.19 --arch=x86_64
venv-build/bin/tools pkg build deb --relenv-version=${RELENV_VERSION} --python-version=${RELENV_PYTHON_VERSION} --arch=${BUILD_ARCH}

echo "List artifacts..."
find ../ -name "*.deb" 

echo "Build finished successfully"
