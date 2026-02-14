/**
 * Registry Client tests
 *
 * Uses a minimal Express mock server to test RegistryClient
 * without depending on RegistryService (which is server-side only).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { AgentIdentity, parseDID, verify as verifySig, serializePayload } from '../src/identity/index.js';
import { RegistryClient, type RegistryEntry, type SignedRequest } from '../src/registry/index.js';

// ─── Minimal Mock Registry ──────────────────────────────────────

function createMockRegistry(adminDids: string[]) {
  const app = express();
  app.use(express.json());
  const entries = new Map<string, RegistryEntry>();
  const adminSet = new Set(adminDids);

  function verifyReq(signed: SignedRequest): { valid: boolean; error?: string } {
    const reqTime = new Date(signed.timestamp).getTime();
    const now = Date.now();
    if (isNaN(reqTime) || now - reqTime > 300_000) return { valid: false, error: 'Expired' };
    let pk: Uint8Array;
    try { pk = parseDID(signed.did); } catch { return { valid: false, error: 'Bad DID' }; }
    const signable = serializePayload({ payload: signed.payload, did: signed.did, timestamp: signed.timestamp });
    if (!verifySig(signable, signed.signature, pk)) return { valid: false, error: 'Bad sig' };
    return { valid: true };
  }

  app.post('/registry/v1/register', (req, res) => {
    const signed = req.body as SignedRequest<Partial<RegistryEntry>>;
    const auth = verifyReq(signed);
    if (!auth.valid) { res.status(401).json({ error: auth.error }); return; }
    const body = signed.payload;
    if (!body.name || !body.endpoint || !body.capabilities) {
      res.status(400).json({ error: 'Missing fields' }); return;
    }
    const did = signed.did;
    const existing = entries.get(did);
    const entry: RegistryEntry = {
      did, name: body.name, description: body.description,
      capabilities: body.capabilities!, endpoint: body.endpoint,
      trustScore: existing?.trustScore ?? 0,
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
      lastSeen: new Date().toISOString(), verified: existing?.verified ?? false,
      metadata: body.metadata,
    };
    entries.set(did, entry);
    res.status(existing ? 200 : 201).json(entry);
  });

  app.get('/registry/v1/search', (req, res) => {
    let results = [...entries.values()];
    const type = req.query.type as string | undefined;
    if (type) results = results.filter(e => e.capabilities.some(c => c.type === type));
    const minScore = req.query.minScore ? parseFloat(req.query.minScore as string) : undefined;
    if (minScore !== undefined) results = results.filter(e => e.trustScore >= minScore);
    if (req.query.verifiedOnly === 'true') results = results.filter(e => e.verified);
    results.sort((a, b) => b.trustScore - a.trustScore);
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    results = results.slice(0, limit);
    res.json({ count: results.length, agents: results });
  });

  app.get('/registry/v1/agent/:did', (req, res) => {
    const did = decodeURIComponent(req.params.did as string);
    const entry = entries.get(did);
    if (!entry) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(entry);
  });

  app.post('/registry/v1/heartbeat', (req, res) => {
    const signed = req.body as SignedRequest<{ did: string }>;
    const auth = verifyReq(signed);
    if (!auth.valid) { res.status(401).json({ error: auth.error }); return; }
    const entry = entries.get(signed.did);
    if (!entry) { res.status(404).json({ error: 'Not registered' }); return; }
    entry.lastSeen = new Date().toISOString();
    res.json({ status: 'ok' });
  });

  app.post('/registry/v1/score/update', (req, res) => {
    const signed = req.body as SignedRequest<{ did: string; trustScore: number }>;
    const auth = verifyReq(signed);
    if (!auth.valid) { res.status(401).json({ error: auth.error }); return; }
    if (!adminSet.has(signed.did)) { res.status(403).json({ error: 'Not admin' }); return; }
    const entry = entries.get(signed.payload.did);
    if (!entry) { res.status(404).json({ error: 'Not found' }); return; }
    entry.trustScore = signed.payload.trustScore;
    res.json({ status: 'ok', trustScore: entry.trustScore });
  });

  app.post('/registry/v1/verify', (req, res) => {
    const signed = req.body as SignedRequest<{ did: string; verified: boolean }>;
    const auth = verifyReq(signed);
    if (!auth.valid) { res.status(401).json({ error: auth.error }); return; }
    if (!adminSet.has(signed.did)) { res.status(403).json({ error: 'Not admin' }); return; }
    const entry = entries.get(signed.payload.did);
    if (!entry) { res.status(404).json({ error: 'Not found' }); return; }
    entry.verified = signed.payload.verified;
    res.json({ status: 'ok', verified: entry.verified });
  });

  app.delete('/registry/v1/agent/:did', (req, res) => {
    const did = decodeURIComponent(req.params.did as string);
    const signed = req.body as SignedRequest<{}>;
    if (!signed.signature) { res.status(401).json({ error: 'Need sig' }); return; }
    const auth = verifyReq(signed);
    if (!auth.valid) { res.status(401).json({ error: auth.error }); return; }
    if (signed.did !== did && !adminSet.has(signed.did)) {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    if (!entries.has(did)) { res.status(404).json({ error: 'Not found' }); return; }
    entries.delete(did);
    res.json({ status: 'removed' });
  });

  app.get('/registry/v1/stats', (_req, res) => {
    const caps = new Set<string>();
    for (const e of entries.values()) for (const c of e.capabilities) caps.add(c.type);
    res.json({
      totalAgents: entries.size,
      verifiedAgents: [...entries.values()].filter(e => e.verified).length,
      capabilityTypes: [...caps],
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('Agent Registry (Authenticated)', () => {
  let server: Server;
  let client: RegistryClient;
  const PORT = 13200 + Math.floor(Math.random() * 1000);

  const admin = new AgentIdentity({ agent_id: 'admin' });
  const agent1 = new AgentIdentity({ agent_id: 'agent1' });
  const agent2 = new AgentIdentity({ agent_id: 'agent2' });
  const agent3 = new AgentIdentity({ agent_id: 'agent3' });

  beforeAll(async () => {
    const app = createMockRegistry([admin.did]);
    server = app.listen(PORT);
    client = new RegistryClient({ registryUrl: `http://localhost:${PORT}` });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('should register an agent with DID signature', async () => {
    const entry = await client.register(
      {
        name: 'Flight Search Agent',
        capabilities: [{ type: 'flight_search', description: 'Search flights' }],
        endpoint: 'http://localhost:3001',
      },
      agent1,
    );
    expect(entry.did).toBe(agent1.did);
    expect(entry.name).toBe('Flight Search Agent');
    expect(entry.trustScore).toBe(0);
    expect(entry.verified).toBe(false);
  });

  it('should register multiple agents', async () => {
    await client.register(
      {
        name: 'Hotel Booking Agent',
        capabilities: [
          { type: 'hotel_booking', description: 'Book hotels' },
          { type: 'flight_search', description: 'Also searches flights' },
        ],
        endpoint: 'http://localhost:3002',
      },
      agent2,
    );
    await client.register(
      {
        name: 'Weather Agent',
        capabilities: [{ type: 'weather', description: 'Weather forecasts' }],
        endpoint: 'http://localhost:3003',
      },
      agent3,
    );
    const stats = await client.stats();
    expect(stats.totalAgents).toBe(3);
  });

  it('should search by capability type', async () => {
    const result = await client.search({ type: 'flight_search' });
    expect(result.count).toBe(2);
  });

  it('should get a specific agent', async () => {
    const entry = await client.getAgent(agent1.did);
    expect(entry.name).toBe('Flight Search Agent');
  });

  it('should send heartbeat', async () => {
    await client.heartbeat(agent1);
    const entry = await client.getAgent(agent1.did);
    expect(entry.lastSeen).toBeDefined();
  });

  it('should search with minScore filter', async () => {
    const result = await client.search({ minScore: 50 });
    expect(result.count).toBe(0);
  });

  it('should return stats', async () => {
    const stats = await client.stats();
    expect(stats.totalAgents).toBe(3);
    expect(stats.capabilityTypes).toContain('flight_search');
    expect(stats.capabilityTypes).toContain('hotel_booking');
    expect(stats.capabilityTypes).toContain('weather');
  });

  it('should unregister an agent', async () => {
    await client.unregister(agent3);
    const stats = await client.stats();
    expect(stats.totalAgents).toBe(2);
  });

  it('should return 404 for unregistered agent', async () => {
    await expect(client.getAgent(agent3.did)).rejects.toThrow();
  });

  it('should update agent registration', async () => {
    const updated = await client.register(
      {
        name: 'Flight Search Agent v2',
        capabilities: [
          { type: 'flight_search', description: 'Search flights v2' },
          { type: 'car_rental', description: 'Rent cars' },
        ],
        endpoint: 'http://localhost:3001',
      },
      agent1,
    );
    expect(updated.name).toBe('Flight Search Agent v2');
    expect(updated.capabilities).toHaveLength(2);
  });

  it('should search with verifiedOnly filter', async () => {
    const result = await client.search({ verifiedOnly: true });
    expect(result.count).toBe(0);
  });
});
