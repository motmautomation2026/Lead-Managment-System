// Fails when everything dist/index.html loads up front (entry, modulepreloads, CSS) exceeds the
// first-load budget in gzip. Runs after `vite build` in `npm run check`. `--list` prints each file.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const BUDGET_KB = 350;

/** The verdict for a first-load total (kB gzip): `ok` false above the budget. */
export function checkBudget(totalKb, budgetKb = BUDGET_KB) {
  return totalKb > budgetKb
    ? {
        ok: false,
        message: `First-load bundle is over budget by ${(totalKb - budgetKb).toFixed(1)} kB. See docs/crm-v2/C1-ui.md §1.9.`,
      }
    : { ok: true, message: null };
}

function main() {
  const dist = join(import.meta.dirname, "..", "dist");
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const files = [
    ...new Set(
      [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]),
    ),
  ];
  const sizes = files.map((file) => ({
    file,
    kb: gzipSync(readFileSync(join(dist, file))).length / 1024,
  }));
  const total = sizes.reduce((sum, s) => sum + s.kb, 0);

  if (process.argv.includes("--list")) {
    for (const s of [...sizes].sort((a, b) => b.kb - a.kb))
      console.log(`${s.kb.toFixed(1).padStart(7)} kB  ${s.file}`);
  }
  console.log(
    `First load: ${total.toFixed(1)} kB gzip in ${files.length} files (budget ${BUDGET_KB} kB).`,
  );
  const verdict = checkBudget(total);
  if (!verdict.ok) {
    console.error(verdict.message);
    process.exit(1);
  }
}

// Run only as a script (`npm run size`), not when a test imports checkBudget.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
