interface SynthesizePolicyPromptInput {
  prefer: string[];
  avoid: string[];
  title: string;
  kind: 'series' | 'movie';
  seasonNumber?: number;
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
 * states the task (pick exactly ONE release, or declare none viable, honoring the
 * user's freeform Prefer/Avoid preferences verbatim, preferring higher seeders on ties,
 * and returning JSON per the caller's schema), the user prompt lists those preferences
 * as bullets under their own headers and names the target title/season. Pure string
 * building — the numbered candidate list itself is appended by the pick step, not here.
 */
export function synthesizePolicyPrompt(input: SynthesizePolicyPromptInput): PolicyPrompt {
  const system = [
    'You are selecting a single release to download for a media library.',
    "Pick exactly ONE release from the numbered candidate list the user provides, honoring the user's freeform preferences verbatim: favor releases matching the Prefer list and steer away from releases matching the Avoid list.",
    'If no candidate is viable given those preferences, declare none viable instead of forcing a pick.',
    'Avoid entries are strong negative preferences, not absolute bans — pick an avoided release only when every alternative is worse overall, and declare none viable if nothing acceptable remains.',
    'When multiple candidates are otherwise equally good, prefer the one with higher seeders.',
    "Answer with the candidate's number (the # prefix on its line in the list, e.g. 2 for \"#2 [...]\") — not its title or any other identifier.",
    'When you pick, also extract the release group — the fansub/release group name in the picked title, usually bracketed at the start or end — into releaseGroup; use null only if no group is identifiable.',
    'Respond with JSON matching the schema provided — no prose outside the JSON.',
  ].join(' ');

  const target = input.kind === 'series' && input.seasonNumber !== undefined
    ? `${input.title}, Season ${input.seasonNumber}`
    : input.title;

  // Internal newlines are normalized to single spaces so one entry always renders as
  // exactly one bullet — an entry containing a literal newline would otherwise fracture
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

  const sections = [`Target: ${target}`, preferences];
  if (input.hint) {
    // Same internal-newline normalization as a preference entry above, for the same reason:
    // an operator hint pasted from elsewhere shouldn't fracture into multiple lines.
    const normalizedHint = input.hint.replace(/\s*\n\s*/g, ' ');
    sections.push(`Operator hint (from a human reviewing a previous attempt — weigh it heavily):\n${normalizedHint}`);
  }
  const user = sections.join('\n\n');

  return { system, user };
}
