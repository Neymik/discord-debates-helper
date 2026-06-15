import { ChannelType, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { ApiClient } from "../apiClient.js";
import type { RecordingManager } from "../recording/session.js";
import type { BotConfig } from "../config.js";
import { consentNotice } from "../consent.js";
import { formatDuration } from "../lib/duration.js";

export async function handleRecord(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
  manager: RecordingManager,
  cfg: BotConfig,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "start") return handleStart(interaction, api, manager);
  if (sub === "stop") return handleStop(interaction, manager, cfg);
}

async function handleStart(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
  manager: RecordingManager,
): Promise<void> {
  const guildId = interaction.guildId;
  const member = interaction.member as GuildMember | null;
  const voiceChannel = member?.voice.channel ?? null;

  if (!guildId || !voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({ content: "join a voice channel first", ephemeral: true });
    return;
  }

  // Local guard mirroring the API's DB-enforced 409.
  if (manager.isActive(guildId)) {
    await interaction.reply({ content: "a recording is already active in this server.", ephemeral: true });
    return;
  }

  await interaction.deferReply(); // visible (non-ephemeral) — consent notice must be public
  let created;
  try {
    created = await api.createSession({
      started_by_discord_user_id: interaction.user.id,
      voice_channel_id: voiceChannel.id,
      voice_channel_name: voiceChannel.name,
      guild_id: guildId,
    });
  } catch {
    await interaction.editReply("backend not reachable, try again.");
    return;
  }
  if (!created.ok) {
    await interaction.editReply("a recording is already active in this server.");
    return;
  }

  const onWarn = () => {
    void interaction.followUp("⚠️ Recording will auto-stop in 15 minutes (max session length).").catch(() => undefined);
  };
  const onAutoStop = () => {
    void autoStop(interaction, manager, guildId).catch((e) =>
      console.error("[discord-bot] auto-stop failed:", e),
    );
  };

  await manager.start(created.session, voiceChannel, onWarn, onAutoStop);

  // Mandatory consent notice (spec §5 step 6 / §11). If posting fails, STOP immediately.
  try {
    await interaction.editReply(consentNotice(voiceChannel.name, created.session.id));
  } catch (err) {
    console.error("[discord-bot] consent notice failed — aborting recording:", err);
    await manager.abort(guildId);
    await interaction
      .followUp({ content: "could not post the recording notice — recording stopped.", ephemeral: true })
      .catch(() => undefined);
  }
}

async function handleStop(
  interaction: ChatInputCommandInteraction,
  manager: RecordingManager,
  cfg: BotConfig,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !manager.isActive(guildId)) {
    await interaction.reply({ content: "no active recording in this server.", ephemeral: true });
    return;
  }
  const transcribe = interaction.options.getBoolean("transcribe") ?? false;
  const type = interaction.options.getString("type") ?? "batch";

  await interaction.deferReply();
  const result = await manager.stop(guildId, { transcribe, type });
  if (!result) {
    await interaction.editReply("no active recording in this server.");
    return;
  }

  let msg = `Recorded ${result.speakerCount} speakers, ${formatDuration(result.totalDurationSec)}. See admin panel for download.`;
  if (transcribe) {
    if (cfg.transcribeHook) {
      const note = type === "incremental" ? " (incremental coming soon — running batch)" : "";
      msg += `\n📝 Transcribing${note}… the transcript will appear in the session folder in a few minutes.`;
    } else {
      msg += `\n⚠️ Transcription was requested but isn't configured on this bot.`;
    }
  }
  await interaction.editReply(msg);
}

/** Auto-stop path (hard cap): stop then post a notice in the originating channel. */
async function autoStop(
  interaction: ChatInputCommandInteraction,
  manager: RecordingManager,
  guildId: string,
): Promise<void> {
  const result = await manager.stop(guildId);
  if (!result) return;
  await interaction.followUp(
    `⏹️ Auto-stopped at the max session length. Recorded ${result.speakerCount} speakers, ${formatDuration(
      result.totalDurationSec,
    )}.`,
  );
}
