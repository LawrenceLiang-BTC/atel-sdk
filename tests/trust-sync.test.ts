import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpTrustSyncAdapter } from '../src/trust-sync/index.js';

const sampleSubmission = {
  executor: 'did:atel:exec',
  issuer: 'did:atel:iss',
  task_id: 'task-1',
  task_type: 'test',
  risk_level: 'low' as const,
  success: true,
  duration_ms: 12,
  tool_calls: 1,
  policy_violations: 0,
  proof_id: 'proof-1',
  timestamp: new Date().toISOString(),
};

describe('HttpTrustSyncAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns synced=true on 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ agent_id: 'did:atel:exec', last_updated: 'now' }),
    }));

    const adapter = new HttpTrustSyncAdapter({ baseUrl: 'http://localhost:3100' });
    const result = await adapter.submit(sampleSubmission);
    expect(result.synced).toBe(true);
    expect(result.reference).toBe('did:atel:exec');
  });

  it('returns synced=false on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    }));

    const adapter = new HttpTrustSyncAdapter({ baseUrl: 'http://localhost:3100' });
    const result = await adapter.submit(sampleSubmission);
    expect(result.synced).toBe(false);
    expect(result.detail).toContain('HTTP 500');
  });

  it('returns synced=false when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const adapter = new HttpTrustSyncAdapter({ baseUrl: 'http://localhost:3100' });
    const result = await adapter.submit(sampleSubmission);
    expect(result.synced).toBe(false);
    expect(result.detail).toContain('network down');
  });
});
