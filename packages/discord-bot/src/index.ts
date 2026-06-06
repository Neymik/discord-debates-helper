import { Client, GatewayIntentBits, Events, MessageFlags } from "discord.js";
import { buildBotConfig } from "./config.js";
import { ApiClient } from "./apiClient.js";
import { RecordingManager } from "./recording/session.js";
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
