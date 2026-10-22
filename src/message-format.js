'use strict';

const MAX_MESSAGE_LENGTH = 1900;

function sanitizeMentionText(content, message) {
  let text = String(content || '');
  text = text.replace(/<@!?(\d+)>/g, (match, userId) => {
    const user = message.mentions?.users?.get(userId);
    return user ? `@${user.globalName || user.username}` : '@user';
  });
  text = text.replace(/<@&(\d+)>/g, (match, roleId) => {
    const role = message.mentions?.roles?.get(roleId);
    return role ? `@${role.name}` : '@role';
  });
  text = text.replace(/<#(\d+)>/g, (match, channelId) => {
    const channel = message.mentions?.channels?.get(channelId);
    return channel ? `#${channel.name}` : '#channel';
  });
  return text.replace(/@(everyone|here)/gi, '@\u200b$1');
}

function splitText(text, maxLength = MAX_MESSAGE_LENGTH) {
  if (!text) return [];
  const chunks = [];
  let remainder = text;
  while (remainder.length > maxLength) {
    let splitAt = remainder.lastIndexOf('\n', maxLength - 1);
    if (splitAt < Math.floor(maxLength * 0.55)) splitAt = remainder.lastIndexOf(' ', maxLength - 1);
    if (splitAt < Math.floor(maxLength * 0.55)) splitAt = maxLength;
    chunks.push(remainder.slice(0, splitAt));
    remainder = remainder.slice(splitAt);
  }
  if (remainder.length) chunks.push(remainder);
  return chunks;
}

function displayName(message) {
  const name = message.member?.displayName || message.author?.globalName || message.author?.username || 'Unknown user';
  return name.replace(/[\r\n]/g, ' ').slice(0, 80) || 'Unknown user';
}

function buildRelayPayloads(message) {
  const bodyParts = [];
  const sanitizedContent = sanitizeMentionText(message.content, message);
  if (sanitizedContent.trim()) bodyParts.push(sanitizedContent);
  if (message.attachments?.size) {
    for (const attachment of message.attachments.values()) {
      const name = String(attachment.name || 'Attachment').replace(/[\r\n]/g, ' ').slice(0, 150);
      bodyParts.push(`${name}: ${attachment.url}`);
    }
  }
  const chunks = splitText(bodyParts.join('\n'));
  const embeds = (message.embeds || []).slice(0, 10).map((embed) => {
    try { return typeof embed.toJSON === 'function' ? embed.toJSON() : embed; } catch { return null; }
  }).filter(Boolean);
  if (chunks.length === 0 && embeds.length === 0) return [];
  if (chunks.length === 0) return [{ embeds, allowedMentions: { parse: [], repliedUser: false } }];
  return chunks.map((content, index) => ({
    content: content || undefined,
    embeds: index === 0 ? embeds : [],
    allowedMentions: { parse: [], repliedUser: false },
  }));
}

module.exports = { MAX_MESSAGE_LENGTH, sanitizeMentionText, splitText, displayName, buildRelayPayloads };
