/**
 * BOLO — DSP Harness CLI entry (bundled with esbuild and run with node).
 *
 *   npx esbuild scripts/runDspHarness.ts --bundle --platform=node --format=esm --outfile=/tmp/dsp-harness.mjs
 *   node /tmp/dsp-harness.mjs
 *
 * Prints the measured-feature trace for every fixture — the deterministic
 * proof the acoustic detector works (a Vite build proves nothing here).
 */
import { runAll, formatTable, digestDiagnostic } from "../src/lib/dsp/harness";

const rows = runAll();

console.log("BOLO DSP DETECTOR — DETERMINISTIC HARNESS (raw PCM → detector → verdicts)");
console.log("");

for (const r of rows) {
  console.log(`=== ${r.name} (expect ${r.expect}) ===`);
  if (r.detail.length === 0) {
    console.log("  (no candidate created — speech did not resemble any disfluency)");
  } else {
    for (const d of r.detail) console.log(`  ${d}`);
  }
  for (const v of r.verdicts) console.log(`  MEASURED: ${digestDiagnostic(v)}`);
  console.log("");
}

console.log("────────────────────────────────────────────────────────────────────────");
console.log(formatTable(rows));
console.log("");

const failures = rows.filter(
  (r) => (r.expect === "confirmed" && r.confirmedCount === 0) ||
         (r.expect === "rejected" && r.confirmedCount > 0)
);
if (failures.length === 0) {
  console.log(`ALL ${rows.length} fixtures match expected outcomes.`);
} else {
  console.log(`MISMATCH on ${failures.length} fixture(s): ${failures.map((f) => f.name).join(", ")}`);
  process.exitCode = 1;
}
