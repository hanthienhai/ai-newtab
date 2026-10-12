/** Structured output for the page-picking step. The cap lives in the schema so the model sees it. */
export const PICK_PAGES_SCHEMA = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
      description: "Absolute URLs to open in the user's logged-in browser.",
    },
  },
  required: ["urls"],
  additionalProperties: false,
} as const;

export const DEFAULTS = {
  daysToAnalyze: 14,
  maxResults: 30,
  loadDelayMs: 8000,
  maxPages: 8,
  /** Cap on titles carried per domain in the digest. */
  sampleTitles: 5,
} as const;
