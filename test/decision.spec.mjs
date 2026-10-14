/**
 * The decision table, row by row.
 *
 * Every row of the table in `src/decision.ts` is a claim about what the plugin
 * does or refuses, and each is reachable here without a context, an adapter or
 * an asynchronous lookup: `decide` is a pure function of the resolution, the
 * route and the route's own declaration.
 *
 * The rows that matter most are the refusals. A plugin that filled every gap it
 * found would turn "the route says nothing" into "the route thinks" and "the
 * level was misconfigured" into a terminal `UNSUPPORTED_REASONING_EFFORT`, so
 * each refusal is asserted with the *positive* control beside it — the same
 * input with the one field changed that makes the plugin act.
 *
 * @module test/decision.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { OUTCOMES, decide, publishedEffort } from '../lib/decision.js'
import { normalizeConfig } from '../lib/config.js'

/** The ladder the toggle models in the source report publish. */
const TOGGLE = { efforts: [{ id: 'off' }, { id: 'high' }] }

/** Settings with one provider-wide key. */
function settings(defaults, mode = 'enforce') {
  return normalizeConfig({ mode, defaults })
}

/** Settings with one exact-route key. */
function routeSettings(defaults, mode = 'enforce') {
  return normalizeConfig({ mode, defaults })
}

test('a listed route with a ladder and no default is published', () => {
  const finding = decide(settings({ route: 'high' }), 'route', 'toggle', TOGGLE)
  assert.equal(finding.outcome, 'published')
  assert.equal(publishedEffort(finding), 'high')
})

test('observe reaches the same decision and publishes nothing', () => {
  const observing = decide(settings({ route: 'high' }, 'observe'), 'route', 'toggle', TOGGLE)
  assert.equal(observing.outcome, 'observed')
  assert.equal(publishedEffort(observing), undefined)
  // The positive control: the same input in `enforce` does publish, so the
  // assertion above is about the mode and not about the input being inert.
  assert.equal(decide(settings({ route: 'high' }, 'enforce'), 'route', 'toggle', TOGGLE).outcome, 'published')
})

test('an unlisted provider is untouched', () => {
  assert.equal(decide(settings({ other: 'high' }), 'route', 'toggle', TOGGLE).outcome, 'unlisted')
  assert.equal(publishedEffort(decide(settings({ other: 'high' }), 'route', 'toggle', TOGGLE)), undefined)
})

test('an unlisted model on a listed provider is untouched unless it is keyed', () => {
  const listed = routeSettings({ 'route/toggle': 'high' })
  assert.equal(decide(listed, 'route', 'toggle', TOGGLE).outcome, 'published')
  assert.equal(decide(listed, 'route', 'other', TOGGLE).outcome, 'unlisted')
  // …while a provider-wide key covers every model behind it, which is the
  // blast radius the README states.
  assert.equal(decide(settings({ route: 'high' }), 'route', 'other', TOGGLE).outcome, 'published')
})

test('an exact-route key wins over a provider key', () => {
  const both = routeSettings({ route: 'low', 'route/toggle': 'high' })
  assert.equal(decide(both, 'route', 'toggle', TOGGLE).effort, 'high')
  assert.equal(decide(both, 'route', 'other', TOGGLE).effort, 'low')
})

test('off is refused as a value: it is the absence being filled', () => {
  const finding = decide(settings({ route: 'off' }), 'route', 'toggle', TOGGLE)
  assert.equal(finding.outcome, 'off-is-absence')
  assert.equal(finding.effort, 'off')
  assert.equal(publishedEffort(finding), undefined)
})

test('a route with no ladder is untouched: there is no default to fill', () => {
  const finding = decide(settings({ route: 'high' }), 'route', 'toggle', undefined)
  assert.equal(finding.outcome, 'no-ladder')
  // The positive control: the same route with a ladder is published.
  assert.equal(decide(settings({ route: 'high' }), 'route', 'toggle', TOGGLE).outcome, 'published')
})

test('a route that declares its own default is never second-guessed', () => {
  const declared = { efforts: TOGGLE.efforts, defaultEffort: 'off' }
  const finding = decide(settings({ route: 'high' }), 'route', 'toggle', declared)
  assert.equal(finding.outcome, 'already-declared')
  assert.equal(publishedEffort(finding), undefined)
  // Even when the route's own default is not what this plugin prefers.
  assert.equal(decide(settings({ route: 'high' }), 'route', 'toggle', { ...TOGGLE, defaultEffort: 'high' }).outcome, 'already-declared')
})

test('a level the ladder does not admit is refused rather than published', () => {
  const finding = decide(settings({ route: 'medium' }), 'route', 'toggle', TOGGLE)
  assert.equal(finding.outcome, 'unsupported')
  assert.equal(finding.effort, 'medium')
  assert.equal(publishedEffort(finding), undefined)
})

test('a lone off ladder admits nothing this plugin will publish', () => {
  const only = { efforts: [{ id: 'off' }] }
  assert.equal(decide(settings({ route: 'high' }), 'route', 'toggle', only).outcome, 'unsupported')
  // …including the level the ladder does hold, which is the absence itself.
  assert.equal(decide(settings({ route: 'off' }), 'route', 'toggle', only).outcome, 'off-is-absence')
})

test('the outcome union is closed over every input the table can be handed', () => {
  const declarations = [
    undefined,
    TOGGLE,
    { efforts: [{ id: 'off' }] },
    { ...TOGGLE, defaultEffort: 'high' },
  ]
  const configurations = [
    settings({ route: 'high' }, 'enforce'),
    settings({ route: 'high' }, 'observe'),
    settings({ route: 'medium' }, 'enforce'),
    settings({ route: 'off' }, 'enforce'),
    settings({ other: 'high' }, 'enforce'),
    routeSettings({ 'route/toggle': 'high' }),
    routeSettings({ 'route/other': 'high' }),
  ]
  const seen = new Set()
  for (const configuration of configurations) {
    for (const declaration of declarations) {
      const finding = decide(configuration, 'route', 'toggle', declaration)
      seen.add(finding.outcome)
      // Whatever the answer, it is a member of the declared union, and only
      // `published` ever carries an effort back to a caller.
      assert.ok(OUTCOMES.includes(finding.outcome), `${finding.outcome} is not in OUTCOMES`)
      assert.equal(publishedEffort(finding) === undefined, finding.outcome !== 'published')
    }
  }
  // Six of the nine outcomes are reachable from this table alone — the whole
  // population the counters can hold except the two the entry points produce
  // (`unresolved` for an adapter that threw, `named` for a call that already
  // carried an effort) and `observed`, which needs `observe` mode and is swept
  // here by the second configuration.
  assert.deepEqual(
    [...seen].sort(),
    ['already-declared', 'no-ladder', 'observed', 'off-is-absence', 'published', 'unlisted', 'unsupported'],
  )
})
