/**
 * Trust Score Network Service
 *
 * HTTP API wrapping TrustScoreClient and TrustGraph with
 * JSON file persistence. MVP — no database required.
 */

import express, { Request, Response, NextFunction } from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import {
  TrustScoreClient,
  type ExecutionSummary,
  type ScoreReport,
} from '../score/index.js';
import {
  TrustGraph,
  calculateTaskWeight,
  type TrustResult,
  type GraphNode,
  type GraphEdge,
} from '../graph/index.js';

// ─── Types ───────────────────────────────────────────────────────

export interface ServiceConfig {
  port: number;
  /** Directory for JSON persistence files */
  dataDir: string;
}

/** Request body for POST /api/v1/summary */
export interface SummaryRequest extends ExecutionSummary {
  /** Issuer DID — the agent that delegated the task */
  issuer: string;
}

/** Serialized graph data (Sets → arrays for JSON) */
interface GraphData {
  nodes: Array<Omit<GraphNode, 'scenes'> & { scenes: string[] }>;
  edges: GraphEdge[];
}

// ─── Service ─────────────────────────────────────────────────────

export class TrustScoreService {
  readonly app: express.Application;
  private scoreClient: TrustScoreClient;
  private graph: TrustGraph;
  private config: ServiceConfig;
  private server: Server | null = null;
  private summaries: SummaryRequest[] = [];

  constructor(config: ServiceConfig) {
    this.config = config;
    this.app = express();
    this.scoreClient = new TrustScoreClient();
    this.graph = new TrustGraph();

    this.app.use(express.json());
    this.setupRoutes();
    this.app.use(this.errorHandler.bind(this));
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    this.loadData();
    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, () => {
        console.log(`[ATEL] Trust Score Service listening on :${this.config.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
      this.server = null;
    });
  }

  // ── Persistence ──────────────────────────────────────────────

  saveData(): void {
    const dir = resolve(this.config.dataDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(
      resolve(dir, 'scores.json'),
      JSON.stringify(this.summaries, null, 2),
    );

    const graphExport = this.graph.exportGraph();
    const graphData: GraphData = {
      nodes: graphExport.nodes.map((n) => ({
        ...n,
        scenes: [...n.scenes],
      })),
      edges: graphExport.edges,
    };
    writeFileSync(
      resolve(dir, 'graph.json'),
      JSON.stringify(graphData, null, 2),
    );

    console.log(`[ATEL] Data saved to ${dir}`);
  }

  loadData(): void {
    const dir = resolve(this.config.dataDir);

    // Load summaries and replay into TrustScoreClient
    const scoresPath = resolve(dir, 'scores.json');
    if (existsSync(scoresPath)) {
      try {
        const raw = readFileSync(scoresPath, 'utf-8');
        const loaded: SummaryRequest[] = JSON.parse(raw);
        this.summaries = loaded;
        this.scoreClient = new TrustScoreClient();
        for (const s of loaded) {
          this.scoreClient.submitExecutionSummary(s);
        }
        console.log(`[ATEL] Loaded ${loaded.length} summaries from disk`);
      } catch (e) {
        console.error('[ATEL] Failed to load scores.json:', e);
      }
    }

    // Load graph data and replay into TrustGraph
    const graphPath = resolve(dir, 'graph.json');
    if (existsSync(graphPath)) {
      try {
        const raw = readFileSync(graphPath, 'utf-8');
        const data: GraphData = JSON.parse(raw);
        this.graph = new TrustGraph();
        // Restore nodes with metadata
        for (const n of data.nodes) {
          this.graph.addNode(n.agent_id, n.metadata);
        }
        // Replay interactions from summaries to rebuild edges properly
        // (edges contain computed fields like consistency_score that need
        //  the running EMA, so we replay from summaries instead)
        for (const s of this.summaries) {
          const taskWeight = calculateTaskWeight({
            tool_calls: s.tool_calls,
            duration_ms: s.duration_ms,
            max_cost: s.risk_level === 'critical' ? 10 : s.risk_level === 'high' ? 5 : s.risk_level === 'medium' ? 2 : 1,
            risk_level: s.risk_level,
            similar_task_count: 0,
          });
          this.graph.recordInteraction({
            from: s.issuer,
            to: s.executor,
            scene: s.task_type,
            success: s.success,
            task_weight: taskWeight,
            duration_ms: s.duration_ms,
          });
        }
        console.log(`[ATEL] Loaded graph: ${data.nodes.length} nodes, ${data.edges.length} edges`);
      } catch (e) {
        console.error('[ATEL] Failed to load graph.json:', e);
      }
    }
  }

  // ── Routes ───────────────────────────────────────────────────

  private setupRoutes(): void {
    const r = express.Router();

    // Health check
    r.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Submit execution summary
    r.post('/summary', (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as SummaryRequest;
        this.validateSummary(body);

        // 1. Submit to TrustScoreClient
        this.scoreClient.submitExecutionSummary(body);

        // 2. Update TrustGraph
        const taskWeight = calculateTaskWeight({
          tool_calls: body.tool_calls,
          duration_ms: body.duration_ms,
          max_cost: body.risk_level === 'critical' ? 10 : body.risk_level === 'high' ? 5 : body.risk_level === 'medium' ? 2 : 1,
          risk_level: body.risk_level,
          similar_task_count: 0,
        });
        this.graph.recordInteraction({
          from: body.issuer,
          to: body.executor,
          scene: body.task_type,
          success: body.success,
          task_weight: taskWeight,
          duration_ms: body.duration_ms,
        });

        // 3. Persist
        this.summaries.push(body);
        this.saveData();

        // 4. Return updated score
        const report = this.scoreClient.getAgentScore(body.executor);
        res.status(201).json(report);
      } catch (err) {
        next(err);
      }
    });

    // Query single agent score
    r.get('/score/:agentId', (req: Request, res: Response) => {
      const agentId = Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId;
      const report = this.scoreClient.getAgentScore(agentId);
      res.json(report);
    });

    // Query all scores
    r.get('/scores', (_req: Request, res: Response) => {
      res.json(this.scoreClient.getAllScores());
    });

    // ── Graph routes ───────────────────────────────────────────

    // Composite trust query
    r.post('/graph/trust', (req: Request, res: Response, next: NextFunction) => {
      try {
        const { from, to, scene } = req.body as { from: string; to: string; scene: string };
        if (!from || !to || !scene) {
          res.status(400).json({ error: 'from, to, and scene are required' });
          return;
        }
        const result = this.graph.compositeTrust(from, to, scene);
        res.json(result);
      } catch (err) {
        next(err);
      }
    });

    // Node info
    r.get('/graph/node/:agentId', (req: Request, res: Response) => {
      const agentId = Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId;
      const node = this.graph.getNode(agentId);
      if (!node) {
        res.status(404).json({ error: 'Agent not found in graph' });
        return;
      }
      // Serialize Set → array
      res.json({ ...node, scenes: [...node.scenes] });
    });

    // Top partners
    r.get('/graph/partners/:agentId', (req: Request, res: Response) => {
      const agentId = Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId;
      const k = parseInt(req.query.k as string) || 10;
      const partners = this.graph.topPartners(agentId, k);
      res.json(partners);
    });

    // Scene top agents
    r.get('/graph/scene/:scene', (req: Request, res: Response) => {
      const scene = Array.isArray(req.params.scene) ? req.params.scene[0] : req.params.scene;
      const k = parseInt(req.query.k as string) || 10;
      const agents = this.graph.topAgentsForScene(scene, k);
      res.json(agents);
    });

    // Behavior consistency
    r.get('/graph/consistency/:agentId', (req: Request, res: Response) => {
      const agentId = Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId;
      const result = this.graph.behaviorConsistencyScore(agentId);
      res.json(result);
    });

    // Suspicious clusters
    r.get('/graph/suspicious', (_req: Request, res: Response) => {
      const clusters = this.graph.detectSuspiciousClusters();
      res.json(clusters);
    });

    // Graph stats
    r.get('/graph/stats', (_req: Request, res: Response) => {
      res.json(this.graph.getStats());
    });

    this.app.use('/api/v1', r);
  }

  // ── Validation ───────────────────────────────────────────────

  private validateSummary(body: SummaryRequest): void {
    const required: Array<keyof SummaryRequest> = [
      'executor', 'issuer', 'task_id', 'task_type',
      'risk_level', 'proof_id', 'timestamp',
    ];
    for (const field of required) {
      if (!body[field]) {
        throw new ValidationError(`${field} is required`);
      }
    }
    const validRisk = ['low', 'medium', 'high', 'critical'];
    if (!validRisk.includes(body.risk_level)) {
      throw new ValidationError(`risk_level must be one of: ${validRisk.join(', ')}`);
    }
    if (typeof body.success !== 'boolean') {
      throw new ValidationError('success must be a boolean');
    }
    if (typeof body.duration_ms !== 'number' || body.duration_ms < 0) {
      throw new ValidationError('duration_ms must be a non-negative number');
    }
    if (typeof body.tool_calls !== 'number' || body.tool_calls < 0) {
      throw new ValidationError('tool_calls must be a non-negative number');
    }
    if (typeof body.policy_violations !== 'number' || body.policy_violations < 0) {
      throw new ValidationError('policy_violations must be a non-negative number');
    }
  }

  // ── Error handling ───────────────────────────────────────────

  private errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[ATEL] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
