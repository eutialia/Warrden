export interface SynthesizePolicyPromptInput {
  tags: string[];
  title: string;
  kind: 'series' | 'movie';
  seasonNumber?: number;
}

export interface PolicyPrompt {
  system: string;
  user: string;
}

/**
 * Builds the system/user prompt pair for the release-pick LLM call: the system prompt
 * states the task (pick exactly ONE release, or declare none viable, honoring the
 * user's freeform preference tags verbatim, preferring higher seeders on ties, and
 * returning JSON per the caller's schema), the user prompt lists those preference tags
 * as bullets and names the target title/season. Pure string building — the numbered
 * candidate list itself is appended by the pick step, not here.
 */
export function synthesizePolicyPrompt(input: SynthesizePolicyPromptInput): PolicyPrompt {
  const system = [
    'You are selecting a single release to download for a media library.',
    "Pick exactly ONE release from the numbered candidate list the user provides, honoring the user's freeform preferences verbatim.",
    'If no candidate is viable given those preferences, declare none viable instead of forcing a pick.',
    'When multiple candidates are otherwise equally good, prefer the one with higher seeders.',
    'Respond with JSON matching the schema provided — no prose outside the JSON.',
  ].join(' ');

  const target = input.kind === 'series' && input.seasonNumber !== undefined
    ? `${input.title}, Season ${input.seasonNumber}`
    : input.title;

  const preferences = input.tags.length > 0
    ? `Preferences:\n${input.tags.map((t) => `- ${t}`).join('\n')}`
    : 'Preferences: none specified.';

  const user = [`Target: ${target}`, preferences].join('\n\n');

  return { system, user };
}
