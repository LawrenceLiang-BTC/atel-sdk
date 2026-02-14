/**
 * ATEL Network Module — Connection Establishment Layer
 *
 * Part of the ATEL protocol: defines how agents discover and connect to each other.
 *
 * Candidate types (priority high → low):
 *   1. local   — LAN IP (same network direct connect)
 *   2. direct  — Public IP (cross-network, requires port reachable)
 *   3. upnp    — Public IP with UPnP mapping (auto port forward)
 *   4. relay   — Relay server (encrypted passthrough, fallback)
 *
 * Connection flow:
 *   Agent A wants to reach Agent B →
 *   Fetch B's candidates from Registry →
 *   Try each candidate by priority (health check) →
 *   First reachable one wins
 */

import natUpnp from 'nat-upnp';
import { networkInterfaces } from 'node:os';

// ─── Types ───────────────────────────────────────────────────────

export interface ConnectionCandidate {
  type: 'local' | 'direct' | 'upnp' | 'relay';
  url: string;
  priority: number;
}

export interface NetworkConfig {
  port: number;
  candidates: ConnectionCandidate[];
  publicIP: string | null;
  localIPs: string[];
  upnpSuccess: boolean;
  relayUrl?: string;
  configuredAt: string;
}

export interface ConnectResult {
  url: string;
  candidateType: string;
  latencyMs: number;
}

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_RELAY = 'http://47.251.8.19:9000';

const IP_SERVICES = [
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://icanhazip.com',
];

// ─── IP Discovery ────────────────────────────────────────────────

/** Get all local (LAN) IPv4 addresses */
export function getLocalIPs(): string[] {
  const ips: string[] = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

/** Discover public IP via HTTP services */
export async function discoverPublicIP(): Promise<string | null> {
  for (const url of IP_SERVICES) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const ip = (await resp.text()).trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
      }
    } catch { /* try next */ }
  }
  return null;
}

// ─── UPnP ────────────────────────────────────────────────────────

/** Attempt UPnP port mapping */
export async function tryUPnPMapping(port: number): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const client = natUpnp.createClient();
    const timeout = setTimeout(() => {
      client.close();
      resolve({ success: false, error: 'UPnP timeout (5s)' });
    }, 5000);

    client.portMapping({
      public: port,
      private: port,
      ttl: 7200,
      description: `ATEL Agent (port ${port})`,
    }, (err: Error | null) => {
      clearTimeout(timeout);
      client.close();
      resolve(err ? { success: false, error: err.message } : { success: true });
    });
  });
}

// ─── Port Reachability ───────────────────────────────────────────

/** Check if a URL is reachable (ATEL health endpoint) */
export async function checkReachable(url: string, timeoutMs = 5000): Promise<{ reachable: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const resp = await fetch(`${url}/atel/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Date.now() - start;
    return { reachable: resp.ok, latencyMs };
  } catch {
    return { reachable: false, latencyMs: Date.now() - start };
  }
}

/** Verify port reachable from internet via external service */
export async function verifyPortReachable(ip: string, port: number): Promise<boolean> {
  try {
    const resp = await fetch(`https://ports.yougetsignal.com/check-port.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `remoteAddress=${ip}&portNumber=${port}`,
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) return (await resp.text()).includes('"open"');
  } catch {}
  return false;
}

// ─── Candidate Collection ────────────────────────────────────────

/**
 * Collect all connection candidates for this agent.
 * Called during `atel start` — auto-detects everything.
 */
export async function collectCandidates(port: number, relayUrl?: string): Promise<{
  candidates: ConnectionCandidate[];
  publicIP: string | null;
  localIPs: string[];
  upnpSuccess: boolean;
  steps: string[];
}> {
  const candidates: ConnectionCandidate[] = [];
  const steps: string[] = [];

  // 1. Local IPs (highest priority — same LAN = fastest)
  const localIPs = getLocalIPs();
  for (const ip of localIPs) {
    candidates.push({ type: 'local', url: `http://${ip}:${port}`, priority: 100 });
    steps.push(`Local candidate: http://${ip}:${port}`);
  }

  // 2. Public IP
  steps.push('Discovering public IP...');
  const publicIP = await discoverPublicIP();
  if (publicIP) {
    steps.push(`Public IP: ${publicIP}`);

    // 3. Try UPnP port mapping
    steps.push('Attempting UPnP port mapping...');
    const upnp = await tryUPnPMapping(port);
    if (upnp.success) {
      candidates.push({ type: 'upnp', url: `http://${publicIP}:${port}`, priority: 80 });
      steps.push(`UPnP success: http://${publicIP}:${port}`);
    } else {
      steps.push(`UPnP failed: ${upnp.error}`);
      // Still add as direct candidate — might work if port is already forwarded
      candidates.push({ type: 'direct', url: `http://${publicIP}:${port}`, priority: 50 });
      steps.push(`Direct candidate (unverified): http://${publicIP}:${port}`);
    }

    return { candidates, publicIP, localIPs, upnpSuccess: upnp.success, steps };
  }

  steps.push('Could not determine public IP');

  // 4. Relay fallback (always available)
  const relay = relayUrl || DEFAULT_RELAY;
  candidates.push({ type: 'relay', url: relay, priority: 10 });
  steps.push(`Relay fallback: ${relay}`);

  return { candidates, publicIP: null, localIPs, upnpSuccess: false, steps };
}

// ─── Connection Establishment ────────────────────────────────────

/**
 * Try to connect to a remote agent by testing their candidates in priority order.
 * Direct candidates are tested first (health check). Relay is only used as last resort.
 *
 * When relay is used, returns a proxy URL: relay/v1/proxy/<did>/
 * This makes relay transparent to the caller — same ATEL endpoints work.
 */
export async function connectToAgent(candidates: ConnectionCandidate[], remoteDid?: string, timeoutMs = 3000): Promise<ConnectResult | null> {
  // Sort by priority descending
  const sorted = [...candidates].sort((a, b) => b.priority - a.priority);

  // Phase 1: Try all non-relay candidates
  const directCandidates = sorted.filter(c => c.type !== 'relay');
  for (const candidate of directCandidates) {
    const result = await checkReachable(candidate.url, timeoutMs);
    if (result.reachable) {
      return { url: candidate.url, candidateType: candidate.type, latencyMs: result.latencyMs };
    }
  }

  // Phase 2: Fallback to relay (proxy mode)
  const relayCandidates = sorted.filter(c => c.type === 'relay');
  for (const candidate of relayCandidates) {
    // Verify relay is up
    try {
      const resp = await fetch(`${candidate.url}/relay/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (resp.ok) {
        // Return relay send URL — caller posts requests here
        const sendUrl = remoteDid
          ? `${candidate.url}/relay/v1/send/${encodeURIComponent(remoteDid)}`
          : candidate.url;
        return { url: sendUrl, candidateType: 'relay', latencyMs: Date.now() };
      }
    } catch { /* try next relay */ }
  }

  return null;
}

// ─── Full Auto Setup (for CLI) ───────────────────────────────────

/**
 * Full network setup: collect candidates + add relay fallback.
 * Returns complete NetworkConfig ready to save and register.
 */
export async function autoNetworkSetup(port: number, relayUrl?: string): Promise<NetworkConfig & { steps: string[] }> {
  const { candidates, publicIP, localIPs, upnpSuccess, steps } = await collectCandidates(port, relayUrl);

  // Always ensure relay fallback exists
  const relay = relayUrl || DEFAULT_RELAY;
  if (!candidates.find(c => c.type === 'relay')) {
    candidates.push({ type: 'relay', url: relay, priority: 10 });
    steps.push(`Relay fallback: ${relay}`);
  }

  steps.push(`Total candidates: ${candidates.length}`);

  return {
    port,
    candidates,
    publicIP,
    localIPs,
    upnpSuccess,
    relayUrl: relay,
    configuredAt: new Date().toISOString(),
    steps,
  };
}
