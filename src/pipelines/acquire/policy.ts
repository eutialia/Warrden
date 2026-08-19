import type { SeasonMode } from './seasonMode.js';

interface SynthesizePolicyPromptInput {
  prefer: string[];
  avoid: string[];
  title: string;
  kind: 'series' | 'movie';
  seasonNumber?: number;
  mode?: SeasonMode;
  // A human's guidance on a re-pick after a previous attempt (e.g. a rejected pick, or a
  // low-confidence rescue) — see `run.ts`'s `resolveHint` for how this is sourced from
  // `job.payload.hint`. Absent for every ordinary (non-repick) attempt.
  hint?: string;
}

interface PolicyPrompt {
  system: string;
  user: string;
}

/**
 * Builds the system/user prompt pair for the release-pick LLM call: the system prompt
 * states the task (pick exactly ONE release; Prefer is a rank boost; Avoid is semantic;
 * none-viable only for an unusable list), the user prompt lists those preferences as
 * bullets, names the target, and states pack-first vs single-first when a season mode
 * is known. Pure string building: the numbered candidate list is appended by the pick
 * step, not here.
 */
export function synthesizePolicyPrompt(input: SynthesizePolicyPromptInput): PolicyPrompt {
  const system = [
    'You are selecting a single release to download for a media library.',
    'Pick exactly ONE release from the numbered candidate list the user provides.',
    'Prefer entries are rank boosts, never exclusive filters: if nothing matches the Prefer list, pick the best remaining candidate. Do not declare none viable just because a preferred group or keyword is absent.',
    'Avoid entries are strong negative preferences, not absolute bans: pick an avoided release only when every alternative is worse overall.',
    'Dual-audio, multi-audio, Dual, and Multi include the original language and are not original-language-only dubs; do not treat them as an English-dub-only release.',
    'Sonarr language tags often list only the original language even on dual/multi releases. Do not treat a single-language tag as proof the release is not dual.',
    'Declare none viable only when the list is actually unusable (wrong title, CAM, or nothing acceptable remains), not because a Prefer entry is unmatched.',
    'If you declare none viable, a human reviews your reasoning and can override it, so name the concrete defect that disqualifies the candidates.',
    'When multiple candidates are otherwise equally good, prefer the one with higher seeders.',
    'Answer with the candidate\'s number (the # prefix on its line in the list, e.g. 2 for "#2 [...]") — not its title or any other identifier.',
    'When you pick, also extract the release group — the fansub/release group name in the picked title, usually bracketed at the start or end — into releaseGroup; use null only if no group is identifiable.',
    'Respond with JSON matching the schema provided — no prose outside the JSON.',
  ].join(' ');

  const target = input.kind === 'series' && input.seasonNumber !== undefined
    ? `${input.title}, Season ${input.seasonNumber}`
    : input.title;

  // Internal newlines are normalized to single spaces so one entry always renders as
  // exactly one bullet: an entry containing a literal newline would otherwise fracture
  // into multiple bullet-list lines, and the extra ones wouldn't start with "- ".
  const bullets = (header: string, entries: string[]) =>
    `${header}:\n${entries.map((e) => `- ${e.replace(/\s*\n\s*/g, ' ')}`).join('\n')}`;
  // Only the non-empty lists get a header, so a user who filled just one side never sees
  // an empty section; with neither filled the prompt keeps its single "none specified" line.
  const lists = [
    ...(input.prefer.length > 0 ? [bullets('Prefer', input.prefer)] : []),
    ...(input.avoid.length > 0 ? [bullets('Avoid', input.avoid)] : []),
  ];
  const preferences = lists.length > 0 ? lists.join('\n\n') : 'Preferences: none specified.';

  const sections = [`Target: ${target}`];
  if (input.mode === 'complete') {
    sections.push(
      'Season status: complete. Every episode has aired. Prefer a season pack that covers the whole season. A single-episode release is a fallback only if no acceptable pack remains.',
    );
  } else if (input.mode === 'airing') {
    sections.push(
      'Season status: airing. Some episodes have not aired yet. Prefer a single-episode release for a missing aired episode.',
    );
  }
  sections.push(preferences);
  if (input.hint) {
    // Same internal-newline normalization as a preference entry above, for the same reason:
    // an operator hint pasted from elsewhere shouldn't fracture into multiple lines.
    const normalizedHint = input.hint.replace(/\s*\n\s*/g, ' ');
    sections.push(`Operator hint (from a human reviewing a previous attempt — weigh it heavily):\n${normalizedHint}`);
  }
  const user = sections.join('\n\n');

  return { system, user };
}
