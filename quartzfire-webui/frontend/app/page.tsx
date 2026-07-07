"use client";

import { useEffect, useState } from "react";

// Calls the backend proxy, which forwards to the VyOS HTTP API. We send only
// the `data` form field; the backend injects the `key` field server-side so it
// never reaches the browser (VyOS authenticates via form-encoded data + key).
async function retrieveConfig(): Promise<unknown> {
  const body = new URLSearchParams();
  body.set("data", JSON.stringify({ op: "showConfig", path: [] }));
  const res = await fetch("/api/retrieve", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export default function Home() {
  const [status, setStatus] = useState<string>("checking…");

  useEffect(() => {
    retrieveConfig()
      .then(() => setStatus("connected to VyOS API"))
      .catch((e) => setStatus(`API not reachable: ${e.message}`));
  }, []);

  return (
    <main style={{ padding: "3rem", maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.25rem" }}>QuartzFire</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>Firewall management console</p>
      <div
        style={{
          marginTop: "2rem",
          padding: "1rem 1.25rem",
          border: "1px solid #24314d",
          borderRadius: 12,
          background: "#111a2e",
        }}
      >
        <strong>Backend status:</strong> {status}
      </div>
      {/* TODO: replace placeholder with real config/status views mapped to the
          VyOS HTTP API endpoints (retrieve, configure, show, generate, etc.). */}
    </main>
  );
}
