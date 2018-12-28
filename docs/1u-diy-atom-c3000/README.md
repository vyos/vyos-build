Ínitially I wanted to replace Cisco and Ubiquity devices with VyOS but did not
want to run a full blown Hypervisor at that locations. Instead I opted to get
one of the new Intel Atom C3000 CPUs to spawn VyOS on it.

I ended up with this shopping list:
-----------------------------------
* 1x Supermicro CSE-505-203B (19" 1U chassis, inkl. 200W PSU)
* 1x Supermicro A2SDi-2C-HLN4F (Intel Atom C3338, 2C/2T, 4MB cache, Quad LAN with
  Intel C3000 SoC 1GbE)
* 1x Crucial CT4G4DFS824A (4GB DDR4 RAM 2400 MT/s, PC4-19200)
* 1x SanDisk Ultra Fit 32GB (USB-A 3.0 SDCZ43-032G-G46 mass storage for OS)
* 1x Supermicro MCP-320-81302-0B (optional FAN tray)

Latest VyOS rolling releases boot without any problem on this board. You also
receive a nice IPMI interface realized with an ASPEED AST2400 BMC (no information
about [OpenBMC](https://www.openbmc.org/)) so far on this motherboard.
