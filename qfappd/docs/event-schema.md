# qfappd event schema

qfappd emits **one flat JSON object per classified-flow decision**. The schema
is a stability contract for downstream consumers (ELK/Splunk shippers, the
QuartzFire WebUI Alerts tab). It is loosely modeled on Suricata EVE.

**Compatibility rule:** fields are only ever *added*, never renamed, retyped,
or removed. The exact serialized form is pinned by a golden test
(`qfappd_core::event::tests::schema_golden`); changing it fails CI on purpose.

## Transports

The identical line is written to every enabled sink (`[events]` in
`qfappd.toml`):

| Sink | Path | Consumer |
|------|------|----------|
| UNIX datagram socket | `/run/qfappd/events.sock` | ELK/Splunk log shipper (binds the path) |
| Line-delimited file | `/var/log/qfappd/events.json` | durable history; logrotate-managed |
| stdout → journald | `journalctl -t qfappd` | WebUI Alerts tab (live SSE) |

Datagram-socket delivery is fire-and-forget; if no reader is bound the event is
counted (`event_sink_drops` in `GetStatus`) and dropped, never blocking a
worker. The file and journal always receive it.

## Fields

| Field | Type | Notes |
|-------|------|-------|
| `timestamp` | string | RFC 3339, millisecond precision, UTC |
| `event_type` | string | always `"app_control"` |
| `src_ip` / `dest_ip` | string | flow endpoints (original direction) |
| `src_port` / `dest_port` | number | |
| `proto` | string | `"TCP"`, `"UDP"`, or the protocol number |
| `vlan` | number | VLAN id, 0 if untagged/unknown |
| `in_iface` | string | ingress interface name (`""` if unresolved) |
| `app` | string | nDPI application name; `"Unknown"` if unclassified |
| `app_id` | number | nDPI protocol id (matches the ct-mark APP_ID) |
| `category` | string | nDPI category name |
| `action` | string | `"allow"` or `"block"` |
| `action_name` | string | the named action (policy) that decided |
| `block_mode` | string | `"drop"` or `"reset"` (meaningful when blocked) |
| `confidence` | string | nDPI confidence (`dpi`, `match_by_port`, `match_by_ip`, `dpi_cache`, `unknown`, …) |
| `default_applied` | bool | true if the verdict came from the action default ("when application does not match") rather than an explicit app/category rule |
| `sni` | string? | TLS/QUIC SNI or HTTP host, omitted when absent |
| `ja4` | string? | JA4 client fingerprint (JA3 on older libndpi), omitted when absent |
| `bytes` | number | flow bytes at decision time (both directions) |
| `pkts` | number | flow packets at decision time |

`sni` and `ja4` are omitted entirely when not available (not emitted as
`null`), so consumers must treat them as optional.

## Example

```json
{"timestamp":"2026-07-11T14:03:22.117Z","event_type":"app_control","src_ip":"10.0.1.23","src_port":51544,"dest_ip":"104.16.1.1","dest_port":443,"proto":"TCP","vlan":0,"in_iface":"eth1","app":"ChatGPT","app_id":244,"category":"AI","action":"block","action_name":"Global","block_mode":"drop","confidence":"dpi","default_applied":false,"sni":"chatgpt.com","bytes":3908,"pkts":7}
```

## On-target notes

- **JA4** requires a libndpi build that exposes the JA4 fingerprint (landed
  upstream in 4.9; field name varies across 4.x). Until the appliance pins its
  libndpi, `ja4` is omitted and `sni` carries the identifying info. This is the
  one field marked *needs on-target validation*.
- `confidence` values are the lowercased `ndpi_confidence_t` enum names as the
  installed library reports them.
