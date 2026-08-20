# Agentic Video Editor

A timeline video editor where the browser UI and the HTTP API share **one live state**. Whatever you
drag, trim or cut by hand is immediately readable over the API — and whatever an API client changes
appears in the UI straight away, over a WebSocket, without a refresh.

That makes it a video editor an AI agent can actually operate: it can read the cut, look at a frame,
apply an edit, and see the result — while you are working in the same timeline.

## What it does

- **Timeline editing** — overwrite editing like Premiere: place, move, trim, razor, ripple delete,
  close gaps, snapping per track, linked video+audio.
- **Two monitors** — a source monitor with in/out points and a program monitor that plays the
  composited timeline in real time (layers, opacity, scale/position, titles).
- **Audio** — clip gain, volume envelopes with keyframes, fades, mute/solo/lock per track, VU meter.
- **Transitions** — crossfade, wipe and dip-to-black, dragged onto a cut from the toolbar.
- **Titles** — text overlays as media, trimmable like any other clip.
- **Markers and review notes** — notes at a timecode, in the spirit of Vimeo Review.
- **Versions** — full snapshots of the cut with a message, plus a diff to see what changed.
- **Render** — H.264 / ProRes / WAV / MP3 through ffmpeg, whole timeline or work area.
- **Exchange** — modern Final Cut Pro XML (FCPXML 1.10), Premiere Pro XML (FCP7 xmeml) and an Adobe Audition session (.sesx).
- **Analysis** — scene-change and silence detection, as input for automated edits.
- **Interface in Dutch, English and German.**

## Requirements

- Node.js 20 or newer
- [ffmpeg](https://ffmpeg.org) and ffprobe on your `PATH`

## Getting started

```bash
npm install
npm start          # http://localhost:4720
```

Or as a desktop app:

```bash
npm run app        # Electron; starts the server itself if it is not running yet
```

Import a file, drag it to the timeline, and press space.

## Driving it from a script or an agent

Every edit goes through one endpoint, so a client only has to know `POST /api/command`. Read the
state first — someone may have been editing by hand:

```bash
curl -s localhost:4720/api/summary          # readable overview: media, tracks, clips, ids, playhead
curl -s localhost:4720/api/state            # the full state as JSON
curl -s "localhost:4720/api/frame?t=12.5" -o frame.jpg   # what is on screen at 12.5 s
```

Then edit:

```bash
curl -s -X POST localhost:4720/api/command -H 'Content-Type: application/json' \
  -d '{"cmd":"trimClip","args":{"clipId":"abc1234","edge":"out","time":14.0}}'
```

Every command is a single undo step, so `{"cmd":"undo"}` always gets you back.
The full list of 46 commands and all endpoints is in **[docs/API.md](docs/API.md)**.

## How it is put together

```
server/
  state.js      project state and every edit command — the single source of truth, undo/redo
  media.js      import, ffprobe, thumbnails, filmstrips, waveform peaks
  render.js     export through an ffmpeg filter_complex
  versions.js   snapshots of the cut: save, compare, restore
  analyze.js    scene changes and silences
  fcpxml.js     modern Final Cut Pro XML (FCPXML 1.10)
  xml.js        Premiere Pro XML (FCP7 xmeml)
  sesx.js       Adobe Audition session
  index.js      Express + WebSocket
public/
  js/timeline.js  the timeline: drawing and all mouse interaction
  js/player.js    real-time preview: compositing, audio mixing, VU meter
  js/mediabin.js  media bin and dialogs
  js/source.js    source monitor
  js/notes.js     review notes
  js/versions.js  version dialog
  js/app.js       state, WebSocket, keyboard shortcuts
```

The state lives in `projects/<name>.json` and is written on every change. `media/`, `renders/` and
`projects/` stay out of git.

Tracks are `V1`, `V2`, … and `A1`, `A2`, …; the topmost video track wins on screen.

## Keyboard

| | |
|---|---|
| space | play / pause |
| `V` / `C` | select tool / razor |
| `⌘K` | razor across all tracks at the playhead |
| `⌫` / `⇧⌫` | delete / ripple delete |
| `⌘A` / `⌘C` / `⌘V` / `⌘D` | select all / copy / paste / duplicate |
| `I` / `O` | mark in / out in the source monitor |
| `,` | place the source clip at the playhead |
| `M` / `⇧M` | add / remove marker |
| `N` | note at the playhead |
| `←` / `→` | one frame back / forward (with `⇧`: one second) |
| `Home` | back to the start |
| `⌘Z` / `⇧⌘Z` | undo / redo |
| `+` / `-` / `⇧Z` | zoom in / out / fit |
| `Esc` | clear the selection, back to the select tool |

## Background

This is an isolated, self-contained extract of the timeline core of a larger production editor. The
generative and publishing parts of that project (voice-over, transcription, screen recording,
storyboards, accessibility, uploads) are deliberately not included here: this repository is the
editor itself.

## License

MIT — see [LICENSE](LICENSE).
