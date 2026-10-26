import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const telegramBindingDurationMs = 15 * 60 * 1000

export function createTelegramBinding(now = Date.now()) {
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: now + telegramBindingDurationMs,
  }
}

export function claimTelegramBinding(requests, token, telegramUserId, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^\d{1,20}$/.test(String(telegramUserId ?? ''))) return null
  const tokenHash = createHash('sha256').update(token).digest()
  const request = requests.find((item) => {
    if (item.status !== 'pending' || item.telegramUserId || !Number.isFinite(item.telegramBindingExpiresAt) || item.telegramBindingExpiresAt <= now) return false
    if (!/^[a-f0-9]{64}$/.test(item.telegramBindingTokenHash ?? '')) return false
    return timingSafeEqual(Buffer.from(item.telegramBindingTokenHash, 'hex'), tokenHash)
  })
  if (!request) return null
  request.telegramUserId = String(telegramUserId)
  request.telegramLinkedAt = new Date(now).toISOString()
  delete request.telegramBindingTokenHash
  delete request.telegramBindingExpiresAt
  return request
}
