# @argszero/dsh-effort-default-fallback

A DeepSeek Harness plugin that gives a model which declares a reasoning ladder
and **no** default a real default effort, for exactly the routes you list.

## The failure it removes

`llm-pi-ai` describes a model's selectable efforts only when the model carries
reasoning metadata, and publishes a default only when the deployment configured
one:

```ts
// packages/llm/llm-pi-ai/src/adapter.ts
function reasoningInfo(model, defaultLevel) {
  if (!model.reasoning) return {}
  return {
    reasoning: {
      efforts: levels.map(…),
      …defaultLevel === undefined ? {} : { defaultEffort },
    },
  }
}
```

`defaultLevel` is `describableReasoningLevel(resolvedModel, profile.reasoning)`,
so it is `undefined` unless the provider profile sets `reasoning`. A route that
declares a ladder and no default is therefore the ordinary state of a fresh
third-party gateway, and `packages/llm/llm/src/index.ts` resolves a call with

```ts
const effective = requested ?? reasoning.defaultEffort
```

so when nothing requested an effort and the route declares no default, **nothing**
is resolved. The request goes out with no reasoning parameter, and `llm-pi-ai`
reads a missing parameter as explicit `off`: the model does not think. The user
sees an extra **Default** row in the effort menu, leaves it there, and gets `off`
with no error anywhere.

The clearest cases are the toggle models — Xiaomi MiMo and Moonshot / Kimi — but
they are not the only ones: any gateway with a reasoning ladder it does not
default is in the same state.

Three surfaces read that one absence, and the plugin covers all three:

| surface | reads | shows without this plugin |
|---|---|---|
| the model picker | `session-controller/catalog.ts` → `resolveModelInfo().reasoning.defaultEffort` | a synthetic **Default** row, in front of the real levels |
| installing a session's selection | `session-controller/commands.ts` → `resolveCallConfig()` | a selection with no `reasoningEffort`, which then logs and dispatches as none |
| the turn itself | `agent-loop` → `prepareCall()` | no reasoning parameter on the wire |

## The documented workaround, and why you might still want this

`llm-pi-ai`'s provider profile already fixes all three:

```yaml
llm:
  providers:
    xiaomi:
      reasoning: high
```

It is a **per-provider** knob — the profile type carries `reasoning` once per
provider and a per-model map only for `maxTokens` — so a gateway whose models
differ cannot be configured model by model, and turning it on to make one toggle
model think turns it on for every model behind that gateway. If that is your
situation, this plugin takes a `provider/model` key instead. If it is not,
**use the profile**: it marks the effort as an adapter default, which is the more
accurate description of what happened, and it needs no plugin.

## Install

```sh
npm install @argszero/dsh-effort-default-fallback
```

Then mount it — `cordis.patch.yml` in this package is a ready patch:

```yaml
- insert:
    - id: effort-default-fallback
      name: '@argszero/dsh-effort-default-fallback'
      config:
        mode: enforce
        defaults:
          xiaomi: high
          moonshot/kimi-k2-thinking: medium
```

`defaults` is the whole scope. A bare key names a whole provider; a
`provider/model` key names one exact route and wins when both are listed. The
split is on the **first** slash, so a provider id may not contain one and a
model id may.

## Modes

- **`observe`** (the default) — the listed routes are judged and counted, and
  nothing is changed. This is how you measure what would happen on your
  deployment before arming it.
- **`enforce`** — the routes that can take the default are given it.

Publishing a route default is not a menu fix: once it exists,
`requested ?? defaultEffort` gives it to *every* call on that route that names no
effort, including the auxiliary calls (`auto-review`, the compaction
summarizer). That is why the default is `observe` rather than `enforce`.

## What it refuses to do

Every rule is a refusal, and each is counted by name in the report:

- **an unlisted route is untouched** — the allowlist is the entire scope;
- **a route with no ladder is untouched** — `reasoning === undefined` means the
  route publishes no reasoning surface at all, and inventing one would advertise
  a control the model cannot honour;
- **a route that already declares a `defaultEffort` is untouched** — it has an
  answer, and this plugin has no business second-guessing it;
- **a level the ladder does not admit is refused**, counted, and warned about
  once — publishing it would move the failure from a silent `off` to a loud
  `UNSUPPORTED_REASONING_EFFORT`, and that throw happens inside `prepareCall`,
  before a stream exists, so it would be terminal for the turn;
- **`off` is refused as a value** — `off` *is* the absence this plugin exists to
  replace, so configuring it asks for an absence to be replaced with an absence.
  A route that must be pinned off belongs in the provider profile;
- **a route whose capability cannot be read is left alone** — an adapter that
  throws is `unknown`, never "supports nothing", and no default is published on a
  guess;
- **a call that already names an effort is never overridden** — this plugin
  supplies a default, not a policy.

A configuration that cannot be honoured is refused at mount, not repaired: an
entry that is not a non-empty string, a key with an empty half, and a `mode` or
`log` that is not one of the two values all raise rather than silently doing
something else. Only an **absent** key falls back to the default — which is why
`mode:` with nothing after it (a bare YAML key, i.e. `null`) is an error rather
than a quiet `observe`.

## Reading back what it did

```ts
ctx.get('effortDefaultFallback').snapshot()
```

```ts
{
  mode: 'enforce',
  counters: {
    reads: 3, selections: 1, calls: 7, errors: 0,
    outcomes: { published: 7, observed: 0, 'off-is-absence': 0, 'no-ladder': 3, … },
  },
  settings: …,
  notCovered: […],
}
```

`notCovered` is not decoration: a plugin that reports only its decisions leaves
you unable to tell "nothing needed filling" from "the plugin never ran". It
states, on every report, that

- only the three instance methods are wrapped — a caller that hands
  `GenerateOptions` straight to `ctx.llm.stream()` (the auxiliary paths:
  `auto-review`, the compaction summarizer) is **not** covered, because that
  entry point is synchronous and an effort cannot be checked against the route's
  ladder before it is published;
- only routes listed in `defaults` are judged, and everything else is not even
  counted;
- a provider key covers every model behind that provider, including models you
  did not think about — the same blast radius as the profile, which is what a
  `provider/model` key is for;
- the published effort is written into the resolved config, so the loop records
  it as the request's **own** reasoning effort rather than as an adapter default,
  and a resumed session re-imposes it as a named effort — the profile marks it as
  an adapter default instead;
- a route whose adapter throws while being inspected is left alone, and an
  unreadable route is never treated as a route that supports nothing.

`reset()` zeroes the counters.

## Compatibility

Compiled and tested against both builds of this DeepSeek Harness line:

- `0.2.1-alpha.2`
- `0.2.1-alpha.3`

`peerDependencies` declares that line and nothing older:

```
@deepseek-ai/dsh-llm: >=0.2.1-alpha.2 <0.3.0
@deepseek-ai/cordis: ~4.0.5-alpha.1
```

**Why the floor is `0.2.1-alpha.2` and not the released lines.** That is the
first build whose `LlmRuntime.prepareCall` is
`(config, signal?, configure?)`. On `0.1.7-rc.2`, `0.2.0-rc.2` and
`0.2.1-alpha.1` the runtime's `prepareCall` is `(config, signal?)`, so the turn
path has no callback for this plugin to compose with: the two query layers would
still answer, the request that actually reaches the adapter would carry nothing,
and — this is the dangerous part — the suite would be green either way. Those
lines also do not export `ConfigureCall` or `LlmCallControls`, so `src/` does not
compile against them at all. The ceiling is the same argument in the other
direction: `0.3.0` is a line nobody has run the suite against.

The builds are checked, not asserted: `npm run test:probe-lines` pins **every**
harness package of one build in a scratch tree, installs it with
`--legacy-peer-deps`, builds and runs the suite — for **every** published build
the range admits, floor included, because the floor is where this package's own
defect would live. A build that stops working is removed from the range, the
README and `SUPPORTED_LINES` in `test/packaging.spec.mjs` rather than left
claimed.

## Dependencies

None at run time. Every harness import in `src/` is type-only and erased; the
plugin reaches the service through `ctx.get('llm')` and writes on the instance
behind the view, and it asks `@deepseek-ai/dsh-llm`'s own `resolveModelInfo` for
a route's capability. `test/packaging.spec.mjs` asserts that the emitted
JavaScript in `lib/` contains no bare specifier at all, so the claim cannot
quietly stop being true.

## Development

```sh
npm install --legacy-peer-deps
npm test                 # tsc, then the suite
npm run test:inject      # defect injection: every arm must be caught
npm run test:probe-lines # pin one harness line and run the suite against it
```

## License

MIT
