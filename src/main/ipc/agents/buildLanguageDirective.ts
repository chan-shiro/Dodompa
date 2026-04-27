import { resolveUiLanguage } from '../settingsManager'

/**
 * Returns a short prompt block telling the model to produce user-facing output
 * in the user's current UI language. Appended to prompts whose output is
 * displayed to the user (descriptions, summaries, error analyses, category
 * explanations, etc.). Code, JSON field names, and variable identifiers stay
 * English in all cases.
 *
 * Prompts themselves remain English regardless of UI language — only the
 * generated natural-language output varies. This lets a Japanese user see
 * Japanese descriptions, while the LLM still gets a well-tested English
 * system prompt.
 */
export function buildLanguageDirective(lang?: 'en' | 'ja'): string {
  const effective = lang ?? resolveUiLanguage()
  const label = effective === 'ja' ? 'Japanese (日本語)' : 'English'
  return `\n## Output Language\nRespond in ${label}. All user-facing text in your output — descriptions, explanations, error analyses, category names, messages, summaries — MUST be in ${label}. Code, JSON field names, identifiers, and variable names remain in English.\n`
}
