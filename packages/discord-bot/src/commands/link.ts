import type { ChatInputCommandInteraction } from "discord.js";
import type { ApiClient } from "../apiClient.js";

/** /link <code> — spec §10: redeem a code, tie this Discord user to a Telegram user. */
export async function handleLink(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const code = interaction.options.getString("code", true);
  await interaction.deferReply({ ephemeral: true });
  const result = await api.redeemLink({
    code,
    discord_user_id: interaction.user.id,
    discord_username: interaction.user.username,
  });
  if (!result) {
    await interaction.editReply("invalid or expired code");
    return;
  }
  await interaction.editReply(`linked as ${result.display_name}`);
}
