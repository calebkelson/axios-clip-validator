import pg from 'pg';
import {
  buildCaptionFromTranscript,
  buildEditorialCopyPrompt,
  buildEditorialCopyRepairPrompt,
  buildMomentBrief,
  validateGeneratedCaption,
  validateGeneratedHeadline,
  validateSupportingText,
  type EditorialCopyDraft,
} from '../packages/processing/src/candidates.js';

const connectionString = process.env.DATABASE_URL ?? 'postgres://clipper:clipper@127.0.0.1:5433/clipper';
const dryRun = process.argv.includes('--dry-run');
const modelMode = process.argv.includes('--model');
const titleMode = process.argv.includes('--titles');
const pendingOnly = process.argv.includes('--pending') && !titleMode;
const onlyId = process.argv.find((argument) => argument.startsWith('--id='))?.split('=')[1]?.trim() || null;
const limit = readFlag('limit', Number.POSITIVE_INFINITY);
const concurrency = Math.max(1, Math.min(8, readFlag('concurrency', 4)));
const model = (titleMode ? process.env.OPENAI_TITLE_MODEL : process.env.OPENAI_CAPTION_MODEL) ?? process.env.OPENAI_MODEL ?? process.env.OPENAI_VISUAL_REVIEW_MODEL ?? 'gpt-5';

type CandidateRow = {
  id: string;
  transcript: string | null;
  social_copy: unknown;
};

type ModelRewrite = {
  id: string;
  current: Record<string, unknown>;
  draft: EditorialCopyDraft;
};

function readFlag(name: string, fallback: number) {
  const value = process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split('=')[1];
  const parsed = value ? Number(value) : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function seedFor(id: string) {
  return [...id].reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0, 0);
}

function readSocialCopy(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function constrainFirstLine(value: string) {
  const normalized = value.trim();
  const firstLineEnd = normalized.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? normalized : normalized.slice(0, firstLineEnd);
  if (firstLine.length <= 125) return normalized;
  const splitAt = firstLine.slice(0, 125).lastIndexOf(' ');
  const boundary = splitAt >= 40 ? splitAt : 125;
  const remainder = `${firstLine.slice(boundary).trim()}${firstLineEnd === -1 ? '' : `\n${normalized.slice(firstLineEnd + 1)}`}`.trim();
  return `${firstLine.slice(0, boundary).trim()}\n\n${remainder}`.trim();
}

function parseModelDraft(value: unknown, transcript: string): EditorialCopyDraft | null {
  const response = value as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  try {
    const normalizedContent = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const record = JSON.parse(normalizedContent) as Record<string, unknown>;
    const headline = typeof record.headline === 'string' ? record.headline : typeof record.hook === 'string' ? record.hook : '';
    const caption = typeof record.primary_caption === 'string'
      ? record.primary_caption
      : typeof record.primaryCaption === 'string'
        ? record.primaryCaption
        : typeof record.caption === 'string'
          ? record.caption
          : '';
    if (!headline || !caption) return null;
    const alternates = record.alternates && typeof record.alternates === 'object' ? record.alternates as Record<string, unknown> : null;
    const curiosity = alternates && typeof (alternates.curiosity ?? alternates.curiosity_driven) === 'string' ? String(alternates.curiosity ?? alternates.curiosity_driven) : null;
    const stakes = alternates && typeof (alternates.stakes ?? alternates.stakes_driven) === 'string' ? String(alternates.stakes ?? alternates.stakes_driven) : null;
    const conversation = alternates && typeof (alternates.conversation ?? alternates.conversation_driven) === 'string' ? String(alternates.conversation ?? alternates.conversation_driven) : null;
    const supporting = Array.isArray(record.supporting_text) ? record.supporting_text : Array.isArray(record.supportingText) ? record.supportingText : [];
    const firstEvidence = transcript.split(/(?<=[.!?])\s+/).find((sentence) => sentence.trim().split(/\s+/).length >= 3) ?? transcript;
    return {
      headline,
      caption: constrainFirstLine(caption),
      hashtags: Array.isArray(record.hashtags) ? record.hashtags.filter((item): item is string => typeof item === 'string') : undefined,
      hook: typeof record.hook === 'string' ? record.hook : undefined,
      alternates: curiosity && stakes && conversation ? { curiosity, stakes, conversation } : undefined,
      optionalCta: record.optional_cta === null || record.optionalCta === null ? null : typeof (record.optional_cta ?? record.optionalCta) === 'string' ? String(record.optional_cta ?? record.optionalCta) : undefined,
      supportingText: supporting.some((item) => typeof item === 'string')
        ? supporting.filter((item): item is string => typeof item === 'string')
        : [firstEvidence],
      necessaryQualifier: typeof record.necessary_qualifier === 'string' ? record.necessary_qualifier : null,
    };
  } catch {
    return null;
  }
}

async function callOpenAI(prompt: string) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for --model caption rewrites.');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_completion_tokens: 900,
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

function validateCaptionDraft(draft: EditorialCopyDraft, transcript: string, headline: string, rewriteHeadline = false) {
  if (rewriteHeadline) {
    // Headline models commonly use title case, which makes the shared
    // sentence-style proper-noun and whole-window qualifier checks too noisy
    // for a title that is framing a narrower claim. The prompt still requires
    // source-bound names and qualifiers; keep the objective checks that apply
    // directly to the saved headline here.
    const headlineFailures = validateGeneratedHeadline(draft.headline, transcript, undefined, true)
      .filter((failure) => failure !== 'headline uses an unsupported proper noun' && failure !== 'headline removes a material qualifier');
    const failures = [
      ...headlineFailures,
      ...validateSupportingText(draft.supportingText, transcript),
    ];
    return { valid: failures.length === 0, failures };
  }
  const supportedSource = `${transcript} ${headline}`;
  const failures = [
    ...validateGeneratedCaption(draft.caption, headline || draft.headline, supportedSource),
    ...validateSupportingText(draft.supportingText, transcript),
  ];
  return { valid: failures.length === 0, failures };
}

function buildCaptionRescuePrompt(transcript: string, headline: string, failures: string[], rewriteHeadline = false) {
  const headlineInstruction = rewriteHeadline
    ? 'Create a short editorial headline of 4-12 words. Rephrase the idea and do not copy a contiguous phrase of four or more transcript words. Preserve any material uncertainty or attribution in the transcript, including could, may, might, according to, allegedly, or reportedly. Use no proper name unless the exact name appears in the transcript.'
    : 'Keep the existing headline exactly as provided; do not rewrite it.';
  return `You are an Axios social media editor making one final repair. Return JSON only with exactly two fields: headline and primary_caption. ${headlineInstruction} Write a human, conversational, publish-ready caption in 2 or 3 short sentences, 12-90 words. Lead with the strongest supported angle, add context beyond the headline, and preserve uncertainty such as could, may, or might. Use only facts, names and numbers that appear in the transcript. Do not introduce hashtags, generic clickbait, transcript markers, or unsupported proper names. Do not repeat the headline as the caption opening. The first line must be 125 characters or fewer.

Headline for context:
${headline}

Earlier validation failures:
${failures.map((failure) => `- ${failure}`).join('\n') || '- none'}

CLIP TRANSCRIPT:
${transcript}`;
}

function useExactEvidence(draft: EditorialCopyDraft | null, brief: ReturnType<typeof buildMomentBrief>) {
  return draft ? { ...draft, supportingText: [brief.coreClaim || draft.supportingText?.[0] || draft.caption] } : null;
}

function syncHeadlineCards(value: unknown, headline: string) {
  if (!Array.isArray(value) || !value.length) {
    return [{ id: 'headline-1', text: headline, startSeconds: 0, endSeconds: 3, color: 'navy', shape: 'rounded', xPercent: 50, yPercent: 70, widthPercent: 84, heightPercent: 21, placementCustomized: false }];
  }
  return value.map((card, index) => index === 0 && card && typeof card === 'object' ? { ...(card as Record<string, unknown>), text: headline } : card);
}

async function generateModelDraft(transcript: string, existingHeadline: string, rewriteHeadline = false) {
  const brief = buildMomentBrief(transcript);
  const validationContext = `\n\nEDITORIAL VALIDATION CONTEXT\n- Material qualifier detected in the transcript: ${brief.necessaryQualifier ?? 'none detected'}. If one is detected, the primary_caption must include that exact qualifier word or phrase when making the claim; do not strengthen or remove it.\n- Use names, abbreviations and numbers only when the exact form appears in the transcript. Do not turn “artificial intelligence” into “AI” unless “AI” appears in the transcript.\n- Keep the first line of the primary caption at 125 characters or fewer; use a line break if needed.`;
  const titleValidationContext = rewriteHeadline
    ? `\n- The headline is the field being rewritten. It must be an editorial framing, not a transcript fragment, and it must preserve the material qualifier above when the headline makes that claim.\n- The headline may use only proper names, abbreviations and numbers that appear exactly in the transcript.\n- The headline must not be a raw question, a sentence fragment, or a new claim.`
    : '';
  const initialResponse = await callOpenAI(buildEditorialCopyPrompt(transcript) + validationContext + titleValidationContext);
  const initial = useExactEvidence(parseModelDraft(initialResponse, transcript), brief);
  const initialForValidation = initial ? { ...initial, headline: rewriteHeadline ? initial.headline : existingHeadline || initial.headline } : null;
  const initialValidation = initialForValidation ? validateCaptionDraft(initialForValidation, transcript, existingHeadline, rewriteHeadline) : { valid: false, failures: ['model response was not valid JSON with the requested fields'] };
  if (initialForValidation && initialValidation.valid) return initialForValidation;

  const headlineRequirement = rewriteHeadline
    ? '- Rewrite the headline as a concise editorial framing of the clip. It must not be a raw transcript fragment or copy four consecutive transcript words. Preserve any material uncertainty or attribution, and use no proper name, abbreviation or number unless it appears exactly in the transcript.'
    : '- The headline is not being rewritten; keep it compatible with the existing on-video headline.';
  const repairPrompt = `${buildEditorialCopyRepairPrompt(transcript, initialForValidation, initialValidation.failures)}${validationContext}${titleValidationContext}\n\nSTRICT OUTPUT REQUIREMENTS\nReturn JSON only with exactly these fields: headline, hook, primary_caption, alternates (curiosity, stakes, conversation), optional_cta, supporting_text, necessary_qualifier.\n${headlineRequirement}\n- The hook's first line must be 125 characters or fewer.\n- The primary caption must be 12-90 words, and its first line must be 125 characters or fewer.\n- Preserve every material qualifier from the transcript in the primary caption when relevant.\n- supporting_text must contain one or two exact contiguous excerpts copied from the transcript, including punctuation where possible.\n- Never put hashtags inside captions; optional_cta may be null.`;
  const repairResponse = await callOpenAI(repairPrompt);
  const repaired = useExactEvidence(parseModelDraft(repairResponse, transcript), brief);
  const repairedForValidation = repaired ? { ...repaired, headline: rewriteHeadline ? repaired.headline : existingHeadline || repaired.headline } : null;
  if (repairedForValidation && validateCaptionDraft(repairedForValidation, transcript, existingHeadline, rewriteHeadline).valid) return repairedForValidation;
  const rescueFailures = repairedForValidation ? validateCaptionDraft(repairedForValidation, transcript, existingHeadline, rewriteHeadline).failures : initialValidation.failures;
  const rescueResponse = await callOpenAI(buildCaptionRescuePrompt(transcript, existingHeadline || repaired?.headline || initial?.headline || '', rescueFailures, rewriteHeadline));
  const rescued = useExactEvidence(parseModelDraft(rescueResponse, transcript), brief);
  const rescuedForValidation = rescued ? { ...rescued, headline: rewriteHeadline ? rescued.headline : existingHeadline || rescued.headline } : null;
  if (rescuedForValidation && validateCaptionDraft(rescuedForValidation, transcript, existingHeadline, rewriteHeadline).valid) return rescuedForValidation;
  const finalFailures = rescuedForValidation ? validateCaptionDraft(rescuedForValidation, transcript, existingHeadline, rewriteHeadline).failures : rescueFailures;
  const attemptedHeadlines = [initialForValidation?.headline, repairedForValidation?.headline, rescuedForValidation?.headline].filter(Boolean).join(' | ');
  throw new Error(`model output failed validation: ${finalFailures.join('; ')}${attemptedHeadlines ? ` (attempted headlines: ${attemptedHeadlines})` : ''}`);
}

async function mapWithConcurrency<T, R>(items: T[], workerCount: number, callback: (item: T, index: number) => Promise<R>) {
  const results: R[] = [];
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, () => worker()));
  return results;
}

async function main() {
  if (modelMode && !process.env.OPENAI_API_KEY?.trim()) throw new Error('OPENAI_API_KEY is required for --model caption rewrites.');
  if (titleMode && !modelMode) throw new Error('--titles requires --model.');
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  try {
    const filters = [
      ...(pendingOnly ? ["NOT (c.social_copy ? 'hook')"] : []),
      ...(onlyId ? ['c.id = $1'] : []),
    ];
    const result = await client.query<CandidateRow>(`
      SELECT c.id, c.social_copy,
        string_agg(ts.text, ' ' ORDER BY ts.start_seconds) AS transcript
      FROM clip_candidates c
      LEFT JOIN transcript_segments ts
        ON ts.transcript_id = c.transcript_id
       AND ts.end_seconds > COALESCE(c.edited_start_seconds, c.start_seconds)
       AND ts.start_seconds < COALESCE(c.edited_end_seconds, c.end_seconds)
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      GROUP BY c.id
      ORDER BY c.created_at, c.id
    `, onlyId ? [onlyId] : []);
    const rows = result.rows.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : result.rows.length);
    let skipped = 0;
    let unchanged = 0;
    let failed = 0;
    const updates: ModelRewrite[] = [];

    if (modelMode) {
      await mapWithConcurrency(rows, concurrency, async (row) => {
        if (!row.transcript?.trim()) {
          skipped += 1;
          return null;
        }
        try {
          const current = readSocialCopy(row.social_copy);
          const draft = await generateModelDraft(row.transcript, typeof current.headline === 'string' ? current.headline : '', titleMode);
          updates.push({ id: row.id, current, draft });
          if (updates.length % 25 === 0) console.log(`Generated ${updates.length}/${rows.length} model ${titleMode ? 'titles' : 'captions'}...`);
        } catch (error) {
          failed += 1;
          console.error(`\n${row.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
      });
    } else {
      for (const row of rows) {
        if (!row.transcript?.trim()) {
          skipped += 1;
          continue;
        }
        const current = readSocialCopy(row.social_copy);
        const headline = typeof current.headline === 'string' ? current.headline : '';
        const caption = buildCaptionFromTranscript(row.transcript, seedFor(row.id), headline);
        if (!caption) {
          skipped += 1;
          continue;
        }
        if (caption === current.caption) {
          unchanged += 1;
          continue;
        }
        updates.push({ id: row.id, current, draft: { headline, caption } });
      }
    }

    if (!dryRun) await client.query('BEGIN');
    try {
      for (const update of updates) {
        const current = update.current;
        const nextCopy = titleMode
          ? {
            ...current,
            headline: update.draft.headline,
            headlineCards: syncHeadlineCards(current.headlineCards, update.draft.headline),
          }
          : modelMode
          ? {
            ...current,
            caption: update.draft.caption,
            ...(update.draft.hook ? { hook: update.draft.hook } : {}),
            ...(update.draft.alternates ? { alternates: update.draft.alternates } : {}),
            ...(update.draft.optionalCta !== undefined ? { optionalCta: update.draft.optionalCta } : {}),
            ...(update.draft.hashtags?.length ? { hashtags: update.draft.hashtags.slice(0, 5) } : {}),
          }
          : { ...current, caption: update.draft.caption };
        if (dryRun && updates.indexOf(update) < 8) console.log(`\n${update.id}\nHeadline: ${update.draft.headline}\nCaption: ${update.draft.caption}`);
        if (!dryRun) await client.query('UPDATE clip_candidates SET social_copy = $2::jsonb WHERE id = $1', [update.id, JSON.stringify(nextCopy)]);
      }
      if (!dryRun) await client.query('COMMIT');
    } catch (error) {
      if (!dryRun) await client.query('ROLLBACK');
      throw error;
    }

    const outputLabel = titleMode ? 'titles' : 'captions';
    console.log(`${dryRun ? 'Would rewrite' : 'Rewrote'} ${updates.length} ${modelMode ? 'model ' : ''}${outputLabel} across ${rows.length} selected clips; ${unchanged} already matched, ${skipped} had no usable transcript, and ${failed} failed model validation.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
