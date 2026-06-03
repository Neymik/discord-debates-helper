import { buildConfig } from "./config.js";
import { createApp } from "./app.js";
import { startCrons } from "./crons.js";
import { reconcileJobs } from "./scheduler/scheduler.js";

const config = buildConfig();
const app = createApp();

app.listen(config.port, async () => {
  console.log(`[api] listening on :${config.port}`);
  const count = await reconcileJobs(); // self-heal Redis on boot
  console.log(`[api] reconciled jobs for ${count} upcoming games`);
  startCrons();
});
