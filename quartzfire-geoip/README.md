# quartzfire-geoip

Geolocation (country) traffic filtering for QuartzFire — IPFire libloc
database + per-country nftables sets + `service geolocation` VyOS config
nodes, implemented as a single Rust multi-call binary (`qzgeo`). See
[docs/design.md](docs/design.md) for the architecture, file paths, and
naming conventions.

```
quartzfire-geoip/
├── src/
│   ├── main.rs             argv[0]/subcommand dispatch (qzgeo multi-call)
│   ├── commands.rs         commit / apply / update / lookup / countries / counters
│   ├── model.rs            normalized model + validation
│   ├── matchrepl.rs        firewall-rule match replication
│   ├── render.rs           nftables rendering + interval collapse
│   ├── apply.rs            orchestration, nft, status/counters, cache
│   ├── config.rs           cli-shell-api reader (session + active views)
│   ├── db.rs               Database trait + libloc FFI (feature `libloc`)
│   ├── shim.c              the only libloc-API-aware code (compiled in the deb build)
│   └── pipeline_tests.rs   fixture-database end-to-end test
├── vyos/templates/         cstore node.def templates (the CLI grammar)
├── debian/                 packaging + systemd units (symlinks → qzgeo)
└── docs/design.md          the contract everything above implements
```

Build the package (Docker; needs libloc-dev in the container, drops the .deb
into `../packages/` for the ISO):

```
./build-deb.sh
```

Run the tests locally (no libloc needed — the `libloc` feature stays off):

```
cargo test
```
