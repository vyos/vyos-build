"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/// Static export can't server-redirect; hop to the rules table client-side.
export default function FirewallIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/firewall/rules");
  }, [router]);
  return null;
}
