import { describe, it, expect } from 'vitest';
import { MerkleTree, ProofGenerator, ProofVerifier } from '../src/proof/index.js';
import { ExecutionTrace } from '../src/trace/index.js';
import { AgentIdentity } from '../src/identity/index.js';
import { createHash } from 'node:crypto';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

describe('proof', () => {
  describe('MerkleTree', () => {
    it('should build correctly from leaves', () => {
      const leaves = ['aaa', 'bbb', 'ccc', 'ddd'].map((s) => sha256(s));
      const tree = new MerkleTree(leaves);
      expect(tree.getRoot()).toBeTruthy();
      expect(tree.getLeafCount()).toBe(4);
    });

    it('should produce a deterministic root', () => {
      const leaves = ['a', 'b', 'c'].map((s) => sha256(s));
      const tree1 = new MerkleTree(leaves);
      const tree2 = new MerkleTree(leaves);
      expect(tree1.getRoot()).toBe(tree2.getRoot());
    });

    it('should handle a single leaf', () => {
      const leaves = [sha256('only')];
      const tree = new MerkleTree(leaves);
      expect(tree.getRoot()).toBe(leaves[0]);
      expect(tree.getLeafCount()).toBe(1);
    });

    it('should throw on empty leaves', () => {
      expect(() => new MerkleTree([])).toThrow();
    });

    it('should generate and verify a proof for a leaf', () => {
      const leaves = ['a', 'b', 'c', 'd'].map((s) => sha256(s));
      const tree = new MerkleTree(leaves);
      const root = tree.getRoot();

      for (let i = 0; i < leaves.length; i++) {
        const proof = tree.getProof(i);
        expect(MerkleTree.verify(leaves[i], proof, root)).toBe(true);
      }
    });

    it('should fail verification with a tampered leaf', () => {
      const leaves = ['a', 'b', 'c', 'd'].map((s) => sha256(s));
      const tree = new MerkleTree(leaves);
      const root = tree.getRoot();
      const proof = tree.getProof(0);

      const tamperedLeaf = sha256('tampered');
      expect(MerkleTree.verify(tamperedLeaf, proof, root)).toBe(false);
    });

    it('should handle odd number of leaves', () => {
      const leaves = ['a', 'b', 'c'].map((s) => sha256(s));
      const tree = new MerkleTree(leaves);
      const root = tree.getRoot();

      for (let i = 0; i < leaves.length; i++) {
        const proof = tree.getProof(i);
        expect(MerkleTree.verify(leaves[i], proof, root)).toBe(true);
      }
    });

    it('should throw on out-of-bounds proof index', () => {
      const leaves = [sha256('a')];
      const tree = new MerkleTree(leaves);
      expect(() => tree.getProof(1)).toThrow();
      expect(() => tree.getProof(-1)).toThrow();
    });
  });

  describe('ProofGenerator', () => {
    it('should generate a complete ProofBundle', () => {
      const identity = new AgentIdentity();
      const trace = new ExecutionTrace('task-gen', identity);
      trace.append('TASK_ACCEPTED', { info: 'start' });
      trace.append('TOOL_CALL', { tool: 'test' });
      trace.append('TOOL_RESULT', { result: 'ok' });
      trace.finalize({ status: 'success' });

      const gen = new ProofGenerator(trace, identity);
      const bundle = gen.generate(
        sha256('policy-doc'),
        sha256('consent-token'),
        sha256('result-data'),
      );

      expect(bundle.proof_id).toBeTruthy();
      expect(bundle.version).toBe('proof.bundle.v0.1');
      expect(bundle.executor).toBe(identity.did);
      expect(bundle.task_id).toBe('task-gen');
      expect(bundle.trace_root).toBeTruthy();
      expect(bundle.trace_length).toBe(4); // 3 events + TASK_RESULT from finalize
      expect(bundle.policy_ref).toBeTruthy();
      expect(bundle.consent_ref).toBeTruthy();
      expect(bundle.result_ref).toBeTruthy();
      expect(bundle.signature.alg).toBe('Ed25519');
      expect(bundle.signature.sig).toBeTruthy();
      expect(bundle.attestations.length).toBeGreaterThan(0);
    });

    it('should throw on empty trace', () => {
      const identity = new AgentIdentity();
      const trace = new ExecutionTrace('task-empty', identity);
      const gen = new ProofGenerator(trace, identity);
      expect(() => gen.generate('a', 'b', 'c')).toThrow();
    });
  });

  describe('ProofVerifier', () => {
    function makeBundle() {
      const identity = new AgentIdentity();
      const trace = new ExecutionTrace('task-verify', identity);
      trace.append('TASK_ACCEPTED', { info: 'start' });
      trace.append('TOOL_CALL', { tool: 'test' });
      trace.checkpoint();
      trace.append('TOOL_RESULT', { result: 'ok' });
      trace.finalize({ status: 'success' });

      const gen = new ProofGenerator(trace, identity);
      const bundle = gen.generate(
        sha256('policy'),
        sha256('consent'),
        sha256('result'),
      );
      return { bundle, trace, identity };
    }

    it('should verify a valid proof with trace', () => {
      const { bundle, trace } = makeBundle();
      const report = ProofVerifier.verify(bundle, { trace });
      expect(report.valid).toBe(true);
      expect(report.checks.length).toBeGreaterThan(0);
      expect(report.checks.every((c) => c.passed)).toBe(true);
    });

    it('should include all expected check names', () => {
      const { bundle, trace } = makeBundle();
      const report = ProofVerifier.verify(bundle, { trace });
      const checkNames = report.checks.map((c) => c.name);
      expect(checkNames).toContain('structure');
      expect(checkNames).toContain('bundle_signature');
      expect(checkNames).toContain('trace_hash_chain');
      expect(checkNames).toContain('merkle_root');
      expect(checkNames).toContain('checkpoints');
      expect(checkNames).toContain('references');
      expect(checkNames).toContain('trace_length');
    });

    it('should verify without trace (basic checks only)', () => {
      const { bundle } = makeBundle();
      const report = ProofVerifier.verify(bundle);
      expect(report.valid).toBe(true);
      expect(report.summary).toContain('passed');
    });

    it('should fail if references are empty', () => {
      const { bundle, trace } = makeBundle();
      bundle.policy_ref = '';
      const report = ProofVerifier.verify(bundle, { trace });
      const refCheck = report.checks.find((c) => c.name === 'references');
      expect(refCheck!.passed).toBe(false);
    });

    it('should fail when bundle signature is tampered', () => {
      const { bundle, trace } = makeBundle();
      bundle.signature.sig = 'tampered-signature';
      const report = ProofVerifier.verify(bundle, { trace });
      const sigCheck = report.checks.find((c) => c.name === 'bundle_signature');
      expect(sigCheck?.passed).toBe(false);
      expect(report.valid).toBe(false);
    });
  });

  describe('end-to-end: trace → proof → verify', () => {
    it('should complete the full flow successfully', () => {
      const identity = new AgentIdentity();
      const trace = new ExecutionTrace('task-e2e', identity);

      // Simulate execution
      trace.append('TASK_ACCEPTED', { task: 'e2e-test' });
      trace.append('POLICY_CHECK', { action: 'http.get', result: 'allow' });
      trace.append('TOOL_CALL', { tool: 'http.get', url: 'https://example.com' });
      trace.append('TOOL_RESULT', { status: 200, body: 'ok' });
      trace.checkpoint();
      trace.finalize({ status: 'success', output: 'done' });

      // Verify trace integrity
      expect(trace.verify().valid).toBe(true);

      // Generate proof
      const gen = new ProofGenerator(trace, identity);
      const bundle = gen.generate(
        sha256('policy-doc'),
        sha256('consent-token'),
        sha256('task-result'),
      );

      // Verify proof
      const report = ProofVerifier.verify(bundle, { trace });
      expect(report.valid).toBe(true);
      expect(report.summary).toContain('passed');
    });
  });
});
