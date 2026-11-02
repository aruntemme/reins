// Same-origin in the browser (Next rewrites /api/* to the Reins server).
const BASE = "";

export interface TimelineEntry { kind: string; summary: string; at: number }
export interface Handoff {
  id: string;
  to: string;
  from?: string;
  kind: "mention" | "collision" | "blocker" | "fyi" | "assignment";
  text: string;
  status: "open" | "ack" | "resolved";
  createdAt: number;
  updatedAt?: number;
  area?: string | null;
  // The recipient's relevant conventions (only when they opted in to sharing).
  conventions?: string[];
  // Set when Reins closed it on its own (overlap ended, blocker resolved, work merged).
  autoClosed?: { code: string; reason: string; event: string | null } | null;
}

export interface Directive { id: string; text: string; targets: string[]; by: string | null; createdAt: number; expiresAt: number }
export interface Assignment { id: string; member: string; area: string; note: string | null; by: string | null; createdAt: number }
export interface Collision { area: string; members: string[]; note: string; computed?: boolean }

export interface Member {
  member: string;
  displayName: string;
  headline: string;
  goal: string;
  status: "active" | "blocked" | "idle";
  displayStatus: "active" | "blocked" | "idle";
  live: boolean;
  workingOn: string[];
  // Files they really edited recently (from the hook), newest first.
  touches: { path: string; at: number }[];
  // Last reported git state; branch/head are null when the workspace hides them.
  git: { branch: string | null; head: string | null; dirty: number; at: number } | null;
  lastSeen: number;
  updatedAt: number;
  handoffs: Handoff[];
  // Recently auto-closed handoffs, shown with a one-click reopen.
  autoClosed: Handoff[];
  timeline: TimelineEntry[];
}

export type TraitType = "tooling" | "quality" | "communication" | "concern" | "workflow";
export interface Trait {
  id: string;
  member: string;
  type: TraitType;
  statement: string;
  confidence: number;
  level: "low" | "medium" | "high";
  observations: number;
  evidence: string | null;
  lastSeen: number;
}

export interface MemberDetail extends Member {
  projectId: string;
  pending: { id: string; text: string; status: string; claimedBy?: string; createdAt: number }[];
  // Learned taste profile — durable working grain, strongest first. Raw prompts
  // are never sent to the client.
  profile: Trait[];
  // Cleared handoffs directed at this member — the resolved history.
  resolvedHandoffs: Handoff[];
  // Lead directives aimed at them (or the whole team), and areas assigned to them.
  directives: Directive[];
  assignments: Assignment[];
  sharesTraits: boolean;
}
// The exact text the capture hook injects into a member's agent at session start
// (empty when it would inject nothing). Capped server-side at ~300 tokens.
export interface MemberBrief { text: string; version: string }
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
  collisions: Collision[];
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
  // Live computed overlaps (shared files/branches), also before the first rollup.
  collisions: Collision[];
  directives: Directive[];
  assignments: Assignment[];
  hideBranches: boolean;
}
export interface ProjectSummary {
  id: string;
  name: string;
  goal: string;
  members: number;
  active: number;
  /** Items not done yet (owned work); absent from servers older than the calm workspace. */
  open?: number;
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

/** A non-2xx, non-401 response: keeps the HTTP status and the server's message. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** The message to show for a failed request (the server's own error when it gave one). */
export function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.";
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
    credentials: "include",
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    // Server errors are { error: string } or { error: ZodIssue[] }.
    let msg = "";
    try {
      const err = (await res.json())?.error;
      if (typeof err === "string") msg = err;
      else if (Array.isArray(err)) msg = err.map((i) => i?.message).filter(Boolean).join("; ");
    } catch { /* not JSON */ }
    throw new ApiError(msg || `request failed (${res.status})`, res.status);
  }
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
  // The capture identity this account acts as in the active workspace (the hook's
  // --me). Drives which goals/proposals are "yours". Null falls back to email.
  member?: string | null;
  // Whether this account shares its learned traits with agents (opt-in).
  shareTraits?: boolean;
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

// LLM provider config as exposed to the dashboard. The API key is never sent
// back to the client — only whether one is set (`hasKey`) and a masked preview.
export interface Provider {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  fastModel: string;
  maxTokens: number;
  active: boolean;
  hasKey: boolean;
  keyMask: string;
}
export interface ProviderInput {
  label: string;
  baseURL: string;
  model: string;
  fastModel?: string;
  maxTokens?: number;
  apiKey?: string; // omit on edit to keep the existing key
}
export interface ActiveModel { model: string; fastModel: string; label: string }

// ── CLI device login (the terminal's "approve this machine" page) ──
export type CliLoginStatus = "pending" | "approved" | "denied" | "consumed" | "expired";
export interface CliLogin {
  userCode: string;
  host: string;
  repo: string;
  status: CliLoginStatus;
  expiresAt: number;
  workspace: Workspace;
  projects: { id: string; name: string }[];
  suggestedProject: string;
}
export type CliApproveInput = { project: string } | { newProject: { name: string } };

// ── Calm workspace: owned items, releases, agent sessions, posts ──
export type ItemKind = "feature" | "bug" | "try" | "chore";
export type ItemStatus = "open" | "doing" | "waiting" | "blocked" | "paused" | "done";
export type Tone = "calm" | "needs" | "block" | "good";
export type SessionState = "working" | "waiting" | "blocked" | "idle" | "ended";
export type PostKind = "handover" | "update" | "question" | "answer" | "note" | "review" | "decision" | "finding";
export type PostStatus = "open" | "answered" | "approved" | "changed" | "dismissed";
export type ClipKind = ItemKind | "wait" | "block" | "none";
export type WorkPart = { kind: ItemKind | "blocked"; hours: number };

export interface Who { member: string; displayName: string }
export interface ItemLane {
  id: string;
  title: string;
  kind: ItemKind;
  owner: Who;
  release: { id: string; title: string } | null;
  steps: { done: number; total: number };
  /** `at` is the rider's position along the lane, 0..1 (= done/total). */
  agents: { sessionId: string; source: string; state: SessionState; at: number }[];
  state: { text: string; tone: Tone };
}
export interface Post {
  id: string;
  kind: PostKind;
  itemId: string | null;
  itemTitle: string | null;
  author: Who;
  source: string;
  toMember: string | null;
  /** The addressee for display (null = the team, or the leads for questions/decisions). */
  to?: Who | null;
  replyTo: string | null;
  status: PostStatus | null;
  delegate: boolean;
  text: string;
  createdAt: number;
}
export interface Need {
  id: string;
  type: "question" | "decision" | "blocked" | "overlap";
  text: string;
  meta: string;
  item: { id: string; title: string } | null;
  from: Who & { source: string };
  at: number;
  postId: string | null;
  sessionId: string | null;
}
export interface Clip { itemId: string | null; label: string; kind: ClipKind; from: number; to: number | null }
export interface KindCounts { feature: number; bug: number; try: number; chore: number }
export interface Trait2 { text: string; why: string }

export interface TodayData {
  now: number;
  project: { id: string; name: string };
  viewer: Who & { role: Role };
  counts: KindCounts & { waitingOnViewer: number };
  since: { tasksDone: number; questionsSettled: number; blocked: number };
  release: null | { id: string; title: string; dueAt: number | null; items: { id: string; title: string; stateText: string; tone: Tone }[] };
  groups: { kind: "feature" | "bug" | "try_chore"; items: ItemLane[] }[];
  untracked: { sessionId: string; member: Who; source: string; text: string; minutes: number }[];
  tracks: {
    from: number;
    to: number;
    now: number;
    rows: { sessionId: string; who: Who; source: string; branch: string | null; worktree: string | null; clips: Clip[] }[];
    overlaps: { members: Who[]; path: string; at: number }[];
  };
  needs: Need[];
  tape: { at: number; kind: "Asked" | "Answered" | "Done" | "Blocked" | "Delegated" | "Finding" | "Handed over"; text: string }[];
  people: { who: Who; owns: KindCounts; done7d: number; style: string }[];
}
export interface MyAgent {
  sessionId: string;
  source: string;
  branch: string | null;
  worktree: string | null;
  item: { id: string; title: string } | null;
  state: SessionState;
  stateSince: number;
  lastLine: string | null;
  clips: Clip[];
  /** Agent step marks: edits and questions ("test" may never appear). */
  steps: { at: number; kind: "edit" | "test" | "test_fail" | "ask" }[];
}
export interface MyDayData {
  me: Who;
  counts?: Partial<KindCounts & { waitingOnViewer: number }>;
  forYou: Post[];
  agents: MyAgent[];
  around: { who: Who; text: string; meta: string; tone: Tone }[];
  owned: ItemLane[];
  traits: Trait2[];
}
export interface WeekData {
  from: number;
  to: number;
  tasksDone: number;
  /** % of agent-active time per kind. */
  mix: KindCounts;
  owned: { id: string; title: string; kind: ItemKind; owner: Who; stateText: string; tone: Tone; before: number; now: number; total: number; perDay: number[] }[];
  people: { who: Who; agents: number; days: { date: string | number; hours: number; parts: WorkPart[] }[] }[];
  table: { who: Who; done: number; owns: string; blockedHours: number; helped: number }[];
  look: Trait2[];
}
export interface ItemStep { id: string; text: string; done: boolean; doneBy: Who | null; doneSource: string | null; doneAt: number | null }
export interface ItemData {
  item: {
    id: string;
    title: string;
    kind: ItemKind;
    status: ItemStatus;
    owner: Who;
    release: { id: string; title: string; dueAt?: number | null } | null;
    branch: string | null;
    summary: string | null;
    createdAt: number;
    steps: ItemStep[];
  };
  agents: { sessionId: string; source: string; who: Who; branch: string | null; worktree: string | null; state: SessionState; stateSince: number; lastLine: string | null }[];
  thread: Post[];
  open: Post[];
  files: string[];
  nearby: { text: string; meta: string }[];
  proposals: { id: string; text: string; reason: string }[];
}
export interface PersonData {
  who: Who;
  owns: string;
  agentsNow: number;
  stats: { done: number; stepsTicked: number; activeHours: number; blockedHours: number; helped: number; asked: number; askMedianMin: number | null };
  owned: ItemLane[];
  finished: { id: string; title: string; kind: ItemKind }[];
  week: { date: string | number; hours: number; parts: WorkPart[] }[];
  agents: { sessionId: string; source: string; item: { id: string; title: string } | null; branch: string | null; state: SessionState; lines: string[] }[];
  traits: Trait2[];
}
export interface NewItem { title: string; kind: ItemKind; owner?: string; releaseId?: string; steps?: string[]; branch?: string }
export interface ItemPatch { title?: string; kind?: ItemKind; owner?: string; status?: ItemStatus; releaseId?: string | null; branch?: string | null; note?: string }
export interface NewPost { itemId?: string; kind: PostKind; text: string; toMember?: string; replyTo?: string }

const P = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
/** The browser's timezone offset and local midnight, for endpoints that count "since today". */
function localDay(): string {
  return `tz=${new Date().getTimezoneOffset()}&since=${new Date().setHours(0, 0, 0, 0)}`;
}
const E = encodeURIComponent;

export const api = {
  me: () => j<Me>("/api/auth/me"),
  signin: (token: string) => j<{ ok: boolean; workspace: Workspace }>("/api/auth/session", { method: "POST", body: JSON.stringify({ token }) }),
  logout: () => j<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  projects: () => j<{ projects: ProjectSummary[]; llm: boolean; auth: boolean }>("/api/projects"),
  project: (id: string) => j<Project>(`/api/projects/${encodeURIComponent(id)}`),
  member: (id: string, member: string) =>
    j<MemberDetail>(`/api/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(member)}`),
  memberBrief: (id: string, member: string) =>
    j<MemberBrief>(`/api/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(member)}/brief`),
  setGoal: (id: string, goal: string, by?: string) =>
    j(`/api/projects/${encodeURIComponent(id)}/goal`, {
      method: "PUT",
      body: JSON.stringify({ goal, by }),
    }),
  claim: (id: string, project: string, by: string) =>
    j(`/api/pending/${id}/claim`, { method: "POST", body: JSON.stringify({ by, project }) }),
  done: (id: string, project: string) =>
    j(`/api/pending/${id}/done`, { method: "POST", body: JSON.stringify({ project }) }),
  handoff: (id: string, project: string, action: "ack" | "resolve" | "reopen") =>
    j(`/api/handoffs/${id}/${action}`, { method: "POST", body: JSON.stringify({ project }) }),
  resolveHandoffs: (project: string, member: string, kind?: Handoff["kind"]) =>
    j<{ ok: boolean; resolved: number }>(`/api/projects/${encodeURIComponent(project)}/handoffs/resolve`, {
      method: "POST",
      body: JSON.stringify({ member, ...(kind ? { kind } : {}) }),
    }),
  // ── Lead actions (owners/admins) ──
  postDirective: (project: string, d: { text: string; targets: string[]; ttlHours: number }) =>
    j<{ ok: boolean; id: string }>(`/api/projects/${encodeURIComponent(project)}/directives`, { method: "POST", body: JSON.stringify(d) }),
  clearDirective: (id: string, project: string) =>
    j<{ ok: boolean }>(`/api/directives/${encodeURIComponent(id)}/clear`, { method: "POST", body: JSON.stringify({ project }) }),
  assign: (project: string, a: { area: string; member: string; note?: string }) =>
    j<{ ok: boolean; id: string }>(`/api/projects/${encodeURIComponent(project)}/assignments`, { method: "POST", body: JSON.stringify(a) }),
  clearAssignment: (id: string, project: string) =>
    j<{ ok: boolean }>(`/api/assignments/${encodeURIComponent(id)}/clear`, { method: "POST", body: JSON.stringify({ project }) }),
  workspaceSettings: () => j<{ hideBranches: boolean }>("/api/workspace/settings"),
  setWorkspaceSettings: (s: { hideBranches: boolean }) =>
    j<{ ok: boolean; hideBranches: boolean }>("/api/workspace/settings", { method: "PUT", body: JSON.stringify(s) }),
  setTraitsSharing: (on: boolean) =>
    j<{ ok: boolean; shareTraits: boolean }>("/api/auth/traits-sharing", { method: "POST", body: JSON.stringify({ on }) }),
  refreshRollup: (id: string) =>
    j(`/api/projects/${encodeURIComponent(id)}/rollup`, { method: "POST" }),
  // ── LLM providers (admin-managed; keys encrypted server-side) ──
  // instanceDefault: the operator's env fallback model is configured (has a key).
  providers: () => j<{ providers: Provider[]; active: ActiveModel; instanceDefault: boolean }>("/api/providers"),
  createProvider: (p: ProviderInput) =>
    j<{ provider: Provider }>("/api/providers", { method: "POST", body: JSON.stringify(p) }),
  updateProvider: (id: string, p: Partial<ProviderInput>) =>
    j<{ provider: Provider }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(p),
    }),
  activateProvider: (id: string) =>
    j<{ ok: boolean; active: ActiveModel }>(`/api/providers/${encodeURIComponent(id)}/activate`, {
      method: "POST",
    }),
  deleteProvider: (id: string) =>
    j<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),

  invite: (name: string, access: boolean) =>
    j<{ ok: boolean; name: string | null; ingest: string; access?: string }>("/api/admin/invite", {
      method: "POST",
      body: JSON.stringify({ name, access }),
    }),
  tokens: () => j<{ tokens: Token[] }>("/api/admin/tokens"),
  revokeToken: (id: string) =>
    j<{ ok: boolean }>(`/api/admin/tokens/${encodeURIComponent(id)}/revoke`, { method: "POST" }),

  // ── Accounts ──────────────────────────────────────────────
  /** `invite`: the code from an invite link, so the account joins that workspace instead of getting its own. */
  signup: (email: string, password: string, workspaceName?: string, invite?: string) =>
    j<{ ok: boolean; user: { email: string }; workspace: Workspace; role: Role }>(
      "/api/auth/signup",
      { method: "POST", body: JSON.stringify({ email, password, workspaceName, invite }) }
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
  setMember: (member: string) =>
    j<{ ok: boolean; member: string | null }>("/api/auth/member", { method: "POST", body: JSON.stringify({ member }) }),
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

  // ── CLI device login ──────────────────────────────────────
  cliLogin: (code: string) => j<CliLogin>(`/api/cli/login/${encodeURIComponent(code)}`),
  cliApprove: (code: string, choice: CliApproveInput) =>
    j<{ ok: boolean; project: { id: string; name: string } }>(`/api/cli/login/${encodeURIComponent(code)}/approve`, {
      method: "POST",
      body: JSON.stringify(choice),
    }),
  cliDeny: (code: string) =>
    j<{ ok: boolean }>(`/api/cli/login/${encodeURIComponent(code)}/deny`, { method: "POST" }),

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

  // ── Taste profile (a member curates their own learned grain) ──
  patchTrait: (id: string, patch: { statement?: string; type?: TraitType }) =>
    j<{ ok: boolean }>(`/api/traits/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTrait: (id: string) => j<{ ok: boolean }>(`/api/traits/${id}`, { method: "DELETE" }),

  // ── Calm workspace reads ──
  // tz/since make "today" the browser's day, not the server's.
  today: (id: string) => j<TodayData>(`${P(id)}/today?${localDay()}`),
  myDay: (id: string) => j<MyDayData>(`${P(id)}/me?${localDay()}`),
  week: (id: string, days = 7) => j<WeekData>(`${P(id)}/week?days=${days}&tz=${new Date().getTimezoneOffset()}`),
  item: (id: string, itemId: string) => j<ItemData>(`${P(id)}/items/${E(itemId)}`),
  person: (id: string, member: string) => j<PersonData>(`${P(id)}/people/${E(member)}?tz=${new Date().getTimezoneOffset()}`),

  // ── Calm workspace writes ──
  createItem: (id: string, item: NewItem) =>
    j<{ ok: boolean; id: string; item?: unknown }>(`${P(id)}/items`, { method: "POST", body: JSON.stringify(item) }),
  patchItem: (itemId: string, patch: ItemPatch) =>
    j<{ ok?: boolean }>(`/api/items/${E(itemId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  addStep: (itemId: string, text: string) =>
    j<{ ok: boolean; id: string; step?: unknown }>(`/api/items/${E(itemId)}/steps`, { method: "POST", body: JSON.stringify({ text }) }),
  setStep: (stepId: string, done: boolean) =>
    j<{ ok?: boolean }>(`/api/steps/${E(stepId)}`, { method: "PATCH", body: JSON.stringify({ done }) }),
  createRelease: (id: string, r: { title: string; dueAt?: number | null }) =>
    j<{ ok: boolean; id: string; release?: unknown }>(`${P(id)}/releases`, { method: "POST", body: JSON.stringify(r) }),
  patchRelease: (releaseId: string, r: { title?: string; dueAt?: number | null }) =>
    j<{ ok?: boolean }>(`/api/releases/${E(releaseId)}`, { method: "PATCH", body: JSON.stringify(r) }),
  deleteRelease: (releaseId: string) =>
    j<{ ok?: boolean }>(`/api/releases/${E(releaseId)}`, { method: "DELETE" }),
  createPost: (id: string, p: NewPost) =>
    j<{ id?: string }>(`${P(id)}/posts`, { method: "POST", body: JSON.stringify(p) }),
  answerPost: (postId: string, text: string) =>
    j<{ ok?: boolean }>(`/api/posts/${E(postId)}/answer`, { method: "POST", body: JSON.stringify({ text }) }),
  resolvePost: (postId: string, status: "approved" | "changed" | "dismissed", text?: string) =>
    j<{ ok?: boolean }>(`/api/posts/${E(postId)}/resolve`, { method: "POST", body: JSON.stringify(text ? { status, text } : { status }) }),
  delegatePost: (postId: string) =>
    j<{ ok?: boolean }>(`/api/posts/${E(postId)}/delegate`, { method: "POST" }),
  trackSession: (sessionId: string, t: { title?: string; kind: ItemKind }) =>
    j<{ id?: string }>(`/api/sessions/${E(sessionId)}/track`, { method: "POST", body: JSON.stringify(t) }),
};

// Quote a value for a POSIX shell command line unless it is plainly safe.
function shq(v: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** The one-line capture-hook install command; omitted options fall back to the hook's defaults. */
export function installCommand(o: { url: string; me?: string | null; project?: string; token?: string | null }): string {
  let cmd = `npx reins-hook install --url ${shq(o.url)}`;
  if (o.me) cmd += ` --me ${shq(o.me)}`;
  if (o.project) cmd += ` --project ${shq(o.project)}`;
  if (o.token) cmd += ` --token ${shq(o.token)}`;
  return cmd;
}

export function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
