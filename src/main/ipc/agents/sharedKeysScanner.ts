// ─── ctx.shared write scanner ───
// Static-scans generated step code to find which ctx.shared.xxx keys the step
// writes to. This metadata is persisted on StepMeta.producedSharedKeys at the
// moment a step transitions to stable, and is later read by planningAgent so
// that regenerations plan only the delta instead of duplicating work.
//
// Intentionally lightweight — regex-based, not an AST parse. The goal is to
// catch the common forms the codegen agent actually produces, not every
// possible JS assignment target.

/**
 * Matched patterns (examples):
 *   ctx.shared.foo = ...
 *   ctx.shared.foo ??= ...
 *   ctx.shared['foo'] = ...
 *   ctx.shared["foo"] = ...
 *   Object.assign(ctx.shared, { foo: ..., bar: ... })
 *
 * NOT matched (rare / ambiguous):
 *   const s = ctx.shared; s.foo = ...   (indirect write through alias)
 *   destructure: ({ foo } = ctx.shared) (this is a read, not a write anyway)
 */
export function extractProducedSharedKeys(code: string): string[] {
  if (!code) return []
  const keys = new Set<string>()

  // Direct property assignment: ctx.shared.name = / ctx.shared.name ??= / ctx.shared.name +=
  for (const m of code.matchAll(/ctx\.shared\.(\w+)\s*(?:=|\?\?=|\|\|=|\+=)/g)) {
    keys.add(m[1])
  }

  // Bracket notation with string literal: ctx.shared['name'] = / ctx.shared["name"] =
  for (const m of code.matchAll(/ctx\.shared\[\s*['"]([^'"]+)['"]\s*\]\s*(?:=|\?\?=|\|\|=|\+=)/g)) {
    keys.add(m[1])
  }

  // Object.assign(ctx.shared, { a: ..., b: ... }) — pull object-literal keys
  // from the argument. Only handles a single object literal argument.
  for (const m of code.matchAll(/Object\.assign\s*\(\s*ctx\.shared\s*,\s*\{([^}]*)\}/g)) {
    const body = m[1]
    // Match identifier keys and string-literal keys at the start of properties.
    for (const km of body.matchAll(/(?:^|,)\s*(?:(\w+)|['"]([^'"]+)['"])\s*:/g)) {
      const name = km[1] ?? km[2]
      if (name) keys.add(name)
    }
  }

  return [...keys].sort()
}
