import type { Config } from './config.js';
import type { ImmichClient } from './immich.js';
import type { Marker, Pipeline } from './pipeline.js';
import { Queue } from './queue.js';
import { currentSettings, describeSettingsDrift, settingsMatch } from './settings.js';
import { log, errorMessage } from './log.js';

export interface BackfillOptions {
  /** Stop after this many candidates. 0 means no limit. */
  limit: number;
  /** List what would be processed without downloading anything. */
  listOnly: boolean;
  /** Regrade everything, marker or not. */
  force: boolean;
  /** Regrade only what was graded with encode settings that no longer apply. */
  changed: boolean;
}

export function parseBackfillArgs(argv: string[]): BackfillOptions {
  const options: BackfillOptions = { limit: 0, listOnly: false, force: false, changed: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') {
      options.listOnly = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--changed') {
      options.changed = true;
    } else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) throw new Error('--limit needs a non-negative integer');
      options.limit = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.force && options.changed) throw new Error('use either --force or --changed, not both');
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
  const candidates: { id: string; name: string; model: string; reprocess: boolean }[] = [];
  const settings = await currentSettings(config);

  for (const model of models) {
    const criteria: Record<string, unknown> = { type: 'VIDEO', withStacked: true };
    if (model) criteria['model'] = model;

    for await (const asset of immich.searchAssets(criteria)) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);

      const marker = (await immich.getMetadataKey(asset.id, config.metadataKey)) as Marker | null;
      let reprocess = false;
      if (marker) {
        const fields = { assetId: asset.id, file: asset.originalFileName };
        if (options.force) {
          reprocess = true;
        } else if (options.changed && marker.status === 'graded' && !settingsMatch(marker.settings, settings)) {
          reprocess = true;
          log.info('encode settings no longer match', { ...fields, drift: describeSettingsDrift(marker.settings, settings) });
        } else {
          log.debug('already handled', fields);
          continue;
        }
      }

      candidates.push({
        id: asset.id,
        name: asset.originalFileName,
        model: asset.exifInfo?.model ?? 'unknown',
        reprocess,
      });
      if (options.limit > 0 && candidates.length >= options.limit) break;
    }
    if (options.limit > 0 && candidates.length >= options.limit) break;
  }

  log.info('backfill candidates found', {
    count: candidates.length,
    reprocess: candidates.filter((candidate) => candidate.reprocess).length,
    models: config.cameraModels.join(',') || 'any',
  });

  if (options.listOnly) {
    for (const candidate of candidates) {
      console.log(
        `${candidate.id}  ${candidate.model.padEnd(12)}  ${candidate.reprocess ? 'reprocess' : 'new      '}  ${candidate.name}`,
      );
    }
    return 0;
  }

  if (candidates.length === 0) return 0;

  const queue = new Queue(config.concurrency);
  const tally = { graded: 0, skipped: 0, failed: 0 };

  for (const candidate of candidates) {
    queue.add(candidate.id, async () => {
      // process() reports its own failures, so this only catches something
      // unforeseen. Either way it has to be counted: a tally that says nothing
      // failed, and an exit code of 0, would be worse than the failure itself.
      try {
        const outcome = await pipeline.process(candidate.id, { reprocess: candidate.reprocess });
        tally[outcome.action] += 1;
      } catch (error) {
        tally.failed += 1;
        log.error('clip failed', { assetId: candidate.id, file: candidate.name, error: errorMessage(error) });
      }
      log.info('backfill progress', { ...tally, remaining: queue.size - 1 });
    });
  }

  await queue.onIdle();
  log.info('backfill complete', tally);
  return tally.failed > 0 ? 1 : 0;
}
