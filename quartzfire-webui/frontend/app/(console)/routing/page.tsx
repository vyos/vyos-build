"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/// Static export can't server-redirect; hop to the first routing type client-side.
export default function RoutingIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/routing/static");
  }, [router]);
  return null;
}
