import { buildConfig } from "./config.js";
import { createApp } from "./app.js";

const config = buildConfig();
const app = createApp();

app.listen(config.port, () => {
  console.log(`[api] listening on :${config.port}`);
});
