"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, HardDriveDownload, Power, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import {
  addImage,
  deleteImage,
  fetchImages,
  rebootSystem,
  shutdownSystem,
  SystemImage,
} from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const monoSt = {
  background: "var(--qz-input-bg)",
  border: "1px solid var(--qz-border)",
  fontFamily: "var(--qz-font-mono)",
} as const;

type PowerAction = "reboot" | "shutdown";

/// Confirmation dialog for reboot/shutdown — both cut this session off, so
/// spell out what happens before firing.
function PowerConfirmModal({
  action,
  onClose,
  onConfirmed,
}: {
  action: PowerAction;
  onClose: () => void;
  onConfirmed: (message: string) => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const isReboot = action === "reboot";

  const run = async () => {
    setWorking(true);
    setError("");
    try {
      if (isReboot) await rebootSystem();
      else await shutdownSystem();
      onConfirmed(
        isReboot
          ? "Reboot initiated — the WebUI will be unreachable until the firewall is back up."
          : "Shutdown initiated — the firewall must be powered on manually to come back.",
      );
    } catch (e) {
      // The device may drop the connection before answering — that's success.
      const msg = e instanceof Error ? e.message : "";
      if (/network|fetch|unreachable|gateway/i.test(msg)) {
        onConfirmed(isReboot ? "Reboot initiated." : "Shutdown initiated.");
        return;
      }
      setError(msg || `Failed to ${action}.`);
      setWorking(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={440}>
      <ModalHeader
        title={isReboot ? "Reboot Firewall" : "Shut Down Firewall"}
        onClose={onClose}
      />
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-[var(--qz-fg-2)] m-0">
          {isReboot
            ? "All traffic through the firewall stops until it has booted again (typically a minute or two). Unsaved config changes are already persisted automatically after each apply."
            : "All traffic through the firewall stops, and it will stay off until powered on at the console or via out-of-band management. Are you sure?"}
        </p>
        {error && (
          <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>
            {error}
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer"
            style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={working}
            onClick={run}
            className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0"
            style={{ background: "var(--qz-danger)", color: "white", opacity: working ? 0.7 : 1 }}
          >
            {working ? "Sending…" : isReboot ? "Reboot now" : "Shut down now"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/// Install a new system image from a URL. The call is long — the device
/// downloads and unpacks the image before answering — so the modal stays up
/// with a busy state until it finishes.
function AddImageModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  // An install in flight can't be cancelled from here — closing the modal
  // would just hide it, so the modal stays up until the device answers.
  const close = () => {
    if (!working) onClose();
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const u = url.trim();
    if (!/^https?:\/\/.+/i.test(u)) {
      setError("Enter the http(s) URL of a QuartzFire/VyOS ISO image.");
      return;
    }
    setWorking(true);
    try {
      await addImage(u);
      onSaved("Image installed. It becomes the default boot image — reboot to run it.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to install the image.");
      setWorking(false);
    }
  };

  return (
    <ModalShell onClose={close} maxWidth={520}>
      <ModalHeader
        title="Add System Image"
        subtitle="Download and install an upgrade image alongside the running one"
        onClose={close}
      />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">Image URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/quartzfire-1.5-rolling.iso"
            disabled={working}
            className={inputCls}
            style={monoSt}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--qz-accent)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--qz-border)")}
          />
          <p className="text-[11px] text-[var(--qz-fg-4)] m-0 mt-[5px]">
            The image installs next to the current one, so the running system is untouched until you reboot —
            and the previous image stays available as a rollback boot entry.
          </p>
        </div>

        {working && (
          <p className="text-[12px] m-0 text-[var(--qz-fg-3)]">
            Downloading and installing… this can take several minutes. Keep this page open.
          </p>
        )}
        {error && (
          <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>
            {error}
          </p>
        )}

        <div className="flex gap-2 justify-end mt-1">
          <button
            type="button"
            onClick={close}
            disabled={working}
            className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer disabled:opacity-50"
            style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={working}
            className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0"
            style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: working ? 0.7 : 1 }}
          >
            {working ? "Installing…" : "Install image"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/// Delete-only row action with inline confirmation (RowActions assumes an
/// edit affordance images don't have).
function DeleteImageAction({ name, onDelete }: { name: string; onDelete: () => Promise<unknown> }) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1 justify-end">
        <button
          type="button"
          disabled={working}
          onClick={async () => {
            setWorking(true);
            try {
              await onDelete();
            } finally {
              setWorking(false);
              setConfirming(false);
            }
          }}
          className="text-[12px] font-semibold px-[10px] py-[5px] rounded cursor-pointer border-0 disabled:opacity-60"
          style={{ background: "var(--qz-danger)", color: "white" }}
        >
          {working ? "…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-[12px] px-[10px] py-[5px] rounded cursor-pointer"
          style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-3)" }}
        >
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`Delete image ${name}`}
      aria-label="Delete"
      onClick={() => setConfirming(true)}
      className="grid place-items-center w-7 h-7 rounded-md bg-transparent border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer"
    >
      <Trash2 size={14} />
    </button>
  );
}

export default function MaintenancePage() {
  const { setToast } = useDashboard();
  const [images, setImages] = useState<SystemImage[] | null>(null);
  const [loading, setLoading] = useState(true);

  const [powerModal, setPowerModal] = useState<PowerAction | null>(null);
  const [addModal, setAddModal] = useState(false);

  const load = useCallback(async () => {
    try {
      setImages(await fetchImages());
    } catch {
      setImages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const removeImage = async (img: SystemImage) => {
    try {
      await deleteImage(img.name);
      setToast(`Deleted image ${img.name}.`);
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete image ${img.name}.`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Maintenance
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Power control and system image upgrades
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        <div className="flex flex-col gap-7">
          {/* Power */}
          <section
            className="rounded-lg px-5 py-4"
            style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
          >
            <h2 className="text-[15px] font-semibold text-[var(--qz-fg-1)] m-0">Power</h2>
            <p className="text-[13px] text-[var(--qz-fg-4)] mt-1 mb-4">
              Both actions interrupt all traffic through the firewall. Configuration is already saved to the
              boot config after every apply, so nothing is lost by rebooting.
            </p>
            <div className="flex gap-2">
              <Button kind="secondary" icon={RotateCw} onClick={() => setPowerModal("reboot")}>
                Reboot
              </Button>
              <Button kind="danger" icon={Power} onClick={() => setPowerModal("shutdown")}>
                Shut down
              </Button>
            </div>
          </section>

          {/* System images */}
          <section
            className="rounded-lg px-5 py-4"
            style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-[var(--qz-fg-1)] m-0">System Images</h2>
              <Button kind="primary" size="sm" icon={HardDriveDownload} onClick={() => setAddModal(true)}>
                Add image
              </Button>
            </div>
            <p className="text-[13px] text-[var(--qz-fg-4)] mt-1 mb-4">
              QuartzFire is image-based: upgrades install a whole new image next to the running one, and a
              reboot switches over. The previous image stays installed as a rollback boot entry.
            </p>

            {loading ? (
              <div className="text-[13px] text-[var(--qz-fg-4)]">Loading images…</div>
            ) : images && images.length > 0 ? (
              <div className="rounded-md overflow-x-auto" style={{ border: "1px solid var(--qz-border)" }}>
                <table className="qz-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Image</th>
                      <th style={{ width: 130 }}>Default Boot</th>
                      <th style={{ width: 110 }}>Running</th>
                      <th style={{ width: 150 }} className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {images.map((img) => (
                      <tr key={img.name}>
                        <td className="mono">{img.name}</td>
                        <td>
                          {img.default_boot ? (
                            <span className="badge badge-ok">Default</span>
                          ) : (
                            <span className="text-[var(--qz-fg-4)]">—</span>
                          )}
                        </td>
                        <td>
                          {img.running ? (
                            <span className="badge badge-info">Running</span>
                          ) : (
                            <span className="text-[var(--qz-fg-4)]">—</span>
                          )}
                        </td>
                        <td className="text-right">
                          {img.running ? (
                            <span className="text-[11px] text-[var(--qz-fg-4)]" title="The running image can't delete itself.">
                              in use
                            </span>
                          ) : (
                            <DeleteImageAction name={img.name} onDelete={() => removeImage(img)} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[13px] text-[var(--qz-fg-4)]">
                <AlertTriangle size={14} />
                Could not read the installed images (older or non-image installs don&apos;t report them). Adding an
                image and power actions still work.
              </div>
            )}
          </section>
        </div>
      </div>

      {powerModal && (
        <PowerConfirmModal
          action={powerModal}
          onClose={() => setPowerModal(null)}
          onConfirmed={(msg) => {
            setPowerModal(null);
            setToast(msg);
          }}
        />
      )}

      {addModal && (
        <AddImageModal
          onClose={() => setAddModal(false)}
          onSaved={(msg) => {
            setAddModal(false);
            setToast(msg);
            load();
          }}
        />
      )}
    </div>
  );
}
