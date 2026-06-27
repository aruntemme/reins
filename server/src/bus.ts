import { EventEmitter } from "node:events";

export type ReinsEvent =
  | { type: "member.updated"; project: string; member: string }
  | { type: "timeline.added"; project: string; member: string }
  | { type: "pending.changed"; project: string }
  | { type: "rollup.updated"; project: string }
  | { type: "handoff.changed"; project: string }
  | { type: "goal.updated"; project: string }
  | { type: "goals.changed"; project: string }
  | { type: "profile.changed"; project: string; member: string }
  | { type: "ingest"; project: string; member: string };

class Bus extends EventEmitter {
  emitChange(e: ReinsEvent) {
    this.emit("change", e);
  }
  onChange(fn: (e: ReinsEvent) => void) {
    this.on("change", fn);
    return () => this.off("change", fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);
