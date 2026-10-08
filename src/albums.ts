import type { BulkIdResult, ImmichClient } from './immich.js';
import { log, errorMessage } from './log.js';

export interface Album {
  id: string;
  albumName: string;
}

/**
 * Every album holding one of the assets, less those excluded by name or id. The
 * server cannot tell an album synced from a phone folder apart from one made by
 * hand, so those have to be named for them to be left alone.
 */
export async function albumsToUpdate(immich: ImmichClient, assetIds: string[], exclude: string[]): Promise<Album[]> {
  const excluded = new Set(exclude.map((entry) => entry.toLowerCase()));
  const byId = new Map<string, Album>();
  for (const albums of await Promise.all(assetIds.map((id) => immich.albumsContaining(id)))) {
    for (const album of albums) {
      if (excluded.has(album.id.toLowerCase()) || excluded.has(album.albumName.toLowerCase())) continue;
      byId.set(album.id, album);
    }
  }
  return [...byId.values()];
}

/**
 * Puts the graded copy in every album holding one of the replaced assets, the
 * original or a graded copy being superseded, and takes those out, so the album
 * shows the graded version in their place. An album only loses an asset once the
 * graded copy is in it, so a failure never leaves a clip missing from an album.
 *
 * Returns how many albums were updated.
 */
export async function replaceInAlbums(
  immich: ImmichClient,
  gradedId: string,
  replacedIds: string[],
  exclude: string[],
  fields: Record<string, unknown>,
): Promise<number> {
  const toReplace = replacedIds.filter((id) => id !== gradedId);
  if (toReplace.length === 0) return 0;

  let albums: Album[];
  try {
    albums = await albumsToUpdate(immich, toReplace, exclude);
  } catch (error) {
    log.warn('could not look up the albums to update', { ...fields, error: errorMessage(error) });
    return 0;
  }

  let updated = 0;
  for (const album of albums) {
    const albumFields = { ...fields, album: album.albumName };
    try {
      const notAdded = failures(await immich.addAssetsToAlbum(album.id, [gradedId]), 'duplicate');
      if (notAdded.length > 0) {
        log.warn('could not add the graded version to an album, leaving the album as it was', { ...albumFields, reason: notAdded.join(',') });
        continue;
      }
      const notRemoved = failures(await immich.removeAssetsFromAlbum(album.id, toReplace), 'not_found');
      if (notRemoved.length > 0) {
        log.warn('added the graded version to an album but could not remove what it replaces', { ...albumFields, reason: notRemoved.join(',') });
      }
      updated += 1;
    } catch (error) {
      log.warn('could not update an album', { ...albumFields, error: errorMessage(error) });
    }
  }

  if (updated > 0) log.info('replaced with the graded version in albums', { ...fields, gradedAssetId: gradedId, albums: updated });
  return updated;
}

function failures(results: BulkIdResult[], expected: BulkIdResult['error']): string[] {
  return results.filter((result) => !result.success && result.error !== expected).map((result) => result.error ?? 'unknown');
}
