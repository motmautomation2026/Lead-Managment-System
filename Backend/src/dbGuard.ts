import { assertDatabaseAllowed } from "./noDatabase.js";

// DEMO-1 rule 1: src/db.ts imports this first, so a run without a database stops before env.ts or any pool loads.
assertDatabaseAllowed("src/db.ts was loaded");
