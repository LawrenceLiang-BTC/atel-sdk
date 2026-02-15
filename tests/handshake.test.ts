import { describe, it, expect } from 'vitest';
import { AgentIdentity } from '../src/identity/index.js';
import { HandshakeManager, createWalletBundle, verifyWalletBundle } from '../src/handshake/index.js';

describe('Handshake Protocol', () => {
  const alice = new AgentIdentity({ agent_id: 'alice' });
  const bob = new AgentIdentity({ agent_id: 'bob' });

  it('should complete a full handshake with encryption', () => {
    const aliceHs = new HandshakeManager(alice);
    const bobHs = new HandshakeManager(bob);

    // Step 1: Alice creates init (includes X25519 enc key)
    const initMsg = aliceHs.createInit(bob.did);
    expect(initMsg.type).toBe('handshake_init');
    expect(initMsg.payload.encPublicKey).toBeTruthy();

    // Step 2: Bob processes init, creates ack (includes his X25519 enc key)
    const ackMsg = bobHs.processInit(initMsg);
    expect(ackMsg.type).toBe('handshake_ack');
    expect(ackMsg.payload.encPublicKey).toBeTruthy();

    // Step 3: Alice processes ack, creates confirm
    const { confirm, session: aliceSession } = aliceHs.processAck(ackMsg);
    expect(confirm.type).toBe('handshake_confirm');
    expect(aliceSession.remoteDid).toBe(bob.did);
    expect(aliceSession.state).toBe('active');
    expect(aliceSession.encrypted).toBe(true);

    // Step 4: Bob processes confirm
    const bobSession = bobHs.processConfirm(confirm, alice.publicKey);
    expect(bobSession.remoteDid).toBe(alice.did);
    expect(bobSession.state).toBe('active');
    expect(bobSession.encrypted).toBe(true);

    // Both should have active sessions
    expect(aliceHs.hasActiveSession(bob.did)).toBe(true);
    expect(bobHs.hasActiveSession(alice.did)).toBe(true);
  });

  it('should establish E2E encryption during handshake', () => {
    const aliceHs = new HandshakeManager(alice);
    const bobHs = new HandshakeManager(bob);

    const initMsg = aliceHs.createInit(bob.did);
    const ackMsg = bobHs.processInit(initMsg);
    const { confirm } = aliceHs.processAck(ackMsg);
    bobHs.processConfirm(confirm, alice.publicKey);

    // Both should have encryption sessions
    expect(aliceHs.encryption.hasSession(bob.did)).toBe(true);
    expect(bobHs.encryption.hasSession(alice.did)).toBe(true);

    // Alice encrypts, Bob decrypts
    const encrypted = aliceHs.encryption.encryptFor(bob.did, 'secret message');
    const decrypted = bobHs.encryption.decryptFrom(alice.did, encrypted);
    expect(decrypted).toBe('secret message');

    // Bob encrypts, Alice decrypts
    const encrypted2 = bobHs.encryption.encryptFor(alice.did, 'reply secret');
    const decrypted2 = aliceHs.encryption.decryptFrom(bob.did, encrypted2);
    expect(decrypted2).toBe('reply secret');
  });

  it('should reject handshake with wrong challenge response', () => {
    const aliceHs = new HandshakeManager(alice);
    const bobHs = new HandshakeManager(bob);
    const eve = new AgentIdentity({ agent_id: 'eve' });

    const initMsg = aliceHs.createInit(bob.did);
    const ackMsg = bobHs.processInit(initMsg);

    // Tamper with the ack
    const tamperedAck = { ...ackMsg, payload: { ...ackMsg.payload, did: eve.did } };
    expect(() => aliceHs.processAck(tamperedAck as any)).toThrow();
  });

  it('should manage session lifecycle', () => {
    const aliceHs = new HandshakeManager(alice, { sessionTtlSec: 1 });
    const bobHs = new HandshakeManager(bob, { sessionTtlSec: 1 });

    const initMsg = aliceHs.createInit(bob.did);
    const ackMsg = bobHs.processInit(initMsg);
    const { confirm } = aliceHs.processAck(ackMsg);
    bobHs.processConfirm(confirm, alice.publicKey);

    expect(aliceHs.getActiveSessions().length).toBe(1);

    // Terminate session (should also destroy encryption)
    aliceHs.terminateSession(bob.did);
    expect(aliceHs.hasActiveSession(bob.did)).toBe(false);
    expect(aliceHs.encryption.hasSession(bob.did)).toBe(false);
  });

  it('should reject init with mismatched DID and public key', () => {
    const aliceHs = new HandshakeManager(alice);
    const bobHs = new HandshakeManager(bob);

    const initMsg = aliceHs.createInit(bob.did);
    const tampered = {
      ...initMsg,
      payload: {
        ...initMsg.payload,
        publicKey: Buffer.from(bob.publicKey).toString('base64'),
      },
    };

    expect(() => bobHs.processInit(tampered as any)).toThrow();
  });

  it('should work with encryption disabled', () => {
    const aliceHs = new HandshakeManager(alice, { enableEncryption: false });
    const bobHs = new HandshakeManager(bob, { enableEncryption: false });

    const initMsg = aliceHs.createInit(bob.did);
    const ackMsg = bobHs.processInit(initMsg);
    const { session: aliceSession } = aliceHs.processAck(ackMsg);

    // Session should work but not be encrypted
    expect(aliceSession.state).toBe('active');
    expect(aliceSession.encrypted).toBe(false);
  });

  describe('wallet bundle verification', () => {
    it('should verify wallet ownership via DID signature', () => {
      const aliceWallets = { solana: 'ALiCe1234567890abcdef', base: '0xAlice1234' };
      const bobWallets = { solana: 'BoB1234567890abcdef', bsc: '0xBob5678' };

      const aliceHs = new HandshakeManager(alice);
      const bobHs = new HandshakeManager(bob);

      const initMsg = aliceHs.createInit(bob.did, aliceWallets);
      expect(initMsg.payload.walletBundle).toBeDefined();
      expect(initMsg.payload.walletBundle!.proof).toBeTruthy();

      const ackMsg = bobHs.processInit(initMsg, bobWallets);
      expect(ackMsg.payload.walletBundle).toBeDefined();

      const { session: aliceSession } = aliceHs.processAck(ackMsg);
      expect(aliceSession.remoteWallets).toEqual(bobWallets);
      expect(aliceSession.remoteWalletsVerified).toBe(true);
    });

    it('should detect tampered wallet addresses', () => {
      const wallets = { solana: 'MyRealWallet123' };
      const bundle = createWalletBundle(wallets, alice.secretKey);

      // Tamper with the address
      const tampered = { ...bundle, addresses: { solana: 'FakeWallet999' } };
      expect(verifyWalletBundle(tampered, alice.publicKey)).toBe(false);

      // Original should verify
      expect(verifyWalletBundle(bundle, alice.publicKey)).toBe(true);
    });

    it('should set remoteWalletsVerified=false when no bundle provided', () => {
      const aliceHs = new HandshakeManager(alice);
      const bobHs = new HandshakeManager(bob);

      const initMsg = aliceHs.createInit(bob.did); // no wallets
      const ackMsg = bobHs.processInit(initMsg);
      const { session } = aliceHs.processAck(ackMsg);

      expect(session.remoteWalletsVerified).toBe(false);
    });
  });
});
