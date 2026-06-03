import { buildConfig } from "./config.js";
import { createApp } from "./app.js";
import { startCrons } from "./crons.js";
import { reconcileJobs } from "./scheduler/scheduler.js";

const config = buildConfig();
const app = createApp();

app.listen(config.port, () => {
  console.log(`[api] listening on :${config.port}`);
  reconcileJobs()
    .then((count) => console.log(`[api] reconciled jobs for ${count} upcoming games`))
    .catch((err) => console.error("[api] boot reconcile failed (crons will still start):", err))
    .finally(() => startCrons());
});
