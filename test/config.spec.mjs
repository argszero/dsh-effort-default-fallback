/**
 * The configuration surface: what it accepts, what it refuses, and what a
 * refusal costs.
 *
 * A configuration is a promise about which routes a mounted plugin will answer
 * for. Two failures matter, and both are silent in a naive version: an entry
 * that is quietly dropped (the operator lists a route, nothing ever happens, and
 * nothing says why) and an entry that is quietly repaired (the operator types an
 * effort and a different one is used). Every refusal here is asserted beside the
 * accepted form of the same field, so the assertion is about the rule rather
 * than about the fixture.
 *
 * @module test/config.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultConfig, normalizeConfig, routeKey } from '../lib/config.js'

test('the defaults are inert and stated', () => {
  assert.deepEqual(defaultConfig, { mode: 'observe', defaults: {}, log: 'summary' })
  const settings = normalizeConfig()
  assert.equal(settings.mode, 'observe')
  assert.equal(settings.log, 'summary')
  assert.equal(settings.providers.size, 0)
  assert.equal(settings.routes.size, 0)
})

test('a provider key and a route key are filed separately', () => {
  const settings = normalizeConfig({ defaults: { xiaomi: 'high', 'moonshot/kimi-k2-thinking': 'medium' } })
  assert.equal(settings.providers.get('xiaomi'), 'high')
  assert.equal(settings.routes.get(routeKey('moonshot', 'kimi-k2-thinking')), 'medium')
  assert.equal(settings.providers.size, 1)
  assert.equal(settings.routes.size, 1)
})

test('the route key splits on the first slash, so a model id may contain one', () => {
  const settings = normalizeConfig({ defaults: { 'gateway/meta-llama/llama-4': 'high' } })
  assert.equal(settings.routes.size, 1)
  assert.equal(settings.routes.get(routeKey('gateway', 'meta-llama/llama-4')), 'high')
})

test('an unknown mode is refused', () => {
  assert.throws(() => normalizeConfig({ mode: 'repair' }), /mode must be 'observe' or 'enforce'/)
  // The accepted forms, so the refusal above is about the value and not about
  // the field.
  assert.equal(normalizeConfig({ mode: 'observe' }).mode, 'observe')
  assert.equal(normalizeConfig({ mode: 'enforce' }).mode, 'enforce')
})

test('an unknown log setting is refused', () => {
  assert.throws(() => normalizeConfig({ log: 'verbose' }), /log must be 'off' or 'summary'/)
  assert.equal(normalizeConfig({ log: 'off' }).log, 'off')
})

test('an entry that does not name an effort is refused rather than dropped', () => {
  assert.throws(() => normalizeConfig({ defaults: { route: '' } }), /must name a reasoning effort/)
  assert.throws(() => normalizeConfig({ defaults: { route: '   ' } }), /must name a reasoning effort/)
  assert.throws(() => normalizeConfig({ defaults: { route: 3 } }), /must name a reasoning effort/)
  assert.equal(normalizeConfig({ defaults: { route: 'high' } }).providers.get('route'), 'high')
})

test('a malformed route key is refused rather than read as a provider', () => {
  assert.throws(() => normalizeConfig({ defaults: { '/toggle': 'high' } }), /must be "provider\/model"/)
  assert.throws(() => normalizeConfig({ defaults: { 'route/': 'high' } }), /must be "provider\/model"/)
  assert.throws(() => normalizeConfig({ defaults: { ' route': 'high' } }), /non-empty/)
  // Whitespace on either side of a `provider/model` key is the same mistake on
  // the other branch of the split, and it fails the same way: filed under a
  // provider id nobody will ever ask for is a setting that silently did not
  // apply.
  assert.throws(() => normalizeConfig({ defaults: { ' route/toggle': 'high' } }), /must be "provider\/model"/)
  assert.throws(() => normalizeConfig({ defaults: { 'route/toggle ': 'high' } }), /must be "provider\/model"/)
  assert.equal(normalizeConfig({ defaults: { 'route/toggle': 'high' } }).routes.size, 1)
})

test('a defaults value that is not an object is refused', () => {
  assert.throws(() => normalizeConfig({ defaults: ['route'] }), /defaults must be an object/)
  assert.equal(normalizeConfig({ defaults: {} }).providers.size, 0)
})

test('only an absent key falls back, so a bare key is refused rather than read as a default', () => {
  // `null` is what a bare key in YAML is, and it is the one class of mistake
  // this plugin exists to remove: a setting that silently did not apply. `??`
  // would fold it into the default and make exactly that silent.
  assert.throws(() => normalizeConfig({ mode: null }), /mode must be 'observe' or 'enforce'/)
  assert.throws(() => normalizeConfig({ log: null }), /log must be 'off' or 'summary'/)
  assert.throws(() => normalizeConfig({ defaults: null }), /defaults must be an object/)
  // The absent forms, so the refusals above are about the value and not about
  // the fields.
  assert.equal(normalizeConfig({ mode: undefined }).mode, 'observe')
  assert.equal(normalizeConfig({ log: undefined }).log, 'summary')
  assert.equal(normalizeConfig({ defaults: undefined }).providers.size, 0)
})

test('the resolved settings do not alias the caller\'s object', () => {
  const defaults = { route: 'high' }
  const settings = normalizeConfig({ defaults })
  defaults.route = 'low'
  assert.equal(settings.providers.get('route'), 'high')
})
