'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SNOWFLAKE_PATTERN = /^\d{15,22}$/;
function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE_PATTERN.test(value);
}

function normalizeBridge(bridge) {
  if (!bridge || !isSnowflake(bridge.sourceChannelId) || !isSnowflake(bridge.targetChannelId)) return null;
  if (bridge.sourceChannelId === bridge.targetChannelId) return null;
  return {
    sourceChannelId: bridge.sourceChannelId,
    targetChannelId: bridge.targetChannelId,
    createdAt: typeof bridge.createdAt === 'string' ? bridge.createdAt : new Date(0).toISOString(),
    createdBy: typeof bridge.createdBy === 'string' ? bridge.createdBy : 'unknown',
  };
}

class BridgeStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.bridges = [];
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.bridges = [];
      this.save();
      return this.list();
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new Error(`Could not parse bridge configuration at ${this.filePath}: ${error.message}`);
    }
    if (!parsed || !Array.isArray(parsed.bridges)) {
      throw new Error(`Invalid bridge configuration at ${this.filePath}: expected a "bridges" array.`);
    }
    const unique = new Map();
    for (const candidate of parsed.bridges) {
      const bridge = normalizeBridge(candidate);
      if (bridge) unique.set(this.key(bridge.sourceChannelId, bridge.targetChannelId), bridge);
    }
    this.bridges = [...unique.values()];
    return this.list();
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    const data = `${JSON.stringify({ version: 1, bridges: this.bridges }, null, 2)}\n`;
    fs.writeFileSync(temporaryPath, data, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  key(sourceChannelId, targetChannelId) {
    return `${sourceChannelId}:${targetChannelId}`;
  }

  list() {
    return this.bridges.map((bridge) => ({ ...bridge }));
  }

  has(sourceChannelId, targetChannelId) {
    return this.bridges.some((bridge) => bridge.sourceChannelId === sourceChannelId && bridge.targetChannelId === targetChannelId);
  }

  add(sourceChannelId, targetChannelId, createdBy = 'unknown') {
    const normalized = normalizeBridge({ sourceChannelId, targetChannelId, createdBy, createdAt: new Date().toISOString() });
    if (!normalized) return { ok: false, reason: 'invalid' };
    if (this.has(sourceChannelId, targetChannelId)) return { ok: false, reason: 'exists' };
    this.bridges.push(normalized);
    this.save();
    return { ok: true, bridge: { ...normalized } };
  }

  addBidirectional(channelAId, channelBId, createdBy = 'unknown') {
    if (!isSnowflake(channelAId) || !isSnowflake(channelBId) || channelAId === channelBId) return { ok: false, reason: 'invalid' };
    if (this.has(channelAId, channelBId) || this.has(channelBId, channelAId)) return { ok: false, reason: 'exists' };
    const createdAt = new Date().toISOString();
    this.bridges.push(
      { sourceChannelId: channelAId, targetChannelId: channelBId, createdBy, createdAt },
      { sourceChannelId: channelBId, targetChannelId: channelAId, createdBy, createdAt },
    );
    this.save();
    return { ok: true };
  }

  remove(sourceChannelId, targetChannelId) {
    const index = this.bridges.findIndex((bridge) => bridge.sourceChannelId === sourceChannelId && bridge.targetChannelId === targetChannelId);
    if (index === -1) return false;
    this.bridges.splice(index, 1);
    this.save();
    return true;
  }

  removeBidirectional(channelAId, channelBId) {
    const before = this.bridges.length;
    this.bridges = this.bridges.filter((bridge) => !(
      (bridge.sourceChannelId === channelAId && bridge.targetChannelId === channelBId) ||
      (bridge.sourceChannelId === channelBId && bridge.targetChannelId === channelAId)
    ));
    if (this.bridges.length !== before) this.save();
    return before - this.bridges.length;
  }

  removeTouching(channelId) {
    const before = this.bridges.length;
    this.bridges = this.bridges.filter((bridge) => bridge.sourceChannelId !== channelId && bridge.targetChannelId !== channelId);
    if (this.bridges.length !== before) this.save();
    return before - this.bridges.length;
  }
}

module.exports = { BridgeStore, isSnowflake };
