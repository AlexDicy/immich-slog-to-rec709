import type { BulkIdResult, ImmichClient } from './immich.js';
import { log, errorMessage } from './log.js';

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
  fields: Record<string, unknown>,
): Promise<number> {
  const toReplace = replacedIds.filter((id) => id !== gradedId);
  if (toReplace.length === 0) return 0;

  let albumIds: Set<string>;
  try {
    albumIds = new Set((await Promise.all(toReplace.map((id) => immich.albumsContaining(id)))).flat().map((album) => album.id));
  } catch (error) {
    log.warn('could not look up the albums to update', { ...fields, error: errorMessage(error) });
    return 0;
  }

  let updated = 0;
  for (const albumId of albumIds) {
    try {
      const notAdded = failures(await immich.addAssetsToAlbum(albumId, [gradedId]), 'duplicate');
      if (notAdded.length > 0) {
        log.warn('could not add the graded version to an album, leaving the album as it was', { ...fields, albumId, reason: notAdded.join(',') });
        continue;
      }
      const notRemoved = failures(await immich.removeAssetsFromAlbum(albumId, toReplace), 'not_found');
      if (notRemoved.length > 0) {
        log.warn('added the graded version to an album but could not remove what it replaces', { ...fields, albumId, reason: notRemoved.join(',') });
      }
      updated += 1;
    } catch (error) {
      log.warn('could not update an album', { ...fields, albumId, error: errorMessage(error) });
    }
  }

  if (updated > 0) log.info('replaced with the graded version in albums', { ...fields, gradedAssetId: gradedId, albums: updated });
  return updated;
}

function failures(results: BulkIdResult[], expected: BulkIdResult['error']): string[] {
  return results.filter((result) => !result.success && result.error !== expected).map((result) => result.error ?? 'unknown');
}
