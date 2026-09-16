import { mkdir, rm, stat } from 'node:fs/promises';
import { join, parse as parsePath } from 'node:path';
import type { Config } from './config.js';
import { ImmichClient, type Asset } from './immich.js';
import { detect, probe } from './detect.js';
import { grade } from './grade.js';
import { writeSourceMetadata } from './metadata.js';
import { currentSettings, type EncodeSettings } from './settings.js';
import { log, errorMessage } from './log.js';

export type Outcome =
  | { action: 'graded'; gradedAssetId: string; gamma: string | null }
  | { action: 'skipped'; reason: string }
  | { action: 'failed'; reason: string };

/** Written to the asset so a rerun can tell what was already decided and why. */
export interface Marker {
  status: 'graded' | 'not-log' | 'graded-output';
  /** Read as written by whichever version wrote it, so old markers still parse. */
  version: number;
  at: string;
  gamma?: string | null;
  method?: string;
  reason?: string;
  gradedAssetId?: string;
  sourceAssetId?: string;
  /** Absent on markers written before the settings were tracked. */
  settings?: EncodeSettings;
}

/** Bumped when the marker's shape changes. Version 1 recorded `lut` as a path. */
const MARKER_VERSION = 2;

export class Pipeline {
  constructor(
    private readonly config: Config,
    private readonly immich: ImmichClient,
  ) {}

  /**
   * Cheap checks that need no download, so the common case costs one API call.
   * The marker is returned either way, because a reprocess needs what it recorded.
   */
  private async screen(asset: Asset, reprocess: boolean): Promise<{ skip: string | null; marker: Marker | null }> {
    if (asset.type !== 'VIDEO') return { skip: `asset type is ${asset.type}`, marker: null };
    if (asset.isTrashed) return { skip: 'asset is in the trash', marker: null };

    const { name } = parsePath(asset.originalFileName);
    if (name.endsWith(this.config.gradedSuffix)) return { skip: 'filename marks this as a graded output', marker: null };

    const marker = (await this.immich.getMetadataKey(asset.id, this.config.metadataKey)) as Marker | null;
    if (marker?.status && !reprocess) return { skip: `already handled: ${marker.status}`, marker };

    // A reprocess expects to find its own previous output stacked on top of this
    // asset. Any other stack means the asset belongs to something else.
    const stackedElsewhere = Boolean(asset.stack) && asset.stack?.primaryAssetId !== asset.id;
    const ownStack = reprocess && Boolean(marker?.gradedAssetId) && asset.stack?.primaryAssetId === marker?.gradedAssetId;
    if (stackedElsewhere && !ownStack) return { skip: 'asset is already stacked under another asset', marker };

    const models = this.config.cameraModels;
    if (models.length > 0) {
      const model = asset.exifInfo?.model ?? '';
      if (!models.some((candidate) => model.toLowerCase().includes(candidate.toLowerCase()))) {
        return { skip: `camera model "${model || 'unknown'}" is not in CAMERA_MODELS`, marker };
      }
    }

    return { skip: null, marker };
  }

  /** `reprocess` regrades an asset that already carries a marker, replacing its output. */
  async process(assetId: string, options: { reprocess?: boolean } = {}): Promise<Outcome> {
    const reprocess = options.reprocess ?? false;
    const asset = await this.immich.getAsset(assetId);
    const fields = { assetId, file: asset.originalFileName };

    const { skip: skipReason, marker } = await this.screen(asset, reprocess);
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
          version: MARKER_VERSION,
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

      await writeSourceMetadata(this.config, gradedPath, asset.exifInfo);

      const settings = await currentSettings(this.config);
      const gradedMarker: Marker = {
        status: 'graded-output',
        version: MARKER_VERSION,
        at: new Date().toISOString(),
        sourceAssetId: assetId,
        settings,
      };

      // The marker goes out with the upload rather than in a call after it, so the
      // graded asset carries it from the moment it exists. Its own workflow webhook
      // can then only ever see it already marked, and is screened out.
      log.info('uploading graded version', { ...fields, filename: gradedName });
      const upload = await this.immich.upload({
        filePath: gradedPath,
        filename: gradedName,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        duration: asset.duration,
        metadata: [{ key: this.config.metadataKey, value: gradedMarker as unknown as Record<string, unknown> }],
      });

      if (upload.status === 'duplicate') {
        // Immich matched an existing asset and returned that instead, so nothing
        // sent with the upload was applied to it.
        log.warn('Immich reported the graded upload as a duplicate', { ...fields, gradedAssetId: upload.id });
        await this.mark(upload.id, gradedMarker);
      }

      // Only once the replacement exists, so a failed encode or upload never
      // leaves the asset with nothing stacked over it. A byte identical re-encode
      // comes back as a duplicate of the asset being replaced, and that one has to
      // be kept rather than deleted.
      const supersededId = marker?.gradedAssetId;
      if (supersededId && supersededId !== upload.id) {
        try {
          await this.immich.deleteAssets([supersededId]);
          log.info('moved the superseded graded version to the trash', { ...fields, supersededId });
        } catch (error) {
          log.warn('could not remove the superseded graded version', { ...fields, supersededId, error: errorMessage(error) });
        }
      }

      await this.mark(assetId, {
        status: 'graded',
        version: MARKER_VERSION,
        at: new Date().toISOString(),
        gamma: detection.gamma,
        method: detection.method,
        gradedAssetId: upload.id,
        settings,
      });

      if (this.config.stackAssets) {
        try {
          // First id becomes the stack cover, so the graded version is what you see.
          await this.immich.createStack([upload.id, assetId]);
          log.info('stacked graded version over original', { ...fields, gradedAssetId: upload.id });
        } catch (error) {
          // The graded version is uploaded and marked by this point, so failing the
          // whole clip over the stack would throw away the expensive part.
          log.warn('could not stack the graded version over the original', { ...fields, error: errorMessage(error) });
        }
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
