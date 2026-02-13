import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TrustScoreService } from '../src/service/index.js';

const TEST_DATA_DIR = resolve(import.meta.dirname, '../.test-data');

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    executor: 'did:atel:agent-executor',
    issuer: 'did:atel:agent-issuer',
    task_id: 'task-001',
    task_type: 'flight_search',
    risk_level: 'medium',
    success: true,
    duration_ms: 1500,
    tool_calls: 3,
    policy_violations: 0,
    proof_id: 'proof-001',
    timestamp: '2026-02-13T00:00:00Z',
    ...overrides,
  };
}

describe('TrustScoreService', () => {
  let service: TrustScoreService;

  beforeAll(async () => {
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
    service = new TrustScoreService({ port: 0, dataDir: TEST_DATA_DIR });
  });

  afterAll(async () => {
    await service.stop();
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  });

  // ── Health ─────────────────────────────────────────────────

  it('GET /api/v1/health returns ok', async () => {
    const res = await request(service.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });

  // ── Submit summary ─────────────────────────────────────────

  it('POST /api/v1/summary creates score report', async () => {
    const res = await request(service.app)
      .post('/api/v1/summary')
      .send(makeSummary());

    expect(res.status).toBe(201);
    expect(res.body.agent_id).toBe('did:atel:agent-executor');
    expect(res.body.trust_score).toBeGreaterThan(0);
    expect(res.body.total_tasks).toBe(1);
    expect(res.body.success_rate).toBe(1);
  });

  it('POST /api/v1/summary validates required fields', async () => {
    const res = await request(service.app)
      .post('/api/v1/summary')
      .send({ executor: 'did:atel:x' }); // missing fields

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('POST /api/v1/summary validates risk_level', async () => {
    const res = await request(service.app)
      .post('/api/v1/summary')
      .send(makeSummary({ risk_level: 'invalid' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('risk_level');
  });

  it('POST /api/v1/summary validates duration_ms', async () => {
    const res = await request(service.app)
      .post('/api/v1/summary')
      .send(makeSummary({ duration_ms: -1 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('duration_ms');
  });

  // ── Query scores ───────────────────────────────────────────

  it('GET /api/v1/score/:agentId returns score report', async () => {
    const res = await request(service.app)
      .get('/api/v1/score/did:atel:agent-executor');

    expect(res.status).toBe(200);
    expect(res.body.agent_id).toBe('did:atel:agent-executor');
    expect(res.body.trust_score).toBeGreaterThan(0);
  });

  it('GET /api/v1/score/:agentId returns zero for unknown agent', async () => {
    const res = await request(service.app)
      .get('/api/v1/score/did:atel:unknown');

    expect(res.status).toBe(200);
    expect(res.body.trust_score).toBe(0);
    expect(res.body.total_tasks).toBe(0);
  });

  it('GET /api/v1/scores returns all scores', async () => {
    const res = await request(service.app).get('/api/v1/scores');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  // ── Graph: composite trust ─────────────────────────────────

  it('POST /api/v1/graph/trust returns composite trust', async () => {
    const res = await request(service.app)
      .post('/api/v1/graph/trust')
      .send({
        from: 'did:atel:agent-issuer',
        to: 'did:atel:agent-executor',
        scene: 'flight_search',
      });

    expect(res.status).toBe(200);
    expect(res.body.trust_score).toBeGreaterThanOrEqual(0);
    expect(res.body.source).toBeDefined();
  });

  it('POST /api/v1/graph/trust validates params', async () => {
    const res = await request(service.app)
      .post('/api/v1/graph/trust')
      .send({ from: 'a' }); // missing to, scene

    expect(res.status).toBe(400);
  });

  // ── Graph: node info ───────────────────────────────────────

  it('GET /api/v1/graph/node/:agentId returns node', async () => {
    const res = await request(service.app)
      .get('/api/v1/graph/node/did:atel:agent-executor');

    expect(res.status).toBe(200);
    expect(res.body.agent_id).toBe('did:atel:agent-executor');
    expect(Array.isArray(res.body.scenes)).toBe(true);
  });

  it('GET /api/v1/graph/node/:agentId returns 404 for unknown', async () => {
    const res = await request(service.app)
      .get('/api/v1/graph/node/did:atel:nonexistent');

    expect(res.status).toBe(404);
  });

  // ── Graph: top partners ────────────────────────────────────

  it('GET /api/v1/graph/partners/:agentId returns partners', async () => {
    const res = await request(service.app)
      .get('/api/v1/graph/partners/did:atel:agent-issuer?k=5');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ── Graph: scene top agents ────────────────────────────────

  it('GET /api/v1/graph/scene/:scene returns top agents', async () => {
    const res = await request(service.app)
      .get('/api/v1/graph/scene/flight_search?k=5');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ── Graph: consistency ─────────────────────────────────────

  it('GET /api/v1/graph/consistency/:agentId returns BCS', async () => {
    const res = await request(service.app)
      .get('/api/v1/graph/consistency/did:atel:agent-issuer');

    expect(res.status).toBe(200);
    expect(typeof res.body.score).toBe('number');
    expect(typeof res.body.suspicious).toBe('boolean');
  });

  // ── Graph: suspicious clusters ─────────────────────────────

  it('GET /api/v1/graph/suspicious returns clusters array', async () => {
    const res = await request(service.app)
      .get('/api/v1/graph/suspicious');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ── Graph: stats ───────────────────────────────────────────

  it('GET /api/v1/graph/stats returns statistics', async () => {
    const res = await request(service.app)
      .get('/api/v1/graph/stats');

    expect(res.status).toBe(200);
    expect(typeof res.body.total_nodes).toBe('number');
    expect(typeof res.body.total_edges).toBe('number');
    expect(Array.isArray(res.body.scenes)).toBe(true);
  });

  // ── Persistence ────────────────────────────────────────────

  it('persists and reloads data correctly', async () => {
    // Submit a few more summaries
    await request(service.app)
      .post('/api/v1/summary')
      .send(makeSummary({ task_id: 'task-persist-1', executor: 'did:atel:persist-agent' }));
    await request(service.app)
      .post('/api/v1/summary')
      .send(makeSummary({ task_id: 'task-persist-2', executor: 'did:atel:persist-agent', success: false }));

    // Verify files exist
    expect(existsSync(resolve(TEST_DATA_DIR, 'scores.json'))).toBe(true);
    expect(existsSync(resolve(TEST_DATA_DIR, 'graph.json'))).toBe(true);

    // Create a new service instance pointing at the same data dir
    const service2 = new TrustScoreService({ port: 0, dataDir: TEST_DATA_DIR });
    // loadData is called in start(), but we can also test it directly
    service2.loadData();

    // Query the reloaded service — should have the persist-agent data
    const res = await request(service2.app)
      .get('/api/v1/score/did:atel:persist-agent');

    expect(res.status).toBe(200);
    expect(res.body.total_tasks).toBe(2);
    expect(res.body.success_rate).toBe(0.5);

    // Graph should also be restored
    const statsRes = await request(service2.app)
      .get('/api/v1/graph/stats');
    expect(statsRes.body.total_nodes).toBeGreaterThanOrEqual(2);
  });
});
