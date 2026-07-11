"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, fetchMe, getCurrentUser } from "@/lib/api";

/// Auth gate for protected pages. The session is an httpOnly cookie (invisible
/// to JS), so we confirm it with the backend via /auth/me. The server enforces
/// auth on every /api request regardless; this just avoids rendering protected
/// UI for an unauthenticated visitor and refreshes the cached user.
///
/// Only a 401 sends the visitor back to the login page. A 5xx or network
/// failure means the backend is down or restarting — bouncing to the login
/// page then would ping-pong with its "already signed in" redirect, so we keep
/// the console up (pages surface their own errors) or show a retry screen when
/// there is no cached session to render for.
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<"checking" | "authed" | "offline">("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then(() => !cancelled && setState("authed"))
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/");
        } else if (getCurrentUser()) {
          // Backend unreachable but we had a session; render the console and
          // let each page show its own error/retry state.
          setState("authed");
        } else {
          setState("offline");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [router, attempt]);

  if (state === "checking") return null;

  if (state === "offline") {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-4"
        style={{ background: "var(--qz-bg)" }}
      >
        <p className="text-[13px] m-0" style={{ color: "var(--qz-danger)" }}>
          Cannot reach the QuartzFire backend. It may be restarting.
        </p>
        <button
          onClick={() => {
            setState("checking");
            setAttempt((n) => n + 1);
          }}
          className="rounded-md px-4 py-2 text-[13px] font-semibold cursor-pointer border-0"
          style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)" }}
        >
          Retry
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
