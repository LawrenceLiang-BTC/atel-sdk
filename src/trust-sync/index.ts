import type { TrustSubmission } from '../trust/index.js';

export interface TrustSyncResult {
  synced: boolean;
  reference?: string;
  detail?: string;
}

export interface TrustSyncAdapter {
  submit(submission: TrustSubmission): Promise<TrustSyncResult>;
}

export interface HttpTrustSyncAdapterOptions {
  /** Base URL of TrustScoreService, e.g. http://localhost:3100 */
  baseUrl: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Optional bearer token */
  bearerToken?: string;
}

/**
 * Default network trust sync adapter for self-hosted TrustScoreService.
 *
 * Sends execution summary to:
 *   POST {baseUrl}/api/v1/summary
 */
export class HttpTrustSyncAdapter implements TrustSyncAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly bearerToken?: string;

  constructor(options: HttpTrustSyncAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.bearerToken = options.bearerToken;
  }

  async submit(submission: TrustSubmission): Promise<TrustSyncResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.bearerToken) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/summary`, {
        method: 'POST',
        headers,
        body: JSON.stringify(submission),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          synced: false,
          detail: `HTTP ${response.status}: ${text || response.statusText}`,
        };
      }

      const body = await response.json() as { agent_id?: string; last_updated?: string };
      return {
        synced: true,
        reference: body.agent_id ?? submission.executor,
        detail: body.last_updated ? `updated_at=${body.last_updated}` : 'ok',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        synced: false,
        detail: message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
