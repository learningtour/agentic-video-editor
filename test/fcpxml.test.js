import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFcpXml } from '../server/fcpxml.js';

function fixtureProject(fps = 30) {
  return {
    settings: { width: 1920, height: 1080, fps, sampleRate: 48000 },
    meta: { title: 'Demo & review' },
    media: {
      video: {
        id: 'video', name: 'Source & camera.mov', path: '/tmp/Source & camera.mov',
        type: 'video', duration: 10, hasAudio: true,
      },
      overlay: {
        id: 'overlay', name: 'Quote "overlay".png', path: '/tmp/Quote "overlay".png',
        type: 'image', duration: 0, hasAudio: false,
      },
    },
    tracks: [
      {
        id: 'V2', type: 'video', clips: [
          { id: 'overlay-1', mediaId: 'overlay', start: 4, in: 0, out: 4, speed: 1, label: 'Overlay & title' },
        ],
      },
      {
        id: 'V1', type: 'video', clips: [
          { id: 'video-1', mediaId: 'video', start: 0, in: 0, out: 5, speed: 1, linkId: 'linked' },
          { id: 'video-2', mediaId: 'video', start: 5, in: 5, out: 10, speed: 1, linkId: 'linked' },
        ],
      },
      {
        id: 'A1', type: 'audio', clips: [
          { id: 'audio-1', mediaId: 'video', start: 0, in: 0, out: 5, speed: 1, linkId: 'linked', gain: 0.5 },
          { id: 'audio-2', mediaId: 'video', start: 5, in: 5, out: 10, speed: 1, linkId: 'linked', gain: 0.25 },
        ],
      },
    ],
    markers: [
      { id: 'marker-1', time: 4.5, name: 'First & marker' },
      { id: 'marker-2', time: 5.5, name: 'Second marker' },
    ],
  };
}

test('exports a Final Cut Pro 1.10 timeline with linked audio gain and markers', () => {
  const xml = buildFcpXml(fixtureProject(), { projectName: 'fallback', eventName: 'Agentic export' });

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<!DOCTYPE fcpxml>/);
  assert.match(xml, /<fcpxml version="1\.10">/);
  assert.match(xml, /<event name="Agentic export">/);
  assert.match(xml, /<project name="Demo &amp; review">/);
  assert.match(xml, /frameDuration="1\/30s"/);
  assert.match(xml, /duration="300\/30s" tcStart="0s"/);
  assert.equal((xml.match(/<asset-clip /g) ?? []).length, 2);
  assert.match(xml, /<adjust-volume amount="-6\.02dB"\/>/);
  assert.match(xml, /<adjust-volume amount="-12\.04dB"\/>/);
  assert.match(xml, /value="First &amp; marker"/);
  assert.match(xml, /src="file:\/\/\/tmp\/Source%20&amp;%20camera\.mov"/);
});

test('splits an image overlay at spine edit points and places connected clips before markers', () => {
  const xml = buildFcpXml(fixtureProject());

  assert.match(xml, /<video ref="r3" lane="1" offset="120\/30s" name="Overlay &amp; title" start="0\/30s" duration="30\/30s"\/>/);
  assert.match(xml, /<video ref="r3" lane="1" offset="150\/30s" name="Overlay &amp; title" start="30\/30s" duration="90\/30s"\/>/);

  const firstClip = xml.slice(xml.indexOf('<asset-clip'), xml.indexOf('</asset-clip>'));
  assert.ok(firstClip.indexOf('<video ') < firstClip.indexOf('<marker '));
});

test('uses the exact FCPXML frame duration for common NTSC rates', () => {
  const xml = buildFcpXml(fixtureProject(29.97));
  assert.match(xml, /frameDuration="1001\/30000s"/);
  assert.match(xml, /duration="300300\/30000s" tcStart="0s"/);
  assert.match(xml, /<marker start="135135\/30000s" duration="1001\/30000s"/);
});

test('uses the DTD-compatible sequence audio rate for 44.1 kHz projects', () => {
  const sourceProject = fixtureProject();
  sourceProject.settings.sampleRate = 44100;
  const xml = buildFcpXml(sourceProject);
  assert.match(xml, /audioRate="44\.1k"/);
  assert.doesNotMatch(xml, /audioRate="44k"/);
});

test('anchors connected overlays in the trimmed parent source time', () => {
  const sourceProject = fixtureProject();
  sourceProject.media.video.duration = 20;
  sourceProject.tracks[1].clips = [
    { id: 'video-1', mediaId: 'video', start: 0, in: 10, out: 15, speed: 1, linkId: 'linked' },
  ];
  sourceProject.tracks[2].clips = [
    { id: 'audio-1', mediaId: 'video', start: 0, in: 10, out: 15, speed: 1, linkId: 'linked', gain: 1 },
  ];
  sourceProject.tracks[0].clips = [
    { id: 'overlay-1', mediaId: 'overlay', start: 2, in: 0, out: 2, speed: 1 },
  ];

  const xml = buildFcpXml(sourceProject);
  assert.match(xml, /<video ref="r3" lane="1" offset="360\/30s"[^>]*start="0\/30s" duration="60\/30s"\/>/);
  assert.doesNotMatch(xml, /<video ref="r3" lane="1" offset="60\/30s"/);
});

test('excludes unused media-bin assets and illegal XML control characters', () => {
  const sourceProject = fixtureProject();
  sourceProject.media.unused = {
    id: 'unused', name: 'Unrelated secret.mov', path: '/private/unrelated-secret.mov',
    type: 'video', duration: 4, hasAudio: true,
  };
  sourceProject.meta.title = 'Safe\u0001 title';

  const xml = buildFcpXml(sourceProject);
  assert.doesNotMatch(xml, /unrelated-secret|Unrelated secret/);
  assert.doesNotMatch(xml, /\u0001/);
  assert.match(xml, /<project name="Safe title">/);
});

test('preserves markers in timeline gaps', () => {
  const sourceProject = fixtureProject();
  sourceProject.tracks[1].clips = [sourceProject.tracks[1].clips[0]];
  sourceProject.tracks[2].clips = [sourceProject.tracks[2].clips[0]];
  sourceProject.tracks[0].clips[0].out = 1;
  sourceProject.markers = [{ id: 'marker-gap', time: 7, name: 'Gap marker' }];

  const xml = buildFcpXml(sourceProject);
  assert.match(xml, /<gap name="Gap" offset="150\/30s" start="0s" duration="61\/30s">[\s\S]*<marker start="60\/30s"[^>]*value="Gap marker"\/>[\s\S]*<\/gap>/);
});

test('silences deleted or muted linked audio', () => {
  const mutedProject = fixtureProject();
  mutedProject.tracks[2].muted = true;
  assert.equal((buildFcpXml(mutedProject).match(/amount="-96\.00dB"/g) ?? []).length, 2);

  const deletedProject = fixtureProject();
  deletedProject.tracks[2].clips = [];
  assert.equal((buildFcpXml(deletedProject).match(/amount="-96\.00dB"/g) ?? []).length, 2);
});

test('rejects edits it cannot represent without changing the timeline', () => {
  const retimed = fixtureProject();
  retimed.tracks[1].clips[0].speed = 2;
  assert.throws(() => buildFcpXml(retimed), /retimed spine clips/);

  const splitAudio = fixtureProject();
  splitAudio.tracks[2].clips[0].start = 1;
  assert.throws(() => buildFcpXml(splitAudio), /moved or split linked audio/);

  const envelope = fixtureProject();
  envelope.tracks[2].clips[0].gainKeys = [{ t: 0, gain: 0.5 }];
  assert.throws(() => buildFcpXml(envelope), /audio fades or gain envelopes/);

  const independentAudio = fixtureProject();
  independentAudio.tracks[2].clips.push({
    id: 'music', mediaId: 'video', start: 0, in: 0, out: 2, gain: 1, linkId: 'other',
  });
  assert.throws(() => buildFcpXml(independentAudio), /independent audio clips/);
});

test('requires at least one base video clip', () => {
  const sourceProject = fixtureProject();
  sourceProject.tracks = sourceProject.tracks.filter((track) => track.id !== 'V1');
  assert.throws(
    () => buildFcpXml(sourceProject),
    /requires a base video clip/,
  );
});
