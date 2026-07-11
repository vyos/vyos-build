#!/usr/bin/env python3
"""Tiny UDP DNS server for the integration test: answers every A query with a
fixed address so nDPI sees real, classifiable DNS traffic. Not a resolver."""
import socket
import struct
import sys

bind_ip = sys.argv[1] if len(sys.argv) > 1 else "0.0.0.0"
answer_ip = sys.argv[2] if len(sys.argv) > 2 else "10.10.2.2"

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((bind_ip, 53))

while True:
    try:
        data, addr = sock.recvfrom(512)
    except KeyboardInterrupt:
        break
    if len(data) < 12:
        continue
    txid = data[:2]
    # header: response, recursion available; 1 question, 1 answer
    header = txid + struct.pack(">HHHHH", 0x8180, 1, 1, 0, 0)
    question = data[12:]
    # answer: name pointer to 0x0c, type A, class IN, ttl 60, rdlen 4
    answer = struct.pack(">HHHIH", 0xC00C, 1, 1, 60, 4) + socket.inet_aton(answer_ip)
    sock.sendto(header + question + answer, addr)
