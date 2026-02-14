import _Ajv, { type ErrorObject } from 'ajv';
const Ajv = _Ajv as unknown as typeof _Ajv.default;
import _addFormats from 'ajv-formats';
const addFormats = _addFormats as unknown as (ajv: any) => void;
import { v4 as uuidv4 } from 'uuid';
import { sign as edSign } from '../identity/index.js';
import taskSchemaJson from './task-schema.json' with { type: 'json' };
import capabilitySchemaJson from './capability-schema.json' with { type: 'json' };

// ─── Custom Errors ───────────────────────────────────────────────

export class SchemaValidationError extends Error {
  public readonly validationErrors: string[];
  constructor(message: string, errors: string[]) {
    super(message);
    this.name = 'SchemaValidationError';
    this.validationErrors = errors;
  }
}

// ─── Types ───────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Settlement = 'offchain' | 'onchain' | 'credit';

export interface TaskIntent {
  type: string;
  goal: string;
  constraints?: Record<string, unknown>;
}

export interface TaskRisk {
  level: RiskLevel;
  requires_human_confirm?: boolean;
}

export interface TaskEconomics {
  max_cost?: number;
  currency?: string;
  settlement?: Settlement;
}

export interface ContextRef {
  type: string;
  ref: string;
}

export interface TaskSignature {
  alg: 'ed25519';
  sig: string;
}

export interface Task {
  task_id: string;
  version: 'task.v0.1';
  issuer: string;
  audience?: string[];
  intent: TaskIntent;
  risk: TaskRisk;
  economics?: TaskEconomics;
  deadline?: string;
  context_refs?: ContextRef[];
  nonce: string;
  signature?: TaskSignature;
}

export interface CapabilityEntry {
  type: string;
  description: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  constraints?: {
    max_risk_level?: RiskLevel;
    supported_settlements?: Settlement[];
    max_cost?: number;
    currency?: string;
    [key: string]: unknown;
  };
}

export interface Capability {
  cap_id: string;
  version: 'cap.v0.1';
  provider: string;
  capabilities: CapabilityEntry[];
  endpoint?: string;
  signature?: TaskSignature;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

// ─── Validator Setup ─────────────────────────────────────────────

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateTaskSchema = ajv.compile(taskSchemaJson);
const validateCapabilitySchema = ajv.compile(capabilitySchemaJson);

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  return errors.map((e) => `${e.instancePath || '/'} ${e.message ?? 'unknown error'}`);
}

// ─── Validation Functions ────────────────────────────────────────

/**
 * Validate a JSON object against the ATEL Task schema (task.v0.1).
 * @param taskJson - The task object to validate.
 * @returns Validation result with optional error messages.
 */
export function validateTask(taskJson: unknown): ValidationResult {
  const valid = validateTaskSchema(taskJson);
  if (valid) return { valid: true };
  return { valid: false, errors: formatErrors(validateTaskSchema.errors) };
}

/**
 * Validate a JSON object against the ATEL Capability schema (cap.v0.1).
 * @param capJson - The capability object to validate.
 * @returns Validation result with optional error messages.
 */
export function validateCapability(capJson: unknown): ValidationResult {
  const valid = validateCapabilitySchema(capJson);
  if (valid) return { valid: true };
  return { valid: false, errors: formatErrors(validateCapabilitySchema.errors) };
}

// ─── Factory Functions ───────────────────────────────────────────

export interface CreateTaskParams {
  issuer: string;
  intent: TaskIntent;
  risk: TaskRisk;
  audience?: string[];
  economics?: TaskEconomics;
  deadline?: string;
  context_refs?: ContextRef[];
}

/**
 * Create a standard ATEL Task object with auto-generated task_id and nonce.
 * @param params - Task creation parameters.
 * @returns A valid Task object (unsigned).
 */
export function createTask(params: CreateTaskParams): Task {
  const task: Task = {
    task_id: uuidv4(),
    version: 'task.v0.1',
    issuer: params.issuer,
    intent: params.intent,
    risk: params.risk,
    nonce: uuidv4(),
  };
  if (params.audience) task.audience = params.audience;
  if (params.economics) task.economics = params.economics;
  if (params.deadline) task.deadline = params.deadline;
  if (params.context_refs) task.context_refs = params.context_refs;

  const result = validateTask(task);
  if (!result.valid) {
    throw new SchemaValidationError('Created task failed validation', result.errors ?? []);
  }
  return task;
}

/**
 * Create and sign an ATEL Task in one step.
 *
 * Convenience method that creates a task and immediately signs it
 * with the provided secret key.
 *
 * @param params - Task creation parameters.
 * @param secretKey - The issuer's 64-byte Ed25519 secret key for signing.
 * @returns A valid, signed Task object.
 */
export function createSignedTask(params: CreateTaskParams, secretKey: Uint8Array): Task {
  const task = createTask(params);
  task.signature = {
    alg: 'ed25519',
    sig: edSign(task, secretKey),
  };
  return task;
}

export interface CreateCapabilityParams {
  provider: string;
  capabilities: CapabilityEntry[];
  endpoint?: string;
}

/**
 * Create a standard ATEL Capability declaration with auto-generated cap_id.
 * @param params - Capability creation parameters.
 * @returns A valid Capability object (unsigned).
 */
export function createCapability(params: CreateCapabilityParams): Capability {
  const cap: Capability = {
    cap_id: uuidv4(),
    version: 'cap.v0.1',
    provider: params.provider,
    capabilities: params.capabilities,
  };
  if (params.endpoint) cap.endpoint = params.endpoint;

  const result = validateCapability(cap);
  if (!result.valid) {
    throw new SchemaValidationError('Created capability failed validation', result.errors ?? []);
  }
  return cap;
}

// ─── Matching ────────────────────────────────────────────────────

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface MatchResult {
  matched: boolean;
  matchedCapabilities: CapabilityEntry[];
  reasons?: string[];
}

/**
 * Match a task against a capability declaration.
 * Checks intent type, risk level, and economic constraints.
 * @param task - The task to match.
 * @param capability - The capability to match against.
 * @returns Match result with matched capabilities and reasons for rejection.
 */
export function matchTaskToCapability(task: Task, capability: Capability): MatchResult {
  const matched: CapabilityEntry[] = [];
  const reasons: string[] = [];

  for (const cap of capability.capabilities) {
    // Type match
    if (cap.type !== task.intent.type) {
      reasons.push(`Capability type "${cap.type}" does not match task intent type "${task.intent.type}"`);
      continue;
    }

    // Risk level check
    if (cap.constraints?.max_risk_level) {
      const capRisk = RISK_ORDER[cap.constraints.max_risk_level];
      const taskRisk = RISK_ORDER[task.risk.level];
      if (taskRisk > capRisk) {
        reasons.push(`Task risk "${task.risk.level}" exceeds capability max "${cap.constraints.max_risk_level}"`);
        continue;
      }
    }

    // Settlement check
    if (task.economics?.settlement && cap.constraints?.supported_settlements) {
      if (!cap.constraints.supported_settlements.includes(task.economics.settlement)) {
        reasons.push(`Settlement "${task.economics.settlement}" not supported`);
        continue;
      }
    }

    // Cost check
    if (task.economics?.max_cost !== undefined && cap.constraints?.max_cost !== undefined) {
      if (task.economics.max_cost > cap.constraints.max_cost) {
        reasons.push(`Task max cost ${task.economics.max_cost} exceeds capability max ${cap.constraints.max_cost}`);
        continue;
      }
    }

    matched.push(cap);
  }

  return matched.length > 0
    ? { matched: true, matchedCapabilities: matched }
    : { matched: false, matchedCapabilities: [], reasons };
}
