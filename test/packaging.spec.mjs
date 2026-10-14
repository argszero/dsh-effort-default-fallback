/**
 * Packaging guard: the published artifact must declare every bare specifier it
 * imports, must not declare packages it never mentions, must actually ship the
 * files the manifest promises — and must describe its own compatibility range
 * the same way in the manifest and in the README.
 *
 * Each arm is a defect this family has already shipped once somewhere:
 *
 * - A value import declared only in `devDependencies` resolves on the publishing
 *   machine and fails for a consumer with `ERR_MODULE_NOT_FOUND`.
 * - A `files` list that names the entry but not its modules publishes a package
 *   whose own relative imports are missing.
 * - A peer range written too long admits lines where an imported symbol does not
 *   exist; quoted only partially in the README, the documentation becomes the
 *   trap. Both halves are asserted against one list of supported lines.
 *
 * This package makes a stronger claim than most in the family, and the checks
 * below are what hold it to it: it has **no runtime dependency at all**. Its only
 * bare specifiers are type-only imports, which TypeScript erases, so `lib/` must
 * contain nothing but `node:` builtins and its own relative modules. A single
 * added value import would turn the claim into a lie, which is why the assertion
 * is on the emitted JavaScript rather than on the sources.
 *
 * `npm pack --dry-run` is deliberate: it uses npm's own matcher, where a
 * hand-rolled glob would be the same guess the defect is made of.
 *
 * @module test/packaging.spec
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * The builds the suite has actually been run against.
 *
 * Probed with `npm run test:probe-lines`, whose default set is exactly the
 * published builds the peer range admits, so this list and that command cannot
 * drift apart — adding a build here without running it is how a wrong range gets
 * published. The list is the contract, and the manifest has to agree with it
 * rather than the other way round.
 *
 * The list is short because the range is short, and the range is short because
 * of a mechanism: `LlmRuntime.prepareCall` takes a third `configure` parameter
 * only from `0.2.1-alpha.2` on — before that it is `prepareCall(config, signal?)`
 * — and that callback is what the turn path is built on. On an earlier build the
 * composed callback is simply never invoked, so the turn would be silently
 * uncovered while every other arm of the suite stayed green. The range therefore
 * starts at the build that introduced the parameter, and **both** builds of that
 * line are listed because both are admitted.
 */
const SUPPORTED_LINES = ['0.2.1-alpha.2', '0.2.1-alpha.3']

/**
 * The nearest builds the range must **exclude**, each with the reading that put
 * it there. A range's floor is a claim like any other, and the only way it stops
 * being one is to assert what it keeps out.
 *
 * The readings were taken from the published tarballs' own declarations, one
 * line each — `lib/types/index.d.ts` for the signatures, `package.json` for the
 * cordis range the line asks for — because "compiled and tested against" is a
 * claim about build artifacts and not about any commit.
 */
const EXCLUDED_LINES = [
  // `prepareCall(config, signal?)` from here down: two parameters, so the turn
  // path's composition has nothing to compose with — and no `ConfigureCall` or
  // `LlmCallControls`, so `src/` does not compile against the line either.
  ['0.2.1-alpha.1', 'the last build whose prepareCall has no configure parameter'],
  ['0.2.0-rc.2', 'the newest released line, whose prepareCall is (config, signal?)'],
  ['0.1.7-rc.2', 'the line the family this plugin was ported from was developed on'],
]

/** Every file under `dir` whose name ends with one of `extensions`. */
function walk(dir, extensions, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, extensions, found)
    else if (extensions.some(extension => entry.name.endsWith(extension))) found.push(path)
  }
  return found
}

/** Specifiers reached by static import/export (value or type), `import()` and `require()`. */
function allSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /(?:^|[\s;{])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;(=])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;{])(?:import|export)\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers]
}

/** Specifiers a loader resolves at run time: `import x from 'y'`, not `import type { X } from 'y'`. */
function valueSpecifiers(source) {
  return allSpecifiers(source).filter((specifier) => {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:import|export)\\s+(?!type\\b)[^'"]*?from\\s*['"]${escaped}['"]`).test(source)
  })
}

/** Bare (installable) specifiers only: relative targets and `node:` builtins are not packages. */
function bareSpecifiers(source) {
  return allSpecifiers(source).filter(specifier =>
    !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:'))
}

/** The package a specifier resolves to: `@scope/name` or `name`, subpath dropped. */
function packageOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const runtimeDeclared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])

/** The harness packages whose API this plugin is compiled against. */
const dshPeers = Object.keys(manifest.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))

const sourceFiles = walk(join(ROOT, 'src'), ['.ts'])
const emittedFiles = walk(join(ROOT, 'lib'), ['.js'])
const imported = new Set()
const importedForValue = new Set()
for (const file of [...sourceFiles, ...emittedFiles]) {
  const source = readFileSync(file, 'utf8')
  for (const specifier of bareSpecifiers(source)) imported.add(packageOf(specifier))
  for (const specifier of valueSpecifiers(source)) {
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    importedForValue.add(packageOf(specifier))
  }
}

/** What npm itself would put in the tarball. */
function packedPaths() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' })
  const parsed = JSON.parse(output)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  return new Set(entry.files.map(file => file.path))
}

test('the guard has something to guard', () => {
  // A walk that silently finds nothing would make every assertion below vacuous.
  assert.ok(sourceFiles.some(file => file.endsWith(join('src', 'index.ts'))), 'src/index.ts must be scanned')
  assert.ok(emittedFiles.some(file => file.endsWith(join('lib', 'index.js'))), 'lib/index.js must be built and scanned')
  assert.ok(emittedFiles.length >= 3, `expected the three compiled modules, saw ${emittedFiles.length}`)
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm']) {
    assert.ok(imported.has(name), `the walk must find the import of ${name}, saw ${[...imported].join(', ')}`)
  }
  // The source imports its own modules relatively; if that stopped being true the
  // tarball check below would be checking an artifact with no internal edges.
  const relative = new Set(sourceFiles.flatMap(file =>
    allSpecifiers(readFileSync(file, 'utf8')).filter(specifier => specifier.startsWith('.'))))
  assert.deepEqual([...relative].sort(), ['./config.ts', './decision.ts'],
    'the entry must reach its own modules, and nothing else in src/ may')
})

test('the emitted artifact has no runtime package dependency at all', () => {
  // The claim the README makes. Not "the peer ranges are right" — that they are
  // never reached: every dependency is a type, and types are erased.
  const bare = []
  for (const file of emittedFiles) {
    for (const specifier of bareSpecifiers(readFileSync(file, 'utf8'))) {
      bare.push(`${file.slice(ROOT.length + 1)} imports ${specifier}`)
    }
  }
  assert.deepEqual(bare, [], `the shipped JavaScript reaches for a package: ${bare.join('; ')}`)
  assert.deepEqual([...importedForValue].filter(name => !name.startsWith('node:')), [],
    'every bare import in the sources must be type-only')
  // The one value import in the sources is this plugin's own module graph, and
  // the one artifact-wide invariant that makes that checkable is that `node:` is
  // the only other thing the emitted files may reach for.
  const emitted = emittedFiles.flatMap(file => bareSpecifiers(readFileSync(file, 'utf8')))
  assert.deepEqual(emitted, [], `the tarball's JavaScript must reach nothing but its own modules: ${emitted.join(', ')}`)
})

test('every bare import in the published artifact is declared', () => {
  const undeclared = [...imported].filter(name => !runtimeDeclared.has(name))
  assert.deepEqual(
    undeclared,
    [],
    `imported by shipped code but not declared in dependencies/peerDependencies: ${undeclared.join(', ')}`
      + ' — a consumer installing this package by name gets ERR_MODULE_NOT_FOUND',
  )
})

test('no runtime declaration is left over from a version this plugin no longer describes', () => {
  const unused = [...runtimeDeclared].filter(name => !imported.has(name))
  assert.deepEqual(unused, [], `declared but never imported by shipped code: ${unused.join(', ')}`)
  // The plugin never imports the runtime it wraps for value: it reaches the
  // service through `ctx.get('llm')` and writes on the instance behind the view.
  // Declaring the runtime as a dependency instead would be a dependency the
  // artifact does not have, and — because a plugin's own dependency can
  // materialize a second copy of a harness package — a failure this family has
  // already produced more than once.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes('@deepseek-ai/dsh-llm'), 'the README must name the package whose API it reads')
})

test('every harness peer range admits exactly the lines this plugin claims, and no next minor', () => {
  assert.ok(dshPeers.includes('@deepseek-ai/dsh-llm'), `expected the registry peer to be declared, saw ${dshPeers.join(', ')}`)
  for (const name of dshPeers) {
    const range = manifest.peerDependencies[name]
    assert.ok(typeof range === 'string' && range.length > 0, `${name} must carry a range`)
    for (const line of SUPPORTED_LINES) {
      assert.ok(semver.satisfies(line, range), `the peer range for ${name} rejects ${line}, which the README claims`)
    }
    // The list and the range describe one claim, so they must agree about its
    // *shape*: a single line, oldest build first, each named once. A range
    // stitched together from two lines with `||` is how a segment nobody probed
    // gets admitted while the list still looks right.
    assert.deepEqual([...SUPPORTED_LINES].sort(semver.compare), SUPPORTED_LINES,
      'the probed builds must be listed oldest first')
    assert.equal(new Set(SUPPORTED_LINES).size, SUPPORTED_LINES.length,
      `a probed build is listed twice: ${SUPPORTED_LINES.join(', ')}`)
    assert.equal(new Set(SUPPORTED_LINES.map(build => build.split('-')[0])).size, 1,
      `the probed builds must all belong to one line, saw ${SUPPORTED_LINES.join(', ')}`)
    // The ceiling is the next line, not the next major: a range that reached
    // further would claim a build the suite has never run against.
    assert.ok(!semver.satisfies('0.3.0', range), `the peer range for ${name} must not admit the next line`)
    assert.ok(!semver.satisfies('0.1.6', range), `the peer range for ${name} must not reach back past the line the API is read through`)
  }
})

test('the peer range refuses every build the floor is there to keep out', () => {
  // Without this the floor is a comment: `SUPPORTED_LINES` says what is admitted,
  // and only a named exclusion says what is not, so a range later widened to
  // `>=0.1.7-rc.2 <0.3.0` would still satisfy every assertion above while
  // silently admitting three builds on which the turn path does nothing.
  assert.ok(EXCLUDED_LINES.length >= 3, `expected the nearest builds to be named, saw ${EXCLUDED_LINES.length}`)
  for (const [line, reading] of EXCLUDED_LINES) {
    for (const name of dshPeers) {
      assert.ok(!semver.satisfies(line, manifest.peerDependencies[name]),
        `the peer range for ${name} admits ${line} — ${reading}`)
    }
    // Each exclusion has to be a line this package could otherwise be installed
    // against: a version that never existed proves nothing.
    assert.ok(semver.valid(line) !== null, `${line} must be a version, not a line name`)
  }
})

test('the README quotes the range it is describing, in full', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  // A README that quotes only the first `||` segment is a trap: it admits lines
  // where the symbol this plugin reads does not exist.
  for (const name of dshPeers) {
    const range = manifest.peerDependencies[name]
    assert.ok(readme.includes(range.replace(/\|/g, '\\|')) || readme.includes(range),
      `the README must quote the peer range ${range} verbatim (pipes escaped inside a table)`)
  }
  for (const line of SUPPORTED_LINES) {
    assert.ok(readme.includes(line), `the README must name the ${line} line it was verified against`)
  }
})

test('the tarball carries the entry, its modules, the bundle patch, and the type declarations', () => {
  const paths = packedPaths()
  for (const required of [
    'package.json',
    'lib/index.js', 'lib/config.js', 'lib/decision.js',
    'lib/types/index.d.ts', 'lib/types/config.d.ts', 'lib/types/decision.d.ts',
    'cordis.patch.yml', 'README.md', 'LICENSE',
  ]) {
    assert.ok(paths.has(required), `npm pack omits ${required} (declared in "files"): ${[...paths].join(', ')}`)
  }
  assert.ok(![...paths].some(path => path.startsWith('test/') || path.startsWith('src/') || path.startsWith('scripts/')),
    'source, tests and scripts stay unpublished')
  assert.ok(![...paths].some(path => path.startsWith('node_modules/')), 'the tarball must not carry the dev tree')
})

test('every manifest entry point is in the tarball, and the patch names this plugin', () => {
  const paths = packedPaths()
  assert.ok(paths.has(manifest.main), `"main" (${manifest.main}) is not in the tarball`)
  assert.ok(paths.has(manifest.types), `"types" (${manifest.types}) is not in the tarball`)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'the bundle patch declaration points at the shipped file')
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(manifest.name), 'the bundle patch must mount this package by name')
  assert.ok(patch.includes('effort-default-fallback'), 'the bundle patch must use this plugin\'s id')
  for (const name of dshPeers) {
    assert.ok(!patch.includes(`'${name}'`) && !patch.includes(`"${name}"`),
      `the patch must not declare ${name} as an installed dependency of its own`)
  }
})

test('every relative import inside the tarball resolves to a file the tarball contains', () => {
  const paths = packedPaths()
  let checked = 0
  for (const file of [...paths].filter(path => path.startsWith('lib/') && path.endsWith('.js'))) {
    for (const specifier of allSpecifiers(readFileSync(join(ROOT, file), 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      checked += 1
      const target = resolve(ROOT, dirname(file), specifier)
      const candidates = [target, `${target}.js`, join(target, 'index.js')]
      assert.ok(
        candidates.some(candidate => paths.has(resolve(candidate).slice(ROOT.length + 1))),
        `${file} imports ${specifier}, which the tarball does not contain`,
      )
    }
  }
  assert.ok(checked >= 2, `expected to check the entry's own modules, checked ${checked}`)
})

test('the published version is the one the README documents', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes(`${manifest.name}@${manifest.version}`)
    || !readme.includes(`${manifest.name}@`),
  'the README must not name a version other than the published one')
})

test('the description names the failure, not the mechanism it is implemented with', () => {
  // The registry's search result is one paragraph, and a user finds this package
  // by its symptom: a toggle model that does not think while its effort menu
  // offers a **Default** row. The routes in the source report belong in the
  // README, not in a field a search index reads.
  assert.ok(manifest.description.includes('reasoning'), 'the description must name the setting a user would search for')
  assert.ok(manifest.description.includes('MiMo') && manifest.description.includes('Kimi'),
    'the description must name the models the failure is visible on')
  assert.ok(manifest.description.length > 400 && manifest.description.length < 2000,
    `the description must be one usable paragraph, saw ${manifest.description.length} characters`)
})
