'use strict';

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { buildRelayPayloads, displayName } = require('./message-format');

const WEBHOOK_NAME = 'Discord Chat Bridge';

class RelayManager {
  constructor(client, store, options = {}) {
    this.client = client;
    this.store = store;
    this.prefix = options.prefix || '?';
    this.trackLimit = Math.max(100, Number(options.trackLimit) || 5000);
    this.webhookCache = new Map();
    this.relayedMessages = new Map();
    this._onMessage = (message) => this.handleMessage(message).catch((error) => {
      console.error('[bridge] Failed to relay message:', error);
    });
    this._onMessageUpdate = (oldMessage, newMessage) => this.handleUpdate(oldMessage, newMessage).catch((error) => {
      console.error('[bridge] Failed to update relayed message:', error);
    });
    this._onMessageDelete = (message) => this.handleDelete(message).catch((error) => {
      console.error('[bridge] Failed to delete relayed message:', error);
    });
  }

  start() {
    this.client.on('messageCreate', this._onMessage);
    this.client.on('messageUpdate', this._onMessageUpdate);
    this.client.on('messageDelete', this._onMessageDelete);
    console.log(`[bridge] Loaded ${this.store.list().length} directional bridge(s).`);
  }

  stop() {
    this.client.off('messageCreate', this._onMessage);
    this.client.off('messageUpdate', this._onMessageUpdate);
    this.client.off('messageDelete', this._onMessageDelete);
    this.webhookCache.clear();
    this.relayedMessages.clear();
  }

  getRoutesFrom(sourceChannelId) {
    return this.store.list().filter((bridge) => bridge.sourceChannelId === sourceChannelId);
  }

  isEligibleMessage(message) {
    if (!message || !message.guild || !message.author || message.author.bot || message.webhookId || message.system) return false;
    // Never relay operator commands into linked channels.
    if (message.content?.trimStart().startsWith(this.prefix)) return false;
    return true;
  }

  async handleMessage(message) {
    if (!this.isEligibleMessage(message)) return;
    const routes = this.getRoutesFrom(message.channelId);
    if (!routes.length) return;
    const payloads = buildRelayPayloads(message);
    if (!payloads.length) return;

    const mirrors = [];
    for (const route of routes) {
      try {
        const target = await this.client.channels.fetch(route.targetChannelId);
        if (!this.isGuildTextChannel(target)) {
          console.warn(`[bridge] Target ${route.targetChannelId} is unavailable or not a standard text channel.`);
          continue;
        }
        const botPermissions = target.permissionsFor(this.client.user);
        if (!botPermissions?.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(PermissionFlagsBits.SendMessages)) {
          console.warn(`[bridge] Missing View Channel/Send Messages permission in ${route.targetChannelId}.`);
          continue;
        }

        const webhook = await this.getWebhook(target);
        const targetMessages = [];
        for (const originalPayload of payloads) {
          const payload = { ...originalPayload };
          let sent;
          if (webhook) {
            sent = await webhook.send({
              ...payload,
              username: displayName(message),
              avatarURL: message.author.displayAvatarURL({ size: 128 }),
            });
          } else {
            const prefixText = `**${escapeMarkdown(displayName(message))}**`;
            payload.content = payload.content ? `${prefixText}: ${payload.content}` : prefixText;
            sent = await target.send(payload);
          }
          targetMessages.push({ targetMessageId: sent.id, webhook: webhook || null });
        }
        mirrors.push({ targetChannelId: target.id, webhook: webhook || null, messages: targetMessages });
      } catch (error) {
        console.error(`[bridge] Relay ${route.sourceChannelId} -> ${route.targetChannelId} failed:`, error.message || error);
      }
    }

    if (mirrors.length) {
      this.relayedMessages.set(this.messageKey(message.channelId, message.id), {
        sourceChannelId: message.channelId,
        sourceMessageId: message.id,
        mirrors,
      });
      while (this.relayedMessages.size > this.trackLimit) {
        this.relayedMessages.delete(this.relayedMessages.keys().next().value);
      }
    }
  }

  async handleUpdate(oldMessage, newMessage) {
    if (!newMessage || !newMessage.id || !newMessage.channelId) return;
    const record = this.relayedMessages.get(this.messageKey(newMessage.channelId, newMessage.id));
    if (!record || !newMessage.author || newMessage.author.bot || newMessage.webhookId) return;
    const payloads = buildRelayPayloads(newMessage);

    for (const group of record.mirrors) {
      const target = await this.client.channels.fetch(group.targetChannelId).catch(() => null);
      if (!target) continue;
      for (let index = 0; index < group.messages.length; index += 1) {
        const mirror = group.messages[index];
        try {
          if (index < payloads.length) {
            const payload = { ...payloads[index] };
            if (mirror.webhook) await mirror.webhook.editMessage(mirror.targetMessageId, payload);
            else {
              const prefixText = `**${escapeMarkdown(displayName(newMessage))}**`;
              payload.content = payload.content ? `${prefixText}: ${payload.content}` : prefixText;
              const targetMessage = await target.messages.fetch(mirror.targetMessageId);
              await targetMessage.edit(payload);
            }
          } else {
            await this.deleteMirror(target, mirror);
          }
        } catch (error) {
          console.warn(`[bridge] Could not update mirror ${mirror.targetMessageId}: ${error.message || error}`);
        }
      }
      // If an edit grows beyond the original number of chunks, send the additional chunks.
      for (let index = group.messages.length; index < payloads.length; index += 1) {
        try {
          const payload = { ...payloads[index] };
          const webhook = group.webhook || group.messages[0]?.webhook || null;
          let sent;
          if (webhook) sent = await webhook.send({ ...payload, username: displayName(newMessage), avatarURL: newMessage.author.displayAvatarURL({ size: 128 }) });
          else {
            payload.content = payload.content ? `**${escapeMarkdown(displayName(newMessage))}**: ${payload.content}` : `**${escapeMarkdown(displayName(newMessage))}**`;
            sent = await target.send(payload);
          }
          group.messages.push({ targetMessageId: sent.id, webhook });
        } catch (error) {
          console.warn(`[bridge] Could not add edited message chunk: ${error.message || error}`);
        }
      }
      group.messages = group.messages.slice(0, payloads.length);
    }
  }

  async handleDelete(message) {
    if (!message || !message.id || !message.channelId) return;
    const key = this.messageKey(message.channelId, message.id);
    const record = this.relayedMessages.get(key);
    if (!record) return;
    for (const group of record.mirrors) {
      const target = await this.client.channels.fetch(group.targetChannelId).catch(() => null);
      if (!target) continue;
      for (const mirror of group.messages) {
        try { await this.deleteMirror(target, mirror); }
        catch (error) { console.warn(`[bridge] Could not delete mirror ${mirror.targetMessageId}: ${error.message || error}`); }
      }
    }
    this.relayedMessages.delete(key);
  }

  async deleteMirror(target, mirror) {
    if (mirror.webhook) await mirror.webhook.deleteMessage(mirror.targetMessageId);
    else {
      const targetMessage = await target.messages.fetch(mirror.targetMessageId);
      await targetMessage.delete();
    }
  }

  async getWebhook(channel) {
    if (this.webhookCache.has(channel.id)) return this.webhookCache.get(channel.id);
    const pending = (async () => {
      const permissions = channel.permissionsFor(this.client.user);
      if (!permissions?.has(PermissionFlagsBits.ManageWebhooks)) return null;
      try {
        const webhooks = await channel.fetchWebhooks();
        let webhook = webhooks.find((candidate) => candidate.name === WEBHOOK_NAME && candidate.owner?.id === this.client.user.id);
        if (!webhook) webhook = await channel.createWebhook({ name: WEBHOOK_NAME, reason: 'Create relay identity webhook' });
        return webhook;
      } catch (error) {
        console.warn(`[bridge] Webhook unavailable in ${channel.id}; using bot messages instead: ${error.message || error}`);
        return null;
      }
    })();
    this.webhookCache.set(channel.id, pending);
    const webhook = await pending;
    this.webhookCache.set(channel.id, webhook);
    return webhook;
  }

  async validateChannels(sourceChannelId, targetChannelId) {
    const [source, target] = await Promise.all([
      this.client.channels.fetch(sourceChannelId).catch(() => null),
      this.client.channels.fetch(targetChannelId).catch(() => null),
    ]);
    if (!this.isGuildTextChannel(source)) return { ok: false, reason: 'source' };
    if (!this.isGuildTextChannel(target)) return { ok: false, reason: 'target' };
    const sourcePerms = source.permissionsFor(this.client.user);
    if (!sourcePerms?.has(PermissionFlagsBits.ViewChannel) || !sourcePerms.has(PermissionFlagsBits.ReadMessageHistory)) {
      return { ok: false, reason: 'source-permissions', source, target };
    }
    const targetPerms = target.permissionsFor(this.client.user);
    if (!targetPerms?.has(PermissionFlagsBits.ViewChannel) || !targetPerms.has(PermissionFlagsBits.SendMessages)) {
      return { ok: false, reason: 'target-permissions', source, target };
    }
    return { ok: true, source, target };
  }

  isGuildTextChannel(channel) {
    return Boolean(channel && channel.guild && typeof channel.isTextBased === 'function' && channel.isTextBased() &&
      [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type));
  }

  messageKey(channelId, messageId) {
    return `${channelId}:${messageId}`;
  }
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}\[\]()<>#+\-.!|~]/g, '\\$&');
}

module.exports = { RelayManager, escapeMarkdown, WEBHOOK_NAME };
