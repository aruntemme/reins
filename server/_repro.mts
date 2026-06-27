import { distillCombined } from "./src/pipeline/distill.js";
import { buildProfileView } from "./src/db.js";
const t0 = Date.now();
try {
  const sig = await distillCombined({
    project: "taste-demo", member: "arun",
    text: "Refactored auth into small single-purpose functions, each under 20 lines. I cannot stand giant functions — terse and composable beats clever. Also added Zod validation on the boundary.",
  });
  console.log("OK significance=", sig, "in", Date.now() - t0, "ms");
  console.log("traits:", JSON.stringify(buildProfileView("taste-demo", "arun").map(t => ({type:t.type, s:t.statement, c:+t.confidence.toFixed(2)})), null, 2));
} catch (e) {
  console.error("DISTILL ERROR:", e);
}
process.exit(0);
