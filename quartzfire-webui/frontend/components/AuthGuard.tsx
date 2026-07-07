"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe } from "@/lib/api";

/// Auth gate for protected pages. The session is an httpOnly cookie (invisible
/// to JS), so we confirm it with the backend via /auth/me. The server enforces
/// auth on every /api request regardless; this just avoids rendering protected
/// UI for an unauthenticated visitor and refreshes the cached user.
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    fetchMe()
      .then(() => setAuthed(true))
      .catch(() => router.replace("/"));
  }, [router]);

  if (!authed) return null;
  return <>{children}</>;
}
