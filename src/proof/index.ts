/**
 * Module 6: Execution Proof & Verify
 *
 * Generates and verifies Merkle-tree-based execution proofs.
 * A ProofBundle ties together the trace, policy, consent, and result
 * into a single cryptographically signed attestation.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { AgentIdentity } from '../identity/index.js';
import { parseDID, verify as verifySignature } from '../identity/index.js';
import type {
  ExecutionTrace,
} from '../trace/index.js';

// ─── Proof Types ─────────────────────────────────────────────────

/** A Merkle proof path entry */
export interface MerkleProofStep {
  /** The sibling hash */
  hash: string;
  /** Which side the sibling is on */
  position: 'left' | 'right';
}

/** The complete proof bundle */
export interface ProofBundle {
  /** Unique proof identifier */
  proof_id: string;
  /** Bundle format version */
  version: string;
  /** Executor DID */
  executor: string;
  /** Task identifier */
  task_id: string;
  /** Merkle root of all trace event hashes */
  trace_root: string;
  /** Total number of events in the trace */
  trace_length: number;
  /** Extracted checkpoint summaries */
  checkpoints: Array<{
    seq: number;
    hash: string;
    sig: string;
  }>;
  /** SHA-256 of the policy document */
  policy_ref: string;
  /** SHA-256 of the consent token */
  consent_ref: string;
  /** SHA-256 of the task result */
  result_ref: string;
  /** Additional attestations */
  attestations: Array<{
    type: string;
    value: string;
  }>;
  /** ISO 8601 creation timestamp */
  created_at: string;
  /** Signature over the bundle */
  signature: {
    alg: string;
    sig: string;
  };
}

/** Verification report returned by ProofVerifier */
export interface VerifyReport {
  /** Overall validity */
  valid: boolean;
  /** Individual check results */
  checks: Array<{
    name: string;
    passed: boolean;
    detail?: string;
  }>;
  /** Human-readable summary */
  summary: string;
}

// ─── Hash Helper ─────────────────────────────────────────────────

/**
 * Compute SHA-256 of a UTF-8 string.
 *
 * @param input - The string to hash.
 * @returns Hex-encoded SHA-256 digest.
 */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

// ─── Merkle Tree ─────────────────────────────────────────────────

/**
 * Binary Merkle Tree built from an array of leaf hashes.
 *
 * Odd layers are handled by duplicating the last leaf.
 * Supports root computation, proof generation, and static verification.
 */
export class MerkleTree {
  /** All layers of the tree, from leaves (index 0) to root */
  private readonly layers: string[][];

  /**
   * Build a Merkle tree from leaf hashes.
   *
   * @param leaves - Array of hex-encoded hashes (one per trace event).
   * @throws If leaves array is empty.
   */
  constructor(leaves: string[]) {
    if (leaves.length === 0) {
      throw new Error('MerkleTree requires at least one leaf');
    }

    this.layers = [leaves.slice()];
    let current = leaves.slice();

    while (current.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          next.push(sha256(current[i] + current[i + 1]));
        } else {
          // Odd leaf — duplicate it
          next.push(sha256(current[i] + current[i]));
        }
      }
      this.layers.push(next);
      current = next;
    }
  }

  /**
   * Get the Merkle root hash.
   *
   * @returns Hex-encoded root hash.
   */
  getRoot(): string {
    const topLayer = this.layers[this.layers.length - 1];
    return topLayer[0];
  }

  /**
   * Generate a Merkle proof for the leaf at the given index.
   *
   * The proof is an array of sibling hashes with their positions,
   * sufficient to recompute the root from the leaf.
   *
   * @param index - Zero-based index of the leaf.
   * @returns Array of MerkleProofStep objects.
   * @throws If index is out of bounds.
   */
  getProof(index: number): MerkleProofStep[] {
    if (index < 0 || index >= this.layers[0].length) {
      throw new Error(
        `Leaf index ${index} out of bounds (0..${this.layers[0].length - 1})`
      );
    }

    const proof: MerkleProofStep[] = [];
    let idx = index;

    for (let layerIdx = 0; layerIdx < this.layers.length - 1; layerIdx++) {
      const layer = this.layers[layerIdx];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;

      if (siblingIdx < layer.length) {
        proof.push({
          hash: layer[siblingIdx],
          position: isRight ? 'left' : 'right',
        });
      } else {
        // No sibling (odd layer) — sibling is self
        proof.push({
          hash: layer[idx],
          position: 'right',
        });
      }

      idx = Math.floor(idx / 2);
    }

    return proof;
  }

  /**
   * Verify that a leaf belongs to a Merkle tree with the given root.
   *
   * @param leaf - The leaf hash to verify.
   * @param proof - The Merkle proof path.
   * @param root - The expected Merkle root.
   * @returns True if the proof is valid.
   */
  static verify(leaf: string, proof: MerkleProofStep[], root: string): boolean {
    let current = leaf;

    for (const step of proof) {
      if (step.position === 'left') {
        current = sha256(step.hash + current);
      } else {
        current = sha256(current + step.hash);
      }
    }

    return current === root;
  }

  /**
   * Get the number of leaves in the tree.
   */
  getLeafCount(): number {
    return this.layers[0].length;
  }
}

// ─── Proof Generator ─────────────────────────────────────────────

/**
 * Generates a ProofBundle from an ExecutionTrace.
 *
 * The bundle includes a Merkle root over all event hashes,
 * checkpoint references, and a signature from the agent identity.
 */
export class ProofGenerator {
  private readonly trace: ExecutionTrace;
  private readonly identity: AgentIdentity;

  /**
   * @param trace - The execution trace to generate a proof for.
   * @param agentIdentity - The agent's cryptographic identity.
   */
  constructor(trace: ExecutionTrace, agentIdentity: AgentIdentity) {
    this.trace = trace;
    this.identity = agentIdentity;
  }

  /**
   * Generate a complete ProofBundle.
   *
   * @param policyRef - SHA-256 hash of the policy document.
   * @param consentRef - SHA-256 hash of the consent token.
   * @param resultRef - SHA-256 hash of the task result.
   * @returns A signed ProofBundle.
   * @throws If the trace has no events.
   */
  generate(policyRef: string, consentRef: string, resultRef: string): ProofBundle {
    return this._buildBundle(policyRef, consentRef, resultRef);
  }

  /**
   * Generate a ProofBundle from execution context, automatically computing
   * reference hashes from the consent token and task result.
   *
   * This is a convenience method that eliminates the need to manually
   * compute SHA-256 hashes for policy_ref, consent_ref, and result_ref.
   *
   * @param context - The execution context containing consent token and task result.
   * @param context.consentToken - The consent token object (will be hashed).
   * @param context.taskResult - The task result object (will be hashed).
   * @returns A signed ProofBundle.
   * @throws If the trace has no events.
   */
  generateFromContext(context: {
    consentToken: Record<string, unknown> | { scopes?: unknown; sig?: string };
    taskResult: unknown;
  }): ProofBundle {
    const consentRef = sha256(sortedStringify(context.consentToken) ?? 'null');
    const policyRef = sha256(sortedStringify(
      'scopes' in context.consentToken
        ? (context.consentToken as Record<string, unknown>).scopes
        : context.consentToken
    ) ?? 'null');
    const resultRef = sha256(sortedStringify(context.taskResult) ?? 'null');
    return this._buildBundle(policyRef, consentRef, resultRef);
  }

  /**
   * Internal: build the proof bundle with given refs.
   */
  private _buildBundle(policyRef: string, consentRef: string, resultRef: string): ProofBundle {
    const events = this.trace.getEvents();
    if (events.length === 0) {
      throw new Error('Cannot generate proof from an empty trace');
    }

    // 1. Collect event hashes as Merkle leaves
    const leaves = events.map((e) => e.hash);

    // 2. Build Merkle tree
    const tree = new MerkleTree(leaves);
    const traceRoot = tree.getRoot();

    // 3. Extract checkpoints
    const checkpoints = events
      .filter((e) => e.type === 'CHECKPOINT' && e.sig)
      .map((e) => ({
        seq: e.seq,
        hash: e.hash,
        sig: e.sig!,
      }));

    // 4. Build attestations
    const attestations: Array<{ type: string; value: string }> = [
      { type: 'trace_verified', value: String(this.trace.verify().valid) },
      { type: 'event_count', value: String(events.length) },
    ];

    if (this.trace.isFinalized()) {
      attestations.push({ type: 'finalized', value: 'true' });
    }

    // 5. Assemble the unsigned bundle
    const unsignedBundle: Omit<ProofBundle, 'signature'> = {
      proof_id: randomUUID(),
      version: 'proof.bundle.v0.1',
      executor: this.identity.did,
      task_id: this.trace.getTaskId(),
      trace_root: traceRoot,
      trace_length: events.length,
      checkpoints,
      policy_ref: policyRef,
      consent_ref: consentRef,
      result_ref: resultRef,
      attestations,
      created_at: new Date().toISOString(),
    };

    // 6. Sign the bundle
    const bundleForSigning = this.serializeForSigning(unsignedBundle);
    const sig = this.identity.sign(bundleForSigning);

    const bundle: ProofBundle = {
      ...unsignedBundle,
      signature: {
        alg: 'Ed25519',
        sig,
      },
    };

    return bundle;
  }

  /**
   * Deterministic serialization of the bundle for signing.
   *
   * @param bundle - The unsigned bundle fields.
   * @returns A deterministic JSON string.
   */
  private serializeForSigning(bundle: Omit<ProofBundle, 'signature'>): string {
    return sortedStringify(bundle);
  }
}

// ─── Proof Verifier ──────────────────────────────────────────────

/** Options for proof verification */
export interface VerifyOptions {
  /** If provided, the trace is verified and its events are checked against the Merkle root */
  trace?: ExecutionTrace;
  /** Public key (base64) of the executor, for signature verification without a full identity */
  executorPublicKey?: string;
}

/**
 * Verifies ProofBundle integrity and authenticity.
 *
 * Performs multiple checks:
 * - Bundle signature
 * - Trace hash chain (if trace provided)
 * - Merkle root consistency
 * - Checkpoint signatures
 * - Reference integrity
 */
export class ProofVerifier {
  /**
   * Verify a ProofBundle.
   *
   * @param proof - The ProofBundle to verify.
   * @param options - Optional trace and/or public key for deeper verification.
   * @returns A detailed VerifyReport.
   */
  static verify(proof: ProofBundle, options?: VerifyOptions): VerifyReport {
    const checks: VerifyReport['checks'] = [];
    const executorPublicKey = ProofVerifier.resolveExecutorPublicKey(proof, options);

    // 1. Verify bundle structure
    checks.push(ProofVerifier.checkStructure(proof));

    // 2. Verify bundle signature cryptographically
    checks.push(ProofVerifier.checkBundleSignature(proof, executorPublicKey));

    // 3. Verify trace hash chain
    if (options?.trace) {
      const traceResult = options.trace.verify();
      checks.push({
        name: 'trace_hash_chain',
        passed: traceResult.valid,
        detail: traceResult.valid
          ? 'Hash chain intact'
          : `Hash chain broken: ${traceResult.errors.join('; ')}`,
      });
    } else {
      checks.push({
        name: 'trace_hash_chain',
        passed: true,
        detail: 'Skipped (no trace provided)',
      });
    }

    // 4. Verify Merkle root matches trace events
    if (options?.trace) {
      checks.push(ProofVerifier.checkMerkleRoot(proof, options.trace));
    } else {
      checks.push({
        name: 'merkle_root',
        passed: true,
        detail: 'Skipped (no trace provided)',
      });
    }

    // 5. Verify checkpoints
    checks.push(ProofVerifier.checkCheckpoints(proof, options?.trace, executorPublicKey));

    // 6. Verify references are non-empty
    checks.push(ProofVerifier.checkReferences(proof));

    // 7. Verify trace length
    if (options?.trace) {
      const events = options.trace.getEvents();
      const lengthMatch = events.length === proof.trace_length;
      checks.push({
        name: 'trace_length',
        passed: lengthMatch,
        detail: lengthMatch
          ? `Trace length matches: ${proof.trace_length}`
          : `Mismatch: proof says ${proof.trace_length}, trace has ${events.length}`,
      });
    }

    // Compute overall result
    const allPassed = checks.every((c) => c.passed);
    const failedChecks = checks.filter((c) => !c.passed);

    const summary = allPassed
      ? `All ${checks.length} checks passed. Proof is valid.`
      : `${failedChecks.length} of ${checks.length} checks failed: ${failedChecks.map((c) => c.name).join(', ')}`;

    return {
      valid: allPassed,
      checks,
      summary,
    };
  }

  /**
   * Check that the proof bundle has all required fields.
   */
  private static checkStructure(proof: ProofBundle): VerifyReport['checks'][0] {
    const requiredFields: Array<keyof ProofBundle> = [
      'proof_id',
      'version',
      'executor',
      'task_id',
      'trace_root',
      'trace_length',
      'checkpoints',
      'policy_ref',
      'consent_ref',
      'result_ref',
      'created_at',
      'signature',
    ];

    const missing = requiredFields.filter(
      (f) => proof[f] === undefined || proof[f] === null
    );

    return {
      name: 'structure',
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? 'All required fields present'
          : `Missing fields: ${missing.join(', ')}`,
    };
  }

  /**
   * Verify the bundle signature using checkpoint signatures from the trace.
   * We reconstruct the unsigned bundle and check the signature.
   */
  private static checkBundleSignature(
    proof: ProofBundle,
    executorPublicKey: Uint8Array | null,
  ): VerifyReport['checks'][0] {
    try {
      if (!proof.signature.sig || proof.signature.sig.length === 0) {
        return {
          name: 'bundle_signature',
          passed: false,
          detail: 'Signature is empty',
        };
      }

      if (proof.signature.alg !== 'Ed25519') {
        return {
          name: 'bundle_signature',
          passed: false,
          detail: `Unknown algorithm: ${proof.signature.alg}`,
        };
      }
      if (!executorPublicKey) {
        return {
          name: 'bundle_signature',
          passed: false,
          detail: 'Executor public key unavailable for signature verification',
        };
      }

      const unsignedBundle = { ...proof };
      delete (unsignedBundle as { signature?: unknown }).signature;
      const payload = sortedStringify(unsignedBundle);
      const valid = verifySignature(payload, proof.signature.sig, executorPublicKey);

      return {
        name: 'bundle_signature',
        passed: valid,
        detail: valid
          ? 'Bundle signature verified with executor public key'
          : 'Bundle signature verification failed',
      };
    } catch (err) {
      return {
        name: 'bundle_signature',
        passed: false,
        detail: `Signature check error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Verify that the Merkle root in the proof matches the trace events.
   */
  private static checkMerkleRoot(
    proof: ProofBundle,
    trace: ExecutionTrace
  ): VerifyReport['checks'][0] {
    try {
      const events = trace.getEvents();
      if (events.length === 0) {
        return {
          name: 'merkle_root',
          passed: false,
          detail: 'Trace has no events',
        };
      }

      const leaves = events.map((e) => e.hash);
      const tree = new MerkleTree(leaves);
      const computedRoot = tree.getRoot();

      const matches = computedRoot === proof.trace_root;
      return {
        name: 'merkle_root',
        passed: matches,
        detail: matches
          ? 'Merkle root matches trace events'
          : `Mismatch: proof root "${proof.trace_root}", computed "${computedRoot}"`,
      };
    } catch (err) {
      return {
        name: 'merkle_root',
        passed: false,
        detail: `Merkle root check error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Verify checkpoint entries in the proof.
   */
  private static checkCheckpoints(
    proof: ProofBundle,
    trace?: ExecutionTrace,
    executorPublicKey?: Uint8Array | null,
  ): VerifyReport['checks'][0] {
    if (proof.checkpoints.length === 0) {
      return {
        name: 'checkpoints',
        passed: true,
        detail: 'No checkpoints to verify',
      };
    }

    // Basic structural check
    for (const cp of proof.checkpoints) {
      if (!cp.hash || !cp.sig) {
        return {
          name: 'checkpoints',
          passed: false,
          detail: `Checkpoint seq=${cp.seq} missing hash or signature`,
        };
      }
      if (!executorPublicKey || !verifySignature(cp.hash, cp.sig, executorPublicKey)) {
        return {
          name: 'checkpoints',
          passed: false,
          detail: `Checkpoint seq=${cp.seq} signature verification failed`,
        };
      }
    }

    // If trace is provided, verify checkpoint hashes exist in the trace
    if (trace) {
      const events = trace.getEvents();
      const eventHashes = new Set(events.map((e) => e.hash));

      for (const cp of proof.checkpoints) {
        if (!eventHashes.has(cp.hash)) {
          return {
            name: 'checkpoints',
            passed: false,
            detail: `Checkpoint seq=${cp.seq} hash not found in trace`,
          };
        }
      }
    }

    return {
      name: 'checkpoints',
      passed: true,
      detail: `${proof.checkpoints.length} checkpoint(s) verified cryptographically`,
    };
  }

  private static resolveExecutorPublicKey(
    proof: ProofBundle,
    options?: VerifyOptions,
  ): Uint8Array | null {
    if (options?.executorPublicKey) {
      try {
        const key = Uint8Array.from(Buffer.from(options.executorPublicKey, 'base64'));
        return key.length === 32 ? key : null;
      } catch {
        return null;
      }
    }
    try {
      return parseDID(proof.executor);
    } catch {
      return null;
    }
  }

  /**
   * Verify that policy_ref, consent_ref, and result_ref are non-empty.
   */
  private static checkReferences(proof: ProofBundle): VerifyReport['checks'][0] {
    const refs = [
      { name: 'policy_ref', value: proof.policy_ref },
      { name: 'consent_ref', value: proof.consent_ref },
      { name: 'result_ref', value: proof.result_ref },
    ];

    const empty = refs.filter((r) => !r.value || r.value.length === 0);

    return {
      name: 'references',
      passed: empty.length === 0,
      detail:
        empty.length === 0
          ? 'All references present'
          : `Empty references: ${empty.map((r) => r.name).join(', ')}`,
    };
  }
}

// ─── Deterministic Serialization (local) ─────────────────────────

/**
 * Deterministic JSON serialization with sorted keys.
 *
 * @param obj - Value to serialize.
 * @returns Deterministic JSON string.
 */
function sortedStringify(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj);
  }
  if (typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => sortedStringify(item)).join(',')}]`;
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${sortedStringify(record[k])}`);
  return `{${pairs.join(',')}}`;
}
