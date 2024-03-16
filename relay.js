const { WebhookClient, MessageEmbed } = require('discord.js');

// Create a map to store active relaying collector
const activeRelayCollector = new Map();
// Create a map to store webhook timers
const webhookTimers = new Map();
const webhookTimerDuration = 30 * 60 * 1000; // 30 minutes in milliseconds

module.exports = {
  name: 'relay',
  aliases: [],
  cooldowns: 3000,
  description: 'Relay messages from one channel to another',
  usage: '?relay <source-channel-id> <target-channel-id> OR ?relay stop',
  toggleOff: false,
  developersOnly: false,
  userPermissions: ['ADMINISTRATOR'],
  botPermissions: ['SEND_MESSAGES'],

  run: async (client, message, args) => {
    if (args.length === 2) {
      return startRelay(client, message, args);
    } else if (args[0] === 'stop') {
      return stopRelay(client, message);
    } else {
      return message.channel.send('Invalid command format. Usage: `' + module.exports.usage + '`');
    }
  },
};

// Create a function to replace mentions with plain text
function replaceMentions(text, message) {
  // Replace user mentions (e.g., @user)
  text = text.replace(/<@!?\d+>/g, (match) => {
    const userId = match.replace(/<@!?(\d+)>/, '$1');
    const user = message.guild.members.cache.get(userId);
    if (user) {
      return `@${user.displayName}`;
    } else {
      return `@UnknownUser`;
    }
  });

  // Replace @everyone and @here
  text = text.replace(/@(everyone|here)/g, '$1');

  return text;
}

async function createWebhook(client, channelId) {
  const targetChannel = client.channels.cache.get(channelId);

  if (!targetChannel) {
    return null;
  }

  try {
    const webhooks = await targetChannel.fetchWebhooks();
    if (webhooks.size > 0) {
      return webhooks.first();
    }

    const webhook = await targetChannel.createWebhook('Relay Bot');
    return webhook;
  } catch (error) {
    console.error('Failed to create/get webhook:', error);
    return null;
  }
}

async function startRelay(client, message, args) {
  const sourceChannelId = args[0];
  const targetChannelId = args[1];

  const sourceChannel = client.channels.cache.get(sourceChannelId);
  const targetChannel = client.channels.cache.get(targetChannelId);

  if (!sourceChannel || !targetChannel) {
    return message.channel.send('Invalid channel ID provided.');
  }

  if (activeRelayCollector.has(targetChannelId)) {
    return message.channel.send(`Relaying to <#${targetChannelId}> is already active.`);
  }

  const webhook = await createWebhook(client, targetChannelId);

  if (!webhook) {
    return message.channel.send('Failed to start relaying. Could not create/get a webhook.');
  }

  // Initialize lastRelayedTime for this channel
  const currentTime = Date.now();
  webhookTimers.set(targetChannelId, currentTime);

  const collector = sourceChannel.createMessageCollector({});
  collector.on('collect', (sourceMessage) => {
    const serializedMessage = sourceMessage.toJSON();
    serializedMessage.username = sourceMessage.author.username;
    serializedMessage.avatarURL = sourceMessage.author.avatarURL();

    const messageOptions = {
      username: serializedMessage.username,
      avatarURL: serializedMessage.avatarURL,
    };

    // Check for message content (a non-empty string)
    if (serializedMessage.content) {
      messageOptions.content = replaceMentions(serializedMessage.content, sourceMessage);
    }

    // Check for message attachments (images, videos, gifs, files)
    if (sourceMessage.attachments.size > 0) {
      messageOptions.files = sourceMessage.attachments.map((attachment) => ({
        attachment: attachment.url,
        name: attachment.name,
      }));
    }

    // Check for message embeds
    if (sourceMessage.embeds.length > 0) {
      messageOptions.embeds = sourceMessage.embeds.map((embed) =>
        new MessageEmbed(embed)
      );
    }

    // Send the message only if there's content, images, videos, gifs, or emojis
    if (
      messageOptions.content ||
      messageOptions.files ||
      messageOptions.embeds ||
      serializedMessage.content.includes('<:') // Check for emojis
    ) {
      webhook.send(messageOptions).catch((error) => {
        console.error('Failed to send message through webhook:', error);
      });

      // Update lastRelayedTime for this channel
      webhookTimers.set(targetChannelId, currentTime);
    }
  });

  activeRelayCollector.set(targetChannelId, collector);
  message.channel.send(`Started relaying messages from <#${sourceChannelId}> to <#${targetChannelId}>.`);
}

function stopRelay(client, message) {
  const targetChannelId = message.channel.id;

  if (!activeRelayCollector.has(targetChannelId)) {
    return message.channel.send(`No active relaying to stop for <#${targetChannelId}>.`);
  }

  const collector = activeRelayCollector.get(targetChannelId);
  collector.stop();
  activeRelayCollector.delete(targetChannelId);

  message.channel.send(`Stopped relaying messages to <#${targetChannelId}>.`);
}
