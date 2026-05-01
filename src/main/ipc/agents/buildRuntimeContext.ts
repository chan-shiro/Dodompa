/**
 * Returns a short prompt block that grounds the LLM in the runtime
 * environment of the host machine: today's date, day of week, local
 * time, timezone, and locale.
 *
 * This is generic environmental context, not date-specific guidance.
 * It is consumed by every agent whose decisions can hinge on a
 * relative reference in the user's instruction or in observed page
 * state ("today", "tomorrow", "next Monday", "in N days",
 * "this morning", "Q1 2026", "next week", and so on).
 *
 * Without this block, planners write vacuous post-conditions, the
 * verifier accepts any URL prefix as success, and self-healing cannot
 * tell whether a navigation actually landed on the requested moment.
 * Generated step code itself still computes time at runtime via
 * `new Date()`; this block grounds the surrounding plan, verification,
 * and diagnosis text so they can be checked against actual screen
 * state.
 */
export function buildRuntimeContext(now: Date = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'

  // Format date/time in the user's local timezone, not UTC.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false, weekday: 'long',
    }).formatToParts(now).map(p => [p.type, p.value])
  )
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const time = `${parts.hour}:${parts.minute}`
  const weekday = parts.weekday

  // Timezone offset like +09:00 / -05:00.
  const offsetMin = -now.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const absMin = Math.abs(offsetMin)
  const offset = `${sign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(absMin % 60).padStart(2, '0')}`

  return `
## Runtime context
Current point in time when this task runs:
- Date: ${date} (${weekday})
- Local time: ${time} (timezone ${tz}, UTC${offset})
- Locale: ${locale}

When the user instruction, the step description, or observed page state contains a relative time reference — "today", "tomorrow", "yesterday", "this morning", "tonight", "next Monday", "in N days", "N days from now", "next week", "Q1 2026", "this month", etc. — resolve it against the values above and reference the resulting **absolute** date/time/weekday in your output (plans, post-conditions, action descriptions, code comments, log messages, verification reasoning, failure diagnoses).

Generated step code may still compute the value at runtime via \`new Date()\`. This block grounds the surrounding text so subsequent agents can compare it against the actual screen state.
`
}
