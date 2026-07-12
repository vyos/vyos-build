"use client";

// SSL Inspection — WatchGuard-style Content Inspection built on Squid ssl_bump.
//
// Squid is the SOLE TLS terminator on the box: it owns ssl_bump, the CA, the
// private key, and the generated-cert store (see
// quartzfire-ssl-inspection/docs/design.md). This page manages the enable
// toggle, the inspection CA, the inspection policy + do-not-inspect list, the
// interface scope, and surfaces build/health status. Config edits are real
// VyOS config (`service quartzfire ssl-inspection …`) committed under
// commit-confirm.
//
// The Content Filter section is intentionally INERT: no filtering engine is
// attached yet. It shows the ICAP seam a future e2guardian/c-icap layer plugs
// into — that engine runs behind Squid over ICAP in plaintext and must never
// do its own TLS MITM. Do not implement filtering logic here.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Lock,
  Plus,
  RotateCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useDashboard } from "@/lib/DashboardContext";
import { fetchEthernet, fetchVlans } from "@/lib/interfaces";
import {
  applySslInspection,
  caCrtUrl,
  caDerUrl,
  caDistUrl,
  emptySslInspectionConfig,
  fetchSslInspection,
  fetchSslStatus,
  regenerateCa,
  setSslEnabled,
  SslInspectionConfig,
  SslStatusReport,
  validateDomainPattern,
} from "@/lib/ssl-inspection";

const inputStyle = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const cardStyle = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;

type IfaceOpt = { name: string; label: string };

// ── status indicators ───────────────────────────────────────────────────────

function Indicator({ label, state, detail }: { label: string; state: "ok" | "warn" | "muted"; detail?: string }) {
  const cls = state === "ok" ? "badge-ok" : state === "warn" ? "badge-warn" : "badge-muted";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">{label}</span>
      <span className={`badge ${cls}`} title={detail}>
        {detail ?? (state === "ok" ? "Yes" : state === "warn" ? "No" : "—")}
      </span>
    </div>
  );
}

function StatusCard({ status }: { status: SslStatusReport | null }) {
  const squid = status?.squid;
  const icap = status?.icap;
  const boolState = (b: boolean | null | undefined): "ok" | "warn" | "muted" =>
    b === true ? "ok" : b === false ? "warn" : "muted";

  return (
    <section className="rounded-lg px-5 py-4 flex flex-col gap-3" style={cardStyle}>
      <h2 className="text-[13px] font-semibold text-[var(--qz-fg-1)] m-0">System status</h2>
      <div className="flex flex-wrap gap-6">
        <Indicator label="Squid running" state={boolState(squid?.running)} />
        <Indicator
          label="Bump-capable build"
          state={boolState(squid?.bump_capable)}
          detail={squid?.bump_capable === false ? "squid-openssl missing" : undefined}
        />
        <Indicator label="ICAP-capable build" state={boolState(squid?.icap_capable)} />
        <Indicator label="Certgen DB" state={boolState(status?.certgen_db_ready)} />
        <Indicator
          label="Content filter (ICAP)"
          state={icap?.configured ? boolState(icap.reachable) : "muted"}
          detail={
            icap?.configured
              ? icap.reachable
                ? `Reachable (${icap.endpoint})`
                : `Unreachable (${icap.endpoint})`
              : "No filter engine configured"
          }
        />
      </div>
      {status?.apply && !status.apply.ok && status.apply.error && (
        <div className="flex items-center gap-2 text-[12px] text-[var(--qz-danger)]">
          <AlertTriangle size={13} /> {status.apply.error}
        </div>
      )}
      {squid?.bump_capable === false && (
        <div className="flex items-center gap-2 text-[12px] text-[var(--qz-danger)]">
          <AlertTriangle size={13} /> This Squid was built without OpenSSL ssl_bump support. Install the
          <span className="mono"> squid-openssl</span> package — inspection cannot work otherwise.
        </div>
      )}
    </section>
  );
}

// ── CA panel ────────────────────────────────────────────────────────────────

function CaPanel({
  status,
  onRegenerate,
  regenerating,
}: {
  status: SslStatusReport | null;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const ca = status?.ca;
  const [copied, setCopied] = useState(false);
  const host = typeof window !== "undefined" ? window.location.hostname : "your-firewall";

  const copyFp = async () => {
    if (!ca?.fingerprint_sha256) return;
    try {
      await navigator.clipboard.writeText(ca.fingerprint_sha256);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex flex-col gap-[2px]">
      <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">{label}</span>
      <span className="text-[13px] text-[var(--qz-fg-1)] break-all">{value}</span>
    </div>
  );

  return (
    <section className="rounded-lg px-5 py-4 flex flex-col gap-4" style={cardStyle}>
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="text-[var(--qz-fg-3)]" />
        <h2 className="text-[13px] font-semibold text-[var(--qz-fg-1)] m-0">Inspection root CA</h2>
      </div>

      {!ca?.present ? (
        <p className="text-[13px] text-[var(--qz-fg-3)] m-0">
          No CA generated yet. Enabling SSL inspection generates a self-signed root CA
          (<span className="mono">CN=QuartzFire SSL Inspection, O=Quartz Systems</span>).
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {row("Subject", ca.subject ?? "—")}
            {row("Serial", <span className="mono text-[12px]">{ca.serial ?? "—"}</span>)}
            {row("Valid from", ca.not_before ?? "—")}
            {row("Valid until", ca.not_after ?? "—")}
          </div>
          <div className="flex flex-col gap-[2px]">
            <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">
              SHA-256 fingerprint
            </span>
            <div className="flex items-center gap-2">
              <span className="mono text-[12px] text-[var(--qz-fg-1)] break-all">
                {ca.fingerprint_sha256 ?? "—"}
              </span>
              {ca.fingerprint_sha256 && (
                <button
                  type="button"
                  onClick={copyFp}
                  className="text-[var(--qz-fg-4)] hover:text-[var(--qz-fg-2)]"
                  title="Copy fingerprint"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              )}
            </div>
          </div>
        </>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <a href={caCrtUrl} download>
          <Button kind="secondary" size="sm" icon={Download} disabled={!ca?.present}>
            Download CA (PEM)
          </Button>
        </a>
        <a href={caDerUrl} download>
          <Button kind="secondary" size="sm" icon={Download} disabled={!ca?.present}>
            Download CA (DER)
          </Button>
        </a>
        <Button kind="danger" size="sm" icon={RotateCw} onClick={onRegenerate} disabled={regenerating}>
          {regenerating ? "Regenerating…" : "Regenerate"}
        </Button>
      </div>

      <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
        Clients install the CA from{" "}
        <a className="text-[var(--qz-info)] underline" href={caDistUrl(host)} target="_blank" rel="noreferrer">
          {caDistUrl(host)}
        </a>{" "}
        (plain HTTP, reachable only on trusted interfaces). The private key never leaves the box.
      </p>
    </section>
  );
}

// ── do-not-inspect editor ───────────────────────────────────────────────────

function NoInspectEditor({
  domains,
  onChange,
}: {
  domains: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const add = () => {
    const d = draft.trim().toLowerCase();
    if (!d) return;
    const e = validateDomainPattern(d);
    if (e) {
      setErr(e);
      return;
    }
    if (domains.includes(d)) {
      setErr("Already in the list.");
      return;
    }
    onChange([...domains, d]);
    setDraft("");
    setErr(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setErr(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
          placeholder=".bank.com, *.mozilla.org…"
          className="rounded-md px-3 py-[6px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[240px] mono"
          style={inputStyle}
        />
        <Button kind="secondary" size="sm" icon={Plus} onClick={add}>
          Add
        </Button>
      </div>
      {err && <span className="text-[12px] text-[var(--qz-danger)]">{err}</span>}
      {domains.length === 0 ? (
        <span className="text-[12px] text-[var(--qz-fg-4)]">
          No custom exclusions. (The shipped baseline still applies unless disabled below.)
        </span>
      ) : (
        <div className="flex flex-wrap gap-2">
          {domains.map((d) => (
            <span
              key={d}
              className="inline-flex items-center gap-1 rounded-md px-2 py-[3px] text-[12px] mono text-[var(--qz-fg-1)]"
              style={inputStyle}
            >
              {d}
              <button
                type="button"
                onClick={() => onChange(domains.filter((x) => x !== d))}
                className="text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)]"
                title="Remove"
              >
                <Trash2 size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export default function SslInspectionPage() {
  const { setToast } = useDashboard();
  const [config, setConfig] = useState<SslInspectionConfig>(emptySslInspectionConfig);
  const [draft, setDraft] = useState<SslInspectionConfig>(emptySslInspectionConfig);
  const [status, setStatus] = useState<SslStatusReport | null>(null);
  const [ifaces, setIfaces] = useState<IfaceOpt[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus((await fetchSslStatus()).status);
    } catch {
      /* status is best-effort; the config still renders */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [cfg, eth, vlans] = await Promise.all([
        fetchSslInspection(),
        fetchEthernet().catch(() => []),
        fetchVlans().catch(() => []),
      ]);
      setConfig(cfg);
      setDraft(cfg);
      setIfaces(
        [...eth, ...vlans].map((i) => ({
          name: i.name,
          label: i.description ? `${i.description} (${i.name})` : i.name,
        })),
      );
      setPhase("ready");
      await loadStatus();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load the SSL inspection config.");
      setPhase("error");
    }
  }, [loadStatus]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(draft), [config, draft]);

  const onToggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await setSslEnabled(config, enabled);
      setToast(enabled ? "SSL inspection enabled." : "SSL inspection disabled.");
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to change the enable state.");
    } finally {
      setToggling(false);
    }
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const n = await applySslInspection(config, draft);
      setToast(n === 0 ? "No changes to apply." : "SSL inspection settings applied.");
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to apply the settings.");
    } finally {
      setSaving(false);
    }
  };

  const onRegenerate = async () => {
    if (
      !window.confirm(
        "Regenerate the inspection CA?\n\nAll previously distributed CAs become INVALID — every " +
          "client must reinstall the new certificate before it can browse HTTPS through the firewall.",
      )
    )
      return;
    setRegenerating(true);
    try {
      await regenerateCa();
      setToast("CA regeneration requested. Re-distribute the new certificate to clients.");
      // The root helper regenerates asynchronously; poll a few times.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        await loadStatus();
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to request CA regeneration.");
    } finally {
      setRegenerating(false);
    }
  };

  const toggleIface = (name: string) => {
    setDraft((d) => ({
      ...d,
      interfaces: d.interfaces.includes(name)
        ? d.interfaces.filter((i) => i !== name)
        : [...d.interfaces, name],
    }));
  };

  if (phase === "loading") {
    return <div className="text-[13px] text-[var(--qz-fg-4)]">Loading…</div>;
  }
  if (phase === "error") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
        <AlertTriangle size={14} /> {errorMsg}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 max-w-[900px]">
      {/* Header + enable */}
      <div className="flex items-center gap-3 flex-wrap">
        <Lock size={18} className="text-[var(--qz-fg-2)]" />
        <div className="flex-1">
          <h1 className="text-[16px] font-semibold text-[var(--qz-fg-1)] m-0">SSL Inspection</h1>
          <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
            Decrypt, inspect, and re-encrypt outbound HTTPS on the selected interfaces (Squid ssl_bump).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-[var(--qz-fg-3)]">{config.enabled ? "Enabled" : "Disabled"}</span>
          <span aria-disabled={toggling} style={{ opacity: toggling ? 0.5 : 1 }}>
            <Switch on={config.enabled} onChange={onToggle} />
          </span>
        </div>
      </div>

      <StatusCard status={status} />
      <CaPanel status={status} onRegenerate={onRegenerate} regenerating={regenerating} />

      {/* Inspection policy */}
      <section className="rounded-lg px-5 py-4 flex flex-col gap-4" style={cardStyle}>
        <h2 className="text-[13px] font-semibold text-[var(--qz-fg-1)] m-0">Inspection policy</h2>

        <div className="flex flex-col gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">Default action</span>
          <Segmented
            items={[
              { value: "inspect", label: "Inspect all" },
              { value: "splice", label: "Splice all" },
            ]}
            value={draft.defaultAction}
            onChange={(v) => setDraft((d) => ({ ...d, defaultAction: v as "inspect" | "splice" }))}
          />
          <span className="text-[12px] text-[var(--qz-fg-4)]">
            Traffic not on the do-not-inspect list is {draft.defaultAction === "inspect" ? "decrypted" : "passed through"}.
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">Interface scope</span>
          {ifaces.length === 0 ? (
            <span className="text-[12px] text-[var(--qz-fg-4)]">No configured interfaces found.</span>
          ) : (
            <div className="flex flex-wrap gap-3">
              {ifaces.map((i) => (
                <label key={i.name} className="flex items-center gap-2 text-[13px] text-[var(--qz-fg-1)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.interfaces.includes(i.name)}
                    onChange={() => toggleIface(i.name)}
                  />
                  {i.label}
                </label>
              ))}
            </div>
          )}
          <span className="text-[12px] text-[var(--qz-fg-4)]">
            Outbound 443 on these interfaces is transparently redirected to Squid. Never select a WAN/untrusted interface.
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">
            Do-not-inspect (spliced) domains
          </span>
          <NoInspectEditor domains={draft.noInspect} onChange={(next) => setDraft((d) => ({ ...d, noInspect: next }))} />
          <label className="flex items-center gap-2 text-[13px] text-[var(--qz-fg-2)] cursor-pointer mt-1">
            <input
              type="checkbox"
              checked={draft.defaultExclusions}
              onChange={(e) => setDraft((d) => ({ ...d, defaultExclusions: e.target.checked }))}
            />
            Apply the shipped baseline (banking, healthcare, government, cert-pinned/update endpoints)
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">
            Upstream certificate validation
          </span>
          <Segmented
            items={[
              { value: "block", label: "Block invalid" },
              { value: "allow", label: "Allow invalid" },
            ]}
            value={draft.upstreamInvalid}
            onChange={(v) => setDraft((d) => ({ ...d, upstreamInvalid: v as "block" | "allow" }))}
          />
        </div>

        <div className="flex items-center gap-2">
          <Button kind="primary" size="sm" onClick={onSave} disabled={!dirty || saving}>
            {saving ? "Applying…" : "Apply changes"}
          </Button>
          {dirty && (
            <Button kind="secondary" size="sm" onClick={() => setDraft(config)} disabled={saving}>
              Discard
            </Button>
          )}
        </div>
      </section>

      {/* Content filter — inert seam */}
      <section className="rounded-lg px-5 py-4 flex flex-col gap-3 opacity-90" style={cardStyle}>
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-[var(--qz-fg-1)] m-0">Content filter (ICAP)</h2>
          <span className="badge badge-muted">Not attached</span>
        </div>
        <p className="text-[13px] text-[var(--qz-fg-3)] m-0">
          No content-filtering engine is attached yet. When one is added (e2guardian in ICAP mode, or
          c-icap/ClamAV), it runs <em>behind</em> Squid and receives already-decrypted plaintext HTTP —
          it never does its own TLS interception and never holds its own CA. These fields are the seam it
          will plug into.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">ICAP host</span>
            <input disabled value={draft.contentFilter?.icapHost ?? "127.0.0.1"} className="rounded-md px-3 py-[6px] text-[13px] mono opacity-60" style={inputStyle} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">ICAP port</span>
            <input disabled value={draft.contentFilter?.icapPort ?? 1344} className="rounded-md px-3 py-[6px] text-[13px] mono opacity-60" style={inputStyle} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">Fail mode</span>
            <input disabled value={draft.contentFilter?.failMode ?? "closed (fail closed)"} className="rounded-md px-3 py-[6px] text-[13px] mono opacity-60" style={inputStyle} />
          </div>
        </div>
      </section>
    </div>
  );
}
