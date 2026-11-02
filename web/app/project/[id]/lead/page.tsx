import { redirect } from "next/navigation";
import { param } from "@/components/work/format";

/** The lead console's actions (new item, release, notes, handovers) now live on the Today page. */
export default async function OldLeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/project/${encodeURIComponent(param(id))}`);
}
