'use strict';

require('dotenv').config();

const path = require('node:path');
const { Client, Events, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const { BridgeStore, isSnowflake } = require('./bridge-store');
const { RelayManager } = require('./relay-manager');

const token = process.env.DISCORD_TOKEN;
const prefix = process.env.COMMAND_PREFIX || '?';
const ownerIds = new Set((process.env.BRIDGE_OWNER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
const trackLimit = Number(process.env.MESSAGE_TRACK_LIMIT || 5000);
const storePath = path.join(__dirname, '..', 'data', 'bridges.json');

if (!token || token === 'replace_with_your_bot_token') {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and add your bot token.');
  process.exit(1);
}

let store;
try {
  store = new BridgeStore(storePath);
} catch (error) {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const relayManager = new RelayManager(client, store, { prefix, trackLimit });

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[startup] Logged in as ${readyClient.user.tag}.`);
  console.log(`[startup] Command prefix: ${prefix}`);
  relayManager.start();
  readyClient.user.setActivity(`${prefix}relay help`, { type: 0 });
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot || message.webhookId) return;
  if (!message.content.startsWith(prefix)) return;
  const parts = message.content.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  const command = (parts.shift() || '').toLowerCase();
  if (command !== 'relay') return;
  try {
    await handleRelayCommand(message, parts);
  } catch (error) {
    console.error('[command] Relay command failed:', error);
    await message.reply({ content: 'The command failed unexpectedly. Check the bot console for details.', allowedMentions: { repliedUser: false } }).catch(() => {});
  }
});

async function handleRelayCommand(message, args) {
  const subcommand = (args[0] || 'help').toLowerCase();
  const userIsOwner = ownerIds.has(message.author.id);

  if (subcommand === 'help') {
    return safeReply(message, [
      '**Discord Chat Bridge commands**',
      `\`${prefix}relay add <source-channel-id> <target-channel-id>\` — add one-way relay`,
      `\`${prefix}relay bidirectional <channel-a-id> <channel-b-id>\` — relay both ways`,
      `\`${prefix}relay remove <source-channel-id> <target-channel-id>\` — remove one route`,
      `\`${prefix}relay stop [channel-id]\` — remove routes involving that channel (defaults to this channel)`,
      `\`${prefix}relay list\` — list configured routes`,
      `\`${prefix}relay help\` — show this help`,
      '',
      'The operator must have **Manage Server** in both connected servers unless allowlisted in `BRIDGE_OWNER_IDS`.',
    ].join('\n'));
  }

  if (!userIsOwner && !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return safeReply(message, 'You need **Manage Server** permission to manage bridges.');
  }

  if (subcommand === 'list') {
    const allBridges = store.list();
    const bridges = [];
    for (const bridge of allBridges) {
      const source = await message.client.channels.fetch(bridge.sourceChannelId).catch(() => null);
      const target = await message.client.channels.fetch(bridge.targetChannelId).catch(() => null);
      if (!source?.guild || !target?.guild) continue;
      if (!userIsOwner && source.guild.id !== message.guild.id && target.guild.id !== message.guild.id) continue;
      const authorized = await authorizeChannels(message, [bridge.sourceChannelId, bridge.targetChannelId], userIsOwner);
      if (authorized.ok) bridges.push(bridge);
    }
    if (!bridges.length) return safeReply(message, `No visible bridges are configured. Use \`${prefix}relay add <source-id> <target-id>\`.`);
    const lines = bridges.map((bridge, index) => `${index + 1}. <#${bridge.sourceChannelId}> → <#${bridge.targetChannelId}>  (\`${bridge.sourceChannelId}\` → \`${bridge.targetChannelId}\`)`);
    return safeReply(message, `**Visible one-way routes (${bridges.length}):**\n${lines.slice(0, 40).join('\n')}${lines.length > 40 ? `\n…and ${lines.length - 40} more.` : ''}`);
  }

  // The bare two-ID form remains compatible with the original repo: ?relay <source> <target>.
  if (subcommand === 'add' || isSnowflake(args[0])) {
    const sourceId = subcommand === 'add' ? args[1] : args[0];
    const targetId = subcommand === 'add' ? args[2] : args[1];
    if (!isSnowflake(sourceId) || !isSnowflake(targetId)) return safeReply(message, `Usage: \`${prefix}relay add <source-channel-id> <target-channel-id>\``);
    if (sourceId === targetId) return safeReply(message, 'Source and target must be different channels.');
    const authorized = await authorizeChannels(message, [sourceId, targetId], userIsOwner);
    if (!authorized.ok) return safeReply(message, authorized.message);
    const validation = await relayManager.validateChannels(sourceId, targetId);
    if (!validation.ok) return safeReply(message, channelValidationMessage(validation.reason));
    const result = store.add(sourceId, targetId, message.author.id);
    if (!result.ok && result.reason === 'exists') return safeReply(message, `That route already exists: <#${sourceId}> → <#${targetId}>.`);
    if (!result.ok) return safeReply(message, 'Invalid route. Check both channel IDs and make sure they differ.');
    return safeReply(message, `Relay started: <#${sourceId}> → <#${targetId}>. It resumes automatically after a bot restart.`);
  }

  if (subcommand === 'bidirectional' || subcommand === 'both') {
    const channelAId = args[1];
    const channelBId = args[2];
    if (!isSnowflake(channelAId) || !isSnowflake(channelBId)) return safeReply(message, `Usage: \`${prefix}relay bidirectional <channel-a-id> <channel-b-id>\``);
    if (channelAId === channelBId) return safeReply(message, 'Choose two different channels.');
    const authorized = await authorizeChannels(message, [channelAId, channelBId], userIsOwner);
    if (!authorized.ok) return safeReply(message, authorized.message);
    const [ab, ba] = await Promise.all([
      relayManager.validateChannels(channelAId, channelBId),
      relayManager.validateChannels(channelBId, channelAId),
    ]);
    if (!ab.ok) return safeReply(message, channelValidationMessage(ab.reason));
    if (!ba.ok) return safeReply(message, channelValidationMessage(ba.reason));
    const result = store.addBidirectional(channelAId, channelBId, message.author.id);
    if (!result.ok && result.reason === 'exists') return safeReply(message, 'At least one direction already exists. Remove the existing route(s) first, then add the bidirectional bridge.');
    if (!result.ok) return safeReply(message, 'Invalid channel pair.');
    return safeReply(message, `Bidirectional relay started: <#${channelAId}> ↔ <#${channelBId}>.`);
  }

  if (subcommand === 'remove') {
    const sourceId = args[1];
    const targetId = args[2];
    if (!isSnowflake(sourceId) || !isSnowflake(targetId)) return safeReply(message, `Usage: \`${prefix}relay remove <source-channel-id> <target-channel-id>\``);
    const authorized = await authorizeChannels(message, [sourceId, targetId], userIsOwner);
    if (!authorized.ok) return safeReply(message, authorized.message);
    const removed = store.remove(sourceId, targetId);
    return safeReply(message, removed ? `Removed route: <#${sourceId}> → <#${targetId}>.` : 'That route was not found.');
  }

  if (subcommand === 'stop') {
    const channelId = args[1] || message.channelId;
    if (!isSnowflake(channelId)) return safeReply(message, `Usage: \`${prefix}relay stop [channel-id]\``);
    const touching = store.list().filter((bridge) => bridge.sourceChannelId === channelId || bridge.targetChannelId === channelId);
    if (!touching.length) return safeReply(message, `No configured routes involve channel \`${channelId}\`.`);
    const ids = [...new Set(touching.flatMap((bridge) => [bridge.sourceChannelId, bridge.targetChannelId]))];
    const authorized = await authorizeChannels(message, ids, userIsOwner);
    if (!authorized.ok) return safeReply(message, authorized.message);
    const removed = store.removeTouching(channelId);
    return safeReply(message, `Stopped ${removed} route(s) involving <#${channelId}>.`);
  }

  return safeReply(message, `Unknown subcommand. Use \`${prefix}relay help\`.`);
}

async function authorizeChannels(message, channelIds, userIsOwner) {
  if (userIsOwner) return { ok: true };
  const guildIds = new Set();
  for (const channelId of channelIds) {
    const channel = await message.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.guild) return { ok: false, message: `I could not access channel \`${channelId}\`. Check the ID and ensure the bot is in that server.` };
    guildIds.add(channel.guild.id);
  }
  for (const guildId of guildIds) {
    const guild = message.client.guilds.cache.get(guildId);
    if (!guild) return { ok: false, message: `I am not currently in server \`${guildId}\`.` };
    const member = guild.id === message.guild.id ? message.member : await guild.members.fetch(message.author.id).catch(() => null);
    if (!member || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return {
        ok: false,
        message: 'For cross-server safety, you need **Manage Server** in every connected server. Trusted global operators can add their user ID to `BRIDGE_OWNER_IDS` in `.env`.',
      };
    }
  }
  return { ok: true };
}

function channelValidationMessage(reason) {
  const messages = {
    source: 'The source ID must be a server text or announcement channel accessible to the bot.',
    target: 'The target ID must be a server text or announcement channel accessible to the bot.',
    'source-permissions': 'The bot needs **View Channel** and **Read Message History** in the source channel.',
    'target-permissions': 'The bot needs **View Channel** and **Send Messages** in the target channel.',
  };
  return messages[reason] || 'Could not validate the channels. Check the IDs and bot permissions.';
}

async function safeReply(message, content) {
  return message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
}

client.on(Events.Error, (error) => console.error('[discord] Client error:', error));
process.on('unhandledRejection', (error) => console.error('[process] Unhandled promise rejection:', error));

async function shutdown(signal) {
  console.log(`[shutdown] Received ${signal}; closing Discord connection.`);
  relayManager.stop();
  client.destroy();
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

client.login(token).catch((error) => {
  console.error('[startup] Discord login failed. Check DISCORD_TOKEN and try again.');
  console.error(error.message || error);
  process.exit(1);
});
