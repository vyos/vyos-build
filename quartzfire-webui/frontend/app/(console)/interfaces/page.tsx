"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/// Static export can't server-redirect; hop to the first interface type client-side.
export default function InterfacesIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/interfaces/ethernet");
  }, [router]);
  return null;
}
