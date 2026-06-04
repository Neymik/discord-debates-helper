import { SlashCommandBuilder } from "discord.js";

export const linkCommand = new SlashCommandBuilder()
  .setName("link")
  .setDescription("Link your Discord account to your Telegram registration")
  .addStringOption((opt) =>
    opt.setName("code").setDescription("The LINK-XXXX code from the Telegram bot").setRequired(true),
  );

export const recordCommand = new SlashCommandBuilder()
  .setName("record")
  .setDescription("Control voice recording for a debate")
  .addSubcommand((sub) => sub.setName("start").setDescription("Start recording your current voice channel"))
  .addSubcommand((sub) => sub.setName("stop").setDescription("Stop the active recording"));

export const commandDefinitions = [linkCommand, recordCommand].map((c) => c.toJSON());
