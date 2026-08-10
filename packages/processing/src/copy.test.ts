import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TranscriptEditorialCopyAgent,
  buildDeterministicCopy,
  buildEditorialCopyPrompt,
  buildMomentBrief,
  validateGeneratedCaption,
  validateGeneratedCopy,
  validateGeneratedHeadline,
} from './candidates.js';

const housingTranscript = [
  'New contracts could reset the housing market next quarter.',
  'Borrowers may face higher monthly costs as those agreements come due.',
  'That matters because families are already managing tighter budgets and fewer options.',
].join(' ');

test('deterministic copy is transcript-grounded and keeps the material qualifier', () => {
  const brief = buildMomentBrief(housingTranscript);
  const draft = buildDeterministicCopy(housingTranscript, brief, 0);

  assert.match(draft.headline, /could|may|might|likely/i);
  assert.ok(draft.headline.length <= 68);
  assert.ok(draft.headline.split(/\s+/).length <= 12);
  assert.equal(validateGeneratedCopy(draft, housingTranscript, brief).valid, true);
  assert.doesNotMatch(draft.headline.toLowerCase(), /this changes everything|you won't believe|must watch/);
  assert.doesNotMatch(draft.caption, /#/);
  assert.doesNotMatch(draft.caption, /the clip examines|the key takeaway is|&gt;&gt;|>>/i);
  assert.ok((draft.caption.split(/\r?\n/)[0] ?? '').length <= 125);
  assert.match(draft.caption, /\n\n|[.!?]\s/);
});

test('headline validation rejects unsupported questions, numbers, names, and quotes', () => {
  const transcript = 'The market could shift next year because borrowers face new costs.';
  const brief = buildMomentBrief(transcript);

  assert.ok(validateGeneratedHeadline('Why will housing collapse?', transcript, brief).some((failure) => failure.includes('question headline is not answered')));
  assert.ok(validateGeneratedHeadline('Housing costs rise 400 percent', transcript, brief).some((failure) => failure.includes('number not present')));
  assert.ok(validateGeneratedHeadline('Avery changes the market', transcript, brief).some((failure) => failure.includes('unsupported proper noun')));
  assert.ok(validateGeneratedHeadline('“The market will collapse” today', transcript, brief).some((failure) => failure.includes('quoted headline text is not present')));
  assert.ok(validateGeneratedHeadline('The market could shift next year', transcript, brief).some((failure) => failure.includes('transcript fragment')));
});

test('caption validation enforces context, no hashtags, and no headline repetition', () => {
  const transcript = housingTranscript;
  const brief = buildMomentBrief(transcript);
  const headline = 'Contracts could reset housing';

  assert.ok(validateGeneratedCaption('Contracts could reset housing #housing', headline, transcript, brief).includes('caption contains hashtags'));
  assert.ok(validateGeneratedCaption(headline, headline, transcript, brief).some((failure) => failure.includes('caption is too short')));
  assert.ok(validateGeneratedCaption(
    'Borrowers may face higher monthly costs as those agreements come due,\n\nputting pressure on families already managing tighter budgets and fewer options.',
    headline,
    transcript,
    brief,
  ).length === 0);
});

test('question-led captions use the answered question without copying the transcript verbatim', () => {
  const transcript = 'Why are prices still rising? Supply costs remain elevated and shoppers are paying more at checkout.';
  const result = new TranscriptEditorialCopyAgent().generate({ transcript });

  assert.doesNotMatch(result.caption, /examines why prices are still rising/i);
  assert.match(result.caption, /prices|shoppers|checkout/i);
  assert.ok((result.caption.split(/\r?\n/)[0] ?? '').length <= 125);
  assert.doesNotMatch(result.caption, /#/);
  assert.equal(validateGeneratedCaption(result.caption, result.headline, transcript).length, 0);
});

test('model-backed copy gets one repair attempt and preserves the existing hashtags', () => {
  let calls = 0;
  const model = new TranscriptEditorialCopyAgent(() => {
    calls += 1;
    if (calls === 1) return JSON.stringify({ headline: 'This changes everything', caption: 'Watch this now #viral' });
    return JSON.stringify({
      headline: 'Contracts could reset housing',
      caption: 'Borrowers may face higher monthly costs as those agreements come due,\n\nputting pressure on families already managing tighter budgets and fewer options.',
      supporting_text: ['Borrowers may face higher monthly costs as those agreements come due.'],
      necessary_qualifier: 'could',
    });
  });
  const deterministic = new TranscriptEditorialCopyAgent().generate({ transcript: housingTranscript });
  const repaired = model.generate({ transcript: housingTranscript });

  assert.equal(calls, 2);
  assert.equal(validateGeneratedHeadline(repaired.headline, housingTranscript).length, 0);
  assert.equal(validateGeneratedCaption(repaired.caption, repaired.headline, housingTranscript).length, 0);
  assert.deepEqual(repaired.hashtags, deterministic.hashtags);
});

test('Axios caption prompt accepts hook, primary caption, alternates, and optional CTA output', () => {
  const prompt = buildEditorialCopyPrompt(housingTranscript);
  assert.match(prompt, /You are an Axios social media editor/);
  assert.match(prompt, /HOOK STRATEGY/);
  assert.match(prompt, /primary_caption/);
  assert.match(prompt, /curiosity-driven version/);
  assert.match(prompt, /not a transcript fragment/);

  const result = new TranscriptEditorialCopyAgent(() => JSON.stringify({
    headline: 'Housing costs could rise',
    hook: 'The next housing squeeze may hit monthly budgets first.',
    primary_caption: 'Borrowers may face higher monthly costs as contracts come due. Families are already working with tighter budgets.',
    alternates: {
      curiosity: 'A housing reset could show up in a place many borrowers feel first: the monthly payment.',
      stakes: 'Higher monthly costs could leave families with fewer options as tighter budgets meet new contracts.',
      conversation: 'If monthly costs rise, what gives first for most families: savings, spending or the home itself?',
    },
    optional_cta: 'Watch the clip for the pressure point to watch next.',
  })).generate({ transcript: housingTranscript });

  assert.equal(result.hook, 'The next housing squeeze may hit monthly budgets first.');
  assert.deepEqual(result.alternates, {
    curiosity: 'A housing reset could show up in a place many borrowers feel first: the monthly payment.',
    stakes: 'Higher monthly costs could leave families with fewer options as tighter budgets meet new contracts.',
    conversation: 'If monthly costs rise, what gives first for most families: savings, spending or the home itself?',
  });
  assert.equal(result.optionalCta, 'Watch the clip for the pressure point to watch next.');
});

test('invalid model output falls back to safe deterministic copy without changing hashtags', () => {
  let calls = 0;
  const model = new TranscriptEditorialCopyAgent(() => {
    calls += 1;
    return 'not json';
  });
  const result = model.generate({ transcript: housingTranscript });
  const baseline = new TranscriptEditorialCopyAgent().generate({ transcript: housingTranscript });

  assert.equal(calls, 2);
  assert.ok(result.headline);
  assert.ok(result.caption);
  assert.deepEqual(result.hashtags, baseline.hashtags);
});

test('empty transcript remains safe', () => {
  const result = new TranscriptEditorialCopyAgent().generate({ transcript: '  ' });
  assert.equal(result.hashtags.length, 5);
  assert.ok(result.hashtags.includes('#Axios'));
  assert.equal(result.headline, 'Transcript unavailable');
  assert.equal(result.caption, '');
});
