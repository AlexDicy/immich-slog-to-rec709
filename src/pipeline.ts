import { mkdir, rm, stat } from 'node:fs/promises';
import { join, parse as parsePath } from 'node:path';
import type { Config } from './config.js';
import { ImmichClient, type Asset } from './immich.js';
import { detect, probe } from './detect.js';
import { grade } from './grade.js';
import { log, errorMessage } from './log.js';

export type Outcome =
  | { action: 'graded'; gradedAssetId: string; gamma: string | null }
  | { action: 'skipped'; reason: string }
  | { action: 'failed'; reason: string };

/** Written to the asset so a rerun can tell what was already decided and why. */
interface Marker {
  status: 'graded' | 'not-log' | 'graded-output';
  version: 1;
  at: string;
  gamma?: string | null;
  method?: string;
  reason?: string;
  gradedAssetId?: string;
  sourceAssetId?: string;
  lut?: string;
}

export class Pipeline {
  constructor(
    private readonly config: Config,
    private readonly immich: ImmichClient,
  ) {}

  /** Cheap checks that need no download, so the common case costs one API call. */
  private async screen(asset: Asset): Promise<string | null> {
    if (asset.type !== 'VIDEO') return `asset type is ${asset.type}`;
    if (asset.isTrashed) return 'asset is in the trash';

    const { name } = parsePath(asset.originalFileName);
    if (name.endsWith(this.config.gradedSuffix)) return 'filename marks this as a graded output';

    const marker = (await this.immich.getMetadataKey(asset.id, this.config.metadataKey)) as Marker | null;
    if (marker?.status) return `already handled: ${marker.status}`;

    if (asset.stack && asset.stack.primaryAssetId !== asset.id) return 'asset is already stacked under another asset';

    const models = this.config.cameraModels;
    if (models.length > 0) {
      const model = asset.exifInfo?.model ?? '';
      if (!models.some((candidate) => model.toLowerCase().includes(candidate.toLowerCase()))) {
        return `camera model "${model || 'unknown'}" is not in CAMERA_MODELS`;
      }
    }

    return null;
  }

  async process(assetId: string): Promise<Outcome> {
    const asset = await this.immich.getAsset(assetId);
    const fields = { assetId, file: asset.originalFileName };

    const skipReason = await this.screen(asset);
    if (skipReason) {
      log.info('skipping', { ...fields, reason: skipReason });
      return { action: 'skipped', reason: skipReason };
    }

    const workDir = join(this.config.workDir, assetId);
    await mkdir(workDir, { recursive: true });

    try {
      const parsed = parsePath(asset.originalFileName);
      const originalPath = join(workDir, `original${parsed.ext || '.mp4'}`);

      log.info('downloading original', fields);
      await this.immich.downloadOriginal(assetId, originalPath);
      const { size } = await stat(originalPath);
      log.debug('downloaded', { ...fields, megabytes: Math.round(size / 1e6) });

      const detection = await detect(this.config, originalPath);
      log.info('detection result', { ...fields, isLog: detection.isLog, method: detection.method, reason: detection.reason });

      if (!detection.isLog) {
        await this.mark(assetId, {
          status: 'not-log',
          version: 1,
          at: new Date().toISOString(),
          gamma: detection.gamma,
          method: detection.method,
          reason: detection.reason,
        });
        return { action: 'skipped', reason: detection.reason };
      }

      if (this.config.dryRun) {
        log.info('dry run, stopping before the encode', fields);
        return { action: 'skipped', reason: 'dry run' };
      }

      const sourceProbe = await probe(this.config, originalPath);
      const gradedName = `${parsed.name}${this.config.gradedSuffix}.mp4`;
      const gradedPath = join(workDir, gradedName);

      log.info('applying LUT', { ...fields, resolution: `${sourceProbe.width}x${sourceProbe.height}`, pixelFormat: sourceProbe.pixelFormat });
      await grade(this.config, { inputPath: originalPath, outputPath: gradedPath, probe: sourceProbe });

      log.info('uploading graded version', { ...fields, filename: gradedName });
      const upload = await this.immich.upload({
        filePath: gradedPath,
        filename: gradedName,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        duration: asset.duration,
      });

      if (upload.status === 'duplicate') {
        log.warn('Immich reported the graded upload as a duplicate', { ...fields, gradedAssetId: upload.id });
      }

      // Mark the graded asset first, so that if its own webhook arrives while the
      // rest of this runs, it is screened out rather than graded again.
      await this.mark(upload.id, {
        status: 'graded-output',
        version: 1,
        at: new Date().toISOString(),
        sourceAssetId: assetId,
        lut: this.config.lutPath,
      });

      await this.mark(assetId, {
        status: 'graded',
        version: 1,
        at: new Date().toISOString(),
        gamma: detection.gamma,
        method: detection.method,
        gradedAssetId: upload.id,
        lut: this.config.lutPath,
      });

      if (this.config.stackAssets) {
        // First id becomes the stack cover, so the graded version is what you see.
        await this.immich.createStack([upload.id, assetId]);
        log.info('stacked graded version over original', { ...fields, gradedAssetId: upload.id });
      }

      if (this.config.tagAssets) {
        await this.applyTags(assetId, upload.id);
      }

      if (this.config.archiveOriginal) {
        await this.immich.setVisibility([assetId], 'archive');
      }

      log.info('done', { ...fields, gradedAssetId: upload.id });
      return { action: 'graded', gradedAssetId: upload.id, gamma: detection.gamma };
    } catch (error) {
      log.error('processing failed', { ...fields, error: errorMessage(error) });
      return { action: 'failed', reason: errorMessage(error) };
    } finally {
      if (!this.config.keepWorkFiles) {
        await rm(workDir, { recursive: true, force: true }).catch((error) =>
          log.warn('could not clean up work directory', { workDir, error: errorMessage(error) }),
        );
      }
    }
  }

  private async mark(assetId: string, marker: Marker): Promise<void> {
    try {
      await this.immich.setMetadata(assetId, [{ key: this.config.metadataKey, value: marker as unknown as Record<string, unknown> }]);
    } catch (error) {
      log.warn('could not write the marker', { assetId, error: errorMessage(error) });
    }
  }

  private async applyTags(originalId: string, gradedId: string): Promise<void> {
    try {
      const wanted = [this.config.originalTag, this.config.gradedTag].filter(Boolean);
      if (wanted.length === 0) return;
      const tags = await this.immich.upsertTags(wanted);
      const byName = new Map(tags.map((tag) => [tag.value, tag.id]));

      const originalTagId = byName.get(this.config.originalTag);
      const gradedTagId = byName.get(this.config.gradedTag);
      if (originalTagId) await this.immich.bulkTagAssets([originalTagId], [originalId]);
      if (gradedTagId) await this.immich.bulkTagAssets([gradedTagId], [gradedId]);
    } catch (error) {
      log.warn('could not apply tags', { error: errorMessage(error) });
    }
  }
}
