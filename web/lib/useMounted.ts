"use client";
import { useEffect, useState } from "react";

/**
 * False on the server and on the first client render, true right after. For
 * markup that depends on the URL (e.g. a link carrying ?next=): the server can't
 * see the query, and React won't patch a mismatched attribute after hydration,
 * so such markup must render its server value first and switch once mounted.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
