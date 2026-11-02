import { redirect } from "next/navigation";
import { param } from "@/components/work/format";

/** The old per-member brief now lives at /project/:id/people/:member. */
export default async function OldMemberPage({ params }: { params: Promise<{ id: string; member: string }> }) {
  const { id, member } = await params;
  redirect(`/project/${encodeURIComponent(param(id))}/people/${encodeURIComponent(param(member))}`);
}
