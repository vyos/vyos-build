// System data layer: local admin users, general settings (hostname, DNS,
// NTP, timezone), the SSH service, and maintenance operations (reboot,
// shutdown, image upgrades).
//
// Everything is plain VyOS config — users are `system login user`, general
// settings live under `system`/`service ntp`, SSH is `service ssh` — so the
// CLI view stays normal. Writes follow the QuartzFire model: diff against the
// live config, commit straight to the VyOS API, and save to the boot config
// in the background. Power and image operations use the dedicated VyOS API
// endpoints (`/reboot`, `/poweroff`, `/image`) — they are operational, not
// config, so nothing is diffed or saved.

import { API, apiFetch, vyosApi } from "./api";
import { PendingWire, registerPending } from "./guard";
import { commitAndSave, VyosCommand, VyosResponse } from "./interfaces";
import { showText } from "./vyos";

// ── parse helpers ─────────────────────────────────────────────────────────────

type Cfg = Record<string, unknown>;

function childStr(v: Cfg, key: string): string | null {
  const x = v[key];
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s === "" ? null : s;
}

function childCfg(v: Cfg, key: string): Cfg | null {
  const x = v[key];
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Cfg) : null;
}

/// VyOS renders a multi-value leaf as a JSON string when it holds one value
/// and a JSON array when it holds several. Tag nodes (values carrying
/// children, like `ntp server <addr> …`) render as an object keyed by value.
function strList(v: Cfg, key: string): string[] {
  const x = v[key];
  if (typeof x === "string") return [x];
  if (Array.isArray(x)) return x.filter((s): s is string => typeof s === "string");
  if (x && typeof x === "object") return Object.keys(x);
  return [];
}

const trimmed = (s: string | null) => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

// ── diff helpers ──────────────────────────────────────────────────────────────

/// Diff a single-value leaf into set/delete commands.
function diffLeaf(out: VyosCommand[], base: string[], sub: string[], liveV: string | null, desiredRaw: string | null): void {
  const desired = trimmed(desiredRaw);
  if (desired === liveV) return;
  if (desired !== null) out.push({ op: "set", path: [...base, ...sub, desired] });
  else out.push({ op: "delete", path: [...base, ...sub] });
}

/// Diff a multi-value leaf (one path segment per value).
function diffMulti(out: VyosCommand[], base: string[], key: string, live: string[], desiredRaw: string[]): void {
  const desired = desiredRaw.map((s) => s.trim()).filter(Boolean);
  for (const v of desired) if (!live.includes(v)) out.push({ op: "set", path: [...base, key, v] });
  for (const v of live) if (!desired.includes(v)) out.push({ op: "delete", path: [...base, key, v] });
}

/// Diff a valueless flag leaf (present = on).
function diffFlag(out: VyosCommand[], base: string[], key: string, live: boolean, desired: boolean): void {
  if (desired === live) return;
  if (desired) out.push({ op: "set", path: [...base, key] });
  else out.push({ op: "delete", path: [...base, key] });
}

// ══ config model ══════════════════════════════════════════════════════════════

/// One `system login user <name>` entry. VyOS 1.4+ has no operator level —
/// every login user is a full administrator.
export interface SystemUser {
  name: string;
  full_name: string | null;
  /** Whether an encrypted-password is set (a keys-only account has none). */
  has_password: boolean;
  keys: SshPublicKey[];
}

/// One `authentication public-keys <id>` entry of a user.
export interface SshPublicKey {
  /** Key identifier, conventionally the `user@host` comment. */
  id: string;
  /** Key algorithm (ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, …). */
  type: string | null;
  /** Base64 key body (no type prefix or comment). */
  key: string | null;
}

export interface GeneralSettings {
  hostname: string | null;
  domain_name: string | null;
  /** `system name-server` — DNS servers the firewall itself resolves with. */
  name_servers: string[];
  timezone: string | null;
  /** `service ntp server` tag values. */
  ntp_servers: string[];
}

export interface SshSettings {
  /** Whether `service ssh` exists at all (absent = sshd not running). */
  enabled: boolean;
  /** Listen ports (VyOS allows several; default 22 when unset). */
  ports: string[];
  listen_addresses: string[];
  /** `disable-password-authentication` — keys-only logins. */
  password_auth_disabled: boolean;
}

export interface SystemConfig {
  users: SystemUser[];
  general: GeneralSettings;
  ssh: SshSettings;
}

// ── reads ─────────────────────────────────────────────────────────────────────

/// Fetch one top-level config subtree ({} when nothing is configured).
async function configTree(path: string[]): Promise<Cfg> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path,
  });
  if (resp.success) return resp.data ?? {};
  // "Configuration under specified path is empty" just means nothing is set.
  if ((resp.error ?? "").toLowerCase().includes("empty")) return {};
  throw new Error(resp.error || "Device returned an error reading the system config.");
}

function parseUsers(login: Cfg): SystemUser[] {
  const users = childCfg(login, "user") ?? {};
  return Object.entries(users)
    .map(([name, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      const auth = childCfg(cfg, "authentication") ?? {};
      const pubkeys = childCfg(auth, "public-keys") ?? {};
      return {
        name,
        full_name: childStr(cfg, "full-name"),
        has_password: childStr(auth, "encrypted-password") !== null,
        keys: Object.entries(pubkeys).map(([id, kraw]) => {
          const k = (kraw ?? {}) as Cfg;
          return { id, type: childStr(k, "type"), key: childStr(k, "key") };
        }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/// Users, general settings, and SSH service state from the running config.
export async function fetchSystemConfig(): Promise<SystemConfig> {
  const [system, service] = await Promise.all([configTree(["system"]), configTree(["service"])]);
  const ntp = childCfg(service, "ntp") ?? {};
  const ssh = childCfg(service, "ssh");
  return {
    users: parseUsers(childCfg(system, "login") ?? {}),
    general: {
      hostname: childStr(system, "host-name"),
      domain_name: childStr(system, "domain-name"),
      name_servers: strList(system, "name-server"),
      timezone: childStr(system, "time-zone"),
      ntp_servers: strList(ntp, "server"),
    },
    ssh: {
      enabled: ssh !== null,
      ports: ssh ? strList(ssh, "port") : [],
      listen_addresses: ssh ? strList(ssh, "listen-address") : [],
      password_auth_disabled: ssh ? "disable-password-authentication" in ssh : false,
    },
  };
}

// ── writes: general settings ──────────────────────────────────────────────────

export interface GeneralUpdate {
  hostname: string | null;
  domain_name: string | null;
  name_servers: string[];
  timezone: string | null;
  ntp_servers: string[];
}

export function diffGeneral(live: GeneralSettings, u: GeneralUpdate): VyosCommand[] {
  const out: VyosCommand[] = [];
  diffLeaf(out, ["system"], ["host-name"], live.hostname, u.hostname);
  diffLeaf(out, ["system"], ["domain-name"], live.domain_name, u.domain_name);
  diffMulti(out, ["system"], "name-server", live.name_servers, u.name_servers);
  diffLeaf(out, ["system"], ["time-zone"], live.timezone, u.timezone);

  // `service ntp` with zero servers fails validation — clearing the list
  // removes the service entirely instead.
  const ntpDesired = u.ntp_servers.map((s) => s.trim()).filter(Boolean);
  if (ntpDesired.length === 0 && live.ntp_servers.length > 0) {
    out.push({ op: "delete", path: ["service", "ntp"] });
  } else {
    diffMulti(out, ["service", "ntp"], "server", live.ntp_servers, ntpDesired);
  }
  return out;
}

/// Apply desired general settings. Returns the number of changes applied.
export function applyGeneral(live: GeneralSettings, update: GeneralUpdate): Promise<number> {
  return commitAndSave(diffGeneral(live, update));
}

// ── writes: users ─────────────────────────────────────────────────────────────

const userBase = (name: string) => ["system", "login", "user", name];

/// Desired user account. `password` is null when unchanged (edits) — VyOS
/// hashes `plaintext-password` into `encrypted-password` at commit, so the
/// plaintext never persists in the config.
export interface UserUpdate {
  name: string;
  full_name: string | null;
  password: string | null;
  keys: SshPublicKey[];
  /** Name of the account being edited; null = create. */
  original_name: string | null;
}

export function diffUser(existing: SystemUser[], u: UserUpdate): VyosCommand[] {
  const live = u.original_name !== null ? existing.find((x) => x.name === u.original_name) ?? null : null;
  const base = userBase(u.name);
  const out: VyosCommand[] = [];

  diffLeaf(out, base, ["full-name"], live?.full_name ?? null, u.full_name);
  if (u.password !== null && u.password !== "") {
    out.push({ op: "set", path: [...base, "authentication", "plaintext-password", u.password] });
  }

  const liveKeys = live?.keys ?? [];
  const keysBase = [...base, "authentication", "public-keys"];
  for (const k of u.keys) {
    const lk = liveKeys.find((x) => x.id === k.id);
    if (!lk || lk.type !== k.type || lk.key !== k.key) {
      if (k.type) out.push({ op: "set", path: [...keysBase, k.id, "type", k.type] });
      if (k.key) out.push({ op: "set", path: [...keysBase, k.id, "key", k.key] });
    }
  }
  for (const lk of liveKeys) {
    if (!u.keys.some((k) => k.id === lk.id)) out.push({ op: "delete", path: [...keysBase, lk.id] });
  }

  // A brand-new user with nothing else set still needs the node created
  // (defensive — the form always requires a password on create).
  if (live === null && out.length === 0) out.push({ op: "set", path: base });
  return out;
}

/// Apply a desired user account. Returns the number of changes applied.
export function applyUser(existing: SystemUser[], update: UserUpdate): Promise<number> {
  return commitAndSave(diffUser(existing, update));
}

/// Delete a user account. The page guards against deleting yourself or the
/// last remaining account; VyOS refuses to commit an empty user set anyway.
export function deleteUser(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: userBase(name) }]);
}

/// Change one user's password (used by the users page and the forced
/// default-password change on first login).
export function setUserPassword(name: string, password: string): Promise<number> {
  return commitAndSave([
    { op: "set", path: [...userBase(name), "authentication", "plaintext-password", password] },
  ]);
}

// ── writes: SSH service ───────────────────────────────────────────────────────

const SSH_BASE = ["service", "ssh"];

export interface SshUpdate {
  enabled: boolean;
  ports: string[];
  listen_addresses: string[];
  password_auth_disabled: boolean;
}

export function diffSsh(live: SshSettings, u: SshUpdate): VyosCommand[] {
  const out: VyosCommand[] = [];
  if (!u.enabled) {
    if (live.enabled) out.push({ op: "delete", path: SSH_BASE });
    return out;
  }
  diffMulti(out, SSH_BASE, "port", live.ports, u.ports);
  diffMulti(out, SSH_BASE, "listen-address", live.listen_addresses, u.listen_addresses);
  diffFlag(out, SSH_BASE, "disable-password-authentication", live.password_auth_disabled, u.password_auth_disabled);
  // Enabling with all defaults still needs the node created (sshd on :22).
  if (!live.enabled && !out.some((c) => c.op === "set")) {
    out.length = 0;
    out.push({ op: "set", path: SSH_BASE });
  }
  return out;
}

/// Apply desired SSH service settings. Returns the number of changes applied.
export function applySsh(live: SshSettings, update: SshUpdate): Promise<number> {
  return commitAndSave(diffSsh(live, update));
}

// ══ maintenance: images and power ═════════════════════════════════════════════

/// One installed system image, from `show system image`.
export interface SystemImage {
  name: string;
  default_boot: boolean;
  running: boolean;
}

/// Parse `show system image`. Recent VyOS prints a table
/// (`Name  Default boot  Running` with Yes/No cells); older releases print a
/// numbered list (`1: <name> (default boot) (running image)`). Handle both.
export function parseSystemImages(text: string): SystemImage[] {
  const out: SystemImage[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const legacy = /^\d+:\s+(\S+)(.*)$/.exec(t);
    if (legacy) {
      out.push({
        name: legacy[1],
        default_boot: /default boot/i.test(legacy[2]),
        running: /running/i.test(legacy[2]),
      });
      continue;
    }
    if (/^name\b/i.test(t) || /^[-\s]+$/.test(t) || /image\(s\) installed/i.test(t)) continue;
    const cols = t.split(/\s{2,}/);
    if (cols.length < 2) continue;
    out.push({
      name: cols[0],
      default_boot: /^y/i.test(cols[1] ?? ""),
      running: /^y/i.test(cols[2] ?? ""),
    });
  }
  return out;
}

/// Installed system images (empty on parse/read failure — the page shows a
/// hint instead of erroring; power controls still work).
export async function fetchImages(): Promise<SystemImage[]> {
  const text = await showText(["system", "image"]);
  return text ? parseSystemImages(text) : [];
}

/// Run one of the operational VyOS API endpoints (`/image`, `/reboot`,
/// `/poweroff`) and surface its error message on failure.
async function opApi(endpoint: string, data: unknown, what: string): Promise<void> {
  const resp = await vyosApi<VyosResponse<unknown>>(endpoint, data);
  if (!resp.success) throw new Error(resp.error || `Device returned an error trying to ${what}.`);
}

/// The installer names the new image after the version embedded in the ISO
/// and dies with a raw `[Errno 17] File exists: '.../boot/<name>/...'` when
/// that name is already on the image partition (typically: installing a
/// rebuild of the version currently running). Translate that into something
/// actionable; anything else passes through unchanged.
function translateImageAddError(msg: string): string {
  const m = /\[Errno 17\][^']*'[^']*\/boot\/([^/']+)\//.exec(msg);
  if (!m) return msg;
  return (
    `An image named "${m[1]}" already exists on the firewall, and the installer can't overwrite it. ` +
    `If that's the running image, build the new ISO with a different version. If it's listed under ` +
    `System Images (and not running), delete it there and retry. If it's in neither state, a previous ` +
    `failed install left it behind — remove /usr/lib/live/mount/persistence/boot/${m[1]} at the CLI.`
  );
}

/// Predict the image name the installer will derive from an ISO's filename.
/// QuartzFire ISOs are named `<version>-<arch>.iso` with the image name equal
/// to the version, so strip the trailing arch. Null when the filename doesn't
/// match (renamed/foreign ISOs — the post-install error still catches those).
export function imageNameFromIsoName(fileName: string): string | null {
  const m = /^(.+)-(amd64|arm64|i386|armhf)\.iso$/i.exec(fileName.trim());
  return m ? m[1] : null;
}

/// Download and install a new system image (`add system image <url>`). This
/// is a long call — the device downloads and unpacks the image before
/// answering — and the new image becomes the default boot entry; the running
/// system is untouched until the next reboot.
export async function addImage(url: string): Promise<void> {
  try {
    await opApi("image", { op: "add", url: url.trim() }, "install the image");
  } catch (e) {
    if (e instanceof Error) throw new Error(translateImageAddError(e.message));
    throw e;
  }
}

/// Upload an ISO from the browser to the device's staging area. XHR rather
/// than fetch so upload progress can be reported (a 500 MB ISO over a LAN
/// still takes a while). Resolves to the on-device path — hand it to
/// `addImage` (the image op accepts local paths as its url).
export function uploadImageFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/image/upload`);
    xhr.withCredentials = true;
    xhr.responseType = "json";
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total);
    };
    xhr.onerror = () => reject(new Error("Upload failed — connection to the firewall lost."));
    xhr.onload = () => {
      const body = xhr.response as { path?: string; error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.path) resolve(body.path);
      else if (xhr.status === 401) reject(new Error("Session expired. Please sign in again."));
      else reject(new Error(body?.error || `Upload failed (${xhr.status}).`));
    };
    xhr.send(file);
  });
}

/// Remove the staged ISO after an install attempt (idempotent, best-effort —
/// a leftover is overwritten by the next upload anyway).
export async function cleanupImageUpload(): Promise<void> {
  try {
    await fetch(`${API}/image/upload`, { method: "DELETE", credentials: "include" });
  } catch {}
}

/// Remove an installed (non-running) system image.
export function deleteImage(name: string): Promise<void> {
  return opApi("image", { op: "delete", name }, "delete the image");
}

/// Reboot the firewall immediately. The `now` path selects the non-interactive
/// form of the op-mode command; a bare `reboot` prompts for confirmation and
/// hangs the API call, since there is no TTY behind the proxy.
export function rebootSystem(): Promise<void> {
  return opApi("reboot", { op: "reboot", path: ["now"] }, "reboot");
}

/// Power the firewall off immediately. `now` selects the non-interactive form
/// (see rebootSystem).
export function shutdownSystem(): Promise<void> {
  return opApi("poweroff", { op: "poweroff", path: ["now"] }, "shut down");
}

// ══ maintenance: configuration backup / restore ═══════════════════════════════

/// Download the running configuration as a config.boot-style file, named
/// client-side (the appliance's clock isn't trusted for timestamps).
export async function downloadConfigBackup(): Promise<void> {
  const res = await fetch(`${API}/config/backup`, { credentials: "include" });
  if (!res.ok) {
    let message = `Backup failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
  }
  const blob = await res.blob();

  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `quartzfire-config-${stamp}.boot`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/// Replace the entire configuration with an uploaded config.boot. Runs under
/// commit-confirm with a long window (the blast radius is the whole config) —
/// the shell banner asks for confirmation and auto-reverts without one.
export async function restoreConfigBackup(content: string): Promise<void> {
  const wire = await apiFetch<PendingWire>("/config/restore", {
    method: "POST",
    body: JSON.stringify({ content, timeout_secs: 120 }),
  });
  registerPending(wire);
}
