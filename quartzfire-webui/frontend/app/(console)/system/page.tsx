"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/// Static export can't server-redirect; hop to the first system page client-side.
export default function SystemIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/system/general");
  }, [router]);
  return null;
}
