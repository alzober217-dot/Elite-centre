import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createCommunityStore } from '../server/community-store.js'

test('serializes concurrent updates and keeps an atomic previous snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'elite-community-store-'))
  const path = join(directory, 'community-data.json')
  const store = createCommunityStore(path)
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.update((data) => {
      data.posts.push({ id: String(index) })
    })))
    const data = await store.read()
    assert.equal(data.posts.length, 20)
    assert.equal(new Set(data.posts.map((post) => post.id)).size, 20)
    assert.deepEqual(JSON.parse(await readFile(`${path}.bak`, 'utf8')).posts.length, 19)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
