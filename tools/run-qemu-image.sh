#!/bin/sh

VM_NAME='vyos_qemu'
VM_IMAGE='./packer_build/qemu/vyos_qemu_image.img'
MEMORY_SIZE='1024'
NCPUS=1
SSH_PORT=2222

qemu-system-x86_64 \
  -name "${VM_NAME}" \
  -m ${MEMORY_SIZE} \
  -net nic,vlan=0,model=virtio \
  -net user,vlan=0,hostfwd=tcp::"${SSH_PORT}"-:22,hostname="${VM_NAME}" \
  -drive if=virtio,file=${VM_IMAGE} \
  -machine accel=kvm \
  -cpu host -smp ${NCPUS}
