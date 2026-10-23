// Imported first by worker.ts, before db.js loads, so the shared pool is sized
// (WORKER_DB_POOL_MAX) and named (northbeam-worker) for the worker.
process.env.NORTHBEAM_DB_ROLE = "worker";
