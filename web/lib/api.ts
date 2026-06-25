// Same-origin in the browser (Next rewrites /api/* to the Reins server).
const BASE = "";

export interface TimelineEntry { kind: string; summary: string; at: number }
export interface Handoff {
  id: string;
  to: string;
  from?: string;
  kind: "mention" | "collision" | "blocker" | "fyi";
  text: string;
  status: "open" | "ack" | "resolved";
  createdAt: number;
}

export interface Member {
  member: string;
  displayName: string;
  headline: string;
  goal: string;
  status: "active" | "blocked" | "idle";
  displayStatus: "active" | "blocked" | "idle";
  live: boolean;
  workingOn: string[];
  lastSeen: number;
  updatedAt: number;
  handoffs: Handoff[];
  timeline: TimelineEntry[];
}

export interface MemberDetail extends Member {
  projectId: string;
  pending: { id: string; text: string; status: string; claimedBy?: string; createdAt: number }[];
  events: { kind: string; text: string; significance?: string; at: number }[];
}
export interface PendingItem {
  id: string;
  member: string;
  text: string;
  status: "open" | "claimed" | "done";
  claimedBy?: string;
  createdAt: number;
}
export interface Rollup {
  summary: string;
  alignment: string;
  collisions: { area: string; members: string[]; note: string }[];
  risks: string[];
  updatedAt: number;
}
export interface Project {
  id: string;
  name: string;
  goal: string;
  goalSetBy?: string;
  updatedAt: number;
  members: Member[];
  handoffs: Handoff[];
  pending: PendingItem[];
  rollup: Rollup | null;
}
export interface ProjectSummary {
  id: string;
  name: string;
  goal: string;
  members: number;
  active: number;
  updatedAt: number;
}

export class AuthError extends Error {
  constructor() { super("auth required"); }
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
    credentials: "include",
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

export interface Workspace { id: string; name: string }
export interface Me { auth: boolean; workspace: Workspace | null; admin?: boolean }

export interface Token {
  id: string;
  kind: "ingest" | "access" | "admin";
  prefix: string;
  label: string | null;
  created_at: number;
  last_used: number | null;
  revoked: 0 | 1;
}

export interface OgStatus {
  enabled: boolean;
  network?: string;
  chainId?: number;
  explorer?: string;
  compute?: {
    mode: "router" | "broker";
    private: boolean;
    ready: boolean;
    provider?: string;
    model: string;
    endpoint: string;
    requests: number;
    verified: number;
    unverifiable: number;
    balance: number | null;
    lastError?: string;
  } | null;
  storage?: {
    uploads: number;
    lastRootHash?: string;
    explorer: string;
    lastError?: string;
  } | null;
}

export const api = {
  me: () => j<Me>("/api/auth/me"),
  signin: (token: string) => j<{ ok: boolean; workspace: Workspace }>("/api/auth/session", { method: "POST", body: JSON.stringify({ token }) }),
  logout: () => j<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  projects: () => j<{ projects: ProjectSummary[]; llm: boolean; auth: boolean }>("/api/projects"),
  project: (id: string) => j<Project>(`/api/projects/${encodeURIComponent(id)}`),
  member: (id: string, member: string) =>
    j<MemberDetail>(`/api/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(member)}`),
  setGoal: (id: string, goal: string, by?: string) =>
    j(`/api/projects/${encodeURIComponent(id)}/goal`, {
      method: "PUT",
      body: JSON.stringify({ goal, by }),
    }),
  claim: (id: string, project: string, by: string) =>
    j(`/api/pending/${id}/claim`, { method: "POST", body: JSON.stringify({ by, project }) }),
  done: (id: string, project: string) =>
    j(`/api/pending/${id}/done`, { method: "POST", body: JSON.stringify({ project }) }),
  handoff: (id: string, project: string, action: "ack" | "resolve") =>
    j(`/api/handoffs/${id}/${action}`, { method: "POST", body: JSON.stringify({ project }) }),
  refreshRollup: (id: string) =>
    j(`/api/projects/${encodeURIComponent(id)}/rollup`, { method: "POST" }),
  ogStatus: () => j<OgStatus>("/api/og/status"),
  invite: (name: string, access: boolean) =>
    j<{ ok: boolean; name: string | null; ingest: string; access?: string }>("/api/admin/invite", {
      method: "POST",
      body: JSON.stringify({ name, access }),
    }),
  tokens: () => j<{ tokens: Token[] }>("/api/admin/tokens"),
  revokeToken: (id: string) =>
    j<{ ok: boolean }>(`/api/admin/tokens/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
};

export function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
