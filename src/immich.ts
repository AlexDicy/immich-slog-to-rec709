import { createWriteStream } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Config } from './config.js';
import { log } from './log.js';

export interface ExifInfo {
  make?: string | null;
  model?: string | null;
  exifImageWidth?: number | null;
  exifImageHeight?: number | null;
  fileSizeInByte?: number | null;
  dateTimeOriginal?: string | null;
}

export interface Asset {
  id: string;
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'OTHER';
  originalFileName: string;
  originalPath: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  duration: string;
  isTrashed: boolean;
  visibility: string;
  exifInfo?: ExifInfo | null;
  stack?: { id: string; primaryAssetId: string; assetCount: number } | null;
}

export interface UploadResult {
  id: string;
  status: 'created' | 'duplicate';
}

export interface MetadataItem {
  key: string;
  value: Record<string, unknown>;
}

export class ImmichError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${method} ${path} returned ${status}: ${body.slice(0, 500)}`);
    this.name = 'ImmichError';
  }
}

export class ImmichClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: Pick<Config, 'immichUrl' | 'immichApiKey'>) {
    this.baseUrl = `${config.immichUrl}/api`;
    this.apiKey = config.immichApiKey;
  }

  private async request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-api-key', this.apiKey);
    headers.set('Accept', 'application/json');

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, method, headers });
    if (!response.ok) {
      throw new ImmichError(response.status, method, path, await response.text().catch(() => ''));
    }
    return response;
  }

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = {};
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json' };
    }
    if (signal) init.signal = signal;
    const response = await this.request(method, path, init);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async ping(): Promise<void> {
    await this.json('GET', '/server/ping');
  }

  async getAsset(id: string): Promise<Asset> {
    return this.json<Asset>('GET', `/assets/${id}`);
  }

  async downloadOriginal(id: string, destinationPath: string): Promise<void> {
    const response = await this.request('GET', `/assets/${id}/original`);
    if (!response.body) throw new Error(`asset ${id} download returned an empty body`);
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destinationPath));
  }

  async upload(options: {
    filePath: string;
    filename: string;
    fileCreatedAt: string;
    fileModifiedAt: string;
    duration?: string;
    visibility?: 'timeline' | 'archive' | 'hidden' | 'locked';
  }): Promise<UploadResult> {
    // openAsBlob streams from disk, so a multi-gigabyte clip never lands in memory.
    const blob = await openAsBlob(options.filePath, { type: 'video/mp4' });
    const form = new FormData();
    form.set('assetData', blob, options.filename);
    form.set('filename', options.filename);
    form.set('fileCreatedAt', options.fileCreatedAt);
    form.set('fileModifiedAt', options.fileModifiedAt);
    if (options.duration) form.set('duration', options.duration);
    if (options.visibility) form.set('visibility', options.visibility);

    // Leave Content-Type unset so fetch generates the multipart boundary.
    const response = await this.request('POST', '/assets', { body: form });
    return (await response.json()) as UploadResult;
  }

  async createStack(assetIds: string[]): Promise<{ id: string; primaryAssetId: string }> {
    return this.json('POST', '/stacks', { assetIds });
  }

  async getMetadataKey(assetId: string, key: string): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.json<{ key: string; value: Record<string, unknown> }>(
        'GET',
        `/assets/${assetId}/metadata/${encodeURIComponent(key)}`,
      );
      return result?.value ?? null;
    } catch (error) {
      if (error instanceof ImmichError && error.status === 404) return null;
      throw error;
    }
  }

  async setMetadata(assetId: string, items: MetadataItem[]): Promise<void> {
    await this.json('PUT', `/assets/${assetId}/metadata`, { items });
  }

  async upsertTags(names: string[]): Promise<{ id: string; value: string }[]> {
    return this.json('PUT', '/tags', { tags: names });
  }

  async bulkTagAssets(tagIds: string[], assetIds: string[]): Promise<void> {
    await this.json('PUT', '/tags/assets', { tagIds, assetIds });
  }

  async setVisibility(assetIds: string[], visibility: 'timeline' | 'archive'): Promise<void> {
    await this.json('PUT', '/assets', { ids: assetIds, visibility });
  }

  async runAssetJob(name: 'refresh-metadata' | 'regenerate-thumbnail' | 'transcode-video', assetIds: string[]): Promise<void> {
    await this.json('POST', '/assets/jobs', { name, assetIds });
  }

  /**
   * Pages through metadata search, yielding every matching asset. Abandoning the
   * generator early, which `backfill --limit` does, cancels any request still in
   * flight rather than leaving it to be torn down at exit.
   */
  async *searchAssets(criteria: Record<string, unknown>): AsyncGenerator<Asset> {
    const controller = new AbortController();
    try {
      let page = 1;
      for (;;) {
        const result = await this.json<{ assets: { items: Asset[]; nextPage: number | string | null } }>(
          'POST',
          '/search/metadata',
          { ...criteria, page, size: 200, withExif: true },
          controller.signal,
        );
        const items = result.assets?.items ?? [];
        for (const item of items) yield item;
        const next = result.assets?.nextPage;
        if (!next) return;
        page = Number(next);
        if (!Number.isFinite(page)) return;
        log.debug('search paging', { page });
      }
    } finally {
      controller.abort();
    }
  }
}
