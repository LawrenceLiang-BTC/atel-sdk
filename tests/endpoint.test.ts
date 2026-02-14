import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentIdentity } from '../src/identity/index.js';
import { AgentEndpoint, AgentClient } from '../src/endpoint/index.js';
import { HandshakeManager } from '../src/handshake/index.js';
import { createMessage } from '../src/envelope/index.js';

describe('Agent Endpoint & Client', () => {
  const alice = new AgentIdentity({ agent_id: 'alice' });
  const bob = new AgentIdentity({ agent_id: 'bob' });

  let bobEndpoint: AgentEndpoint;
  const BOB_PORT = 13100 + Math.floor(Math.random() * 1000);
  const BOB_URL = `http://localhost:${BOB_PORT}`;

  beforeAll(async () => {
    bobEndpoint = new AgentEndpoint(bob, {
      port: BOB_PORT,
      host: 'localhost',
    });

    bobEndpoint.onTask(async (message) => {
      return { status: 'executed', taskData: message.payload };
    });

    await bobEndpoint.start();
  });

  afterAll(async () => {
    await bobEndpoint.stop();
  });

  it('should respond to health check with security info', async () => {
    const client = new AgentClient(alice);
    const health = await client.health(BOB_URL) as any;

    expect(health.status).toBe('ok');
    expect(health.did).toBe(bob.did);
    expect(health.encryption).toBe(true);
  });

  it('should perform a full handshake with encryption via HTTP', async () => {
    const client = new AgentClient(alice);
    const aliceHandshake = new HandshakeManager(alice);

    const session = await client.handshake(BOB_URL, aliceHandshake, bob.did);

    expect(session.remoteDid).toBe(bob.did);
    expect(session.state).toBe('active');
    expect(session.encrypted).toBe(true);
  });

  it('should send and receive a task delegation', async () => {
    const client = new AgentClient(alice);

    const taskMsg = createMessage({
      type: 'task_delegate',
      from: alice.did,
      to: bob.did,
      payload: { intent: 'search_flights', destination: 'Tokyo' },
      secretKey: alice.secretKey,
    });

    const result = await client.sendTask(BOB_URL, taskMsg) as any;
    expect(result.status).toBe('accepted');
    expect(result.result.status).toBe('executed');
  });

  it('should send encrypted task after handshake', async () => {
    const client = new AgentClient(alice);
    const aliceHandshake = new HandshakeManager(alice);

    // Handshake first
    await client.handshake(BOB_URL, aliceHandshake, bob.did);

    // Send encrypted task
    const taskMsg = createMessage({
      type: 'task_delegate',
      from: alice.did,
      to: bob.did,
      payload: { intent: 'book_hotel', city: 'Tokyo', secret: 'credit_card_info' },
      secretKey: alice.secretKey,
    });

    const result = await client.sendTask(BOB_URL, taskMsg, aliceHandshake) as any;
    expect(result.status).toBe('accepted');
  });

  it('should reject messages with invalid signatures', async () => {
    const eve = new AgentIdentity({ agent_id: 'eve' });

    const fakeMsg = createMessage({
      type: 'task_delegate',
      from: alice.did,
      to: bob.did,
      payload: { intent: 'malicious' },
      secretKey: eve.secretKey,
    });

    const response = await fetch(`${BOB_URL}/atel/v1/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fakeMsg),
    });

    expect(response.status).toBe(401);
  });

  it('should reject replay attacks', async () => {
    const taskMsg = createMessage({
      type: 'task_delegate',
      from: alice.did,
      to: bob.did,
      payload: { intent: 'test' },
      secretKey: alice.secretKey,
    });

    // First request succeeds
    const res1 = await fetch(`${BOB_URL}/atel/v1/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskMsg),
    });
    expect(res1.status).toBe(200);

    // Same message again (replay) should be rejected
    const res2 = await fetch(`${BOB_URL}/atel/v1/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskMsg),
    });
    expect(res2.status).toBe(401);
    const body = await res2.json() as any;
    expect(body.error).toContain('Replay');
  });
});
