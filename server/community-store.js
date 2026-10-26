import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const emptyData = () => ({
  posts: [],
  announcements: [],
  notifications: [],
  reports: [],
  bookmarks: [],
  marks: [],
  imports: [],
})

export function createCommunityStore(filePath) {
  let writeQueue = Promise.resolve()

  async function read() {
    try {
      const data = JSON.parse(await readFile(filePath, 'utf8'))
      return { ...emptyData(), ...data }
    } catch (error) {
      if (error.code === 'ENOENT') return emptyData()
      throw error
    }
  }

  async function update(mutator) {
    const operation = writeQueue.then(async () => {
      const data = await read()
      const previousData = JSON.stringify(data)
      const result = await mutator(data)
      if (JSON.stringify(data) === previousData) return result
      await mkdir(dirname(filePath), { recursive: true })
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        try {
          await copyFile(filePath, `${filePath}.bak`)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        await rename(temporaryPath, filePath)
      } finally {
        await unlink(temporaryPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
      return result
    })
    writeQueue = operation.catch(() => {})
    return operation
  }

  return { read, update }
}
