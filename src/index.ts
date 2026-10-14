/**
 * A reasoning ladder without a default leaves every unnamed call on that route
 * with no reasoning parameter at all. This plugin fills the absence, for exactly
 * the routes an operator lists.
 *
 * ## The gap, read from the source
 *
 * `llm-pi-ai` describes a model's selectable efforts only when the model carries
 * reasoning metadata, and publishes `defaultEffort` only when the deployment
 * configured one (`reasoningInfo()` in `packages/llm/llm-pi-ai/src/adapter.ts`,
 * fed by `describableReasoningLevel(resolvedModel, profile.reasoning)`). A route
 * that declares a ladder and **no** default is therefore the ordinary state of
 * every fresh third-party gateway — the toggle models (Xiaomi MiMo, Moonshot /
 * Kimi) are the clearest case, not the only one.
 *
 * `LlmRuntime.resolveCallWithInfo` resolves a call with
 *
 * ```
 * const effective = requested ?? reasoning.defaultEffort
 * ```
 *
 * so when nothing requested an effort and the route declares no default, nothing
 * is resolved: the request carries no `reasoningEffort` and pi-ai — which reads a
 * missing parameter as explicit `off` — does not think. The user sees an extra
 * **Default** row in the effort menu, leaves it, and gets `off` with no error.
 *
 * Three surfaces read that one absence:
 *
 * - the model picker, through `packages/api/session-controller/src/catalog.ts`,
 *   which maps `resolveModelInfo().reasoning.defaultEffort` into the catalog the
 *   client renders;
 * - installing a selection, through `commands.ts#selectModel`, which calls
 *   `resolveCallConfig()` and stores the result as the session's model selection;
 * - the turn itself, through `prepareCall()` on the way to the adapter.
 *
 * The documented workaround is the `llm-pi-ai` provider profile
 * (`providers.<id>.reasoning: high`), which makes the adapter publish the level
 * and fixes all three. It is a **per-provider** knob — the profile type carries
 * `reasoning` once per provider and a per-model map only for `maxTokens` — so a
 * gateway whose models differ cannot be configured model by model, and turning
 * it on to make one toggle model think turns it on for every model behind it.
 *
 * ## What this plugin does
 *
 * It shadows the three `LlmRuntime` methods those surfaces read —
 * `resolveModelInfo`, `resolveCallConfig` and `prepareCall` — on the **service
 * instance** (`Symbol.for('cordis.original')`; the same seam
 * `@argszero/dsh-image-price-fallback` uses for `imageRequestPricing`), and
 * answers with the configured default where the route declares a ladder, admits
 * the level, and has no default of its own. `src/decision.ts` states every rule
 * and every refusal; the short version is that an unlisted route, a route with
 * no ladder, a route with its own `defaultEffort`, a level the ladder does not
 * admit, an unreadable route and a call that already names an effort are all
 * left exactly as they were.
 *
 * `prepareCall` is covered through its third argument rather than by re-calling
 * it with a modified config: the method already takes a pure `configure`
 * callback that runs before defaults and validation, and composing with it means
 * the plugin's answer is applied *after* the caller's own callback has had its
 * say — so a caller that names an effort still wins, whatever this plugin is
 * configured to do. The alternative (`prepareCall({ ...config, reasoningEffort })`)
 * would be overruled by any callback that omits the field.
 *
 * ## Why `observe` is the default
 *
 * Publishing a route default is not a menu fix. Once a default exists, `requested
 * ?? defaultEffort` gives it to every call on that route that names none —
 * including the auxiliary calls — which is what makes it worth measuring before
 * arming. `mode: 'observe'` counts the same decisions and changes nothing;
 * `mode: 'enforce'` publishes them. Nothing is published for a route the
 * configuration does not list, and a mounted plugin with no configuration
 * publishes nothing anywhere.
 *
 * A mount installs one layer per method, and unmounting puts back what it found,
 * so a method that had no own property gets its prototype implementation back
 * rather than a permanent shadow — and a wrapper that was on the instance first
 * is restored rather than discarded. Only **one** mount can exist at a time: the
 * service below is registered per name and cordis refuses to register one name
 * twice, so a second concurrent mount fails loudly at `provide` instead of
 * stacking. A profile that changes this plugin's configuration therefore
 * unmounts first, and that is what makes the new settings the ones in force.
 *
 * @module @argszero/dsh-effort-default-fallback
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConfigureCall,
  LlmCallConfig,
  LlmCallControls,
  LlmResolvedModelInfo,
  LlmRuntime,
  PreparedLlmCall,
} from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
// Pulls in the service augmentation that types `ctx.llm`.
import type {} from '@deepseek-ai/dsh-llm'
import { configuredEffort, normalizeConfig } from './config.ts'
import type { Config, FallbackLog, FallbackMode, Settings } from './config.ts'
import { OUTCOMES, decide, publishedEffort } from './decision.ts'
import type { Finding, Outcome, ReasoningSurface } from './decision.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'effort-default-fallback'

/** The `llm` service owns the three methods this plugin wraps. */
export const inject = ['llm']

export type { Config, FallbackLog, FallbackMode, Settings } from './config.ts'
export { defaultConfig, normalizeConfig, routeKey } from './config.ts'
export type { Finding, Outcome, ReasoningSurface } from './decision.ts'
export { OUTCOMES, decide, publishedEffort } from './decision.ts'

/** The key `getTraceable()` files the underlying instance under — cross-copy stable. */
const ORIGINAL = Symbol.for('cordis.original')

/** The three wrapped methods, as they are installed on the service instance. */
type ModelInfoMethod = (provider: string, model: string, signal?: AbortSignal) => Promise<LlmResolvedModelInfo>
type CallConfigMethod = (config: LlmCallConfig, signal?: AbortSignal) => Promise<LlmCallConfig>
type PrepareCallMethod = (
  config: LlmCallConfig,
  signal?: AbortSignal,
  configure?: ConfigureCall,
) => Promise<PreparedLlmCall>

/** Every method this plugin installs a layer on. */
const METHODS = ['resolveModelInfo', 'resolveCallConfig', 'prepareCall'] as const

/** One of the wrapped method names. */
type MethodName = (typeof METHODS)[number]

/** What one mount did to one method. */
interface Installation {
  /** The descriptor the method carried before this mount; put back when it leaves. */
  readonly previous: PropertyDescriptor | undefined
  /** The implementation this mount asks first, bound to the instance. */
  readonly declared: (...args: never[]) => unknown
  /** The implementation this mount installed, once it has installed one. */
  layer: ((...args: never[]) => unknown) | undefined
}

/** One mount's installations, by method name. */
type Installations = Map<MethodName, Installation>

/**
 * Write one method onto the instance as its own property.
 * @param instance - the llm service instance.
 * @param method - the method name to shadow.
 * @param layer - the implementation to install.
 */
function defineMethod(instance: LlmRuntime, method: MethodName, layer: (...args: never[]) => unknown): void {
  Object.defineProperty(instance, method, {
    value: layer,
    writable: true,
    enumerable: false,
    configurable: true,
  })
}

/**
 * Capture what each wrapped method is, as this mount finds it.
 *
 * Captured once, before this mount installs anything: `declared` binds the
 * implementation the instance resolves to right now — the service's own
 * prototype method, or a foreign wrapper that got here first — and every layer
 * asks *that* one, never itself. That is what keeps the plugin's own extra
 * capability lookup (`describeRoute`) honest: it would find the default this
 * plugin had just published and answer its own edit with `already-declared`.
 * @param instance - the llm service instance.
 * @returns the installations for this mount.
 */
function installationsFor(instance: LlmRuntime): Installations {
  const created: Installations = new Map()
  for (const method of METHODS) {
    created.set(method, {
      previous: Object.getOwnPropertyDescriptor(instance, method),
      declared: (instance[method] as (...args: never[]) => unknown).bind(instance),
      layer: undefined,
    })
  }
  return created
}

/**
 * Install this mount's layer for one method, and hand it the property.
 * @param instance - the llm service instance.
 * @param installations - this mount's installations.
 * @param method - the method being wrapped.
 * @param layer - the implementation this mount installs.
 */
function installLayer(
  instance: LlmRuntime,
  installations: Installations,
  method: MethodName,
  layer: (...args: never[]) => unknown,
): void {
  // The map was built by `installationsFor` in the same mount, so the entry is
  // present; the fallback is unreachable and exists so this function has no
  // throwing path of its own.
  const state = installations.get(method)
  if (state === undefined) return
  state.layer = layer
  defineMethod(instance, method, layer)
}

/**
 * Remove this mount's layer, restoring the descriptor it displaced.
 *
 * The layer is removed only while it owns the property: a wrapper that is not
 * ours may have taken it since this mount installed its own — overwriting that
 * would discard work this plugin does not own.
 * @param instance - the llm service instance.
 * @param installations - this mount's installations.
 * @param method - the method being unwrapped.
 */
function removeLayer(instance: LlmRuntime, installations: Installations, method: MethodName): void {
  const state = installations.get(method)
  if (state === undefined) return
  const layer = state.layer
  state.layer = undefined
  if (layer === undefined || instance[method] !== layer) return
  if (state.previous === undefined) Reflect.deleteProperty(instance, method)
  else Object.defineProperty(instance, method, state.previous)
}

/** The effort each outcome is counted under, for the report. */
const COUNTED: readonly Outcome[] = OUTCOMES.filter(outcome => outcome !== 'unlisted').slice()

/** What the plugin has seen and done, as a caller reads it back. */
export interface Counters {
  /** `resolveModelInfo` calls judged (listed routes only). */
  readonly reads: number
  /** `resolveCallConfig` calls judged. */
  readonly selections: number
  /** `prepareCall` calls judged. */
  readonly calls: number
  /** Judgements that threw and were left alone. */
  readonly errors: number
  /** Every decision, by outcome. `unlisted` is absent: an unlisted route never reaches this plugin. */
  readonly outcomes: Readonly<Record<string, number>>
}

/** The read-only view a host reads back. */
export interface Snapshot {
  readonly mode: FallbackMode
  readonly counters: Counters
  readonly settings: Settings
  /**
   * What this plugin structurally cannot see, stated on every report.
   *
   * A plugin that reports only its decisions leaves an operator unable to tell
   * "nothing needed filling" from "the plugin never ran", and those two look
   * identical in a log. The last line is the one that costs something: the
   * published default is a request-level answer, not an adapter default, and an
   * operator comparing this plugin with the profile workaround should know that.
   */
  readonly notCovered: readonly string[]
}

/** The service this plugin provides. */
export interface EffortDefaultFallbackService {
  /** Counters, the settings in force, and the plugin's own declared blind spots. */
  snapshot(): Snapshot
  /** Zero the counters. */
  reset(): void
}

/**
 * The statements the plugin makes about its own blind spots.
 * @returns the lines the report carries.
 */
function blindSpots(): string[] {
  return [
    'Only the three instance methods are wrapped. A caller that hands `GenerateOptions` straight to `ctx.llm.stream()` — the auxiliary paths (`auto-review`, the compaction summarizer) — is untouched: that entry point is synchronous, so an effort cannot be checked against the route\'s ladder before it is published, and an unadmitted level there would turn a silent `off` into a terminal `UNSUPPORTED_REASONING_EFFORT`.',
    'Only routes listed in `defaults` are judged. Every other route keeps exactly the behaviour it had, and is not counted.',
    'A provider key covers every model behind that provider, including models the operator did not think about — the same blast radius as the provider profile. A `provider/model` key is how to avoid it.',
    'The published effort is written into the resolved config, so the loop records it as the request\'s own reasoning effort rather than as an adapter default; a resumed session therefore re-imposes it as a named effort. The provider profile marks it as an adapter default instead.',
    'A route whose adapter throws while being inspected is left alone. An unreadable route is never treated as a route that supports nothing.',
  ]
}

/** A fresh, all-zero counter block. */
function zeroCounters(): {
  reads: number
  selections: number
  calls: number
  errors: number
  outcomes: Record<string, number>
} {
  return {
    reads: 0,
    selections: 0,
    calls: 0,
    errors: 0,
    outcomes: Object.fromEntries(COUNTED.map(outcome => [outcome, 0])),
  }
}

/**
 * The decision, its counters, and the two log lines a route gets at most once.
 *
 * The class is the whole policy in one place: `judge` is the pure table, and the
 * counters and the announcement are the only state it keeps — per route, and
 * bounded by the number of routes the operator listed.
 */
class Fallback {
  /** The resolved configuration. */
  readonly settings: Settings
  /** Routes a publication has already been logged for. */
  private readonly announced = new Set<string>()
  /** Routes a refused configuration has already been warned about. */
  private readonly warned = new Set<string>()

  /**
   * @param settings - the resolved configuration.
   */
  constructor(settings: Settings) {
    this.settings = settings
  }

  /**
   * Whether this plugin is configured to answer for one route at all.
   *
   * Answered by the same lookup the decision uses, so the scope test and the
   * decision can never disagree about which key won.
   * @param provider - the route's provider id.
   * @param model - the exact model id.
   * @returns whether the route is listed.
   */
  isListed(provider: string, model: string): boolean {
    return configuredEffort(this.settings, provider, model) !== undefined
  }

  /**
   * The decision for one route, given its declaration.
   * @param provider - the route's provider id.
   * @param model - the exact model id.
   * @param reasoning - the route's reasoning surface, or `undefined` when it declares none.
   * @returns the decision.
   */
  judge(provider: string, model: string, reasoning: ReasoningSurface | undefined): Finding {
    return decide(this.settings, provider, model, reasoning)
  }

  /**
   * Record one judgement, and write the one log line its route is entitled to.
   *
   * `summary` is silent for the outcomes an operator cannot act on and loud for
   * the ones they can: a publication, and a configuration the route refuses.
   * @param counters - the counter block to update.
   * @param logger - the context logger.
   * @param provider - the route's provider id.
   * @param model - the exact model id.
   * @param finding - the decision.
   */
  record(
    counters: ReturnType<typeof zeroCounters>,
    logger: Context['logger'],
    provider: string,
    model: string,
    finding: Finding,
  ): void {
    counters.outcomes[finding.outcome] = (counters.outcomes[finding.outcome] ?? 0) + 1
    if (this.settings.log !== 'summary') return
    const key = `${provider}\u0000${model}`
    if (finding.outcome === 'published' && !this.announced.has(key)) {
      this.announced.add(key)
      logger.info(
        `effort-default-fallback: ${provider}/${model} declares a reasoning ladder and no default; `
        + `every call that names no effort now carries "${finding.effort ?? ''}"`,
      )
      return
    }
    if (finding.outcome === 'unsupported' && !this.warned.has(key)) {
      this.warned.add(key)
      logger.warn(
        `effort-default-fallback: ${provider}/${model} does not offer reasoning effort "${finding.effort ?? ''}"; `
        + 'no default was published for it and the route keeps its own behaviour',
      )
    }
  }
}

/**
 * The instance `ctx.get('llm')` is a view of.
 *
 * A view is built per read and holds no stable identity, so the properties have
 * to be written on the instance behind it. `getTraceable()` files that instance
 * under a `Symbol.for` key; the context's own property access resolves to the
 * same object, and is the fallback when the service is not traced.
 * @param ctx - the plugin context, with `llm` declared.
 * @returns the service instance, or `undefined` when no `llm` service is mounted.
 */
function llmInstance(ctx: Context): LlmRuntime | undefined {
  const view = ctx.get('llm') as Record<PropertyKey, unknown> | undefined
  const original = view?.[ORIGINAL]
  if (original !== undefined && original !== null) return original as LlmRuntime
  return ctx.llm
}

/**
 * Mount the fallback.
 *
 * `config` is whatever a loader entry passed, or `undefined` when it passed
 * nothing, so the default lives here. It cannot live in an exported `Config`:
 * Cordis reads `Config['~standard'].validate` off a plugin's `Config`, and a
 * plain defaults object has no such property, so naming one there makes the
 * mount throw before this function is called.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  const fallback = new Fallback(settings)
  const counters = zeroCounters()

  const snapshot = (): Snapshot => ({
    mode: settings.mode,
    counters: {
      reads: counters.reads,
      selections: counters.selections,
      calls: counters.calls,
      errors: counters.errors,
      outcomes: { ...counters.outcomes },
    },
    settings,
    notCovered: blindSpots(),
  })

  ctx.provide('effortDefaultFallback', {
    snapshot,
    reset: () => {
      const fresh = zeroCounters()
      counters.reads = fresh.reads
      counters.selections = fresh.selections
      counters.calls = fresh.calls
      counters.errors = fresh.errors
      counters.outcomes = fresh.outcomes
    },
  } satisfies EffortDefaultFallbackService)

  ctx.effect(() => {
    const instance = llmInstance(ctx)
    if (instance === undefined) {
      ctx.logger.warn('effort-default-fallback: no llm service is mounted; nothing was wrapped')
      return () => {}
    }
    const missing = METHODS.filter(method => typeof instance[method] !== 'function')
    if (missing.length > 0) {
      ctx.logger.warn(
        `effort-default-fallback: the mounted llm service exposes no ${missing.join(', ')}; nothing was wrapped`,
      )
      return () => {}
    }
    const installations = installationsFor(instance)

    /**
     * Judge one route from its declaration, counting the judgement and writing
     * the route's one log line.
     */
    const judge = (
      provider: string,
      model: string,
      reasoning: ReasoningSurface | undefined,
    ): Finding => {
      const finding = fallback.judge(provider, model, reasoning)
      fallback.record(counters, ctx.logger, provider, model, finding)
      return finding
    }

    const modelInfoLayer = async function resolveModelInfo(
      provider: string,
      model: string,
      signal?: AbortSignal,
    ): Promise<LlmResolvedModelInfo> {
      const state = installations.get('resolveModelInfo')
      if (state === undefined) throw new Error('effort-default-fallback: no installation for resolveModelInfo')
      const declared = state.declared as unknown as ModelInfoMethod
      if (!fallback.isListed(provider, model)) return declared(provider, model, signal)
      try {
        counters.reads += 1
        const info = await declared(provider, model, signal)
        const effort = publishedEffort(judge(provider, model, info.reasoning))
        if (effort === undefined || info.reasoning === undefined) return info
        return { ...info, reasoning: { ...info.reasoning, defaultEffort: effort as ReasoningEffortId } }
      } catch (error: unknown) {
        counters.errors += 1
        ctx.logger.warn(
          `effort-default-fallback: could not describe ${provider}/${model}, leaving it unchanged: ${String(error)}`,
        )
        throw error
      }
    }

    const callConfigLayer = async function resolveCallConfig(
      config: LlmCallConfig,
      signal?: AbortSignal,
    ): Promise<LlmCallConfig> {
      const state = installations.get('resolveCallConfig')
      if (state === undefined) throw new Error('effort-default-fallback: no installation for resolveCallConfig')
      const declared = state.declared as unknown as CallConfigMethod
      if (!fallback.isListed(config.provider, config.model)) return declared(config, signal)
      try {
        counters.selections += 1
        const resolved = await declared(config, signal)
        // A call that names an effort is never overridden, and the route's own
        // declaration is not even asked for: nothing here could be written. The
        // refusal is counted, so an operator can see how often a default was not
        // needed rather than read an inert plugin.
        if (config.reasoningEffort !== undefined) {
          fallback.record(counters, ctx.logger, config.provider, config.model, {
            outcome: 'named',
            effort: config.reasoningEffort,
          })
          return resolved
        }
        const info = await describeRoute(installations, config.provider, config.model, signal)
        if (info === undefined) {
          fallback.record(counters, ctx.logger, config.provider, config.model, { outcome: 'unresolved' })
          return resolved
        }
        const effort = publishedEffort(judge(config.provider, config.model, info.reasoning))
        if (effort === undefined) return resolved
        return { ...resolved, reasoningEffort: effort as ReasoningEffortId }
      } catch (error: unknown) {
        counters.errors += 1
        ctx.logger.warn(
          `effort-default-fallback: could not resolve the call config for ${config.provider}/${config.model}, `
          + `leaving it unchanged: ${String(error)}`,
        )
        throw error
      }
    }

    const prepareCallLayer = function prepareCall(
      config: LlmCallConfig,
      signal?: AbortSignal,
      configure?: ConfigureCall,
    ): Promise<PreparedLlmCall> {
      const state = installations.get('prepareCall')
      if (state === undefined) {
        return Promise.reject(new Error('effort-default-fallback: no installation for prepareCall'))
      }
      const declared = state.declared as unknown as PrepareCallMethod
      if (!fallback.isListed(config.provider, config.model)) return declared(config, signal, configure)
      counters.calls += 1
      // The plugin's answer is applied *after* the caller's own callback, so a
      // call that names an effort keeps it whatever this plugin is configured to
      // do — and the route's own declaration, handed to the callback by
      // `prepareCall`, is the one that decides whether the default is admissible.
      const composed: ConfigureCall = (controls, model) => {
        const next: LlmCallControls = configure === undefined ? controls : configure(controls, model)
        if (next.reasoningEffort !== undefined) {
          fallback.record(counters, ctx.logger, config.provider, config.model, {
            outcome: 'named',
            effort: next.reasoningEffort,
          })
          return next
        }
        const finding = judge(config.provider, config.model, model.reasoning)
        const effort = publishedEffort(finding)
        return effort === undefined ? next : { ...next, reasoningEffort: effort as ReasoningEffortId }
      }
      return declared(config, signal, composed)
    }

    installLayer(instance, installations, 'resolveModelInfo', modelInfoLayer as unknown as (...args: never[]) => unknown)
    installLayer(instance, installations, 'resolveCallConfig', callConfigLayer as unknown as (...args: never[]) => unknown)
    installLayer(instance, installations, 'prepareCall', prepareCallLayer as unknown as (...args: never[]) => unknown)

    ctx.logger.info(
      `effort-default-fallback: wrapping ${instance.constructor.name}.${METHODS.join('/')} `
      + `in ${settings.mode} mode for ${settings.providers.size} provider(s) and ${settings.routes.size} route(s)`,
    )

    return () => {
      removeLayer(instance, installations, 'prepareCall')
      removeLayer(instance, installations, 'resolveCallConfig')
      removeLayer(instance, installations, 'resolveModelInfo')
    }
  }, 'effort-default-fallback: fill an absent reasoning default on the routes the configuration lists')

  ctx.logger.info(
    `effort-default-fallback: ${settings.mode} mode — ${settings.mode === 'enforce'
      ? 'listed routes that declare a ladder and no default are given one'
      : 'listed routes are counted and left unchanged'}`,
  )
}

/**
 * Ask one route what it declares, with the implementation the first mount found.
 *
 * Never through this plugin's own wrapper, which would report the default it
 * just published and answer `already-declared` to its own edit.
 * @param installations - the instance's installations.
 * @param provider - the route's provider id.
 * @param model - the exact model id.
 * @param signal - the caller's cancellation.
 * @returns the declaration, or `undefined` when the route could not be asked.
 */
async function describeRoute(
  installations: Installations,
  provider: string,
  model: string,
  signal: AbortSignal | undefined,
): Promise<LlmResolvedModelInfo | undefined> {
  const state = installations.get('resolveModelInfo')
  if (state === undefined) return undefined
  const declared = state.declared as unknown as ModelInfoMethod
  try {
    return await declared(provider, model, signal)
  } catch {
    return undefined
  }
}

/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it is present.
 *
 * `Config: defaultConfig` used to be exported here. `defaultConfig` is a plain
 * object rather than a schema, so the lookup found no `~standard` and every mount
 * of the installed package died with `TypeError: Cannot read properties of
 * undefined (reading 'validate')` before `apply` ran. The defaults reach a mount
 * through `apply(ctx, config = {})` instead, and the convention in this
 * repository's own packages is a real schema (`export const Config = z.object(…)`)
 * or no `Config` at all — never a plain object.
 */
export default { name, inject, apply }
