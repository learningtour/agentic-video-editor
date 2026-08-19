// Adobe Audition-sessie (.sesx) uit de montage.
// Audition rekent in samples; de tijdlijn hier in seconden. Alleen de audiotracks
// gaan mee — voor beeld is er de Premiere-XML (xml.js).
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { project, clipEnd, clipLen, activeProjectName, ROOT } from './state.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function channelsOf(m) {
  if (m.channels) return m.channels;
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=channels', '-of', 'default=nw=1:nk=1', m.path], { encoding: 'utf8' });
    m.channels = parseInt(out.trim()) || 1;
  } catch { m.channels = 1; }
  return m.channels;
}

const fader = (id, volume) =>
`          <component componentID="Audition.Fader" id="${id}" name="volume" powered="true">
            <parameter index="0" name="volume" parameterValue="${volume.toFixed(10)}"/>
            <parameter index="1" name="static gain" parameterValue="1"/>
          </component>`;

const mute = (id, muted = false) => {
  const v = muted ? '1' : '0';
  return `          <component componentID="Audition.Mute" id="${id}" name="Mute" powered="true">
            <parameter index="0" parameterValue="${v}"/>
            <parameter index="1" name="mute" parameterValue="${v}"/>
          </component>`;
};

const panner = (id, pan = 0) =>
`          <component componentID="Audition.StereoPanner" id="${id}" name="StereoPanner" powered="true">
            <parameter index="0" name="Pan" parameterValue="${pan}"/>
          </component>`;

export function buildSesx({ outDir } = {}) {
  const sr = project.settings.sampleRate || 48000;
  const channelType = 'stereo';
  const base = outDir || path.join(ROOT, 'projects');

  const files = new Map(); // pad -> {id, channels, rel}
  const fileId = (m) => {
    if (!files.has(m.path)) {
      files.set(m.path, { id: files.size, channels: channelsOf(m), rel: path.relative(base, m.path) });
    }
    return files.get(m.path).id;
  };

  const audioTracks = project.tracks.filter((t) => t.type === 'audio');
  let durationSamples = 1;
  let nextTrackId = 10001;

  const trackXml = audioTracks.map((t, ti) => {
    const tid = nextTrackId++;
    const clips = t.clips.map((c, ci) => {
      const m = project.media[c.mediaId];
      if (!m || m.type === 'title' || m.type === 'image') return '';
      const fid = fileId(m);
      const len = clipLen(c);
      const start = Math.round(c.start * sr);
      const length = Math.round(len * sr);
      const srcIn = Math.round(c.in * sr);
      const end = start + length;
      // Bij snelheid ≠ 1 kent Audition geen bronrek: we schrijven het bronbereik uit
      // en laten de lengte leidend zijn, zodat de clip in elk geval op zijn plek staat.
      const srcOut = srcIn + Math.round((c.out - c.in) * sr);
      durationSamples = Math.max(durationSamples, end);

      const fi = Math.round((c.fadeIn ?? 0) * sr);
      const fo = Math.round((c.fadeOut ?? 0) * sr);
      const fadeIn = `<fadeIn crossFadeLinkType="linkedAsymmetric" endPoint="${fi}" shape="19" startPoint="0" type="log"/>`;
      const foStart = fo > 0 ? length - fo : length;
      const fadeOut = `<fadeOut crossFadeLinkType="linkedAsymmetric" endPoint="${length}" shape="19" startPoint="${foStart}" type="log"/>`;

      const nch = files.get(m.path).channels;
      const chanMap = nch >= 2
        ? '            <channel index="0" sourceIndex="0"/>\n            <channel index="1" sourceIndex="1"/>'
        : '            <channel index="0" sourceIndex="0"/>';

      return `        <audioClip clipAutoCrossfade="true" crossFadeHeadClipID="-1" crossFadeTailClipID="-1" endPoint="${end}" fileID="${fid}" hue="-1" id="${ci}" lockedInTime="false" looped="false" name="${esc(c.label || m.name)}" offline="false" select="false" sourceInPoint="${srcIn}" sourceOutPoint="${srcOut}" startPoint="${start}" zOrder="${ci}">
${fader('clipGain', c.gain ?? 1)}
${mute('clipMute')}
${panner('clipPan')}
          ${fadeIn}
          ${fadeOut}
          <channelMap>
${chanMap}
          </channelMap>
        </audioClip>`;
    }).filter(Boolean).join('\n');

    return `      <audioTrack automationLaneOpenState="false" id="${tid}" index="${ti + 1}" select="false" visible="true">
        <trackParameters trackHeight="133" trackHue="-1" trackMinimized="false">
          <name>${esc(t.name || t.id)}</name>
        </trackParameters>
        <trackAudioParameters audioChannelType="${channelType}" automationMode="1" monitoring="false" recordArmed="false" solo="${t.solo ? 'true' : 'false'}" soloSafe="false">
          <trackOutput outputID="10000" type="trackID"/>
          <trackInput inputID="-1"/>
${fader('trackFader', 1.0)}
${mute('trackMute', !!t.muted)}
${panner('trackPan')}
        </trackAudioParameters>
${clips}
      </audioTrack>`;
  }).join('\n');

  const master = `      <masterTrack automationLaneOpenState="false" id="10000" index="${audioTracks.length + 1}" select="false" visible="true">
        <trackParameters trackHeight="133" trackHue="-1" trackMinimized="false">
          <name>Mix</name>
        </trackParameters>
        <trackAudioParameters audioChannelType="${channelType}" automationMode="1" monitoring="false" recordArmed="false" solo="false" soloSafe="true">
          <trackOutput outputID="1" type="hardwareOutput"/>
          <trackInput inputID="-1"/>
${fader('trackFader', 1.0)}
${mute('trackMute')}
${panner('trackPan')}
        </trackAudioParameters>
      </masterTrack>`;

  const filesXml = [...files.entries()]
    .sort((a, b) => a[1].id - b[1].id)
    .map(([p, f]) => `    <file absolutePath="${esc(p)}" id="${f.id}" mediaHandler="AmioWav" relativePath="${esc(f.rel)}"/>`)
    .join('\n');

  const markers = (project.markers ?? []).map((mk, i) =>
    `      <marker cueType="Cue" description="" duration="0" name="${esc(mk.name || `Marker ${i + 1}`)}" startPoint="${Math.round(mk.time * sr)}" type="cue"/>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<!DOCTYPE sesx>
<sesx version="1.9">
  <session appBuild="24.4.1.3" appVersion="24.4" audioChannelType="${channelType}" bitDepth="24" duration="${durationSamples}" sampleRate="${sr}">
    <name>${esc(activeProjectName())}</name>
    <tracks>
${trackXml}
${master}
    </tracks>
${markers ? `    <markerList>\n${markers}\n    </markerList>\n` : ''}    <sessionState ctiPosition="${Math.round((project.playhead || 0) * sr)}" smpteStart="0">
      <selectionState selectionDuration="0" selectionStart="0"/>
      <viewState horizontalViewDuration="${durationSamples}" horizontalViewStart="0" trackControlsWidth="224" verticalScrollOffset="0"/>
      <timeFormatState beatsPerBar="4" beatsPerMinute="120" customFrameRate="12" linkToDefaultTimeSettings="true" noteLength="4" subdivisions="16" timeCodeDropFrame="false" timeCodeFrameRate="30" timeCodeNTSC="false" timeFormat="timeFormatDecimal"/>
      <mixingOptionState defaultPanModeLogarithmic="false" panPower="-3" playOverlappingClips="false"/>
    </sessionState>
    <clipGroups/>
  </session>
  <files>
${filesXml}
  </files>
</sesx>
`;
}

export function writeSesx(name) {
  const file = path.join(ROOT, 'projects', `${name || activeProjectName()}.sesx`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildSesx({ outDir: path.dirname(file) }));
  return file;
}
