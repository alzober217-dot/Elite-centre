import { constants } from 'node:fs'
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export async function initializeRuntimeData({ dataDirectory, catalogSeedPath, adminIds = '' }) {
  await mkdir(dataDirectory, { recursive: true })

  const catalogPath = join(dataDirectory, 'catalog.json')
  if (!(await fileExists(catalogPath))) {
    try {
      await copyFile(catalogSeedPath, catalogPath, constants.COPYFILE_EXCL)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }

  const permissionsPath = join(dataDirectory, 'permissions.json')
  if (!(await fileExists(permissionsPath))) {
    const telegramAdminIds = adminIds.split(',').map((id) => id.trim()).filter(Boolean)
    if (telegramAdminIds.some((id) => !/^\d{1,20}$/.test(id))) {
      throw new Error('TELEGRAM_ADMIN_IDS must be a comma-separated list of numeric Telegram user IDs.')
    }
    try {
      await writeFile(permissionsPath, `${JSON.stringify({ telegramAdminIds }, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}
