import { REST, Routes } from "discord.js";
import type { BotConfig } from "../config.js";
import { commandDefinitions } from "./definitions.js";

/**
 * Registers slash commands at startup. Guild-scoped when DISCORD_GUILD_ID is set
 * (instant propagation, recommended for dev — spec §10); otherwise global.
 */
export async function registerCommands(cfg: BotConfig): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(cfg.botToken);
  if (cfg.guildId) {
    await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), { body: commandDefinitions });
    console.log(`[discord-bot] registered ${commandDefinitions.length} guild commands for ${cfg.guildId}`);
  } else {
    console.warn("[discord-bot] DISCORD_GUILD_ID unset — registering GLOBAL commands (slow propagation)");
    await rest.put(Routes.applicationCommands(cfg.clientId), { body: commandDefinitions });
  }
}
