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
import type { Context } from '@deepseek-ai/cordis';
import type { Config, FallbackMode, Settings } from './config.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "effort-default-fallback";
/** The `llm` service owns the three methods this plugin wraps. */
export declare const inject: string[];
export type { Config, FallbackLog, FallbackMode, Settings } from './config.ts';
export { defaultConfig, normalizeConfig, routeKey } from './config.ts';
export type { Finding, Outcome, ReasoningSurface } from './decision.ts';
export { OUTCOMES, decide, publishedEffort } from './decision.ts';
/** What the plugin has seen and done, as a caller reads it back. */
export interface Counters {
    /** `resolveModelInfo` calls judged (listed routes only). */
    readonly reads: number;
    /** `resolveCallConfig` calls judged. */
    readonly selections: number;
    /** `prepareCall` calls judged. */
    readonly calls: number;
    /** Judgements that threw and were left alone. */
    readonly errors: number;
    /** Every decision, by outcome. `unlisted` is absent: an unlisted route never reaches this plugin. */
    readonly outcomes: Readonly<Record<string, number>>;
}
/** The read-only view a host reads back. */
export interface Snapshot {
    readonly mode: FallbackMode;
    readonly counters: Counters;
    readonly settings: Settings;
    /**
     * What this plugin structurally cannot see, stated on every report.
     *
     * A plugin that reports only its decisions leaves an operator unable to tell
     * "nothing needed filling" from "the plugin never ran", and those two look
     * identical in a log. The last line is the one that costs something: the
     * published default is a request-level answer, not an adapter default, and an
     * operator comparing this plugin with the profile workaround should know that.
     */
    readonly notCovered: readonly string[];
}
/** The service this plugin provides. */
export interface EffortDefaultFallbackService {
    /** Counters, the settings in force, and the plugin's own declared blind spots. */
    snapshot(): Snapshot;
    /** Zero the counters. */
    reset(): void;
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
export declare function apply(ctx: Context, config?: Config): void;
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
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map