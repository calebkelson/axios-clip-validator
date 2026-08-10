# Phase 3 Editorial Candidate Contract

## Pipeline

```text
transcript_segments
        |
        v
EditorialCandidateProvider
        |
        v
clip_candidates + evidence + social_copy
        |
        v
producer review and timestamp edits
```

`find_moments` runs ingestion, probing, transcription, candidate generation, and persistence in one durable job. A successful job returns `candidateCount`, `candidateProvider`, `transcriptId`, and `nextStep: "producer_review"` in its result.

## Candidate records

Each candidate stores:

- Original `startSeconds` and `endSeconds` selected from transcript boundaries.
- `score`, `confidence`, and a human-readable `rationale`.
- `evidence`, containing the transcript segments that justify the window.
- `socialCopy.headline`, `socialCopy.caption`, and `socialCopy.hashtags`.
- `reviewStatus`: `proposed`, `accepted`, `rejected`, or `edited`.
- Optional edited timestamps, reviewer, notes, and review time.

The social-copy object is deliberately separate from `clip_renders`. It is available to a producer or publishing workflow and is never included in the FFmpeg input automatically.

## Baseline provider

`HeuristicEditorialCandidateProvider` is the local Phase 3 baseline. It favors complete thoughts, hooks/questions, contrasts, concrete numbers, editorial signal words, and target-length windows. It deduplicates overlapping windows and derives copy only from transcript text.

The `EditorialCandidateProvider` interface is the replacement point for a model-backed moment selector. The production provider hard-bounds Find Moments to 30-60 second windows and adds duration-band diversity so a queue does not collapse into near-identical 30-second cuts. Each selected transcript window is passed to the `TranscriptEditorialCopyAgent`, which creates fresh clip-specific headline, caption, and five-hashtag metadata. A future hosted model can implement the `EditorialCopyAgent` interface without changing the candidate or review APIs; it should return the same bounded timestamps, evidence, rationale, confidence, and social-copy shape rather than writing directly to the database.

## Review API

- `GET /v1/jobs/:jobId/candidates`
- `GET /v1/candidates/:candidateId`
- `PATCH /v1/candidates/:candidateId`
- `GET /v1/clips/search?q=...`

Timestamp edits are stored separately from the original candidate window so the initial editorial recommendation remains auditable.
