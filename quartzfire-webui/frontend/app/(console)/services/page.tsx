"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/// Static export can't server-redirect; hop to the first service client-side.
export default function ServicesIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/services/dhcp-server");
  }, [router]);
  return null;
}
