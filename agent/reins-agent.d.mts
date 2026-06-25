// Type declarations for the dependency-free agent so the TS server tests (run
// under strict) can import it without `any`. Keep in sync with reins-agent.mjs.

export interface PendingItem {
  id: string;
  member?: string;
  text: string;
  status?: string;
  claimedBy?: string;
  createdAt?: string;
}

export interface AgentConn {
  url?: string;
  token?: string;
  project: string;
}

export interface RunOnceResult {
  matched: PendingItem[];
  claimed: string[];
  resolved: string[];
  dryRun: boolean;
  noted: boolean;
}

export function selectItems(items: PendingItem[], policy?: string): PendingItem[];

export function fetchOpenPending(conn: AgentConn): Promise<PendingItem[]>;

export function claimItem(
  args: AgentConn & { id: string; by: string }
): Promise<unknown>;

export function resolveItem(args: AgentConn & { id: string }): Promise<unknown>;

export function note(
  args: AgentConn & { member: string; text: string }
): Promise<unknown>;

export function runOnce(
  args: AgentConn & {
    by?: string;
    policy?: string;
    dryRun?: boolean;
    log?: (msg: string) => void;
  }
): Promise<RunOnceResult>;
