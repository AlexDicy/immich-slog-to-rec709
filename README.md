# immich-slog-to-rec709

**This repository uses LLM tools for code generation**

Detects S-Log videos uploaded to [Immich](https://immich.app) and adds a Rec.709 graded version, stacked over the S-Log original so the graded one is what you see in the timeline.

Built for a Sony ZV-E1 shooting S-Log3 / S-Gamut3.Cine.
The detection reads Sony's standard acquisition metadata, so other Sony bodies that write `CaptureGammaEquation` work the same way.

## Why this exists as a separate service

Immich cannot do this on its own, for three reasons worth knowing before you use this.

Its FFmpeg settings are a fixed list (containers, codecs, preset, CRF, resolution, transcode policy, tone mapping, hardware acceleration).
There is no field for custom FFmpeg arguments and no video filter hook, so there is no way to insert a LUT into the transcode.

Its plugin system runs WebAssembly modules under Extism.
A plugin can make HTTP calls but cannot shell out to FFmpeg, so the grading has to happen in a process you run.

Non-destructive edits (`PUT /assets/:id/edits`) only support crop, rotate, and mirror.
There are no color operations.

What Immich does provide is the trigger.
Workflows (3.0 and later) can fire on new uploads, filter by asset type and EXIF camera model, and POST to a webhook.
This service is what sits on the other end of that webhook.

## How it works

```
Upload (phone app, CLI, web, external library)
  |
  +-- Immich workflow: AssetMetadataExtraction
  |     +-- filter: asset type is VIDEO
  |     +-- filter: EXIF model contains ZV-E1
  |     +-- action: webhook POST -> this service
  |
  +-- this service
        +-- GET /assets/:id                     screen out anything already handled
        +-- GET /assets/:id/original            download the clip
        +-- exiftool -ee CaptureGammaEquation   is it actually S-Log?
        +-- ffmpeg lut3d                        apply the Rec.709 LUT
        +-- POST /assets                        upload NAME_rec709.mp4
        +-- POST /stacks                        stack it over the original, graded on top
        +-- PUT /assets/:id/metadata            record what was done
```

Storage cost is roughly double for the clips it touches, because both versions stay in the library.

## Detection

Sony writes the picture profile into the acquisition metadata carried inside the clip, not into the container's color tags:

```
exiftool -ee -api largefilesupport=1 -CaptureGammaEquation -CaptureColorPrimaries clip.MP4
```

S-Log3 clips report `s-log3` or `s-log3-cine`.
Standard clips report `rec709`.

Do not use `ffprobe`'s `color_transfer` for this.
S-Log3 has no assigned transfer-characteristics code in the H.264 or HEVC specs, so the container claims Rec.709 no matter which profile was used.
The Sony metadata is the only reliable signal.

If your uploads arrive with that metadata stripped, `PIXEL_FALLBACK_ENABLED=true` turns on a weaker heuristic based on luma statistics.
Check before relying on it: download a clip back out of Immich and run the exiftool command above on it.

## Setup

1. Create an Immich API key under Account Settings, on the account that owns the videos.

2. Configure and start the service:

   ```
   cp .env.example .env
   # fill in IMMICH_API_KEY and pick a WEBHOOK_TOKEN
   docker compose up -d --build
   docker compose exec slog-grader node dist/index.js selftest
   ```

3. In Immich, go to Administration, Workflows, and create a workflow.
   Switch to the JSON view and paste `workflow.json`, then replace `headerValue` with your `WEBHOOK_TOKEN` and adjust the URL if the service is not on the same Compose network.

4. Test on one clip before turning it loose.
   Set `DRY_RUN=true`, upload an S-Log clip, and confirm the logs show the detection firing.
   Then set it back to `false`.

## Existing clips

The webhook only sees new uploads.
For what is already in the library:

```
docker compose exec slog-grader node dist/index.js backfill --list
docker compose exec slog-grader node dist/index.js backfill --limit 1
docker compose exec slog-grader node dist/index.js backfill
```

`--list` prints candidates without downloading anything.
Start with `--limit 1` and look at the result in Immich before running the whole library.

## Reprocessing

Every asset it touches gets a `slog-grader` metadata key recording the decision, which is also how it avoids doing the same work twice.
To force a clip to be reprocessed, delete that key:

```
curl -X DELETE -H "x-api-key: $IMMICH_API_KEY" \
  "$IMMICH_URL/api/assets/<asset-id>/metadata/slog-grader"
```

Graded uploads are skipped by three independent checks: the `_rec709` filename suffix, the `graded-output` marker written before anything else happens, and the fact that FFmpeg does not copy Sony's acquisition metadata into the output, so the gamma detection finds nothing to act on.

## Notes

The graded file is H.264 High, yuv420p, tagged Rec.709.
With Immich's default `required` transcode policy that means Immich leaves it alone and serves it directly, so there is no second generation of encoding loss.
If your policy is `optimal` or `bitrate`, Immich will also make its own smaller version, which is fine.

`replaceAsset` (`PUT /assets/:id/original`) was removed from the Immich API, so swapping the original in place is not an option.
Overwriting the file in `encoded-video/` does not work either: thumbnails are generated from the original, so the timeline would still show flat gray tiles, and any admin running "Transcode Videos: All" would undo it.
Stacking a second asset is the approach that survives both.

Verified against the Immich API at spec version 3.2.0 and `immich-plugin-core` 2.0.1.

## Configuration

See `.env.example`.
Every setting is an environment variable.

## License

MIT
