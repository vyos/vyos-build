#!/bin/vbash
source /opt/vyatta/etc/functions/script-template

# Add Debian Jessie repository
set system package repository jessie url 'http://ftp.nl.debian.org/debian/'
set system package repository jessie distribution 'jessie'
set system package repository jessie components 'main contrib non-free'
commit
save

# Install open-vm-tools
sudo apt-get update
sudo apt-get -y install open-vm-tools

# Delete Debian Jessie repository
delete system package repository jessie
commit
save

# Removing leftover leases and persistent rules
sudo rm -f /var/lib/dhcp3/*

# Removing apt caches
sudo rm -rf /var/cache/apt/*

# Removing hw-id
delete interfaces ethernet eth0 hw-id
commit
save
