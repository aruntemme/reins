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

export type GoalScope = "team" | "individual";
export type GoalStatus = "todo" | "in_progress" | "blocked" | "done";
export interface GoalItem { id: string; text: string; done: boolean; origin: string; evidence: string | null }
export interface GoalProgress { done: number; total: number; pct: number }
export interface Goal {
  id: string;
  scope: GoalScope;
  member: string | null;
  parentId: string | null;
  title: string;
  blocked: boolean;
  status: GoalStatus;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  items: GoalItem[];
  progress: GoalProgress;
  rollup: GoalProgress;
}

export interface GoalProposal {
  id: string;
  goalId: string;
  goalTitle: string;
  scope: GoalScope;
  itemId: string | null;
  itemText: string | null;
  kind: "check_item" | "add_item" | "block_goal";
  text: string | null;
  reason: string;
  evidence: string | null;
  member: string | null;
  createdAt: number;
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
export type Role = "owner" | "admin" | "member";
export interface WorkspaceMembership { id: string; name: string; role: Role }
export interface WorkspaceMember { userId: string; email: string; role: Role; createdAt: number }
export interface Me {
  auth: boolean;
  workspace: Workspace | null;
  admin?: boolean;
  // Present when signed in with a real account (vs a pasted token).
  user?: { email: string } | null;
  workspaces?: WorkspaceMembership[];
  role?: Role;
}

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

  // ── Accounts ──────────────────────────────────────────────
  signup: (email: string, password: string, workspaceName?: string) =>
    j<{ ok: boolean; user: { email: string }; workspace: Workspace; tokens?: { ingest: string; access: string; admin: string } }>(
      "/api/auth/signup",
      { method: "POST", body: JSON.stringify({ email, password, workspaceName }) }
    ),
  login: (email: string, password: string) =>
    j<{ ok: boolean; user: { email: string }; workspace: Workspace; workspaces: WorkspaceMembership[] }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) }
    ),
  switchWorkspace: (workspaceId: string) =>
    j<{ ok: boolean; workspace: Workspace }>("/api/auth/switch", {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    }),
  joinWorkspace: (code: string) =>
    j<{ ok: boolean; workspace: Workspace; role: Role }>("/api/auth/join", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  invitePreview: (code: string) =>
    j<{ workspace: string; role: Role; valid: boolean }>(`/api/invites/${encodeURIComponent(code)}`),
  resetPassword: (code: string, password: string) =>
    j<{ ok: boolean }>("/api/auth/reset", { method: "POST", body: JSON.stringify({ code, password }) }),

  // ── Members + invites (workspace-scoped, owner/admin) ─────
  members: (workspaceId: string) =>
    j<{ members: WorkspaceMember[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`),
  inviteLink: (workspaceId: string, role: Role, label?: string) =>
    j<{ ok: boolean; code: string; url: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/invites`, {
      method: "POST",
      body: JSON.stringify({ role, label }),
    }),
  setMemberRole: (workspaceId: string, userId: string, role: Role) =>
    j<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}/role`, {
      method: "POST",
      body: JSON.stringify({ role }),
    }),
  removeMember: (workspaceId: string, userId: string) =>
    j<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    }),

  // ── Projects ──────────────────────────────────────────────
  createProject: (id: string, name: string) =>
    j<{ ok: boolean; project: ProjectSummary }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ id, name }),
    }),

  // ── Short-term goals ──────────────────────────────────────
  goals: (id: string) => j<{ goals: Goal[] }>(`/api/projects/${encodeURIComponent(id)}/goals`),
  addGoal: (id: string, g: { scope: GoalScope; title: string; member?: string; parentId?: string; items?: string[] }) =>
    j<{ ok: boolean; id: string }>(`/api/projects/${encodeURIComponent(id)}/goals`, { method: "POST", body: JSON.stringify(g) }),
  patchGoal: (goalId: string, patch: { title?: string; blocked?: boolean; parentId?: string | null }) =>
    j<{ ok: boolean }>(`/api/goals/${goalId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteGoal: (goalId: string) => j<{ ok: boolean }>(`/api/goals/${goalId}`, { method: "DELETE" }),
  addGoalItem: (goalId: string, text: string) =>
    j<{ ok: boolean; id: string }>(`/api/goals/${goalId}/items`, { method: "POST", body: JSON.stringify({ text }) }),
  patchGoalItem: (itemId: string, patch: { text?: string; done?: boolean }) =>
    j<{ ok: boolean }>(`/api/goal-items/${itemId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteGoalItem: (itemId: string) => j<{ ok: boolean }>(`/api/goal-items/${itemId}`, { method: "DELETE" }),

  // Auto-tracking proposals (the pipeline suggests; the owner confirms).
  goalProposals: (id: string) => j<{ proposals: GoalProposal[] }>(`/api/projects/${encodeURIComponent(id)}/goal-proposals`),
  acceptProposal: (pid: string) => j<{ ok: boolean }>(`/api/goal-proposals/${pid}/accept`, { method: "POST" }),
  dismissProposal: (pid: string) => j<{ ok: boolean }>(`/api/goal-proposals/${pid}/dismiss`, { method: "POST" }),
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
