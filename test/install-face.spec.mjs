/**
 * The install face — what a suite run against the source cannot see.
 *
 * A git install of a package that commits no `lib/` puts the manifest on disk and
 * nothing else, so the loader has no entry to mount; and a node entry that imports
 * a harness package loads in the development rig and throws ERR_MODULE_NOT_FOUND
 * inside a profile, because a profile resolves only the plugin's own dependencies
 * while the harness tree lives under the `dsh` CLI. Both readings are of the
 * repository and the build, never of a working tree that happened to be built.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

/** A value import of a harness package, which a profile cannot resolve. */
const HARNESS_VALUE_IMPORT = /(?:^|\n)\s*import\s[^;\n]*?from\s*['"]@deepseek-ai\//

test('the entry a git install looks for is committed', async () => {
  const info = await stat(new URL('../lib/index.js', import.meta.url))
  assert.ok(info.size > 0, 'lib/index.js must be committed, or a git install mounts nothing')
})

test('the node entry imports no harness peer a profile cannot resolve', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, HARNESS_VALUE_IMPORT,
    'a harness import throws ERR_MODULE_NOT_FOUND when the installed copy is loaded from a profile')
})
