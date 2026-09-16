import type { Config } from './config.js';
import type { ImmichClient } from './immich.js';
import type { Pipeline } from './pipeline.js';
import { Queue } from './queue.js';
import { log } from './log.js';

export interface BackfillOptions {
  /** Stop after this many candidates. 0 means no limit. */
  limit: number;
  /** List what would be processed without downloading anything. */
  listOnly: boolean;
}

export function parseBackfillArgs(argv: string[]): BackfillOptions {
  const options: BackfillOptions = { limit: 0, listOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') {
      options.listOnly = true;
    } else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) throw new Error('--limit needs a non-negative integer');
      options.limit = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Walks the library and runs anything the webhook never saw. The search narrows
 * by camera model where possible, but the S-Log verdict still needs the file
 * itself, so every candidate gets downloaded unless --list is used.
 */
export async function backfill(
  config: Config,
  immich: ImmichClient,
  pipeline: Pipeline,
  options: BackfillOptions,
): Promise<number> {
  const models = config.cameraModels.length > 0 ? config.cameraModels : [undefined];
  const seen = new Set<string>();
  const candidates: { id: string; name: string; model: string }[] = [];

  for (const model of models) {
    const criteria: Record<string, unknown> = { type: 'VIDEO', withStacked: true };
    if (model) criteria['model'] = model;

    for await (const asset of immich.searchAssets(criteria)) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);

      const marker = await immich.getMetadataKey(asset.id, config.metadataKey);
      if (marker) {
        log.debug('already handled', { assetId: asset.id, file: asset.originalFileName });
        continue;
      }

      candidates.push({ id: asset.id, name: asset.originalFileName, model: asset.exifInfo?.model ?? 'unknown' });
      if (options.limit > 0 && candidates.length >= options.limit) break;
    }
    if (options.limit > 0 && candidates.length >= options.limit) break;
  }

  log.info('backfill candidates found', { count: candidates.length, models: config.cameraModels.join(',') || 'any' });

  if (options.listOnly) {
    for (const candidate of candidates) {
      console.log(`${candidate.id}  ${candidate.model.padEnd(12)}  ${candidate.name}`);
    }
    return 0;
  }

  if (candidates.length === 0) return 0;

  const queue = new Queue(config.concurrency);
  const tally = { graded: 0, skipped: 0, failed: 0 };

  for (const candidate of candidates) {
    queue.add(candidate.id, async () => {
      const outcome = await pipeline.process(candidate.id);
      tally[outcome.action] += 1;
      log.info('backfill progress', { ...tally, remaining: queue.size - 1 });
    });
  }

  await queue.onIdle();
  log.info('backfill complete', tally);
  return tally.failed > 0 ? 1 : 0;
}
