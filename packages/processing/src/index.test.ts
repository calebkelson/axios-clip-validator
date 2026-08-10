import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProbeJson, parseTranscriptJson, parseVttTranscript, sanitizeTranscriptText } from './index.js';
import { HeuristicEditorialCandidateProvider } from './candidates.js';
import { createPlatformSourceAdapter, YtDlpSourceAdapter } from './source-adapters.js';

test('probe JSON extracts media metadata', () => {
  const result = parseProbeJson(JSON.stringify({
    format: { duration: '12.5', size: '4096' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, r_frame_rate: '30000/1001' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  }));
  assert.equal(result.durationSeconds, 12.5);
  assert.equal(result.byteSize, 4096);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.equal(result.videoCodec, 'h264');
  assert.equal(result.audioCodec, 'aac');
  assert.ok(result.frameRate && result.frameRate > 29.9 && result.frameRate < 30);
});

test('transcript JSON accepts common Whisper-style segment fields', () => {
  const result = parseTranscriptJson(JSON.stringify({
    language: 'en',
    duration: 4,
    segments: [{ start: 0, end: 2.5, text: '  First point. ' }, { start: 2.5, end: 4, text: 'Second point.' }],
  }));
  assert.deepEqual(result, {
    provider: 'sidecar',
    language: 'en',
    durationSeconds: 4,
    segments: [
      { startSeconds: 0, endSeconds: 2.5, text: 'First point.' },
      { startSeconds: 2.5, endSeconds: 4, text: 'Second point.' },
    ],
  });
});

test('transcript text removes encoded or literal double arrows', () => {
  assert.equal(sanitizeTranscriptText('First point &gt;&gt; second point'), 'First point second point');
  assert.equal(sanitizeTranscriptText('First point >> second point'), 'First point second point');
  assert.deepEqual(parseTranscriptJson(JSON.stringify({
    segments: [
      { start: 0, end: 1, text: ' &gt;&gt; ' },
      { start: 1, end: 3, text: 'Keep this &gt;&gt; sentence.' },
    ],
  })).segments, [{ startSeconds: 1, endSeconds: 3, text: 'Keep this sentence.' }]);
});

test('invalid transcript segments are rejected', () => {
  assert.throws(() => parseTranscriptJson(JSON.stringify({ segments: [{ start: 4, end: 2, text: 'backwards' }] })));
});

test('VTT sidecars remove rolling caption overlap', () => {
  const result = parseVttTranscript([
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:03.000',
    'America faces a rare moment',
    '',
    '00:00:03.000 --> 00:00:03.010',
    'America faces a rare moment',
    '',
    '00:00:03.010 --> 00:00:05.000',
    'America faces a rare moment where we could act',
  ].join('\n'));
  assert.deepEqual(result.segments, [
    { startSeconds: 0, endSeconds: 3, text: 'America faces a rare moment' },
    { startSeconds: 3.01, endSeconds: 5, text: 'where we could act' },
  ]);
});

test('candidate provider creates ranked evidence and social copy', () => {
  const provider = new HeuristicEditorialCandidateProvider({ minSeconds: 3, maxSeconds: 8, maxCandidates: 3 });
  const candidates = provider.generate({
    durationSeconds: 8,
    segments: [
      { startSeconds: 0, endSeconds: 2, text: 'Why did this change happen?' },
      { startSeconds: 2, endSeconds: 4, text: 'Because the impact reached 40 percent.' },
      { startSeconds: 4, endSeconds: 8, text: 'That is the key point for viewers.' },
    ],
  });
  assert.ok(candidates.length > 0);
  assert.ok(candidates[0].score > 0.5);
  assert.ok(candidates[0].evidence.length >= 1);
  assert.ok(candidates.some((candidate) => candidate.evidence.length >= 2));
  assert.doesNotMatch(candidates[0].socialCopy.headline, /Why did this change happen/);
  assert.ok(candidates[0].socialCopy.caption.length > 0);
  assert.ok(candidates[0].socialCopy.hashtags.includes('#Axios'));
  assert.equal(candidates[0].socialCopy.hashtags.length, 5);
  assert.deepEqual(candidates[0].socialCopy.headlineCards[0], {
    id: 'headline-1',
    text: candidates[0].socialCopy.headline,
    startSeconds: 0,
    endSeconds: 3,
    color: 'navy',
    shape: 'rounded',
    xPercent: 50,
    yPercent: 70,
    widthPercent: 84,
    heightPercent: 21,
    placementCustomized: false,
  });
  assert.deepEqual(Object.keys(candidates[0].metadata.scoreDimensions).sort(), [
    'audienceValue',
    'densityAndMomentum',
    'emotionAndTension',
    'hookStrength',
    'novelty',
    'payoffStrength',
    'shareabilityAndQuotability',
    'specificityAndCredibility',
    'standaloneClarity',
  ]);
  assert.equal(candidates[0].metadata.scoringVersion, 'weighted-moment-v2');
});

test('default Find Moments candidates stay within the 30–60 second absolute bounds', () => {
  const provider = new HeuristicEditorialCandidateProvider({ maxCandidates: 4 });
  const candidates = provider.generate({
    durationSeconds: 90,
    segments: Array.from({ length: 9 }, (_, index) => ({
      startSeconds: index * 10,
      endSeconds: (index + 1) * 10,
      text: index === 0 ? 'Why is this changing now?' : `This is the next important point about the policy shift ${index}.`,
    })),
  });
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((candidate) => candidate.endSeconds - candidate.startSeconds >= 30));
  assert.ok(candidates.every((candidate) => candidate.endSeconds - candidate.startSeconds <= 60));
});

test('short source transcripts do not get padded into a Find Moments candidate', () => {
  const provider = new HeuristicEditorialCandidateProvider();
  const candidates = provider.generate({
    durationSeconds: 20,
    segments: [
      { startSeconds: 0, endSeconds: 10, text: 'A short source starts here.' },
      { startSeconds: 10, endSeconds: 20, text: 'There is not enough material for a full candidate.' },
    ],
  });
  assert.deepEqual(candidates, []);
});

test('complete moments shorter than 30 seconds are excluded from Find Moments', () => {
  const candidates = new HeuristicEditorialCandidateProvider().generate({
    durationSeconds: 14,
    segments: [{ startSeconds: 0, endSeconds: 14, text: 'A complete point about why the market is changing now.' }],
  });
  assert.equal(candidates.length, 0);
});

test('Find Moments can carry a question through a payoff after 30 seconds', () => {
  const candidates = new HeuristicEditorialCandidateProvider().generate({
    durationSeconds: 40,
    segments: [
      { startSeconds: 0, endSeconds: 4, text: 'What happens next for the economy?' },
      { startSeconds: 4, endSeconds: 12, text: 'The setup is that companies are changing their plans.' },
      { startSeconds: 12, endSeconds: 22, text: 'Workers are already seeing the first effects.' },
      { startSeconds: 22, endSeconds: 32, text: 'The key is that the policy changes arrive after the market moves.' },
      { startSeconds: 32, endSeconds: 40, text: 'That means the answer is preparation before the disruption spreads.' },
    ],
  });
  const candidate = candidates.find((item) => item.startSeconds === 0);
  assert.ok(candidate);
  assert.ok(candidate.endSeconds >= 32);
  assert.match(candidate.evidence[0].text, /What happens next/);
  assert.match(candidate.evidence.at(-1)?.text ?? '', /answer is preparation/);
});

test('Find Moments keeps a payoff inside the 60 second maximum', () => {
  const candidates = new HeuristicEditorialCandidateProvider().generate({
    durationSeconds: 80,
    segments: Array.from({ length: 8 }, (_, index) => ({
      startSeconds: index * 10,
      endSeconds: (index + 1) * 10,
      text: index === 0
        ? 'Why is this the turning point for the economy?'
        : index === 7
          ? 'The answer is that preparation now determines who benefits later.'
          : `The setup continues with specific market and policy context for stage ${index}.`,
    })),
  });
  const candidate = candidates.find((item) => item.endSeconds >= 60);
  assert.ok(candidate);
  assert.ok(candidate.endSeconds - candidate.startSeconds >= 50);
  assert.ok(candidate.endSeconds - candidate.startSeconds <= 60);
});

test('candidate boundaries do not start or end inside an unresolved sentence', () => {
  const candidates = new HeuristicEditorialCandidateProvider({ minSeconds: 3, maxSeconds: 12 }).generate({
    durationSeconds: 12,
    segments: [
      { startSeconds: 0, endSeconds: 4, text: 'The next shift' },
      { startSeconds: 4, endSeconds: 8, text: 'is already here and companies are reacting' },
      { startSeconds: 8, endSeconds: 12, text: 'because the market moved first now.' },
    ],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].startSeconds, 0);
  assert.equal(candidates[0].endSeconds, 12);
  assert.deepEqual(candidates[0].evidence.map((segment) => segment.text), [
    'The next shift',
    'is already here and companies are reacting',
    'because the market moved first now.',
  ]);
});

test('overlapping candidates with genuinely different claims may remain separate', () => {
  const candidates = new HeuristicEditorialCandidateProvider({ minSeconds: 3, maxSeconds: 60, maxCandidates: 8 }).generate({
    durationSeconds: 60,
    segments: [
      { startSeconds: 0, endSeconds: 5, text: 'Why is the market changing now?' },
      { startSeconds: 5, endSeconds: 15, text: 'The first answer is that new technology is changing how companies work.' },
      { startSeconds: 15, endSeconds: 25, text: 'The evidence is clear in the latest business data.' },
      { startSeconds: 25, endSeconds: 30, text: 'What happens to workers next?' },
      { startSeconds: 30, endSeconds: 40, text: 'The second answer is that workers will need new skills.' },
      { startSeconds: 40, endSeconds: 50, text: 'The consequence is a major training challenge for employers.' },
      { startSeconds: 50, endSeconds: 60, text: 'The conclusion is that policy must move faster.' },
    ],
  });
  assert.ok(candidates.some((candidate) => candidate.startSeconds === 0));
  assert.ok(candidates.some((candidate) => candidate.startSeconds >= 25));
  assert.ok(candidates.length <= 8);
});

test('empty, malformed, and repeated generation inputs are safe and deterministic', () => {
  const provider = new HeuristicEditorialCandidateProvider();
  assert.deepEqual(provider.generate({ durationSeconds: 30, segments: [] }), []);
  assert.deepEqual(provider.generate({ durationSeconds: 30, segments: [
    { startSeconds: 4, endSeconds: 4, text: 'zero length' },
    { startSeconds: 8, endSeconds: 2, text: 'backwards' },
    { startSeconds: Number.NaN, endSeconds: 3, text: 'invalid start' },
  ] }), []);

  const input = {
    durationSeconds: 30,
    segments: [
      { startSeconds: 0, endSeconds: 10, text: 'Why is this change important?' },
      { startSeconds: 10, endSeconds: 20, text: 'The answer is that the effects are already visible.' },
      { startSeconds: 20, endSeconds: 30, text: 'That is the consequence for viewers.' },
    ],
  };
  const first = provider.generate(input);
  const second = provider.generate(input);
  assert.deepEqual(second, first);
  assert.ok(first.every((candidate) => candidate.endSeconds - candidate.startSeconds <= 90));
});

test('social copy avoids transcript fragments and uses topical hashtags', () => {
  const provider = new HeuristicEditorialCandidateProvider({ minSeconds: 3, maxSeconds: 8, maxCandidates: 1 });
  const candidate = provider.generate({
    durationSeconds: 8,
    segments: [
      { startSeconds: 0, endSeconds: 2, text: 'ugly. One of the distinguishing characteristics of AI is that' },
      { startSeconds: 2, endSeconds: 4, text: 'characteristics of AI is that we know what is coming.' },
      { startSeconds: 4, endSeconds: 8, text: 'Turns out it happened quicker and better.' },
    ],
  })[0];
  assert.ok(candidate);
  assert.notEqual(candidate.socialCopy.headline.toLowerCase(), 'ugly');
  assert.match(candidate.socialCopy.headline, /AI/i);
  assert.ok(candidate.socialCopy.hashtags.includes('#AI'));
  assert.equal(candidate.socialCopy.hashtags.length, 5);
});

test('overlapping candidates receive distinct editorial headline variants', () => {
  const provider = new HeuristicEditorialCandidateProvider({ minSeconds: 3, maxSeconds: 8, maxCandidates: 3 });
  const candidates = provider.generate({
    durationSeconds: 12,
    segments: [
      { startSeconds: 0, endSeconds: 2, text: 'AI is moving faster than expected.' },
      { startSeconds: 2, endSeconds: 4, text: 'We did not know when the next breakthrough would arrive.' },
      { startSeconds: 4, endSeconds: 6, text: 'The warning signs were visible before it happened.' },
      { startSeconds: 6, endSeconds: 8, text: 'America could have prepared for the shift.' },
      { startSeconds: 8, endSeconds: 10, text: 'The labor market is changing quickly.' },
      { startSeconds: 10, endSeconds: 12, text: 'Workers will feel the effects first.' },
    ],
  });
  assert.ok(new Set(candidates.map((candidate) => candidate.socialCopy.headline)).size > 1);
});

test('each selected candidate carries evidence from its own transcript window', () => {
  const provider = new HeuristicEditorialCandidateProvider({ minSeconds: 3, maxSeconds: 8, maxCandidates: 3 });
  const candidates = provider.generate({
    durationSeconds: 12,
    segments: [
      { startSeconds: 0, endSeconds: 4, text: 'AI is changing how companies build software.' },
      { startSeconds: 4, endSeconds: 8, text: 'Workers will need new skills as the labor market changes.' },
      { startSeconds: 8, endSeconds: 12, text: 'Congress is debating a new policy for the technology sector.' },
    ],
  });
  assert.ok(candidates.length >= 2);
  assert.equal(new Set(candidates.map((candidate) => `${candidate.startSeconds}:${candidate.endSeconds}`)).size, candidates.length);
  assert.ok(candidates.every((candidate) => candidate.evidence.length > 0 && candidate.socialCopy.caption.length > 0));
});

test('platform source adapter is opt-in and provider allowlisted', () => {
  assert.equal(createPlatformSourceAdapter({ SOURCE_PLATFORM_ADAPTER: 'none' }), null);
  const adapter = createPlatformSourceAdapter({ SOURCE_PLATFORM_ADAPTER: 'yt-dlp', SOURCE_PLATFORM_PROVIDERS: 'youtube,vimeo' });
  assert.ok(adapter);
  assert.equal(adapter?.name, 'yt-dlp');
  assert.equal(adapter?.supports('youtube'), true);
  assert.equal(adapter?.supports('vimeo'), true);
  assert.equal(adapter?.supports('unknown'), false);
  assert.equal(new YtDlpSourceAdapter('yt-dlp', ['TikTok']).supports('tiktok'), true);
});
