/**
 * The configuration surface of the effort default fallback.
 *
 * Every field is optional and every default is stated here rather than implied
 * by the code that reads it, because the allowlist *is* the plugin's whole
 * opinion: this plugin decides nothing on its own, and a route it was not told
 * about is left exactly as the harness left it. See `src/index.ts` for the gap
 * and for why the default is `observe` rather than `enforce`.
 *
 * @module @argszero/dsh-effort-default-fallback/config
 */

/** Whether a listed route is given a default effort, or only counted. */
export type FallbackMode = 'observe' | 'enforce'

/**
 * How much is logged. `summary` writes one line per route the plugin publishes
 * a default for, the first time it publishes one, plus one warning per route
 * whose configuration cannot be honoured — the only durable answer to "is it
 * working?" for a plugin that changes an argument rather than an outcome.
 */
export type FallbackLog = 'off' | 'summary'

/**
 * A key names either a whole provider (`xiaomi`) or one exact route
 * (`xiaomi/mimo-vl`). The exact route wins when both are listed.
 *
 * The split is on the **first** slash, so a provider id may not contain one and
 * a model id may.
 */
export type RouteKey = string

/** The plugin's configuration, as written in a profile patch. */
export interface Config {
  /**
   * `observe` (default) counts the decisions and changes nothing; `enforce`
   * publishes the configured default on the routes that can take it.
   */
  mode?: FallbackMode
  /**
   * The routes this plugin answers for, and the effort each is given when a call
   * names none: `{ "xiaomi": "high", "moonshot/kimi-k2-thinking": "medium" }`.
   *
   * Empty (the default) lists nothing, so a mounted plugin with no configuration
   * publishes no default anywhere — the allowlist is an explicit act.
   */
  defaults?: Readonly<Record<RouteKey, string>>
  /** `summary` (default) logs the first publication per route; `off` logs nothing. */
  log?: FallbackLog
}

/** The resolved settings every decision reads. */
export interface Settings {
  readonly mode: FallbackMode
  /** Provider-wide keys, by provider id. */
  readonly providers: ReadonlyMap<string, string>
  /** Exact-route keys, by `` `${provider}\u0000${model}` ``. */
  readonly routes: ReadonlyMap<string, string>
  readonly log: FallbackLog
}

/**
 * The defaults, exported so a host can render them and a test can pin them.
 *
 * Deliberately **not** exported as the plugin's `Config`: cordis validates a
 * mounted plugin's `Config` through `Config['~standard'].validate`, and a plain
 * defaults object has no `~standard`, so naming one there makes the mount throw
 * `reading 'validate'` before `apply` runs. The entry point exports
 * `{ name, inject, apply }` with no `Config`, and these defaults arrive through
 * `apply(ctx, config = {})`.
 */
export const defaultConfig: { mode: FallbackMode; defaults: Record<string, never>; log: FallbackLog } = {
  mode: 'observe',
  defaults: {},
  log: 'summary',
}

/** The key one exact route is filed under. */
export function routeKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * The effort this plugin would publish for one route, and where the answer came
 * from.
 *
 * The precedence is exact route over provider, and it is resolved here rather
 * than at the call site so the two entry points that ask (`resolveModelInfo` and
 * `resolveCallConfig`) cannot disagree about which key won.
 * @param settings - the resolved settings.
 * @param provider - the route's provider id.
 * @param model - the exact model id.
 * @returns the configured effort, or `undefined` when this route is not listed.
 */
export function configuredEffort(settings: Settings, provider: string, model: string): string | undefined {
  const exact = settings.routes.get(routeKey(provider, model))
  if (exact !== undefined) return exact
  return settings.providers.get(provider)
}

/**
 * Resolve one configuration into the settings every decision reads.
 *
 * An unusable entry is refused rather than repaired: silently dropping a route
 * an operator listed is how a configuration knob becomes a mystery, and silently
 * substituting a default for an effort they typed is worse. **Only an absent key
 * falls back** to {@link defaultConfig}, which is why each field is read with an
 * explicit `undefined` test rather than `??`: `null` is a value an operator can
 * write (a bare key in YAML is exactly that), and folding it into the default
 * would make the one class of mistake this plugin exists to remove — a setting
 * that silently did not apply — the behaviour of its own configuration surface.
 * @param config - the plugin configuration.
 * @returns the resolved settings.
 * @throws when a supplied field is not usable.
 */
export function normalizeConfig(config: Config = {}): Settings {
  const mode = config.mode === undefined ? defaultConfig.mode : config.mode
  if (mode !== 'observe' && mode !== 'enforce') {
    throw new TypeError(`effort-default-fallback: mode must be 'observe' or 'enforce', received ${JSON.stringify(config.mode)}`)
  }
  const log = config.log === undefined ? defaultConfig.log : config.log
  if (log !== 'off' && log !== 'summary') {
    throw new TypeError(`effort-default-fallback: log must be 'off' or 'summary', received ${JSON.stringify(config.log)}`)
  }
  const defaults = config.defaults === undefined ? defaultConfig.defaults : config.defaults
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
    throw new TypeError(`effort-default-fallback: defaults must be an object keyed by provider or "provider/model", received ${JSON.stringify(config.defaults)}`)
  }
  const providers = new Map<string, string>()
  const routes = new Map<string, string>()
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`effort-default-fallback: the entry "${key}" must name a reasoning effort, received ${JSON.stringify(value)}`)
    }
    const slash = key.indexOf('/')
    if (slash < 0) {
      if (key.trim() === '' || key !== key.trim()) {
        throw new TypeError(`effort-default-fallback: a provider key must be a non-empty provider id with no surrounding whitespace, received ${JSON.stringify(key)}`)
      }
      providers.set(key, value)
      continue
    }
    const provider = key.slice(0, slash)
    const model = key.slice(slash + 1)
    if (provider === '' || model === '' || key !== key.trim()) {
      throw new TypeError(`effort-default-fallback: "${key}" must be "provider/model" with both parts non-empty, received ${JSON.stringify(key)}`)
    }
    routes.set(routeKey(provider, model), value)
  }
  return { mode, providers, routes, log }
}
