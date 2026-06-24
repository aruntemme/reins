import { Router } from "express";
import { bus, type ReinsEvent } from "../bus.js";
import { requireViewer } from "../middleware.js";
import { env } from "../env.js";
import { projectWorkspace } from "../db.js";

export const stream = Router();

// Server-Sent Events: the dashboard subscribes here and re-fetches on change.
stream.get("/stream", requireViewer, (req, res) => {
  const project = String(req.query.project || "");
  const ws = req.workspaceId;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: hello\ndata: {"ok":true}\n\n`);

  const send = (e: ReinsEvent) => {
    if (project && "project" in e && e.project !== project) return;
    // Workspace isolation: never forward another tenant's events.
    if (env.authEnabled && "project" in e && projectWorkspace(e.project) !== ws) return;
    res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const off = bus.onChange(send);

  const ka = setInterval(() => res.write(`: keep-alive\n\n`), 25000);

  req.on("close", () => {
    clearInterval(ka);
    off();
    res.end();
  });
});
