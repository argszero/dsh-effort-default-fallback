/**
 * The integration harness: a REAL cordis context, the REAL `LlmRuntime` from
 * `@deepseek-ai/dsh-llm`, and a REAL `LlmAdapter` subclass registered on it.
 *
 * Nothing about the seam is simulated. The plugin wraps three methods **on the
 * service instance**, and this harness holds that instance the way the harness
 * does — `ctx.get('llm')[Symbol.for('cordis.original')]` — and drives the three
 * entry points the three surfaces use:
 *
 * | surface | entry point |
 * |---|---|
 * | the model picker | `resolveModelInfo()` (via `session-controller/catalog.ts`) |
 * | installing a session's selection | `resolveCallConfig()` (via `commands.ts#selectModel`) |
 * | the turn itself | `prepareCall()` (via `agent-loop`) |
 *
 * All three are the shipped implementations. What is fabricated is the
 * *subject*: an adapter whose `resolveModel` declares exactly the reasoning
 * surface a test asks for, and whose `stream` records the options it was handed
 * — which is how "the effort reached the wire" becomes an assertion instead of
 * an inference. The adapter is a stub on purpose: the claim being tested is a
 * claim about what the runtime resolves and forwards, and a stub that declares
 * `reasoning: { efforts: […], defaultEffort? }` is not a simulation of that — it
 * is the input to it.
 *
 * `plugin: false` is the control arm: it mounts everything else and leaves this
 * plugin out, so "the call carried an effort" becomes "the plugin caused the
 * call to carry an effort", which is the only form of the claim worth testing.
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

/** The neutral signal every fabricated request carries. */
export const SIGNAL = new AbortController().signal

/** The key the runtime's own traceable instance is filed under. */
export const ORIGINAL = Symbol.for('cordis.original')

/** An effort set wide enough to hold every quadrant's story. */
const WIDE = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
]

/**
 * A route-owned reasoning declaration.
 * @param efforts - the ids this route accepts.
 * @param defaultEffort - the effort the route materializes when a caller omits one.
 * @returns the `reasoning` metadata `resolveModel` returns.
 */
export function reasoning(efforts = WIDE.map(effort => effort.id), defaultEffort) {
  return {
    efforts: WIDE.filter(effort => efforts.includes(effort.id)),
    ...defaultEffort === undefined ? {} : { defaultEffort },
  }
}

/**
 * An adapter that declares exactly the reasoning metadata a test asks for, and
 * records every request it is asked to stream.
 *
 * Registered through the public `ctx.llm.registerAdapter(providers, adapter)`,
 * so the routes, the catalog and the capability lookups are the registry's.
 */
export class StubAdapter extends LlmAdapter {
  /**
   * @param models - `provider/model → declaration`, where a declaration is
   *   `{ reasoning }`, `{ reasoning: undefined }` for "this route declares
   *   nothing", `{ throws: true }` for an adapter that fails while asked, or
   *   `{ failAfter: n }` for one that answers `n` times and then fails — the
   *   shape a transient failure has, and the only way the plugin's own extra
   *   lookup can fail after the runtime's succeeded.
   */
  constructor(models) {
    super()
    this.models = models
    this.asked = []
    this.signals = []
    /** Every `GenerateOptions` the runtime handed to `stream`. */
    this.streams = []
  }

  /**
   * @param provider - the provider id the registry resolved.
   * @param model - the exact model id being asked about.
   * @param signal - the signal the caller forwarded.
   * @returns the declaration this stub was built with.
   */
  async resolveModel(provider, model, signal) {
    this.asked.push(`${provider}/${model}`)
    this.signals.push(signal)
    const declaration = this.models[`${provider}/${model}`]
    if (declaration?.throws === true) throw new Error(`stub adapter refuses to describe ${provider}/${model}`)
    if (declaration?.failAfter !== undefined) {
      const seen = this.asked.filter(entry => entry === `${provider}/${model}`).length
      if (seen > declaration.failAfter) throw new Error(`stub adapter failed on attempt ${seen} for ${provider}/${model}`)
    }
    return {
      provider,
      id: model,
      name: model,
      ...declaration?.reasoning === undefined ? {} : { reasoning: declaration.reasoning },
    }
  }

  /**
   * Record the request, then yield nothing.
   *
   * The request is what this harness is for: the runtime projects and forwards
   * `GenerateOptions`, so what arrives here is what the adapter would put on the
   * wire.
   * @param options - the fully-assembled request.
   * @returns an empty chunk stream.
   */
  async * stream(options) {
    this.streams.push(options)
  }
}

/**
 * Mount a real context with the real LLM registry.
 * @param spec - `plugin: false` omits this plugin (the control arm);
 *   `plugin: 'default'` mounts the module's `default` export, which is what a
 *   loader entry reaches; `config` is the plugin configuration; `models` is the
 *   stub adapter's declaration table; `providers` is the route list.
 * @returns the context, the adapter, the captured log, and the mount handle.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const logged = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })
  await ctx.plugin(LlmRuntime)
  const adapter = new StubAdapter(spec.models ?? {})
  const handle = ctx.llm.registerAdapter(spec.providers ?? ['route'], adapter)
  const harness = {
    ctx,
    adapter,
    logged,
    routes: handle,
    fork: undefined,
    /** The service instance the plugin writes its own properties on. */
    instance() {
      const view = ctx.get('llm')
      return view?.[ORIGINAL] ?? ctx.llm
    },
    /**
     * Mount the plugin (or a second copy of it), the way a loader entry does.
     * `vendor/loader` normalises a module with `exports.default ?? exports`, so
     * the object a profile entry actually reaches is the `default` export — the
     * namespace is mounted only to show what that difference hides.
     * @param options - `export: 'namespace'` mounts the module object itself.
     * @returns the fork handle.
     */
    async mount(options = {}) {
      const target = options.export === 'namespace' ? plugin : plugin.default
      return ctx.plugin(target, options.config ?? spec.config ?? {})
    },
    async dispose() {
      await harness.fork?.dispose()
      harness.fork = undefined
    },
  }
  if (spec.plugin !== false) harness.fork = await harness.mount()
  return harness
}

/**
 * Prepare one call through the shipped runtime and dispatch it, returning every
 * chunk and leaving the adapter's record of the request behind.
 *
 * The request is built from `prepared.config` exactly as `agent-loop`'s
 * `buildRequest` does (`…header.config`, plus `messages` and the signal), so the
 * `INVALID_PREPARED_CALL` guard — which compares the dispatched options against
 * the config `prepareCall` resolved — is the shipped guard, not a relaxed one.
 * @param harness - a harness from {@link world}.
 * @param config - the call config to prepare: `{ provider, model, … }`.
 * @returns the chunks the runtime produced.
 */
export async function dispatch(harness, config) {
  const prepared = await harness.ctx.llm.prepareCall(config, SIGNAL)
  const chunks = []
  for await (const chunk of prepared.stream({ ...prepared.config, messages: [], signal: SIGNAL })) {
    chunks.push(chunk)
  }
  return chunks
}

/** The captured log as one string. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}
