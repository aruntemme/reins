"use client";
import { useEffect, useRef, useState } from "react";

/** Subscribe to the Reins SSE stream and fire `onChange` (debounced) on any update. */
export function useStream(project: string | undefined, onChange: () => void) {
  const [live, setLive] = useState(false);
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const url = project ? `/api/stream?project=${encodeURIComponent(project)}` : "/api/stream";
    const es = new EventSource(url);
    let t: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => cb.current(), 250);
    };
    es.addEventListener("hello", () => setLive(true));
    es.addEventListener("change", bump);
    es.onerror = () => setLive(false);
    return () => {
      if (t) clearTimeout(t);
      es.close();
    };
  }, [project]);

  return live;
}
