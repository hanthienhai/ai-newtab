/** Models offered in Settings, passed to `claude --model`. The first is the default. */
export const MODEL_CHOICES = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
] as const;

export type HomepageModel = (typeof MODEL_CHOICES)[number]["id"];

export const DEFAULT_MODEL: HomepageModel = "claude-haiku-5-5";
