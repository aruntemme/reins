"use client";
import { useEffect, useRef, useState } from "react";

const RETRY_MIN = 1000;
const RETRY_MAX = 30_000;

/** Subscribe to the Reins SSE stream and fire `onChange` (debounced) on any update. */
export function useStream(project: string | undefined, onChange: () => void) {
  const [live, setLive] = useState(false);
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const url = project ? `/api/stream?project=${encodeURIComponent(project)}` : "/api/stream";
    let es: EventSource | null = null;
    let t: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let delay = RETRY_MIN;
    // Set when the stream errors; the next hello is then a reconnect.
    let missed = false;
    let disposed = false;

    const bump = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => cb.current(), 250);
    };

    const connect = () => {
      retry = null;
      if (disposed) return;
      const src = new EventSource(url);
      es = src;
      src.addEventListener("hello", () => {
        setLive(true);
        delay = RETRY_MIN;
        // A hello after an error is a reconnect: changes may have been missed
        // while we were away (or the page's first load failed), so refetch.
        if (missed) bump();
        missed = false;
      });
      src.addEventListener("change", bump);
      src.onerror = () => {
        setLive(false);
        missed = true;
        // On a dropped connection the browser reconnects by itself. After an HTTP
        // error it gives up for good (CLOSED), so reopen it with capped backoff.
        if (src.readyState === EventSource.CLOSED && !disposed) {
          src.close();
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, RETRY_MAX);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (t) clearTimeout(t);
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [project]);

  return live;
}
