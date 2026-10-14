/**
 * The seam: the three shipped entry points, on a real context, with the plugin
 * mounted the way a profile mounts it.
 *
 * Every assertion here is paired with a control. Either the control is
 * `plugin: false` — the same call on the same context with the plugin not
 * mounted, which is what turns "the request carried an effort" into "the plugin
 * made it carry one" — or it is the one field changed that flips the verdict.
 * An arm without its control measures the fixture, not the plugin.
 *
 * The load-bearing arm is the last of the three surfaces: the request the stub
 * adapter is handed. That is the only place where "the model thinks" becomes
 * observable without a provider.
 *
 * @module test/seam.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SIGNAL, dispatch, logText, reasoning, world } from './harness.mjs'

/** The ladder a toggle model publishes: thinking on, or off, and no default. */
const TOGGLE = { 'route/toggle': { reasoning: reasoning(['off', 'high']) } }

/** The configuration every arm starts from; each arm changes one thing. */
const ENFORCE = { mode: 'enforce', defaults: { route: 'high' } }

/** One context, mounted with this plugin and a toggle-model route. */
async function enforce(config = ENFORCE, models = TOGGLE, spec = {}) {
  return world({ ...spec, config, models })
}

test('the picker\'s source publishes the default, and only when armed', async () => {
  const armed = await enforce()
  const info = await armed.ctx.llm.resolveModelInfo('route', 'toggle', SIGNAL)
  assert.equal(info.reasoning?.defaultEffort, 'high')
  // The ladder is the route's own and is not rewritten.
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['off', 'high'])
  assert.deepEqual(armed.adapter.signals.at(-1), SIGNAL)

  const observing = await enforce({ ...ENFORCE, mode: 'observe' })
  assert.equal((await observing.ctx.llm.resolveModelInfo('route', 'toggle', SIGNAL)).reasoning?.defaultEffort, undefined)
  assert.equal((await observing.ctx.get('effortDefaultFallback').snapshot()).counters.outcomes.observed, 1)

  const control = await enforce(ENFORCE, TOGGLE, { plugin: false })
  assert.equal((await control.ctx.llm.resolveModelInfo('route', 'toggle', SIGNAL)).reasoning?.defaultEffort, undefined)
  assert.equal(control.ctx.get('effortDefaultFallback'), undefined)
})

test('the selection the session controller installs carries the default', async () => {
  const armed = await enforce()
  const resolved = await armed.ctx.llm.resolveCallConfig({ provider: 'route', model: 'toggle' }, SIGNAL)
  assert.equal(resolved.reasoningEffort, 'high')
  assert.equal(resolved.provider, 'route')

  const control = await enforce(ENFORCE, TOGGLE, { plugin: false })
  assert.equal(
    (await control.ctx.llm.resolveCallConfig({ provider: 'route', model: 'toggle' }, SIGNAL)).reasoningEffort,
    undefined,
  )
})

test('the turn reaches the adapter with the default, and only when armed', async () => {
  const armed = await enforce()
  await dispatch(armed, { provider: 'route', model: 'toggle' })
  assert.equal(armed.adapter.streams.length, 1)
  assert.equal(armed.adapter.streams[0].reasoningEffort, 'high')
  // Nothing else about the request was touched.
  assert.equal(armed.adapter.streams[0].provider, 'route')
  assert.equal(armed.adapter.streams[0].model, 'toggle')

  const observing = await enforce({ ...ENFORCE, mode: 'observe' })
  await dispatch(observing, { provider: 'route', model: 'toggle' })
  assert.equal(observing.adapter.streams[0].reasoningEffort, undefined)

  const control = await enforce(ENFORCE, TOGGLE, { plugin: false })
  await dispatch(control, { provider: 'route', model: 'toggle' })
  assert.equal(control.adapter.streams[0].reasoningEffort, undefined)
})

test('a call that already names an effort keeps it', async () => {
  const harness = await enforce()
  const resolved = await harness.ctx.llm.resolveCallConfig(
    { provider: 'route', model: 'toggle', reasoningEffort: 'off' },
    SIGNAL,
  )
  assert.equal(resolved.reasoningEffort, 'off')
  await dispatch(harness, { provider: 'route', model: 'toggle', reasoningEffort: 'off' })
  assert.equal(harness.adapter.streams[0].reasoningEffort, 'off')
  // And the refusal to override is counted, so an operator can see how often a
  // default was not needed rather than assume the plugin is inert. Both of the
  // surfaces that could have written record it — installing a selection and the
  // turn itself — and the one that could not have (`resolveModelInfo` describes
  // a route, not a call) is not one of them.
  const snapshot = harness.ctx.get('effortDefaultFallback').snapshot()
  assert.equal(snapshot.counters.outcomes.named, 2)
  assert.equal(snapshot.counters.outcomes.published ?? 0, 0)
})

test('a route that declares its own default is not second-guessed', async () => {
  const declared = { 'route/toggle': { reasoning: reasoning(['off', 'high'], 'off') } }
  const harness = await enforce(ENFORCE, declared)
  const resolved = await harness.ctx.llm.resolveCallConfig({ provider: 'route', model: 'toggle' }, SIGNAL)
  assert.equal(resolved.reasoningEffort, 'off')
  await dispatch(harness, { provider: 'route', model: 'toggle' })
  assert.equal(harness.adapter.streams[0].reasoningEffort, 'off')
  assert.equal((await harness.ctx.llm.resolveModelInfo('route', 'toggle', SIGNAL)).reasoning?.defaultEffort, 'off')
  assert.equal(harness.ctx.get('effortDefaultFallback').snapshot().counters.outcomes['already-declared'], 3)
})

test('a level the ladder does not admit is refused, counted and warned about once', async () => {
  const harness = await enforce({ mode: 'enforce', defaults: { route: 'medium' } })
  assert.equal((await harness.ctx.llm.resolveModelInfo('route', 'toggle', SIGNAL)).reasoning?.defaultEffort, undefined)
  assert.equal(
    (await harness.ctx.llm.resolveCallConfig({ provider: 'route', model: 'toggle' }, SIGNAL)).reasoningEffort,
    undefined,
  )
  await dispatch(harness, { provider: 'route', model: 'toggle' })
  assert.equal(harness.adapter.streams[0].reasoningEffort, undefined)
  const text = logText(harness.logged)
  assert.match(text, /does not offer reasoning effort "medium"/)
  assert.equal(text.match(/does not offer reasoning effort/g).length, 1)
})

test('a route with no ladder is left alone: nothing is invented', async () => {
  const harness = await enforce(ENFORCE, { 'route/toggle': {} })
  const info = await harness.ctx.llm.resolveModelInfo('route', 'toggle', SIGNAL)
  assert.equal(info.reasoning, undefined)
  assert.equal(
    (await harness.ctx.llm.resolveCallConfig({ provider: 'route', model: 'toggle' }, SIGNAL)).reasoningEffort,
    undefined,
  )
  await dispatch(harness, { provider: 'route', model: 'toggle' })
  assert.equal(harness.adapter.streams[0].reasoningEffort, undefined)
  assert.equal(harness.ctx.get('effortDefaultFallback').snapshot().counters.outcomes['no-ladder'], 3)
})

test('a route whose capability cannot be read is left alone, never guessed', async () => {
  // The runtime's own lookup succeeds and the plugin's second one fails, which
  // is what a transient adapter failure looks like from here.
  const harness = await enforce(ENFORCE, { 'route/toggle': { reasoning: reasoning(['off', 'high']), failAfter: 1 } })
  const resolved = await harness.ctx.llm.resolveCallConfig({ provider: 'route', model: 'toggle' }, SIGNAL)
  assert.equal(resolved.reasoningEffort, undefined)
  assert.equal(harness.ctx.get('effortDefaultFallback').snapshot().counters.outcomes.unresolved, 1)
})

test('a call that names no effort in a failing resolveCallConfig still fails', async () => {
  const harness = await enforce(ENFORCE, { 'route/toggle': { throws: true } })
  await assert.rejects(
    harness.ctx.llm.resolveCallConfig({ provider: 'route', model: 'toggle' }, SIGNAL),
    /refuses to describe/,
  )
  // The plugin does not swallow a failure the runtime would have raised.
  assert.equal(harness.ctx.get('effortDefaultFallback').snapshot().counters.errors, 1)
})

test('the direct stream entry point is the declared blind spot', async () => {
  const harness = await enforce()
  for await (const _ of harness.ctx.llm.stream({ provider: 'route', model: 'toggle', messages: [], signal: SIGNAL })) {
    // Consumed so the adapter's own generator runs.
  }
  assert.equal(harness.adapter.streams.length, 1)
  assert.equal(harness.adapter.streams[0].reasoningEffort, undefined)
})

test('the plugin composes with a caller\'s own configure callback', async () => {
  const harness = await enforce()
  // A caller that names an effort through the callback wins — and `off` is the
  // sharpest arm: it is the one value this plugin refuses to publish, so what
  // the callback gets at the end can only have come from the callback.
  const named = await harness.ctx.llm.prepareCall(
    { provider: 'route', model: 'toggle' },
    SIGNAL,
    controls => ({ ...controls, reasoningEffort: 'off' }),
  )
  assert.equal(named.config.reasoningEffort, 'off')
  // …and one that names none receives the plugin's default, which is the whole
  // reason the plugin composes with the callback instead of rewriting the
  // config before the callback runs.
  const silent = await harness.ctx.llm.prepareCall(
    { provider: 'route', model: 'toggle' },
    SIGNAL,
    controls => ({ ...controls }),
  )
  assert.equal(silent.config.reasoningEffort, 'high')
})

test('the snapshot reports what the plugin did, and the blind spots it declares', async () => {
  const harness = await enforce()
  // One call through each of the three surfaces, so the three entry counters are
  // each exercised rather than only the one the load-bearing arm happens to use.
  await harness.ctx.llm.resolveModelInfo('route', 'toggle', SIGNAL)
  await harness.ctx.llm.resolveCallConfig({ provider: 'route', model: 'toggle' }, SIGNAL)
  await dispatch(harness, { provider: 'route', model: 'toggle' })
  const service = harness.ctx.get('effortDefaultFallback')
  const snapshot = service.snapshot()
  assert.equal(snapshot.mode, 'enforce')
  assert.equal(snapshot.counters.reads, 1)
  assert.equal(snapshot.counters.selections, 1)
  assert.equal(snapshot.counters.calls, 1)
  assert.equal(snapshot.counters.outcomes.published, 3)
  // `unlisted` is not a counter: a route this plugin was not told about never
  // reaches it, which is the difference the scope test buys.
  assert.equal(Object.hasOwn(snapshot.counters.outcomes, 'unlisted'), false)
  // Sorted: what is asserted is the *set* of counted outcomes, not their order.
  assert.deepEqual(Object.keys(snapshot.counters.outcomes).sort(), [
    'already-declared', 'named', 'no-ladder', 'observed', 'off-is-absence', 'published', 'unresolved', 'unsupported',
  ])
  assert.equal(snapshot.notCovered.length >= 5, true)
  assert.match(snapshot.notCovered.join('\n'), /ctx\.llm\.stream\(\)/)
  // `settings` is the resolved configuration, not the raw one.
  assert.equal(snapshot.settings.providers.get('route'), 'high')
  service.reset()
  assert.equal(service.snapshot().counters.calls, 0)
  assert.equal(service.snapshot().counters.outcomes.published, 0)
})

test('a mounted plugin with no configuration publishes nothing anywhere', async () => {
  const harness = await enforce({})
  assert.equal((await harness.ctx.llm.resolveModelInfo('route', 'toggle', SIGNAL)).reasoning?.defaultEffort, undefined)
  await dispatch(harness, { provider: 'route', model: 'toggle' })
  assert.equal(harness.adapter.streams[0].reasoningEffort, undefined)
  const snapshot = harness.ctx.get('effortDefaultFallback').snapshot()
  assert.equal(snapshot.counters.reads, 0)
  assert.equal(snapshot.counters.calls, 0)
})

test('unmounting gives the instance back what the first mount found', async () => {
  const harness = await enforce()
  const instance = harness.instance()
  assert.equal(typeof Object.getOwnPropertyDescriptor(instance, 'resolveModelInfo')?.value, 'function')
  await harness.fork.dispose()
  harness.fork = undefined
  for (const method of ['resolveModelInfo', 'resolveCallConfig', 'prepareCall']) {
    assert.equal(Object.getOwnPropertyDescriptor(instance, method), undefined, method)
  }
  assert.equal((await harness.ctx.llm.resolveModelInfo('route', 'toggle', SIGNAL)).reasoning?.defaultEffort, undefined)
  await dispatch(harness, { provider: 'route', model: 'toggle' })
  assert.equal(harness.adapter.streams[0].reasoningEffort, undefined)
})

test('the publication line is written once per route, not once per call', async () => {
  const harness = await enforce()
  await dispatch(harness, { provider: 'route', model: 'toggle' })
  await dispatch(harness, { provider: 'route', model: 'toggle' })
  // One line per route is the whole point of the announcement: a line per call
  // would turn a long session's log into the same sentence thousands of times,
  // and an operator reading it back could not tell a plugin that published once
  // from one that published every turn.
  const text = logText(harness.logged)
  assert.equal(text.match(/every call that names no effort now carries/g).length, 1)
  assert.equal(harness.ctx.get('effortDefaultFallback').snapshot().counters.outcomes.published, 2)
})

test('an unmount leaves a wrapper that is not its own alone', async () => {
  const harness = await enforce()
  const instance = harness.instance()
  // A layer that arrives *after* this mount — another plugin, or the host — on
  // the same method. What it found underneath is this plugin's layer, so an
  // unmount that restored the descriptor it displaced would silently delete work
  // it does not own.
  const foreign = function resolveCallConfig() { return Promise.resolve({ provider: 'route', model: 'toggle' }) }
  Object.defineProperty(instance, 'resolveCallConfig', {
    value: foreign, writable: true, enumerable: false, configurable: true,
  })
  await harness.fork.dispose()
  harness.fork = undefined
  for (const method of ['resolveModelInfo', 'prepareCall']) {
    assert.equal(Object.getOwnPropertyDescriptor(instance, method), undefined, method)
  }
  assert.equal(Object.getOwnPropertyDescriptor(instance, 'resolveCallConfig')?.value, foreign)
})

test('a mount that follows an unmount is the configuration in force', async () => {
  // A ladder wide enough that the two configurations differ in a level both
  // admit: a second mount asking for `low` on the toggle ladder would be
  // refused for the same reason the first publishes `high`, and the arm would
  // then measure the ladder rather than which configuration is in force.
  const WIDE = { 'route/wide': { reasoning: reasoning(['off', 'low', 'high']) } }
  const ask = async harness =>
    (await harness.ctx.llm.resolveCallConfig({ provider: 'route', model: 'wide' }, SIGNAL)).reasoningEffort

  const harness = await enforce(ENFORCE, WIDE)
  assert.equal(await ask(harness), 'high')
  // Only one mount can exist at a time, and that is cordis's rule rather than
  // this plugin's: the service is registered per name and cordis refuses to
  // register one name twice, so a second *concurrent* mount fails at `provide`
  // instead of stacking. A profile that changes this configuration therefore
  // unmounts first, which is the path this arm drives.
  await harness.fork.dispose()
  harness.fork = await harness.mount({ config: { mode: 'enforce', defaults: { route: 'low' } } })
  assert.equal(await ask(harness), 'low')
  // And after the second mount is gone the route's ladder has no default again:
  // a mount restores exactly the descriptors it found, so neither layer leaves
  // anything behind for the next one.
  await harness.fork.dispose()
  harness.fork = undefined
  assert.equal(await ask(harness), undefined)
})

test('mounting the module object a loader normalises away still mounts', async () => {
  const harness = await world({ plugin: false, models: TOGGLE })
  harness.fork = await harness.mount({ export: 'namespace', config: ENFORCE })
  const resolved = await harness.ctx.llm.resolveCallConfig({ provider: 'route', model: 'toggle' }, SIGNAL)
  assert.equal(resolved.reasoningEffort, 'high')
})
