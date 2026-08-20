import { pathToFileURL } from 'url';

const esc = (value) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const clipDuration = (clip) => (clip.out - clip.in) / (clip.speed || 1);
const clipEnd = (clip) => clip.start + clipDuration(clip);
const closeEnough = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 0.001;

function frameTiming(fpsValue) {
  const fps = Math.max(1, Number(fpsValue) || 30);
  const ntscRates = [
    { fps: 23.976, numerator: 1001, denominator: 24000 },
    { fps: 29.97, numerator: 1001, denominator: 30000 },
    { fps: 59.94, numerator: 1001, denominator: 60000 },
  ];
  const ntsc = ntscRates.find((rate) => Math.abs(fps - rate.fps) < 0.01);
  const numerator = ntsc?.numerator ?? 1;
  const denominator = ntsc?.denominator ?? Math.round(fps);
  const actualFps = denominator / numerator;
  const seconds = (value) => {
    const frames = Math.max(0, Math.round((Number(value) || 0) * actualFps));
    return `${frames * numerator}/${denominator}s`;
  };
  return { fps, numerator, denominator, seconds };
}

function resourceXml(media, ref, formatId, timing, sampleRate) {
  const attrs = [
    `id="${ref}"`,
    `name="${esc(media.name)}"`,
    'start="0s"',
    `duration="${media.type === 'image' ? '0s' : timing.seconds(media.duration)}"`,
    'hasVideo="1"',
    `format="${formatId}"`,
  ];
  if (media.hasAudio) {
    attrs.push('hasAudio="1"', 'audioSources="1"', 'audioChannels="2"', `audioRate="${sampleRate}"`);
  }
  return `<asset ${attrs.join(' ')}><media-rep kind="original-media" src="${esc(pathToFileURL(media.path).href)}"/></asset>`;
}

function projectTimelineDuration(sourceProject, frameDuration) {
  const clipsDuration = sourceProject.tracks
    .flatMap((track) => track.clips)
    .reduce((duration, clip) => Math.max(duration, clipEnd(clip)), 0);
  const markersDuration = (sourceProject.markers ?? [])
    .reduce((duration, marker) => Math.max(duration, marker.time + frameDuration), 0);
  return Math.max(clipsDuration, markersDuration);
}

function audioRateName(sampleRate) {
  const rates = new Map([
    [32000, '32k'], [44100, '44.1k'], [48000, '48k'], [88200, '88.2k'],
    [96000, '96k'], [176400, '176.4k'], [192000, '192k'],
  ]);
  const name = rates.get(sampleRate);
  if (!name) throw new Error(`FCPXML export does not support a ${sampleRate} Hz sequence`);
  return name;
}

function trackEnabled(track, peers) {
  const anySolo = peers.some((peer) => peer.solo);
  return !track.muted && (!anySolo || !!track.solo);
}

function assertVisualClipSupported(clip, label) {
  if ((clip.speed ?? 1) !== 1) throw new Error(`FCPXML export does not yet support retimed ${label}`);
  if (clip.fadeIn || clip.fadeOut) throw new Error(`FCPXML export does not yet support fades on ${label}`);
  if (clip.opacity !== undefined || clip.transform) {
    throw new Error(`FCPXML export does not yet support opacity or transforms on ${label}`);
  }
}

function gapXml(start, end, markers, timing) {
  if (end <= start) return '';
  const markerXml = markers
    .filter((marker) => marker.time >= start && marker.time < end)
    .map((marker) => `<marker start="${timing.seconds(marker.time - start)}" duration="${timing.numerator}/${timing.denominator}s" value="${esc(marker.name)}"/>`)
    .join('\n          ');
  return `<gap name="Gap" offset="${timing.seconds(start)}" start="0s" duration="${timing.seconds(end - start)}">${markerXml ? `\n          ${markerXml}\n        ` : ''}</gap>`;
}

export function buildFcpXml(
  sourceProject,
  { projectName = 'project', eventName = 'Agentic Video Editor' } = {},
) {
  if (!sourceProject) throw new Error('FCPXML export requires a project');
  const timing = frameTiming(sourceProject.settings.fps);
  const frameDuration = timing.numerator / timing.denominator;
  const width = sourceProject.settings.width || 1920;
  const height = sourceProject.settings.height || 1080;
  const sampleRate = sourceProject.settings.sampleRate || 48000;
  const formatId = 'r1';
  if ((sourceProject.transitions ?? []).length) {
    throw new Error('FCPXML export does not yet support transitions');
  }
  const videoTracks = sourceProject.tracks.filter((track) => track.type === 'video');
  const enabledVideoTracks = videoTracks.filter((track) => trackEnabled(track, videoTracks));
  const baseTrack = [...enabledVideoTracks].reverse()
    .find((track) => track.clips.some((clip) => sourceProject.media[clip.mediaId]?.type === 'video'));
  if (!baseTrack) throw new Error('FCPXML export requires a base video clip');

  const baseClips = [...baseTrack.clips].sort((a, b) => a.start - b.start);
  for (const clip of baseClips) {
    const media = sourceProject.media[clip.mediaId];
    if (!media || media.type !== 'video') {
      throw new Error('FCPXML export only supports video clips on the primary spine');
    }
    assertVisualClipSupported(clip, 'spine clips');
  }
  for (let index = 1; index < baseClips.length; index++) {
    if (baseClips[index].start < clipEnd(baseClips[index - 1]) - 0.001) {
      throw new Error('FCPXML export does not support overlapping clips on the primary spine');
    }
  }

  const overlayTracks = enabledVideoTracks.filter((track) => track !== baseTrack);
  const overlayEntries = overlayTracks.flatMap((track, trackIndex) => track.clips.map((overlay) => ({ overlay, trackIndex })));
  for (const { overlay } of overlayEntries) {
    if (sourceProject.media[overlay.mediaId]?.type !== 'image') {
      throw new Error('FCPXML export currently supports image overlays only');
    }
    assertVisualClipSupported(overlay, 'image overlays');
  }
  const usedOverlayEntries = overlayEntries.filter(({ overlay }) => baseClips.some(
    (clip) => overlay.start < clipEnd(clip) && clipEnd(overlay) > clip.start,
  ));

  const referencedMediaIds = new Set([
    ...baseClips.map((clip) => clip.mediaId),
    ...usedOverlayEntries.map(({ overlay }) => overlay.mediaId),
  ]);
  const mediaEntries = [...referencedMediaIds].map((mediaId) => sourceProject.media[mediaId]);
  if (mediaEntries.some((media) => !media?.path)) throw new Error('FCPXML export requires file-backed timeline media');
  const refs = new Map(mediaEntries.map((media, index) => [media.id, `r${index + 2}`]));
  const resources = [
    `<format id="${formatId}" name="FFVideoFormat${height}p${Math.round(timing.fps)}" frameDuration="${timing.numerator}/${timing.denominator}s" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>`,
    ...mediaEntries.map((media) => resourceXml(media, refs.get(media.id), formatId, timing, sampleRate)),
  ].join('\n    ');

  const audioTracks = sourceProject.tracks.filter((track) => track.type === 'audio');
  const audioEntries = audioTracks.flatMap((track) => track.clips.map((clip) => ({ clip, track })));
  const matchedAudioIds = new Set();
  const linkedAudioByVideoId = new Map();
  for (const clip of baseClips) {
    const media = sourceProject.media[clip.mediaId];
    if (!media.hasAudio || !clip.linkId) {
      linkedAudioByVideoId.set(clip.id, null);
      continue;
    }
    const candidates = audioEntries.filter(({ clip: audioClip }) => audioClip.linkId === clip.linkId);
    const match = candidates.find(({ clip: audioClip }) => closeEnough(audioClip.start, clip.start)
      && closeEnough(audioClip.in, clip.in)
      && closeEnough(audioClip.out, clip.out)
      && closeEnough(audioClip.speed ?? 1, clip.speed ?? 1));
    if (!match) {
      if (candidates.some(({ track }) => trackEnabled(track, audioTracks))) {
        throw new Error('FCPXML export does not yet support moved or split linked audio');
      }
      linkedAudioByVideoId.set(clip.id, null);
      continue;
    }
    matchedAudioIds.add(match.clip.id);
    if (match.clip.mediaId !== clip.mediaId) throw new Error('FCPXML export requires linked audio from the same media asset');
    if (trackEnabled(match.track, audioTracks) && (match.clip.fadeIn || match.clip.fadeOut || match.clip.gainKeys?.length)) {
      throw new Error('FCPXML export does not yet support audio fades or gain envelopes');
    }
    linkedAudioByVideoId.set(clip.id, trackEnabled(match.track, audioTracks) ? match.clip : null);
  }
  const unsupportedAudio = audioEntries.find(({ clip, track }) => trackEnabled(track, audioTracks) && !matchedAudioIds.has(clip.id));
  if (unsupportedAudio) throw new Error('FCPXML export does not yet support independent audio clips');

  const markers = sourceProject.markers ?? [];
  const assetClipXml = (clip) => {
    const media = sourceProject.media[clip.mediaId];
    const linkedAudio = linkedAudioByVideoId.get(clip.id);
    const gainDb = linkedAudio ? 20 * Math.log10(Math.max(0.000001, linkedAudio.gain ?? 1)) : -96;
    const volumeXml = media.hasAudio ? `<adjust-volume amount="${gainDb.toFixed(2)}dB"/>` : '';

    const overlays = usedOverlayEntries
      .filter(({ overlay }) => sourceProject.media[overlay.mediaId]?.type === 'image'
        && overlay.start < clipEnd(clip)
        && clipEnd(overlay) > clip.start)
      .sort((a, b) => a.overlay.start - b.overlay.start)
      .map(({ overlay, trackIndex }) => {
        const overlayMedia = sourceProject.media[overlay.mediaId];
        const overlapStart = Math.max(overlay.start, clip.start);
        const overlapEnd = Math.min(clipEnd(overlay), clipEnd(clip));
        const overlaySourceStart = overlay.in + (overlapStart - overlay.start);
        const parentSourceOffset = clip.in + (overlapStart - clip.start);
        return `<video ref="${refs.get(overlayMedia.id)}" lane="${trackIndex + 1}" offset="${timing.seconds(parentSourceOffset)}" name="${esc(overlay.label || overlayMedia.name)}" start="${timing.seconds(overlaySourceStart)}" duration="${timing.seconds(overlapEnd - overlapStart)}"/>`;
      })
      .join('\n          ');

    const clipMarkers = markers
      .filter((marker) => marker.time >= clip.start && marker.time < clipEnd(clip))
      .map((marker) => `<marker start="${timing.seconds(clip.in + marker.time - clip.start)}" duration="${timing.numerator}/${timing.denominator}s" value="${esc(marker.name)}"/>`)
      .join('\n          ');

    return `<asset-clip ref="${refs.get(media.id)}" offset="${timing.seconds(clip.start)}" name="${esc(clip.label || media.name)}" start="${timing.seconds(clip.in)}" duration="${timing.seconds(clipDuration(clip))}">
          ${volumeXml}${overlays ? `\n          ${overlays}` : ''}${clipMarkers ? `\n          ${clipMarkers}` : ''}
        </asset-clip>`;
  };

  const duration = projectTimelineDuration(sourceProject, frameDuration);
  const spineItems = [];
  let cursor = 0;
  for (const clip of baseClips) {
    if (clip.start > cursor + 0.001) spineItems.push(gapXml(cursor, clip.start, markers, timing));
    spineItems.push(assetClipXml(clip));
    cursor = clipEnd(clip);
  }
  if (duration > cursor + 0.001) spineItems.push(gapXml(cursor, duration, markers, timing));
  const spine = spineItems.filter(Boolean).join('\n        ');

  const title = sourceProject.meta?.title || projectName;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    ${resources}
  </resources>
  <library>
    <event name="${esc(eventName)}">
      <project name="${esc(title)}">
        <sequence format="${formatId}" duration="${timing.seconds(duration)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="${audioRateName(sampleRate)}">
          <spine>
        ${spine}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
