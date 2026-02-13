/**
 * ATEL Orchestrator — High-level orchestration class
 *
 * Ties together all ATEL modules (Identity, Schema, Policy, Gateway,
 * Trace, Proof, Trust, Anchor) into a simple, cohesive API for
 * common agent collaboration workflows.
 */

import { AgentIdentity, type AgentMetadata, verify as verifySignature, parseDID } from '../identity/index.js';
import {
  createTask,
  createSignedTask,
  matchTaskToCapability,
  type Task,
  type CreateTaskParams,
} from '../schema/index.js';
import {
  mintConsentToken,
  verifyConsentToken,
  PolicyEngine,
  type ConsentToken,
} from '../policy/index.js';
import type { RiskLevel } from '../schema/index.js';
import {
  ToolGateway,
  computeHash,
  type ToolCallResult,
  type ToolHandler,
} from '../gateway/index.js';
import { ExecutionTrace } from '../trace/index.js';
import { ProofGenerator, ProofVerifier, type ProofBundle, type VerifyReport } from '../proof/index.js';
import { TrustManager, type TrustSubmission } from '../trust/index.js';
import type { TrustSyncAdapter } from '../trust-sync/index.js';
import {
  AnchorManager,
  type AnchorProvider,
  type AnchorRecord,
  type ChainId,
} from '../anchor/index.js';

// ─── Types ───────────────────────────────────────────────────────

/** Configuration for ATELOrchestrator */
export interface OrchestratorConfig {
  /** Agent ID (auto-generated if omitted) */
  agentId?: string;
  /** Agent metadata */
  metadata?: AgentMetadata;
  /** Anchor providers to register */
  anchors?: AnchorProvider[];
  /** Data directory for persistence */
  dataDir?: string;
  /**
   * Optional network trust sync adapter.
   * Local trust is always computed; this adapter enables shared/network trust.
   */
  trustSync?: TrustSyncAdapter;
}

/** Parameters for delegating a task */
export interface DelegateTaskParams {
  /** Executor's AgentIdentity or DID string */
  executor: AgentIdentity | string;
  /** Task intent */
  intent: { type: string; goal: string; constraints?: Record<string, unknown> };
  /** Risk level */
  risk: RiskLevel;
  /** Scopes to grant */
  scopes: string[];
  /** Maximum cost */
  maxCost?: number;
  /** Deadline (ISO 8601) */
  deadline?: string;
  /** Consent token TTL in seconds (default: 3600) */
  ttlSec?: number;
  /** Max tool calls allowed (default: 100) */
  maxCalls?: number;
}

/** Context returned after delegating a task */
export interface DelegationContext {
  /** The created task */
  task: Task;
  /** The minted consent token */
  consentToken: ConsentToken;
  /** Serialize the context for transmission to the executor */
  serialize(): string;
}

/** Parameters for executing a delegated task */
export interface ExecuteTaskParams {
  /** The task to execute */
  task: Task;
  /** The consent token authorizing execution */
  consentToken: ConsentToken;
  /** Tool handlers to register */
  tools: Record<string, ToolHandler>;
  /** The execution logic */
  execute: (gateway: ToolGateway, trace: ExecutionTrace) => Promise<unknown>;
}

/** Result of task execution */
export interface ExecutionResult {
  /** Whether execution succeeded */
  success: boolean;
  /** The execution result value */
  result: unknown;
  /** The generated proof bundle */
  proof: ProofBundle;
  /** The execution trace */
  trace: ExecutionTrace;
  /** Anchor records (if anchoring was performed) */
  anchorRecords?: AnchorRecord[];
  /**
   * Standardized anchor receipt for requestor-side policy decisions.
   * Always present even when anchoring is skipped.
   */
  anchor: AnchorReceipt;
  /**
   * Trust sync receipt. Local trust update is always done; this indicates
   * whether optional network sync succeeded.
   */
  trustSync: TrustSyncReceipt;
}

/** Requestor-visible trust synchronization status */
export interface TrustSyncReceipt {
  mode: 'local-only' | 'local+network';
  localUpdated: boolean;
  networkSynced: boolean;
  reference?: string;
  detail?: string;
}

/** Per-chain anchor verification status */
export interface AnchorChainStatus {
  chain: string;
  txHash: string;
  blockNumber?: number;
  anchoredHash: string;
  anchored: boolean;
  anchorVerified: boolean;
  detail?: string;
}

/** Standardized anchor receipt returned to the requestor */
export interface AnchorReceipt {
  anchored: boolean;
  anchoredHash: string;
  verificationPassed: boolean;
  records: AnchorChainStatus[];
  failedChains: string[];
  error?: string;
}

/** Result of proof verification */
export interface OrchestratorVerifyResult {
  /** Overall validity */
  valid: boolean;
  /** Whether the proof itself is valid */
  proofValid: boolean;
  /** Whether the anchor is valid (if checked) */
  anchorValid?: boolean;
  /** Trust score for the executor */
  trustScore?: number;
  /** Detailed verification report */
  report: VerifyReport;
}

// ─── Orchestrator ────────────────────────────────────────────────

/**
 * High-level orchestrator that ties all ATEL modules together.
 *
 * Provides a simple API for:
 * - Delegating tasks to other agents
 * - Executing delegated tasks with automatic tracing and proof generation
 * - Verifying execution proofs
 */
export class ATELOrchestrator {
  /** This agent's identity */
  readonly identity: AgentIdentity;
  /** Trust manager (score + graph) */
  readonly trustManager: TrustManager;
  /** Anchor manager for on-chain anchoring */
  readonly anchorManager: AnchorManager;
  /** Optional network trust sync adapter */
  private readonly trustSync?: TrustSyncAdapter;

  constructor(config: OrchestratorConfig = {}) {
    this.identity = new AgentIdentity({
      agent_id: config.agentId,
      metadata: config.metadata,
    });
    this.trustManager = new TrustManager();
    this.anchorManager = new AnchorManager();
    this.trustSync = config.trustSync;

    // Register anchor providers
    if (config.anchors) {
      for (const provider of config.anchors) {
        this.anchorManager.registerProvider(provider);
      }
    }
  }

  /**
   * Get this orchestrator's agent identity.
   */
  getIdentity(): AgentIdentity {
    return this.identity;
  }

  /**
   * Delegate a task to another agent.
   *
   * Creates a signed task and mints a consent token in one step.
   *
   * @param params - Delegation parameters.
   * @returns A DelegationContext with the task and consent token.
   */
  delegateTask(params: DelegateTaskParams): DelegationContext {
    const executorDid = typeof params.executor === 'string'
      ? params.executor
      : params.executor.did;

    // Create and sign the task
    const task = createSignedTask(
      {
        issuer: this.identity.did,
        audience: [executorDid],
        intent: params.intent,
        risk: { level: params.risk },
        economics: params.maxCost != null
          ? { max_cost: params.maxCost, currency: 'USD', settlement: 'offchain' }
          : undefined,
        deadline: params.deadline,
      },
      this.identity.secretKey,
    );

    // Mint consent token
    const consentToken = mintConsentToken(
      this.identity.did,
      executorDid,
      params.scopes,
      {
        max_calls: params.maxCalls ?? 100,
        ttl_sec: params.ttlSec ?? 3600,
      },
      params.risk,
      this.identity.secretKey,
    );

    return {
      task,
      consentToken,
      serialize(): string {
        return JSON.stringify({ task, consentToken });
      },
    };
  }

  /**
   * Execute a delegated task with automatic tracing, proof generation,
   * and optional anchoring.
   *
   * @param params - Execution parameters.
   * @returns The execution result with proof and trace.
   */
  async executeTask(params: ExecuteTaskParams): Promise<ExecutionResult> {
    const { task, consentToken, tools, execute } = params;
    const issuerPublicKey = parseDID(task.issuer);

    // Validate task and consent before any execution side effects.
    if (!task.signature || task.signature.alg !== 'ed25519') {
      throw new Error('Invalid task: missing or unsupported signature');
    }
    const unsignedTask = { ...task };
    delete (unsignedTask as { signature?: unknown }).signature;
    if (!verifySignature(unsignedTask, task.signature.sig, issuerPublicKey)) {
      throw new Error('Invalid task signature');
    }
    verifyConsentToken(consentToken, issuerPublicKey);
    if (consentToken.iss !== task.issuer) {
      throw new Error('Invalid consent token: issuer does not match task issuer');
    }
    if (consentToken.sub !== this.identity.did) {
      throw new Error('Invalid consent token: subject does not match executor DID');
    }
    if (task.audience && task.audience.length > 0 && !task.audience.includes(this.identity.did)) {
      throw new Error('Task audience does not include this executor');
    }

    // Set up policy engine and gateway with auto-tracing
    const policyEngine = new PolicyEngine(consentToken);
    const trace = new ExecutionTrace(task.task_id, this.identity);
    const gateway = new ToolGateway(policyEngine, {
      trace,
      defaultRiskLevel: task.risk.level,
    });

    // Register tools
    for (const [name, handler] of Object.entries(tools)) {
      gateway.registerTool(name, handler);
    }

    // Record task acceptance
    trace.append('TASK_ACCEPTED', {
      task_id: task.task_id,
      executor: this.identity.did,
      accepted_at: new Date().toISOString(),
    });

    let result: unknown;
    let success = true;

    try {
      result = await execute(gateway, trace);
    } catch (err) {
      success = false;
      result = { error: err instanceof Error ? err.message : String(err) };
      trace.fail(err instanceof Error ? err : new Error(String(err)));
    }

    // Finalize trace if not already done
    if (success && !trace.isFinalized() && !trace.isFailed()) {
      trace.finalize(
        typeof result === 'object' && result !== null
          ? (result as Record<string, unknown>)
          : { result },
      );
    }

    // Generate proof
    const proofGen = new ProofGenerator(trace, this.identity);
    const proof = proofGen.generateFromContext({
      consentToken: consentToken as unknown as Record<string, unknown>,
      taskResult: result,
    });

    // Anchor if providers are available
    let anchorRecords: AnchorRecord[] | undefined;
    const anchorReceipt: AnchorReceipt = {
      anchored: false,
      anchoredHash: proof.trace_root,
      verificationPassed: false,
      records: [],
      failedChains: [],
    };
    const providers = this.anchorManager.getProviders();
    if (providers.length > 0) {
      try {
        anchorRecords = await this.anchorManager.anchorAll(proof.trace_root, {
          proof_id: proof.proof_id,
          task_id: task.task_id,
        });
        anchorReceipt.anchored = anchorRecords.length > 0;
        for (const record of anchorRecords) {
          try {
            const verification = await this.anchorManager.verify(
              proof.trace_root,
              record.txHash,
              record.chain,
            );
            anchorReceipt.records.push({
              chain: record.chain,
              txHash: record.txHash,
              blockNumber: record.blockNumber,
              anchoredHash: proof.trace_root,
              anchored: true,
              anchorVerified: verification.valid,
              detail: verification.detail,
            });
            if (!verification.valid) {
              anchorReceipt.failedChains.push(record.chain);
            }
          } catch (err) {
            anchorReceipt.records.push({
              chain: record.chain,
              txHash: record.txHash,
              blockNumber: record.blockNumber,
              anchoredHash: proof.trace_root,
              anchored: true,
              anchorVerified: false,
              detail: err instanceof Error ? err.message : String(err),
            });
            anchorReceipt.failedChains.push(record.chain);
          }
        }
        anchorReceipt.verificationPassed =
          anchorReceipt.records.length > 0 &&
          anchorReceipt.records.every((r) => r.anchorVerified);
      } catch {
        // Anchoring is best-effort
        anchorReceipt.error = 'Anchoring failed on all configured providers';
      }
    }

    const trustSubmission: TrustSubmission = {
      executor: this.identity.did,
      issuer: task.issuer,
      task_id: task.task_id,
      task_type: task.intent.type,
      risk_level: task.risk.level,
      success,
      duration_ms: trace.getStats().duration_ms ?? 0,
      tool_calls: trace.getStats().tool_calls,
      policy_violations: trace.getStats().policy_violations,
      proof_id: proof.proof_id,
      timestamp: new Date().toISOString(),
    };
    // Local trust update is always performed.
    this.trustManager.submitResult(trustSubmission);
    const trustSyncReceipt: TrustSyncReceipt = {
      mode: this.trustSync ? 'local+network' : 'local-only',
      localUpdated: true,
      networkSynced: false,
    };
    // Network trust sync is optional and best-effort.
    if (this.trustSync) {
      try {
        const sync = await this.trustSync.submit(trustSubmission);
        trustSyncReceipt.networkSynced = sync.synced;
        trustSyncReceipt.reference = sync.reference;
        trustSyncReceipt.detail = sync.detail;
      } catch (err) {
        trustSyncReceipt.networkSynced = false;
        trustSyncReceipt.detail = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      success,
      result,
      proof,
      trace,
      anchorRecords,
      anchor: anchorReceipt,
      trustSync: trustSyncReceipt,
    };
  }

  /**
   * Verify an execution proof, optionally checking on-chain anchors.
   *
   * @param proof - The proof bundle to verify.
   * @param options - Verification options.
   * @returns Verification result.
   */
  async verifyExecution(
    proof: ProofBundle,
    options?: { trace?: ExecutionTrace; anchorChain?: ChainId | string },
  ): Promise<OrchestratorVerifyResult> {
    // Verify the proof bundle
    const report = ProofVerifier.verify(proof, {
      trace: options?.trace,
    });

    let anchorValid: boolean | undefined;

    // Verify anchor if chain is specified
    if (options?.anchorChain) {
      try {
        const records = await this.anchorManager.lookup(proof.trace_root);
        const chainRecords = records.filter((r) => r.chain === options.anchorChain);
        if (chainRecords.length > 0) {
          const verification = await this.anchorManager.verify(
            proof.trace_root,
            chainRecords[0].txHash,
            options.anchorChain,
          );
          anchorValid = verification.valid;
        } else {
          anchorValid = false;
        }
      } catch {
        anchorValid = false;
      }
    }

    // Get trust score for executor
    const scoreReport = this.trustManager.getAgentScore(proof.executor);

    return {
      valid: report.valid && (anchorValid === undefined || anchorValid),
      proofValid: report.valid,
      anchorValid,
      trustScore: scoreReport.trust_score,
      report,
    };
  }
}
