// Premiere Pro-compatibele projectexport: FCP7-XML (xmeml v4).
// Premiere: Bestand > Importeren > project.xml — mediapaden verwijzen naar de originele bestanden.
import fs from 'fs';
import path from 'path';
import { project, projectDuration, clipEnd, ROOT } from './state.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function pathUrl(p) {
  return 'file://localhost' + encodeURI(p).replace(/#/g, '%23');
}

export function buildPremiereXml() {
  const { width, height, fps, sampleRate } = project.settings;
  const tb = Math.round(fps);
  const ntsc = Math.abs(fps - tb) > 0.01 ? 'TRUE' : 'FALSE'; // 29.97 e.d.
  const toF = (sec) => Math.round(sec * fps);
  const rate = `<rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>`;

  const seenFiles = new Set();
  const fileXml = (m) => {
    const id = `file-${m.id}`;
    if (seenFiles.has(id)) return `<file id="${id}"/>`;
    seenFiles.add(id);
    const dur = toF(m.duration ?? 5);
    let media = '';
    if (m.type === 'video' || m.type === 'image') {
      media += `<video><samplecharacteristics><width>${m.width ?? width}</width><height>${m.height ?? height}</height></samplecharacteristics></video>`;
    }
    if (m.hasAudio || m.type === 'audio') {
      media += `<audio><samplecharacteristics><depth>16</depth><samplerate>${sampleRate}</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>`;
    }
    return `<file id="${id}"><name>${esc(m.name)}</name><pathurl>${esc(pathUrl(m.path))}</pathurl>${rate}<duration>${dur}</duration><media>${media}</media></file>`;
  };

  let itemId = 0;
  const clipItem = (c, mediatype, trackIndex) => {
    const m = project.media[c.mediaId];
    if (!m || m.type === 'title') return ''; // titels hebben geen bronbestand; niet exporteren
    itemId++;
    const src = mediatype === 'audio'
      ? `<sourcetrack><mediatype>audio</mediatype><trackindex>${trackIndex}</trackindex></sourcetrack>`
      : `<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>`;
    // audiovolume meenemen als levels-filter
    const gain = c.gain ?? 1;
    const filter = mediatype === 'audio' && gain !== 1
      ? `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><mediatype>audio</mediatype><effecttype>audiolevels</effecttype><parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${gain.toFixed(4)}</value></parameter></effect></filter>`
      : '';
    return `<clipitem id="clipitem-${itemId}">` +
      `<name>${esc(c.label || m.name)}</name><enabled>TRUE</enabled>` +
      `<duration>${toF(m.duration ?? 5)}</duration>${rate}` +
      `<start>${toF(c.start)}</start><end>${toF(clipEnd(c))}</end>` +
      `<in>${toF(c.in)}</in><out>${toF(c.out)}</out>` +
      fileXml(m) + src + filter +
      `</clipitem>`;
  };

  // videotracks van onder (V1) naar boven (Vn); audiotracks A1..An
  const videoTracks = project.tracks.filter((t) => t.type === 'video').slice().reverse();
  const audioTracks = project.tracks.filter((t) => t.type === 'audio');

  const videoXml = videoTracks.map((t) =>
    `<track>${t.clips.map((c) => clipItem(c, 'video', 1)).join('')}<enabled>TRUE</enabled><locked>FALSE</locked></track>`
  ).join('');
  const audioXml = audioTracks.map((t, i) =>
    `<track>${t.clips.map((c) => clipItem(c, 'audio', 1)).join('')}<enabled>TRUE</enabled><locked>FALSE</locked></track>`
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
<sequence id="sequence-1">
<name>Agentic Video Editor montage</name>
<duration>${toF(projectDuration())}</duration>
${rate}
<media>
<video>
<format><samplecharacteristics>${rate}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>
${videoXml}
</video>
<audio>
<format><samplecharacteristics><depth>16</depth><samplerate>${sampleRate}</samplerate></samplecharacteristics></format>
${audioXml}
</audio>
</media>
<timecode><rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
${(project.markers ?? []).map((m) => `<marker><comment></comment><name>${esc(m.name || '')}</name><in>${toF(m.time)}</in><out>-1</out></marker>`).join('\n')}
</sequence>
</xmeml>
`;
}

export function writePremiereXml(name) {
  const file = path.join(ROOT, 'projects', `${name || process.env.PROJECT || 'project'}.xml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildPremiereXml());
  return file;
}
