/**
 * The decision, as a pure function of three facts a caller can be handed.
 *
 * ## The gap this closes
 *
 * `llm-pi-ai` publishes a model's reasoning ladder only when the model carries
 * reasoning metadata, and — in `reasoningInfo()` — publishes a `defaultEffort`
 * only when the deployment configured one:
 *
 * ```
 * function reasoningInfo(model, defaultLevel) {
 *   if (!model.reasoning) return {}
 *   return { reasoning: { efforts: levels.map(…), …defaultLevel === undefined ? {} : { defaultEffort } } }
 * }
 * ```
 *
 * `defaultLevel` is `describableReasoningLevel(resolvedModel, profile.reasoning)`,
 * so it is `undefined` unless the profile sets `reasoning`. A route that
 * declares a ladder but no default is therefore a normal state, and it is the
 * state every third-party toggle model (Xiaomi MiMo, Moonshot/Kimi) is in on a
 * fresh deployment.
 *
 * `packages/llm/llm/src/index.ts` resolves a call with
 *
 * ```
 * const effective = requested ?? reasoning.defaultEffort
 * ```
 *
 * so with `defaultEffort` absent and no requested effort, **nothing** is
 * resolved and the request goes out with no reasoning parameter. pi-ai reads a
 * missing parameter as explicit `off`, so the model does not think. Three
 * surfaces show it, and all three read the same absence:
 *
 * | surface | reads | shows |
 * |---|---|---|
 * | the model picker | `session-controller/catalog.ts` → `resolveModelInfo().reasoning.defaultEffort` | a synthetic **Default** row, in front of the real levels |
 * | installing a session's selection | `session-controller/commands.ts` → `resolveCallConfig()` | a selection with no `reasoningEffort`, which then logs and dispatches as none |
 * | the turn itself | `agent-loop` → `prepareCall()` | no reasoning parameter on the wire |
 *
 * The documented workaround is the provider profile (`llm-pi-ai` →
 * `providers.<id>.reasoning: high`), which makes `describableReasoningLevel`
 * publish the level and thereby fixes all three at once. It is per **provider**:
 * the profile type carries `reasoning` once per provider and a per-model map
 * only for `maxTokens`, so a provider whose models differ cannot be configured
 * model by model, and turning the knob on to make one toggle model think turns
 * it on for every model on that gateway.
 *
 * ## What this plugin does, and what it refuses to do
 *
 * It fills the absent default for exactly the routes an operator lists, and only
 * where the route's own ladder admits the level asked for. The rules, all of
 * them refusals:
 *
 * - **an unlisted route is untouched** — the allowlist is the whole scope, and a
 *   mounted plugin with no configuration publishes nothing anywhere;
 * - **a route with no ladder is untouched** — `reasoning === undefined` means
 *   the route publishes no reasoning surface at all, and inventing one would
 *   advertise a control the model cannot honour;
 * - **a route that already declares `defaultEffort` is untouched** — it has an
 *   answer and this plugin has no business second-guessing it;
 * - **a level the route's ladder does not admit is refused**, counted, and
 *   warned about once — publishing it would move the failure from a silent `off`
 *   to a loud `UNSUPPORTED_REASONING_EFFORT`, and that throw happens inside
 *   `prepareCall`, before a stream exists, so it is terminal for the turn;
 * - **`off` is refused as a value** — `off` *is* the absence this plugin exists
 *   to replace (pi-ai turns both into "no reasoning field"), so configuring it
 *   asks the plugin to replace an absence with an absence. A route that must be
 *   pinned off belongs in the provider profile, not here;
 * - **a route whose capability cannot be read is untouched** — an adapter error
 *   is `unknown`, never "supports nothing", and no default is published on a
 *   guess;
 * - **a call that already names an effort is never overridden** — the plugin
 *   supplies a default, not a policy.
 *
 * ## Why `observe` is the default
 *
 * Publishing a route default is not a menu fix. Once it exists, `requested ??
 * defaultEffort` gives it to *every* call on that route that names no effort,
 * including the auxiliary calls — which is what the source report says about the
 * profile workaround, and why it says a route-wide default is a bigger change
 * than it looks. `mode: 'observe'` therefore counts the same decisions and
 * changes nothing, which is how an operator measures what would happen on their
 * deployment before arming the repair with `mode: 'enforce'`.
 *
 * @module @argszero/dsh-effort-default-fallback/decision
 */

import type { Settings } from './config.ts'
import { configuredEffort } from './config.ts'

/**
 * What one route's reasoning metadata is, read structurally rather than by
 * importing `LlmResolvedModelInfo`.
 *
 * The plugin asks three questions of it, and naming the shape here keeps the
 * dependency surface a reader can check at a glance — the same reason
 * `dsh-effort-route-guard` reads a request header structurally.
 */
export interface ReasoningSurface {
  readonly efforts: readonly { readonly id: string }[]
  readonly defaultEffort?: string | undefined
}

/** Why a route was answered for, or why it was left alone. */
export type Outcome =
  /** `enforce`: this route is given the configured default. */
  | 'published'
  /** `observe`: this route would be given it, and the request is untouched. */
  | 'observed'
  /** The route is not in `defaults`. */
  | 'unlisted'
  /** The configured value is `off`, which is the absence being filled. */
  | 'off-is-absence'
  /** The route declares no reasoning ladder, so there is no default to fill. */
  | 'no-ladder'
  /** The route already declares a `defaultEffort`. */
  | 'already-declared'
  /** The route's ladder does not admit the configured level. */
  | 'unsupported'
  /**
   * The route's capability could not be read; nothing is published on a guess.
   *
   * Recorded by the caller rather than returned by {@link decide}: this is the
   * case where the row could not be *reached*, not a row of the table.
   */
  | 'unresolved'
  /**
   * The call already names an effort, which a default never overrides.
   *
   * Recorded by the caller, never returned by {@link decide} — the table is
   * handed the route's declaration and nothing else, and "the caller named an
   * effort" is a fact about the request, not about the route.
   */
  | 'named'

/** Every outcome, in report order. */
export const OUTCOMES: readonly Outcome[] = [
  'published',
  'observed',
  'unlisted',
  'off-is-absence',
  'no-ladder',
  'already-declared',
  'unsupported',
  'unresolved',
  'named',
]

/** One decision: the outcome, and the effort it concerns. */
export interface Finding {
  readonly outcome: Outcome
  /** The configured effort this decision is about, when one applies. */
  readonly effort?: string | undefined
}

/**
 * Decide what to do for one route, given the route's own declaration.
 *
 * Pure by construction: the caller does the I/O and hands the result in, so the
 * table above is testable row by row rather than only through a live turn.
 * @param settings - the resolved settings.
 * @param provider - the route's provider id.
 * @param model - the exact model id.
 * @param reasoning - the route's reasoning surface, or `undefined` when it
 *   declares none.
 * @returns the decision.
 */
export function decide(
  settings: Settings,
  provider: string,
  model: string,
  reasoning: ReasoningSurface | undefined,
): Finding {
  const effort = configuredEffort(settings, provider, model)
  if (effort === undefined) return { outcome: 'unlisted' }
  if (effort === 'off') return { outcome: 'off-is-absence', effort }
  if (reasoning === undefined) return { outcome: 'no-ladder', effort }
  if (reasoning.defaultEffort !== undefined) return { outcome: 'already-declared', effort }
  if (!reasoning.efforts.some(level => level.id === effort)) return { outcome: 'unsupported', effort }
  return { outcome: settings.mode === 'enforce' ? 'published' : 'observed', effort }
}

/**
 * The effort {@link decide} settled on, or `undefined` when the caller must
 * leave the route as it is.
 * @param finding - a decision.
 * @returns the effort to write, when the decision was `published`.
 */
export function publishedEffort(finding: Finding): string | undefined {
  return finding.outcome === 'published' ? finding.effort : undefined
}
