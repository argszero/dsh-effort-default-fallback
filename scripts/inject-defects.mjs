/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and it is reported as a failure of
 * this harness rather than hidden.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first: a
 * mutation that is never compiled is a mutation the suite cannot see, and a
 * mutation that does not compile is reported as TYPEFAIL, because it never
 * reached the suite either.
 *
 * Every arm below is a defect this plugin could plausibly have shipped — one
 * distinction it exists to make, removed one edit at a time. They are not
 * "does the test file import the module": each one deletes a rule the plugin
 * states in prose to its users, so a SILENT arm is a promise the package makes
 * that nothing checks.
 *
 * The arms this package would be *worthless* without are:
 *
 * - the **allowlist** — the plugin decides nothing on its own, and every arm
 *   here that widens the scope turns "a plugin that answers for the routes you
 *   listed" into something else;
 * - the **ladder** — publishing a level a route does not admit converts a
 *   silent `off` into a terminal `UNSUPPORTED_REASONING_EFFORT`, which is worse
 *   than the failure this package removes;
 * - **`observe`** — the only way to measure before trusting. Mutating it to act
 *   removes the operator's choice in one edit;
 * - **"a call that names an effort is never overridden"** — the plugin supplies
 *   a default, not a policy, and this is the line between the two;
 * - the **report** — a plugin that reports only its decisions leaves an operator
 *   unable to tell "nothing needed filling" from "the plugin never ran".
 *
 * ```sh
 * node scripts/inject-defects.mjs                  # every arm
 * node scripts/inject-defects.mjs --filter=branch  # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    // The allowlist is the plugin's whole scope. Without it a route the operator
    // never listed is judged — and, on the two surfaces that write, given a
    // default nobody asked for.
    name: 'scope: a route that is not listed is judged anyway',
    file: 'src/index.ts',
    edits: [[`      const declared = state.declared as unknown as ModelInfoMethod
      if (!fallback.isListed(provider, model)) return declared(provider, model, signal)`,
      `      const declared = state.declared as unknown as ModelInfoMethod
      if (!fallback.isListed(provider, model) && provider === '\\u0000none') return declared(provider, model, signal)`]],
  },
  {
    // The decision's own first rule: an unlisted route is `unlisted`. Read as a
    // listed one, it falls through to the ladder rules and the outcome — the one
    // an operator reads back — stops saying why.
    name: 'scope: an unlisted route is judged as a listed one',
    file: 'src/decision.ts',
    edits: [["  if (effort === undefined) return { outcome: 'unlisted' }",
      "  if (effort === '\\u0000unlisted') return { outcome: 'unlisted' }"]],
  },
  {
    // `off` is the absence this plugin exists to fill, not a level it publishes.
    // Treating it as a level writes "no reasoning" as if the operator had asked
    // for it — the one value the plugin refuses.
    name: 'value: `off` is published as if it were a level',
    file: 'src/decision.ts',
    edits: [["  if (effort === 'off') return { outcome: 'off-is-absence', effort }",
      "  if (effort === '\\u0000off') return { outcome: 'off-is-absence', effort }"]],
  },
  {
    // A route that declares no ladder publishes no reasoning surface at all.
    // Publishing a default for one advertises a control the model cannot honour.
    name: 'ladder: a route with no ladder is published anyway',
    file: 'src/decision.ts',
    edits: [["  if (reasoning === undefined) return { outcome: 'no-ladder', effort }",
      "  if (reasoning === undefined) return { outcome: 'published', effort }"]],
  },
  {
    // A route that declares its own default has an answer. Inverted, the plugin
    // second-guesses exactly the routes it promised not to, and leaves alone the
    // ones it exists for.
    name: 'default: a route that declares its own default is second-guessed',
    file: 'src/decision.ts',
    edits: [['  if (reasoning.defaultEffort !== undefined) return { outcome: \'already-declared\', effort }',
      '  if (reasoning.defaultEffort === undefined) return { outcome: \'already-declared\', effort }']],
  },
  {
    // The ladder is the route's own statement about what it will accept. Dropping
    // the check publishes a level the route refuses, and `prepareCall` throws on
    // it before a stream exists — terminal for the turn.
    name: 'ladder: every level is admitted',
    file: 'src/decision.ts',
    edits: [['  if (!reasoning.efforts.some(level => level.id === effort)) return { outcome: \'unsupported\', effort }',
      '  if (!reasoning.efforts.some(() => true)) return { outcome: \'unsupported\', effort }']],
  },
  {
    // `observe` is the operator's measurement step, and the plugin's default
    // mode. Publishing in it removes the only way to see what would happen
    // before it happens.
    name: 'mode: observe publishes instead of counting',
    file: 'src/decision.ts',
    edits: [["  return { outcome: settings.mode === 'enforce' ? 'published' : 'observed', effort }",
      "  return { outcome: 'published', effort }"]],
  },
  {
    // Only a publication carries an effort out of the table. Returning one for
    // every outcome makes `unsupported` and `off-is-absence` write too — the
    // refusals become publications.
    name: 'report: an effort is returned for every outcome, not only a publication',
    file: 'src/decision.ts',
    edits: [["  return finding.outcome === 'published' ? finding.effort : undefined",
      '  return finding.effort']],
  },
  {
    // An exact-route key is how an operator says "this model, and not its
    // siblings". Letting the provider key win undoes the one thing that keeps a
    // gateway's blast radius small.
    name: 'exact route: the provider key wins over the exact-route key',
    file: 'src/config.ts',
    edits: [[`  const exact = settings.routes.get(routeKey(provider, model))
  if (exact !== undefined) return exact
  return settings.providers.get(provider)`,
      `  const exact = settings.routes.get(routeKey(provider, model))
  return settings.providers.get(provider) ?? exact`]],
  },
  {
    // Only an absent key falls back. A bare `mode` in YAML is `null`, and folding
    // it into the default makes the plugin's own configuration surface the one
    // class of mistake it exists to remove.
    name: 'config: a bare `mode` key falls back instead of being refused',
    file: 'src/config.ts',
    edits: [['  const mode = config.mode === undefined ? defaultConfig.mode : config.mode',
      '  const mode = config.mode ?? defaultConfig.mode']],
  },
  {
    name: 'config: a bare `log` key falls back instead of being refused',
    file: 'src/config.ts',
    edits: [['  const log = config.log === undefined ? defaultConfig.log : config.log',
      '  const log = config.log ?? defaultConfig.log']],
  },
  {
    name: 'config: a bare `defaults` key falls back instead of being refused',
    file: 'src/config.ts',
    edits: [['  const defaults = config.defaults === undefined ? defaultConfig.defaults : config.defaults',
      '  const defaults = config.defaults ?? defaultConfig.defaults']],
  },
  {
    // `null` is a value an operator can write, and it is not an empty map. Read
    // as one, the plugin mounts with no scope and says nothing.
    name: 'config: `defaults: null` is accepted as an empty map',
    file: 'src/config.ts',
    edits: [["  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {",
      "  if (typeof defaults !== 'object' || Array.isArray(defaults)) {"]],
  },
  {
    // An entry whose value is only whitespace names nothing. Accepting it files a
    // route under an effort no model has, and the failure is silent for the rest
    // of the session.
    name: 'config: an effort that is only whitespace is accepted as a name',
    file: 'src/config.ts',
    edits: [["    if (typeof value !== 'string' || value.trim() === '') {",
      "    if (typeof value !== 'string') {"]],
  },
  {
    // The split is on the **first** slash, so a model id may contain one. Splitting
    // on the last moves the boundary and files the route under a provider nobody
    // will ask for.
    name: 'config: the route key splits on the last slash instead of the first',
    file: 'src/config.ts',
    edits: [["    const slash = key.indexOf('/')", "    const slash = key.lastIndexOf('/')"]],
  },
  {
    // Whitespace around a `provider/model` key is the same mistake as around a
    // provider key: filed under an id nobody will ask for.
    name: 'config: a `provider/model` key with surrounding whitespace is filed as a route',
    file: 'src/config.ts',
    edits: [["    if (provider === '' || model === '' || key !== key.trim()) {",
      "    if (provider === '' || model === '') {"]],
  },
  {
    name: 'config: a provider key with surrounding whitespace is filed',
    file: 'src/config.ts',
    edits: [["      if (key.trim() === '' || key !== key.trim()) {", "      if (key.trim() === '') {"]],
  },
  {
    // The default mode is `observe` on purpose: publishing a route default is a
    // change to every call on that route, including the auxiliary ones, and an
    // operator must be able to measure first.
    name: 'config: the default mode is enforce rather than observe',
    file: 'src/config.ts',
    edits: [["  mode: 'observe',", "  mode: 'enforce',"]],
  },
  {
    // `unlisted` is absent from the counters because an unlisted route never
    // reaches the plugin. Counting it would make the report say the plugin
    // judged routes it is structurally unable to see.
    name: 'report: `unlisted` is counted like every other outcome',
    file: 'src/index.ts',
    edits: [["const COUNTED: readonly Outcome[] = OUTCOMES.filter(outcome => outcome !== 'unlisted').slice()",
      "const COUNTED: readonly Outcome[] = OUTCOMES.filter(outcome => (outcome as string) !== '\\u0000unlisted').slice()"]],
  },
  {
    // The counters are the only account of what the plugin did. An entry that is
    // never incremented reads as "this never happened".
    name: 'counter: the read count is not incremented',
    file: 'src/index.ts',
    edits: [['        counters.reads += 1', '        counters.reads += 0']],
  },
  {
    name: 'counter: the selection count is not incremented',
    file: 'src/index.ts',
    edits: [['        counters.selections += 1', '        counters.selections += 0']],
  },
  {
    name: 'counter: the call count is not incremented',
    file: 'src/index.ts',
    edits: [['      counters.calls += 1', '      counters.calls += 0']],
  },
  {
    // Every judgement is one more judgement. A counter that overwrites reads as a
    // plugin that decided once, however long the session ran.
    name: 'counter: every judgement is counted as one, however many arrive',
    file: 'src/index.ts',
    edits: [['    counters.outcomes[finding.outcome] = (counters.outcomes[finding.outcome] ?? 0) + 1',
      '    counters.outcomes[finding.outcome] = (counters.outcomes[finding.outcome] ?? 0) + 0']],
  },
  {
    // `summary` is the mode that speaks; `off` is the mode that does not. Inverted,
    // a silent configuration logs and the documented one says nothing.
    name: 'log: `summary` is silent and `off` speaks',
    file: 'src/index.ts',
    edits: [["    if (this.settings.log !== 'summary') return", "    if (this.settings.log === 'summary') return"]],
  },
  {
    // One line per route, the first time it is published. A line per call turns a
    // long session's log into the same sentence thousands of times.
    name: 'log: a route is announced on every judgement rather than once',
    file: 'src/index.ts',
    edits: [["    if (finding.outcome === 'published' && !this.announced.has(key)) {",
      "    if (finding.outcome === 'published') {"]],
  },
  {
    name: 'log: a refused level is warned about on every judgement',
    file: 'src/index.ts',
    edits: [["    if (finding.outcome === 'unsupported' && !this.warned.has(key)) {",
      "    if (finding.outcome === 'unsupported') {"]],
  },
  {
    // A caller that names no effort is the case the plugin exists for; a caller
    // that names one is the case it must not touch. Inverted, nothing is ever
    // published and every unnamed call is recorded as somebody's request.
    name: 'request: the "already named" test in resolveCallConfig is inverted',
    file: 'src/index.ts',
    edits: [['        if (config.reasoningEffort !== undefined) {', '        if (config.reasoningEffort === undefined) {']],
  },
  {
    // A route whose capability cannot be read is not a route that named an
    // effort. Recording it as one hides the only case the plugin declines to
    // judge, which is the one an operator has to act on.
    name: 'request: an unreadable route is recorded as a named effort',
    file: 'src/index.ts',
    edits: [["          fallback.record(counters, ctx.logger, config.provider, config.model, { outcome: 'unresolved' })",
      "          fallback.record(counters, ctx.logger, config.provider, config.model, { outcome: 'named' })"]],
  },
  {
    // The caller's own callback is the last word on the controls it was handed.
    // Not consulting it turns someone else's decision into this plugin's.
    name: 'compose: the caller owns callback is not consulted',
    file: 'src/index.ts',
    edits: [['        const next: LlmCallControls = configure === undefined ? controls : configure(controls, model)',
      '        const next: LlmCallControls = configure === undefined ? controls : controls']],
  },
  {
    // A default supplies an effort; it never replaces one. Inverted, the plugin
    // overrides the caller on exactly the calls the caller was explicit about.
    name: 'compose: an effort the caller named is overwritten by the default',
    file: 'src/index.ts',
    edits: [['        if (next.reasoningEffort !== undefined) {', '        if (next.reasoningEffort === undefined) {']],
  },
  {
    // The route's own declaration is what `prepareCall` hands the callback, and
    // it is the only statement about the ladder the callback can read. Without it
    // every route looks like a route with no ladder, and nothing is published.
    name: 'compose: the route own ladder is not consulted on the turn path',
    file: 'src/index.ts',
    edits: [['        const finding = judge(config.provider, config.model, model.reasoning)',
      '        const finding = judge(config.provider, config.model, undefined)']],
  },
  {
    // A layer that took the property since this mount installed its own is work
    // this plugin does not own, and restoring the descriptor it displaced would
    // silently delete it.
    name: 'unmount: a wrapper that took the property since is discarded',
    file: 'src/index.ts',
    edits: [['  if (layer === undefined || instance[method] !== layer) return', '  if (layer === undefined) return']],
  },
  {
    // A method that carried no own property must carry none again. Leaving the
    // plugin's layer installed makes an unmount a no-op that still looks clean.
    name: 'unmount: a method with no own property keeps the plugin layer',
    file: 'src/index.ts',
    edits: [['  if (state.previous === undefined) Reflect.deleteProperty(instance, method)',
      "  if (state.previous === undefined) Reflect.deleteProperty(instance, '\\u0000none')"]],
  },
  {
    // The blind spots are the difference between "nothing needed filling" and
    // "the plugin never ran". Emptying them turns a statement into a silent
    // success.
    name: 'report: the blind spots the plugin cannot close are no longer stated',
    file: 'src/index.ts',
    edits: [['    notCovered: blindSpots(),', '    notCovered: [],']],
  },
  {
    // The last blind spot is the one that costs something: a route whose adapter
    // throws is left alone, and an unreadable route is never treated as a route
    // that supports nothing.
    name: 'report: the unreadable-route blind spot is dropped',
    file: 'src/index.ts',
    edits: [[`    'A route whose adapter throws while being inspected is left alone. An unreadable route is never treated as a route that supports nothing.',
`, '']],
  },
  {
    // The service is how a caller reads the counters. Providing it under another
    // name provides nothing.
    name: 'service: the snapshot service is provided under a name nobody reads',
    file: 'src/index.ts',
    edits: [["  ctx.provide('effortDefaultFallback', {", "  ctx.provide('effortDefaultFallbackService', {"]],
  },
  {
    // An adapter that failed while being asked told the plugin nothing. Read as a
    // route that declares nothing, it is judged — and a default is published on a
    // guess.
    name: 'lookup: an unreadable route is read as a route that declares nothing',
    file: 'src/index.ts',
    edits: [[`  try {
    return await declared(provider, model, signal)
  } catch {
    return undefined
  }`,
      `  try {
    return await declared(provider, model, signal)
  } catch {
    return { provider, id: model, name: model } as unknown as LlmResolvedModelInfo
  }`]],
  },
  {
    // The layer must ask the implementation it found at mount, never itself: its
    // own answer would be the default it just published, and it would answer its
    // own edit with `already-declared`.
    name: 'lookup: the layer asks itself instead of the implementation it found',
    file: 'src/index.ts',
    edits: [[`      const declared = state.declared as unknown as ModelInfoMethod
      if (!fallback.isListed(provider, model)) return declared(provider, model, signal)`,
      `      const declared = instance.resolveModelInfo.bind(instance) as unknown as ModelInfoMethod
      if (!fallback.isListed(provider, model)) return declared(provider, model, signal)`]],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm that removes a reader can leave the
 * suite waiting on a lookup this package would otherwise bound, and a mutant
 * that never terminates is a mutant the suite cannot report on. It is killed
 * here and counted as caught, which is what it is — the suite never reaches its
 * assertions because the code under test never returns.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  // A malformed arm is worse than a missing one: `for (const [from, to] of
  // 'ab')` destructures a *string* into its characters, so the edit becomes a
  // search for two single characters and a rewrite that changes nothing — and
  // the arm then reports SILENT, blaming the suite for a harness bug. Measured
  // here: one flat `edits: [['…', '…']]` reported "the suite stayed green" while
  // the real mutation was never applied.
  const malformed = mutation.edits.some(edit =>
    !Array.isArray(edit) || edit.length !== 2 || edit.some(part => typeof part !== 'string'))
  if (malformed) {
    results.push({ name: mutation.name, outcome: 'MALFORMED', detail: 'an edit is not a [from, to] pair of strings' })
    continue
  }
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}

process.stdout.write(`\n${MUTATIONS.length} arm(s): ${caught} caught, ${equivalents.length} equivalent, ${silent.length} silent, ${other.length} unusable\n`)
if (silent.length > 0 || other.length > 0) {
  process.stdout.write('a SILENT or unusable arm is a promise this package makes that nothing checks\n')
  process.exitCode = 1
}
