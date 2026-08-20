import { pathToFileURL } from 'url';

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const clipDuration = (clip) => (clip.out - clip.in) / (clip.speed || 1);
const clipEnd = (clip) => clip.start + clipDuration(clip);

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

function projectTimelineDuration(sourceProject) {
  return sourceProject.tracks
    .flatMap((track) => track.clips)
    .reduce((duration, clip) => Math.max(duration, clipEnd(clip)), 0);
}

export function buildFcpXml(
  sourceProject,
  { projectName = 'project', eventName = 'Agentic Video Editor' } = {},
) {
  if (!sourceProject) throw new Error('FCPXML export requires a project');
  const timing = frameTiming(sourceProject.settings.fps);
  const width = sourceProject.settings.width || 1920;
  const height = sourceProject.settings.height || 1080;
  const sampleRate = sourceProject.settings.sampleRate || 48000;
  const formatId = 'r1';
  const mediaEntries = Object.values(sourceProject.media)
    .filter((media) => media.path && (media.type === 'video' || media.type === 'image'));
  const refs = new Map(mediaEntries.map((media, index) => [media.id, `r${index + 2}`]));
  const resources = [
    `<format id="${formatId}" name="FFVideoFormat${height}p${Math.round(timing.fps)}" frameDuration="${timing.numerator}/${timing.denominator}s" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>`,
    ...mediaEntries.map((media) => resourceXml(media, refs.get(media.id), formatId, timing, sampleRate)),
  ].join('\n    ');

  const videoTracks = sourceProject.tracks.filter((track) => track.type === 'video');
  const baseTrack = [...videoTracks].reverse()
    .find((track) => track.clips.some((clip) => sourceProject.media[clip.mediaId]?.type === 'video'));
  if (!baseTrack) throw new Error('FCPXML export requires a base video clip');

  const overlayTracks = videoTracks.filter((track) => track !== baseTrack);
  const audioClips = sourceProject.tracks
    .filter((track) => track.type === 'audio')
    .flatMap((track) => track.clips);

  const spine = baseTrack.clips.map((clip) => {
    const media = sourceProject.media[clip.mediaId];
    if (!media || media.type !== 'video') return '';

    const linkedCandidates = clip.linkId
      ? audioClips.filter((audioClip) => audioClip.linkId === clip.linkId)
      : [];
    const linkedAudio = linkedCandidates.find((audioClip) => Math.abs(audioClip.start - clip.start) < 0.001)
      ?? linkedCandidates[0];
    const gainDb = 20 * Math.log10(Math.max(0.000001, linkedAudio?.gain ?? 1));

    const overlays = overlayTracks
      .flatMap((track, trackIndex) => track.clips.map((overlay) => ({ overlay, trackIndex })))
      .filter(({ overlay }) => sourceProject.media[overlay.mediaId]?.type === 'image'
        && overlay.start < clipEnd(clip)
        && clipEnd(overlay) > clip.start)
      .sort((a, b) => a.overlay.start - b.overlay.start)
      .map(({ overlay, trackIndex }) => {
        const overlayMedia = sourceProject.media[overlay.mediaId];
        const overlapStart = Math.max(overlay.start, clip.start);
        const overlapEnd = Math.min(clipEnd(overlay), clipEnd(clip));
        const sourceStart = overlay.in + (overlapStart - overlay.start) * (overlay.speed || 1);
        return `<video ref="${refs.get(overlayMedia.id)}" lane="${trackIndex + 1}" offset="${timing.seconds(overlapStart)}" name="${esc(overlay.label || overlayMedia.name)}" start="${timing.seconds(sourceStart)}" duration="${timing.seconds(overlapEnd - overlapStart)}"/>`;
      })
      .join('\n          ');

    const markers = (sourceProject.markers ?? [])
      .filter((marker) => marker.time >= clip.start && marker.time < clipEnd(clip))
      .map((marker) => `<marker start="${timing.seconds(clip.in + marker.time - clip.start)}" duration="${timing.numerator}/${timing.denominator}s" value="${esc(marker.name)}"/>`)
      .join('\n          ');

    return `<asset-clip ref="${refs.get(media.id)}" offset="${timing.seconds(clip.start)}" name="${esc(clip.label || media.name)}" start="${timing.seconds(clip.in)}" duration="${timing.seconds(clipDuration(clip))}">
          <adjust-volume amount="${gainDb.toFixed(2)}dB"/>${overlays ? `\n          ${overlays}` : ''}${markers ? `\n          ${markers}` : ''}
        </asset-clip>`;
  }).filter(Boolean).join('\n        ');

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
        <sequence format="${formatId}" duration="${timing.seconds(projectTimelineDuration(sourceProject))}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="${Math.round(sampleRate / 1000)}k">
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
