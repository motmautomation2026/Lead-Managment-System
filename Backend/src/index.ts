import { createApp } from "./app.js";
import { env } from "./env.js";
import { closePools, logPoolTargets } from "./db.js";
import { installShutdown } from "./shutdown.js";

const app = createApp();

logPoolTargets();
const server = app.listen(env.PORT, () => {
  console.log(`Northbeam CRM backend listening on port ${env.PORT} (${env.NODE_ENV})`);
});

installShutdown(async () => {
  // Stop accepting requests, drop idle keep-alive sockets, then free the pooler slots.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  await closed;
  await closePools();
});
