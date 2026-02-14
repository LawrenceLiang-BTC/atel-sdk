#!/usr/bin/env node

/**
 * Tunnel Manager — Auto-reconnect localtunnel/ngrok with registry updates
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { serializePayload } from '@lawrenceliang-btc/atel-sdk';

export class TunnelManager extends EventEmitter {
  constructor(type, port, registryClient, identity) {
    super();
    this.type = type; // 'localtunnel' or 'ngrok'
    this.port = port;
    this.registryClient = registryClient;
    this.identity = identity;
    this.process = null;
    this.currentUrl = null;
    this.reconnectDelay = 5000;
    this.running = false;
  }

  async start() {
    this.running = true;
    await this.startTunnel();
  }

  async stop() {
    this.running = false;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  async startTunnel() {
    if (!this.running) return;

    const cmd = this.type === 'localtunnel' ? 'lt' : 'ngrok';
    const args = this.type === 'localtunnel' 
      ? ['--port', this.port.toString()]
      : ['http', this.port.toString()];

    console.log(`[Tunnel] Starting ${this.type}...`);
    this.process = spawn(cmd, args);

    this.process.stdout.on('data', async (data) => {
      const output = data.toString();
      
      // Parse URL from output
      let url = null;
      if (this.type === 'localtunnel') {
        const match = output.match(/your url is: (https:\/\/[^\s]+)/);
        if (match) url = match[1];
      } else if (this.type === 'ngrok') {
        const match = output.match(/url=(https:\/\/[^\s]+)/);
        if (match) url = match[1];
      }

      if (url && url !== this.currentUrl) {
        this.currentUrl = url;
        console.log(`[Tunnel] URL: ${url}`);
        this.emit('url', url);
        
        // Update registry
        try {
          await this.updateRegistry(url);
          console.log(`[Tunnel] Registry updated`);
        } catch (e) {
          console.error(`[Tunnel] Registry update failed:`, e.message);
        }
      }
    });

    this.process.stderr.on('data', (data) => {
      console.error(`[Tunnel] Error: ${data}`);
    });

    this.process.on('exit', async (code) => {
      console.log(`[Tunnel] Process exited with code ${code}`);
      this.process = null;
      this.currentUrl = null;

      if (this.running) {
        console.log(`[Tunnel] Reconnecting in ${this.reconnectDelay}ms...`);
        await new Promise(r => setTimeout(r, this.reconnectDelay));
        await this.startTunnel();
      }
    });
  }

  async updateRegistry(url) {
    // Get current capabilities from registry or use defaults
    const caps = [
      { type: 'general', description: 'general' },
      { type: 'coding', description: 'coding' },
      { type: 'research', description: 'research' },
      { type: 'translation', description: 'translation' }
    ];

    await this.registryClient.register({
      name: this.identity.agent_id,
      capabilities: caps,
      endpoint: url,
      candidates: [
        { type: 'direct', url, priority: 100 },
        { type: 'relay', url: 'http://47.251.8.19:9000', priority: 10 }
      ]
    }, this.identity);
  }

  getUrl() {
    return this.currentUrl;
  }
}

export class HeartbeatManager {
  constructor(registryUrl, identity) {
    this.registryUrl = registryUrl;
    this.identity = identity;
    this.interval = null;
    this.intervalMs = 60000; // 60 seconds
  }

  start() {
    this.sendHeartbeat(); // Send immediately
    this.interval = setInterval(() => this.sendHeartbeat(), this.intervalMs);
    console.log(`[Heartbeat] Started (every ${this.intervalMs / 1000}s)`);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log(`[Heartbeat] Stopped`);
    }
  }

  async sendHeartbeat() {
    try {
      const timestamp = new Date().toISOString();
      const payload = { did: this.identity.did };
      
      // Sign the request - sign the serialized payload
      const { default: nacl } = await import('tweetnacl');
      const signable = serializePayload({ payload, did: this.identity.did, timestamp });
      const signableBytes = new TextEncoder().encode(signable);
      const signature = Buffer.from(
        nacl.sign.detached(signableBytes, this.identity.secretKey)
      ).toString('base64');

      const resp = await fetch(`${this.registryUrl}/registry/v1/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload, did: this.identity.did, timestamp, signature }),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        console.error(`[Heartbeat] Failed: ${resp.status} ${await resp.text()}`);
      }
    } catch (e) {
      console.error(`[Heartbeat] Error:`, e.message);
    }
  }
}
