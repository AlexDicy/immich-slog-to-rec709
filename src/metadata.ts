import type { Config } from './config.js';
import type { ExifInfo } from './immich.js';
import { run } from './exec.js';
import { log, errorMessage } from './log.js';

/**
 * Writes what Immich knows about the source onto the graded file.
 *
 * FFmpeg carries the container tags over, which covers the dates, but the camera,
 * exposure, and GPS values live in the timed metadata track it does not copy. That
 * track could not be copied verbatim anyway: it states the clip is S-Log3, which
 * the graded file is not, and re-detection would then act on it. So the values are
 * written back as ordinary EXIF and XMP instead, under the exact tag names Immich
 * reads when it extracts metadata from the upload.
 *
 * The GPS pair matters for more than the map pin. Immich infers the time zone from
 * the coordinates, and without them it falls back to UTC, which leaves the graded
 * copy displaying a different time than the original it is stacked with.
 *
 * exiftool puts these in an XMP box after moov, so faststart survives, but it does
 * rewrite the file to insert it.
 */
export async function writeSourceMetadata(
  config: Config,
  targetPath: string,
  exif: ExifInfo | null | undefined,
): Promise<void> {
  if (!exif) return;

  const args: string[] = [];
  const add = (tag: string, value: string | number | null | undefined): void => {
    if (value === null || value === undefined || value === '') return;
    args.push(`-${tag}=${value}`);
  };

  add('Make', exif.make);
  add('Model', exif.model);
  add('LensModel', exif.lensModel);
  add('ISO', exif.iso);
  add('FNumber', exif.fNumber);
  add('ExposureTime', exif.exposureTime);
  add('FocalLength', exif.focalLength);
  add('Description', exif.description);
  add('Rating', exif.rating);

  // exiftool takes the hemisphere separately, so the sign is split off here.
  if (typeof exif.latitude === 'number' && typeof exif.longitude === 'number') {
    add('GPSLatitude', Math.abs(exif.latitude));
    add('GPSLatitudeRef', exif.latitude >= 0 ? 'N' : 'S');
    add('GPSLongitude', Math.abs(exif.longitude));
    add('GPSLongitudeRef', exif.longitude >= 0 ? 'E' : 'W');
  }

  if (args.length === 0) return;

  try {
    await run(
      config.exiftoolPath,
      ['-api', 'largefilesupport=1', ...args, '-overwrite_original', targetPath],
      { timeoutMs: 30 * 60 * 1000 },
    );
    log.debug('wrote the source metadata onto the graded file', { tags: args.length });
  } catch (error) {
    // The graded video is still worth uploading without this.
    log.warn('could not write the source metadata onto the graded file', { error: errorMessage(error) });
  }
}
