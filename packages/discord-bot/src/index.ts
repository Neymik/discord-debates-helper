import { Client, GatewayIntentBits, Events, MessageFlags } from "discord.js";
import { buildBotConfig } from "./config.js";
import { ApiClient } from "./apiClient.js";
import { RecordingManager } from "./recording/session.js";
import { recoverOrphans } from "./recording/recovery.js";
import { registerCommands } from "./commands/register.js";
import { handleLink } from "./commands/link.js";
import { handleRecord } from "./commands/record.js";
import { startAnnounceWorker } from "./announce/worker.js";

async function main(): Promise<void> {
  const cfg = buildBotConfig();
  const api = new ApiClient(cfg);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
  });

  const manager = new RecordingManager(api, cfg);

  // Finalize any recording orphaned by a previous crash before we accept commands,
  // so a stuck guild lock is freed quickly. Bounded so a slow/unreachable API can't
  // block startup; recovery keeps running in the background past the timeout.
  if (cfg.recoverOnBoot) {
    await Promise.race([
      recoverOrphans(api, cfg)
        .then((n) => n > 0 && console.warn(`[discord-bot] boot recovery finalized ${n} orphaned session(s)`))
        .catch((err) => console.error("[discord-bot] boot recovery failed:", err)),
      new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
    ]);
  }

  // Graceful shutdown: finalize in-flight recordings on stop/redeploy/crash so a
  // long debate isn't abandoned mid-stream. SIGTERM is what `docker stop` sends.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(`[discord-bot] ${signal} received — finalizing active recordings`);
    try {
      await manager.stopAll();
    } catch (err) {
      console.error("[discord-bot] stopAll during shutdown failed:", err);
    }
    try {
      client.destroy();
    } catch {
      /* already gone */
    }
    process.exit(signal === "uncaughtException" || signal === "unhandledRejection" ? 1 : 0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    console.error("[discord-bot] uncaughtException:", err);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (err) => {
    console.error("[discord-bot] unhandledRejection:", err);
    void shutdown("unhandledRejection");
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord-bot] logged in as ${c.user.tag}`);
    if (cfg.announceEnabled) {
      startAnnounceWorker(client, cfg);
    } else {
      console.warn("[discord-bot] announce worker disabled (ANNOUNCE_ENABLED=false)");
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === "link") {
        await handleLink(interaction, api);
      } else if (interaction.commandName === "record") {
        await handleRecord(interaction, api, manager, cfg);
      }
    } catch (err) {
      console.error("[discord-bot] interaction error:", err);
      const msg = { content: "something went wrong.", flags: MessageFlags.Ephemeral } as const;
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg).catch(() => undefined);
      } else {
        await interaction.reply(msg).catch(() => undefined);
      }
    }
  });

  await registerCommands(cfg);
  await client.login(cfg.botToken);
}

main().catch((err) => {
  console.error("[discord-bot] fatal:", err);
  process.exit(1);
});
