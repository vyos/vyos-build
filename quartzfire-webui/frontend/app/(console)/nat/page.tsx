"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/// Static export can't server-redirect; hop to the first NAT type client-side.
export default function NatIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/nat/nat44");
  }, [router]);
  return null;
}
