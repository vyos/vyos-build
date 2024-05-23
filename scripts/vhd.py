#!/usr/bin/env python
# -*- coding: utf-8 -*-
# Copyright: 2015 Bastian Blank
# License: MIT, see LICENSE.txt for details.

import array
import struct
import time
import sys

from uuid import uuid4


class VHDFooter:
    _struct = struct.Struct('>8sLLQL4sL4sQQ4sLL16sB427x')
    size = _struct.size

    vhd_timestamp_base = 946684800

    def __init__(self, size, uuid=None, timestamp=None):
        self.size = size
        self.timestamp = timestamp or (int(time.time()) - self.vhd_timestamp_base)
        self.uuid = uuid or uuid4()

    @staticmethod
    def _checksum(msg):
        return 0x100000000 + ~sum(array.array("B", msg))

    def _pack_geometry(self):
        sectors = self.size // 512

        if sectors > 65535 * 16 * 255:
            sectors = 65535 * 16 * 255

        if sectors >= 65535 * 16 * 63:
            sectorsPerTrack = 255
            heads = 16
            cylinderTimesHeads = sectors // sectorsPerTrack

        else:
            sectorsPerTrack = 17
            cylinderTimesHeads = sectors // sectorsPerTrack

            heads = (cylinderTimesHeads + 1023) // 1024

            if heads < 4:
                heads = 4
            if cylinderTimesHeads >= (heads * 1024) or heads > 16:
                sectorsPerTrack = 31
                heads = 16
                cylinderTimesHeads = sectors // sectorsPerTrack
            if cylinderTimesHeads >= (heads * 1024):
                sectorsPerTrack = 63
                heads = 16
                cylinderTimesHeads = sectors // sectorsPerTrack

        cylinders = cylinderTimesHeads // heads

        return struct.pack('>HBB', cylinders, heads, sectorsPerTrack)

    def _pack(self, checksum):
        return self._struct.pack(
            b'conectix',            # Cookie
            0x00000002,             # Features
            0x00010000,             # File Format Version
            0xffffffffffffffff,     # Data Offset
            self.timestamp,         # Time Stamp
            b'qemu',                # Creator Application
            0x00010000,             # Creator Version
            b'Wi2k',                # Creator Host OS
            self.size,              # Original Size
            self.size,              # Current Size
            self._pack_geometry(),  # Disk Geometry
            2,                      # Disk Type
            checksum,               # Checksum
            self.uuid.bytes,        # Unique Id
            0,                      # Saved State
        )

    def pack(self):
        c = self._checksum(self._pack(0))
        return self._pack(c)

with open(sys.argv[1], 'rb+') as f:
    f.seek(0, 2)
    image_size = f.tell()
    image_size_complete = image_size + VHDFooter.size
    footer = VHDFooter(image_size)
    f.write(footer.pack())
