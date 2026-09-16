import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { Pipeline } from './pipeline.js';
import type { Queue } from './queue.js';
import { log, errorMessage } from './log.js';

const MAX_BODY_BYTES = 1_000_000;

function tokenMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The webhook action sends the asset object as the request body. Only the id is
 * needed, and re-reading the asset from the API keeps this working even if the
 * payload shape changes between Immich releases.
 */
function extractAssetId(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const candidate = record['id'] ?? (record['asset'] as Record<string, unknown> | undefined)?.['id'];
  if (typeof candidate !== 'string') return null;
  return /^[0-9a-fA-F-]{36}$/.test(candidate) ? candidate : null;
}

export function startServer(config: Config, pipeline: Pipeline, queue: Queue) {
  const json = (response: ServerResponse, status: number, payload: unknown) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

      if (request.method === 'GET' && url.pathname === '/healthz') {
        json(response, 200, { status: 'ok', queued: queue.size });
        return;
      }

      if (url.pathname !== '/webhook') {
        json(response, 404, { error: 'not found' });
        return;
      }
      if (request.method !== 'POST' && request.method !== 'PUT') {
        json(response, 405, { error: 'use POST or PUT' });
        return;
      }

      if (config.webhookToken) {
        const received = request.headers[config.webhookHeader];
        const value = Array.isArray(received) ? received[0] : received;
        if (!value || !tokenMatches(config.webhookToken, value)) {
          log.warn('rejected a webhook with a bad token', { header: config.webhookHeader });
          json(response, 401, { error: 'unauthorized' });
          return;
        }
      }

      let body: string;
      try {
        body = await readBody(request);
      } catch (error) {
        json(response, 413, { error: errorMessage(error) });
        return;
      }

      const assetId = extractAssetId(body);
      if (!assetId) {
        log.warn('webhook body had no usable asset id', { preview: body.slice(0, 200) });
        json(response, 400, { error: 'could not find an asset id in the request body' });
        return;
      }

      // Answer straight away. Grading takes minutes and Immich should not wait.
      const queued = queue.add(assetId, () => pipeline.process(assetId).then(() => undefined));
      log.info('webhook accepted', { assetId, queued, depth: queue.size });
      json(response, 202, { assetId, queued, depth: queue.size });
    })().catch((error) => {
      log.error('request handler failed', { error: errorMessage(error) });
      if (!response.headersSent) json(response, 500, { error: 'internal error' });
    });
  });

  server.listen(config.port, config.bindAddress, () => {
    log.info('listening', {
      address: `http://${config.bindAddress}:${config.port}`,
      webhook: '/webhook',
      authenticated: Boolean(config.webhookToken),
    });
    if (!config.webhookToken) {
      log.warn('WEBHOOK_TOKEN is not set, anyone who can reach this port can queue jobs');
    }
  });

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal, queued: queue.size });
    server.close(() => process.exit(0));
    // Give in-flight encodes a moment, then stop regardless.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}
