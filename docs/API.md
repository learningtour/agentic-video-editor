# HTTP API

The UI and the API talk to the same running state. Anything you change over the API shows up in the
browser immediately (pushed over the WebSocket); anything a person changes by hand is visible to the
API on the next read.

Base URL: `http://localhost:4720` (override with `PORT`).

## Read the state first

```bash
curl -s localhost:4720/api/summary        # readable overview: media, tracks, clips, ids, playhead
curl -s localhost:4720/api/state          # the complete state as JSON
curl -s localhost:4720/api/notes          # review notes with their timecodes
```

`/api/summary` is meant to be read by a human or a language model: it lists every clip with its id,
its position on the timeline and its source range, and warns about open review notes.

## Look at the picture

```bash
curl -s "localhost:4720/api/frame?t=12.5" -o frame.jpg
```

Renders the composited timeline at time `t` (seconds) as a JPEG. This is how a client checks what is
actually on screen instead of guessing from the state.

## Import media

```bash
# by path (scripts, agents)
curl -s -X POST localhost:4720/api/import -H 'Content-Type: application/json' \
  -d '{"paths": ["/path/to/video.mp4"]}'

# by upload (multipart, used by drag & drop in the browser)
curl -s -X POST localhost:4720/api/upload -F "files=@video.mp4"
```

Thumbnails, filmstrips and waveform peaks are generated in the background; the UI updates when they
are ready.

## Edit

Everything goes through one endpoint:

```bash
curl -s -X POST localhost:4720/api/command -H 'Content-Type: application/json' \
  -d '{"cmd": "...", "args": {...}}'
```

Times are in seconds (float). Clip and media ids come from `/api/summary`. Every command is a single
undo step.

### Clips

| cmd | args | what it does |
|---|---|---|
| `addClip` | `{mediaId, trackId, start, in?, out?, linkAudio?, audioTrackId?}` | place a clip (overwrite editing); video with audio also gets a linked audio clip |
| `moveClip` | `{clipId, trackId?, start, withLinked?}` | move a clip; linked audio moves along |
| `moveClips` | `{clipIds: [], delta, withLinked?}` | shift a group by the same delta, tracks unchanged |
| `trimClip` | `{clipId, edge: "in"\|"out", time, withLinked?}` | trim the left or right edge to a timeline time |
| `splitClip` | `{clipId, time}` | cut one clip at a time |
| `splitAt` | `{time, trackIds?}` | razor across all tracks at a time |
| `deleteClip` | `{clipId, withLinked?, ripple?}` | delete (`ripple: true` closes the gap) |
| `rippleDelete` | `{clipId}` | delete and close the gap |
| `closeGap` | `{trackId, time}` | pull the gap at that spot closed across all unlocked tracks |
| `cutRange` | `{start, end, trackIds?, ripple?}` | cut a time range out of the timeline |
| `cutRanges` | `{ranges: [{start, end}], trackIds?, ripple?}` | several ranges in one undo step |
| `duplicateClips` | `{clipIds: [], atTime?}` | copy clips to a time, keeping their spacing and properties |
| `setClipLabel` | `{clipId, label}` | a readable name on the clip |
| `setClipProps` | `{clipId, speed?, opacity?, scale?, x?, y?, withLinked?}` | speed 0.25–4 (length follows), opacity 0–1, scale and position for picture-in-picture (`x`/`y` as a fraction of the frame) |

**Cross dissolve**: put clip B on a higher video track, overlapping clip A, and give B a `fadeIn` —
the layers are composited.

### Audio

| cmd | args | what it does |
|---|---|---|
| `setClipGain` | `{clipId, gain}` | volume 0–4 (1 = unity) |
| `setClipGainKeys` | `{clipId, keys: [{t, gain}]}` | volume envelope; `t` is seconds within the clip, interpolated linearly on top of `gain`. An empty list removes it |
| `setClipFade` | `{clipId, fadeIn?, fadeOut?, withLinked?}` | fades in seconds (video from/to black, audio ramp) |

Ducking music under a voice is `setClipGainKeys` on the music clip.

### Transitions

| cmd | args | what it does |
|---|---|---|
| `addTransition` | `{trackId, time, type: "crossfade"\|"wipe"\|"dip", dur?, withLinked?}` | a transition on a cut; A and B have to meet, and the window is clamped to the available source material |
| `removeTransition` | `{transitionId?\|nearTime?, trackId?}` | remove |
| `editTransition` | `{transitionId, dur?, type?}` | change duration or type |

Transitions are anchored to an absolute time. If you move the clips around them, remove and re-add.

### Tracks

| cmd | args | what it does |
|---|---|---|
| `addTrack` / `removeTrack` | `{type: "video"\|"audio", name?}` / `{trackId}` | manage tracks |
| `setTrackFlags` | `{trackId, muted?, solo?, locked?, magnetic?}` | mute/solo (preview and render), lock (edits refused), magnetic snapping |
| `setTrackName` | `{trackId, name}` | a readable name |

### Titles

| cmd | args | what it does |
|---|---|---|
| `addTitle` | `{text, pos?: "onder"\|"midden"\|"boven", size?, color?, bg?, name?}` | creates title media; place it with `addClip` on a video track |
| `editTitle` | `{mediaId, text?, pos?, size?, color?, bg?}` | change a title; every clip using it follows |

### Markers and review notes

| cmd | args | what it does |
|---|---|---|
| `addMarker` / `removeMarker` / `editMarker` | `{time, name?, color?}` / `{markerId?\|nearTime?}` / `{markerId, …}` | markers on the ruler (they travel into the Premiere XML) |
| `addNote` | `{time, text, author?}` | a review note at a time |
| `editNote` | `{noteId, text?, time?, done?, antwoord?}` | update; `done: true` marks it handled, `antwoord` is your reply |
| `removeNote` | `{noteId}` | remove |

### Media, project and history

| cmd | args | what it does |
|---|---|---|
| `replaceMedia` | `{fromMediaId, toMediaId, trackIds?}` | point every clip at another file, keeping in/out. The replacement must be at least as long |
| `removeMedia` | `{mediaId}` | remove from the bin |
| `setMediaText` | `{mediaId, text?, prompt?, kind?, clear?}` | record source text or a prompt on a media item |
| `setMediaSpeaker` | `{mediaId, speaker}` | attach a speaker name to a microphone track |
| `setPlayhead` / `setSelection` | `{time}` / `{clipIds: []}` | move the playhead, set the selection (the UI follows live) |
| `setWorkArea` / `clearWorkArea` | `{start?, end?}` / `{}` | the work area used for rendering |
| `setSettings` | `{settings: {width, height, fps}}` | project settings |
| `setProjectMeta` | `{meta: {title?, client?, description?, kind?}}` | project properties |
| `newProject` | `{settings?}` | empty timeline (the media bin stays) |
| `undo` / `redo` | `{}` | history |

## Versions

A version is a full snapshot of the cut with a message. Take one before any large change.

```bash
curl -s localhost:4720/api/versions                       # newest first
curl -s -X POST localhost:4720/api/versions/commit  -H 'Content-Type: application/json' \
  -d '{"message": "before reordering chapters"}'
curl -s "localhost:4720/api/versions/diff?a=<id>&b=nu"    # what changed since
curl -s -X POST localhost:4720/api/versions/restore -H 'Content-Type: application/json' -d '{"id": "<id>"}'
curl -s -X POST localhost:4720/api/versions/remove  -H 'Content-Type: application/json' -d '{"id": "<id>"}'
```

Restoring saves the current state first and can also be undone with `undo`. `diff` reports per clip
whether it was added, removed, moved, trimmed or changed — useful to confirm nothing got lost after a
big edit.

## Analysis

```bash
curl -s "localhost:4720/api/analyze/scenes?mediaId=abc&threshold=0.3"
curl -s "localhost:4720/api/analyze/silence?mediaId=abc&noise=-35&minDur=0.6"
```

Scene changes come back as an array of times; silences as `[{start, end, dur}]`. Analysis decodes the
whole file, so pass `start` and `duration` for long ones.

Chopping a rough take into scenes is: place the clip, then `splitClip` at every scene time (plus the
clip's start offset). Cutting silences out is: `cutRanges` with the silence ranges.

## Render

```bash
curl -s -X POST localhost:4720/api/render -H 'Content-Type: application/json' \
  -d '{"name": "cut", "preset": "mp4", "useWorkArea": false}'
curl -s localhost:4720/api/render/status    # {running, progress 0-1, out, error}
```

Presets: `mp4` (H.264, or pass `bitrateM`), `mp4_hq`, `prores` (.mov), `wav`, `mp3`.
Range: `useWorkArea: true` or an explicit `range: {start, end}`. Output lands in `renders/`.

## Projects

```bash
curl -s localhost:4720/api/projects
curl -s localhost:4720/api/projects/info
curl -s -X POST localhost:4720/api/projects/open   -H 'Content-Type: application/json' -d '{"name": "project"}'
curl -s -X POST localhost:4720/api/projects/saveAs -H 'Content-Type: application/json' -d '{"name": "copy"}'
curl -s -X POST localhost:4720/api/projects/new    -H 'Content-Type: application/json' -d '{"name": "new"}'
curl -s -X POST localhost:4720/api/projects/rename -H 'Content-Type: application/json' -d '{"name": "other"}'
```

Projects live in `projects/<name>.json`. `PROJECT=<name>` in the environment overrides which one is
opened at startup.

## Exchange with other editors

```bash
curl -s localhost:4720/api/export.xml  -o project.xml    # Premiere Pro (FCP7 xmeml)
curl -s localhost:4720/api/export.sesx -o project.sesx   # Adobe Audition session
```

The XML refers to the original media files. The Audition session carries the audio tracks with their
names, clip volumes and fades; picture does not travel with it.

## WebSocket

Connect to `ws://localhost:4720`. On connect you get `{type: "state", state: {...}}`, and after that
a new `state` message on every change, plus `{type: "render", status}` while rendering.

Clients may send `{type: "playhead", time}` and `{type: "selection", clipIds}` — these are volatile
updates, broadcast to the other clients without creating an undo step.

## Settings

```bash
curl -s localhost:4720/api/config
curl -s -X POST localhost:4720/api/config -H 'Content-Type: application/json' -d '{"uiLanguage": "en"}'
```

`config.json` holds preferences only: the interface language (`nl`, `en`, `de`) and the last opened
project. It is not tracked in git.
