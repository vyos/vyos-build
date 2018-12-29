Ínitially I wanted to replace Cisco and Ubiquity devices with VyOS but did not
want to run a full blown Hypervisor at that locations. Instead I opted to get
one of the new Intel Atom C3000 CPUs to spawn VyOS on it.

I ended up with this shopping list:
* 1x Supermicro CSE-505-203B (19" 1U chassis, inkl. 200W PSU)
* 1x Supermicro MCP-260-00085-0B (I/O Shield for A2SDi-2C-HLN4F)
* 1x Supermicro A2SDi-2C-HLN4F (Intel Atom C3338, 2C/2T, 4MB cache, Quad LAN with
  Intel C3000 SoC 1GbE)
* 1x Crucial CT4G4DFS824A (4GB DDR4 RAM 2400 MT/s, PC4-19200)
* 1x SanDisk Ultra Fit 32GB (USB-A 3.0 SDCZ43-032G-G46 mass storage for OS)
* 1x Supermicro MCP-320-81302-0B (optional FAN tray)

Latest VyOS rolling releases boot without any problem on this board. You also
receive a nice IPMI interface realized with an ASPEED AST2400 BMC (no information
about [OpenBMC](https://www.openbmc.org/)) so far on this motherboard.

## Pictures

![CSE-505-203B Back][505_case_back]
![CSE-505-203B Front][505_case_front]
![CSE-505-203B Open 1][505_case_open_1]
![CSE-505-203B Open 2][505_case_open_2]
![CSE-505-203B Open 3][505_case_open_3]

[505_case_back]: 1u_vyos_back.jpg "CSE-505-203B Back"
[505_case_front]: 1u_vyos_front.jpg "CSE-505-203B Front"
[505_case_open_1]: 1u_vyos_front_open_1.jpg "CSE-505-203B Open 1"
[505_case_open_2]: 1u_vyos_front_open_2.jpg "CSE-505-203B Open 2"
[505_case_open_3]: 1u_vyos_front_open_3.jpg "CSE-505-203B Open 3"
