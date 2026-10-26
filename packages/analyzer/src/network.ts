import {
  endpointKey,
  type ApiCall,
  type ApiClient,
  type DuplicateGroup,
  type EndpointSummary,
  type NetworkReport,
  type PerfEvent,
  type SequentialChain,
} from '@rnpa/shared';
import { type Ctx, requestKey, visitAt } from './context.js';
import { num, round, stat, str } from './util.js';

const CLIENTS: ApiClient[] = ['fetch', 'xhr', 'axios'];

/** Pairs API_START/API_END into calls. Runs before navigation (visit indices are filled in later). */
export function buildCalls(ctx: Ctx): ApiCall[] {
  const starts = new Map<string, PerfEvent>();
  for (const e of ctx.by.API_START) starts.set(requestKey(e), e);
  const calls: ApiCall[] = [];
  const ended = new Set<string>();

  const toCall = (startEvent: PerfEvent | undefined, endEvent: PerfEvent | null): ApiCall => {
    const src = endEvent ?? (startEvent as PerfEvent);
    const m = src.metadata;
    const method = (str(m.method) ?? 'GET').toUpperCase();
    const url = str(m.url) ?? '';
    const endTs = endEvent ? endEvent.ts : null;
    const duration = endEvent ? (endEvent.duration ?? (startEvent ? endEvent.ts - startEvent.ts : null)) : null;
    const start = startEvent ? startEvent.ts : endTs !== null ? endTs - (duration ?? 0) : src.ts;
    const client = CLIENTS.includes(m.client as ApiClient) ? (m.client as ApiClient) : 'fetch';
    return {
      requestId: requestKey(src),
      method,
      url,
      endpoint: endpointKey(method, url),
      client,
      status: endEvent ? num(m.status) : null,
      error: endEvent ? (str(m.error) ?? null) : null,
      start,
      end: endTs,
      duration: duration !== null ? round(duration) : null,
      requestSize: num(m.requestSize) ?? (startEvent ? num(startEvent.metadata.requestSize) : null),
      responseSize: endEvent ? num(m.responseSize) : null,
      screen: startEvent?.screen ?? src.screen,
      visitIndex: null,
    };
  };

  for (const e of ctx.by.API_END) {
    const key = requestKey(e);
    ended.add(key);
    calls.push(toCall(starts.get(key), e));
  }
  for (const [key, e] of starts) {
    if (!ended.has(key)) calls.push(toCall(e, null));
  }
  calls.sort((a, b) => a.start - b.start);
  return calls;
}

export function analyzeNetwork(ctx: Ctx): NetworkReport {
  const { calls, options } = ctx;
  for (const call of calls) {
    call.visitIndex = visitAt(ctx.visits, call.start);
    if (call.visitIndex !== null && call.screen === null) call.screen = ctx.visits[call.visitIndex]?.screen ?? null;
  }

  const isFailed = (c: ApiCall) => c.end !== null && (c.status === null || c.status >= 400);
  const isSlow = (c: ApiCall) => (c.duration ?? 0) >= options.slowApiMs;

  // Duplicates: same method+URL, same visit, starts within the window.
  const groups = new Map<string, ApiCall[]>();
  for (const c of calls) {
    const key = `${c.visitIndex ?? 'none'}|${c.method}|${c.url}`;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  const duplicates: DuplicateGroup[] = [];
  const duplicateIds = new Set<string>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    let cluster: ApiCall[] = [list[0] as ApiCall];
    const flush = () => {
      if (cluster.length >= 2) {
        const first = cluster[0] as ApiCall;
        duplicates.push({
          endpoint: first.endpoint,
          url: first.url,
          screen: first.screen,
          count: cluster.length,
          requestIds: cluster.map((c) => c.requestId),
          wastedMs: round(cluster.slice(1).reduce((s, c) => s + (c.duration ?? 0), 0)),
        });
        for (const c of cluster.slice(1)) duplicateIds.add(c.requestId);
      }
    };
    for (const c of list.slice(1)) {
      const prev = cluster[cluster.length - 1] as ApiCall;
      if (c.start - prev.start <= options.duplicateWindowMs) cluster.push(c);
      else {
        flush();
        cluster = [c];
      }
    }
    flush();
  }
  duplicates.sort((a, b) => b.wastedMs - a.wastedMs || b.count - a.count);

  // Sequential chains: request N+1 starts right after N's response, per visit.
  const sequentialChains: SequentialChain[] = [];
  const byVisit = new Map<number | null, ApiCall[]>();
  for (const c of calls) {
    if (c.end === null) continue;
    const list = byVisit.get(c.visitIndex);
    if (list) list.push(c);
    else byVisit.set(c.visitIndex, [c]);
  }
  for (const [visitIndex, list] of byVisit) {
    let chain: ApiCall[] = [];
    const finish = () => {
      if (chain.length >= 2) {
        const first = chain[0] as ApiCall;
        const last = chain[chain.length - 1] as ApiCall;
        const totalMs = (last.end as number) - first.start;
        const parallelMs = Math.max(...chain.map((c) => c.duration ?? 0));
        sequentialChains.push({
          screen: first.screen,
          visitIndex,
          requestIds: chain.map((c) => c.requestId),
          endpoints: chain.map((c) => c.endpoint),
          totalMs: round(totalMs),
          parallelMs: round(parallelMs),
        });
      }
    };
    for (const c of list) {
      const prev = chain[chain.length - 1];
      if (prev && prev.end !== null && c.start >= prev.end - 1 && c.start - prev.end <= options.sequentialGapMs) {
        chain.push(c);
      } else {
        finish();
        chain = [c];
      }
    }
    finish();
  }
  sequentialChains.sort((a, b) => b.totalMs - b.parallelMs - (a.totalMs - a.parallelMs));

  // Per-endpoint summary.
  const byEndpoint = new Map<string, ApiCall[]>();
  for (const c of calls) {
    const list = byEndpoint.get(c.endpoint);
    if (list) list.push(c);
    else byEndpoint.set(c.endpoint, [c]);
  }
  const endpoints: EndpointSummary[] = [...byEndpoint.entries()].map(([endpoint, list]) => ({
    endpoint,
    count: list.length,
    errors: list.filter(isFailed).length,
    slow: list.filter(isSlow).length,
    duplicates: list.filter((c) => duplicateIds.has(c.requestId)).length,
    duration: stat(list.map((c) => c.duration)),
    requestBytes: list.reduce((s, c) => s + (c.requestSize ?? 0), 0),
    responseBytes: list.reduce((s, c) => s + (c.responseSize ?? 0), 0),
  }));
  endpoints.sort((a, b) => (b.duration?.total ?? 0) - (a.duration?.total ?? 0));

  return {
    calls,
    endpoints,
    slow: calls.filter(isSlow).map((c) => c.requestId),
    failed: calls.filter(isFailed).map((c) => c.requestId),
    duplicates,
    sequentialChains,
    totalBytes: calls.reduce((s, c) => s + (c.requestSize ?? 0) + (c.responseSize ?? 0), 0),
  };
}
