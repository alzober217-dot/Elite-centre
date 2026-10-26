import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { claimTelegramBinding, createTelegramBinding } from './telegram-binding.js'
import { createCommunityStore } from './community-store.js'
import { inspectMarksWorkbook, maximumMarksFileBytes, marksHeaders } from './marks-import.js'
import { initializeRuntimeData } from './runtime-data.js'

const serverDirectory = dirname(fileURLToPath(import.meta.url))
const projectDirectory = resolve(serverDirectory, '..')
const dataDirectory = resolve(process.env.ELITE_DATA_DIR ?? serverDirectory)
const catalogPath = resolve(dataDirectory, 'catalog.json')
const permissionsPath = resolve(dataDirectory, 'permissions.json')
const requestsPath = resolve(dataDirectory, 'requests.json')
const subscriptionsPath = resolve(dataDirectory, 'subscriptions.json')
const newsReactionsPath = resolve(dataDirectory, 'news-reactions.json')
const communityStore = createCommunityStore(resolve(dataDirectory, 'community-data.json'))
const studentProfilesPath = resolve(dataDirectory, 'student-profiles.json')
const studentSessionsPath = resolve(dataDirectory, 'student-sessions.json')
const studentPhotosPath = resolve(dataDirectory, 'student-photos')
const editableSettingKeys = new Set(['centerName', 'tagline', 'homeTitle', 'homeSubtitle', 'contactText', 'contactPhone', 'contactTelegram', 'logoPath', 'announcement', 'registrationOpen'])
const settingLabels = {
  centerName: 'اسم المركز',
  tagline: 'الشعار النصي',
  homeTitle: 'عنوان الصفحة',
  homeSubtitle: 'وصف الصفحة',
  contactText: 'نص التواصل',
  contactPhone: 'رقم الهاتف',
  contactTelegram: 'رابط تيليغرام',
  logoPath: 'مسار الشعار',
  announcement: 'الإعلان',
}
const pendingSettingEdits = new Map()
const pendingAdminEdits = new Map()
const registrationRateLimits = new Map()
const codeVerificationRateLimits = new Map()
const studentAccessSessions = new Map()
let studentSessionsWriteQueue = Promise.resolve()
const pendingMarkImports = new Map()
const pendingAnnouncements = new Map()
const registrationRateWindowMs = 15 * 60 * 1000
const studentSessionDurationMs = 6 * 60 * 60 * 1000
const pendingActionDurationMs = 15 * 60 * 1000
const marksPreviewPageSize = 8
const maximumStudentPhotoBytes = 1_500_000
const accessCodeHashBytes = 64
const deriveAccessCodeHash = promisify(scrypt)
const nativeApiOrigins = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost'])

async function loadLocalEnvironment() {
  if (process.env.ELITE_SKIP_DOTENV === 'true') return
  try {
    const contents = await readFile(resolve(projectDirectory, '.env'), 'utf8')
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (!match || process.env[match[1]]) continue
      process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function readCatalog() {
  return JSON.parse(await readFile(catalogPath, 'utf8'))
}

async function saveCatalog(catalog) {
  const temporaryPath = `${catalogPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, catalogPath)
}

async function readRegistrationRequests() {
  try {
    const requests = JSON.parse(await readFile(requestsPath, 'utf8'))
    return Array.isArray(requests) ? requests : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function saveRegistrationRequests(requests) {
  const temporaryPath = `${requestsPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(requests, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, requestsPath)
}

async function hashAccessCode(code) {
  const salt = randomBytes(16)
  const hash = await deriveAccessCodeHash(String(code).trim().toUpperCase(), salt, accessCodeHashBytes)
  return { codeSalt: salt.toString('hex'), codeHash: hash.toString('hex') }
}

async function matchesAccessCode(code, subscription) {
  if (!/^[a-f0-9]{32}$/.test(subscription.codeSalt ?? '') ||
      !/^[a-f0-9]{128}$/.test(subscription.codeHash ?? '')) return false
  const expectedHash = Buffer.from(subscription.codeHash, 'hex')
  const actualHash = await deriveAccessCodeHash(String(code).trim().toUpperCase(), Buffer.from(subscription.codeSalt, 'hex'), accessCodeHashBytes)
  return timingSafeEqual(expectedHash, actualHash)
}

function generateAccessCode() {
  return `ELITE-${randomBytes(16).toString('hex').toUpperCase()}`
}

let subscriptionReadQueue = Promise.resolve()

async function readSubscriptions() {
  const currentRead = subscriptionReadQueue.then(readSubscriptionsFromDisk)
  subscriptionReadQueue = currentRead.then(() => undefined, () => undefined)
  return currentRead
}

async function readSubscriptionsFromDisk() {
  try {
    const json = await readFile(subscriptionsPath, 'utf8')
    const payload = JSON.parse(json)
    const subscriptions = { codes: Array.isArray(payload.codes) ? payload.codes : [] }
    let needsSave = false
    for (const entry of subscriptions.codes) {
      if (!entry.id) {
        entry.id = randomUUID()
        needsSave = true
      }
      if (typeof entry.code === 'string') {
        const legacyCode = entry.code.trim().toUpperCase()
        delete entry.code
        if (/^[A-Z0-9-]{12,64}$/.test(legacyCode)) {
          Object.assign(entry, await hashAccessCode(legacyCode))
        } else {
          entry.active = false
        }
        needsSave = true
      } else if (!/^[a-f0-9]{32}$/.test(entry.codeSalt ?? '') || !/^[a-f0-9]{128}$/.test(entry.codeHash ?? '')) {
        if (entry.active !== false) {
          entry.active = false
          needsSave = true
        }
      }
    }
    if (needsSave) await saveSubscriptions(subscriptions)
    return subscriptions
  } catch (error) {
    if (error.code === 'ENOENT') return { codes: [] }
    throw error
  }
}

async function saveSubscriptions(subscriptions) {
  const temporaryPath = `${subscriptionsPath}.${process.pid}.tmp`
  const safeSubscriptions = {
    codes: subscriptions.codes.map(({ code: _code, ...entry }) => entry),
  }
  await writeFile(temporaryPath, `${JSON.stringify(safeSubscriptions, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, subscriptionsPath)
}

function findSessionSubscription(subscriptions, session) {
  return subscriptions.codes.find((entry) =>
    entry.id === session.subscriptionId &&
    String(entry.email ?? '').toLowerCase() === session.email &&
    entry.active !== false
  ) ?? null
}

async function findAccessCodeSubscription(subscriptions, code, email) {
  for (const entry of subscriptions.codes) {
    if (String(entry.email ?? '').toLowerCase() !== email || entry.active === false) continue
    if (await matchesAccessCode(code, entry)) return entry
  }
  return null
}

async function revokeStudentSessions(subscriptionId) {
  let didRevoke = false
  for (const [token, session] of studentAccessSessions) {
    if (session.subscriptionId === subscriptionId) {
      await revokeStudentSession(token)
      didRevoke = true
    }
  }
  if (didRevoke) await persistStudentSessions()
}

async function readNewsReactions() {
  try {
    const payload = JSON.parse(await readFile(newsReactionsPath, 'utf8'))
    return payload.reactions && typeof payload.reactions === 'object' ? payload.reactions : {}
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

async function saveNewsReactions(reactions) {
  const temporaryPath = `${newsReactionsPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify({ reactions }, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, newsReactionsPath)
}

async function readStudentProfiles() {
  try {
    const payload = JSON.parse(await readFile(studentProfilesPath, 'utf8'))
    return payload.profiles && typeof payload.profiles === 'object' ? payload.profiles : {}
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

async function saveStudentProfiles(profiles) {
  const temporaryPath = `${studentProfilesPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify({ profiles }, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, studentProfilesPath)
}

function parseStudentPhoto(dataUrl) {
  if (typeof dataUrl !== 'string') return null
  const match = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/)
  if (!match) return null
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > maximumStudentPhotoBytes) return null
  const isPng = match[1] === 'png' && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const isJpeg = match[1] === 'jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  const isWebp = match[1] === 'webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
  if (!isPng && !isJpeg && !isWebp) return null
  let dimensions
  if (isPng && buffer.length >= 24) {
    dimensions = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  } else if (isJpeg) {
    let offset = 2
    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xff) break
      const marker = buffer[offset + 1]
      const segmentLength = buffer.readUInt16BE(offset + 2)
      if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        dimensions = { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
        break
      }
      offset += 2 + segmentLength
    }
  } else if (isWebp && buffer.length >= 25) {
    const format = buffer.toString('ascii', 12, 16)
    if (format === 'VP8X' && buffer.length >= 30) {
      dimensions = {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      }
    } else if (format === 'VP8L' && buffer[20] === 0x2f) {
      dimensions = {
        width: 1 + (((buffer[22] & 0x3f) << 8) | buffer[21]),
        height: 1 + (((buffer[24] & 0x0f) << 10) | (buffer[23] << 2) | ((buffer[22] & 0xc0) >> 6)),
      }
    } else if (format === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      dimensions = {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      }
    }
  }
  if (!dimensions || !dimensions.width || !dimensions.height ||
      dimensions.width > 4096 || dimensions.height > 4096 ||
      dimensions.width * dimensions.height > 16_777_216) return null
  return { buffer, extension: isPng ? 'png' : isJpeg ? 'jpg' : 'webp', mimeType: `image/${match[1]}` }
}

function studentProfileResponse(profile, subscription, photoDataUrl = '') {
  return {
    email: subscription.email,
    name: subscription.studentName ?? '',
    phone: subscription.phone ?? '',
    grade: subscription.grade ?? 'البكالوريا',
    programType: 'center',
    subjects: subscription.subjectNames ?? [],
    photoDataUrl,
  }
}

async function readJsonBody(request, maximumBytes = 12_000) {
  const chunks = []
  let byteLength = 0
  for await (const chunk of request) {
    byteLength += chunk.length
    if (byteLength > maximumBytes) throw new Error('حجم الطلب أكبر من المسموح.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function getAccessToken(request, _requestUrl) {
  const authorization = request.headers.authorization ?? ''
  const headerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (headerToken) return headerToken
  const cookie = request.headers.cookie ?? ''
  const sessionCookie = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('elite_student_session='))
  if (!sessionCookie) return ''
  try {
    return decodeURIComponent(sessionCookie.slice('elite_student_session='.length))
  } catch {
    return ''
  }
}

function studentSessionId(token) {
  return createHash('sha256').update(token).digest('hex')
}

async function persistStudentSessions() {
  const snapshot = JSON.stringify({
    sessions: [...studentAccessSessions.entries()].map(([id, session]) => ({ id, ...session })),
  }, null, 2)
  const write = studentSessionsWriteQueue.then(async () => {
    await mkdir(dataDirectory, { recursive: true })
    const temporaryPath = `${studentSessionsPath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, studentSessionsPath)
  })
  studentSessionsWriteQueue = write.catch(() => {})
  await write
}

async function loadStudentSessions() {
  try {
    const payload = JSON.parse(await readFile(studentSessionsPath, 'utf8'))
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : []
    for (const session of sessions) {
      if (/^[a-f0-9]{64}$/.test(session.id ?? '') &&
          /^[a-f0-9-]{36}$/.test(session.subscriptionId ?? '') &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(session.email ?? '') &&
          Number.isFinite(session.expiresAt) && session.expiresAt > Date.now()) {
        studentAccessSessions.set(session.id, {
          subscriptionId: session.subscriptionId,
          email: session.email,
          expiresAt: session.expiresAt,
        })
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function revokeStudentSession(token) {
  if (!token) return
  if (studentAccessSessions.delete(studentSessionId(token))) await persistStudentSessions()
}

function studentSessionCookie(token, request, clear = false) {
  const secure = Boolean(request.socket.encrypted) ||
    process.env.TRUST_PROXY === 'true' && request.headers['x-forwarded-proto'] === 'https'
  return `elite_student_session=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : Math.floor(studentSessionDurationMs / 1000)}${secure ? '; Secure' : ''}`
}

function requiresCookieCsrfValidation(request) {
  const authorization = request.headers.authorization ?? ''
  const hasBearerToken = /^Bearer\s+\S+$/i.test(authorization)
  const hasBearerHeader = /^Bearer\s*$/i.test(authorization)
  const hasSessionCookie = (request.headers.cookie ?? '').split(';').some((part) => part.trim().startsWith('elite_student_session='))
  if (hasBearerToken || !hasSessionCookie || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false
  return (!hasBearerHeader && request.headers['x-elite-csrf'] !== '1') ||
    !request.headers.origin ||
    request.headers['sec-fetch-site'] !== 'same-origin'
}

function getValidAccessSession(token) {
  const id = studentSessionId(token)
  const session = studentAccessSessions.get(id)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    studentAccessSessions.delete(id)
    void persistStudentSessions().catch((error) => {
      console.error('Failed to persist expired student session cleanup:', error.message)
    })
    return null
  }
  return session
}

async function authenticateStudentRequest(request, requestUrl) {
  const token = getAccessToken(request, requestUrl)
  const session = getValidAccessSession(token)
  if (!session) return { error: { status: 401, message: 'سجّل الدخول للوصول إلى مساحة الطالب.' } }
  const subscriptions = await readSubscriptions()
  const subscription = findSessionSubscription(subscriptions, session)
  if (!subscription) {
    await revokeStudentSession(token)
    return { error: { status: 403, message: 'الاشتراك غير فعال.' } }
  }
  return { token, session, subscription }
}

function accountRequestResponse(accountRequest) {
  return {
    id: accountRequest.id,
    status: accountRequest.status,
    statusMessage: accountRequest.statusMessage,
    gradeTitle: accountRequest.gradeTitle,
    programType: 'center',
    subjects: accountRequest.subjectNames,
    createdAt: accountRequest.createdAt,
  }
}

function escapeTelegramHtml(value) {
  return String(value ?? '').replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])
}

async function notifyRegistrationAdmins(accountRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return

  try {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const adminIds = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    const message = `<b>طلب تسجيل جديد</b>\nالاسم: ${escapeTelegramHtml(accountRequest.name)}\nالهاتف: <code>${escapeTelegramHtml(accountRequest.phone)}</code>\nالبريد: <code>${escapeTelegramHtml(accountRequest.email)}</code>\nالصف: ${escapeTelegramHtml(accountRequest.gradeTitle)}\nالمطلوب: ${escapeTelegramHtml((accountRequest.subjectNames ?? []).join('، '))}\nرقم الطلب: <code>${accountRequest.id}</code>\nالتفاصيل: /request ${accountRequest.id}`
    const results = await Promise.allSettled(adminIds.map((adminId) => telegramRequest(token, 'sendMessage', { chat_id: adminId, text: message, parse_mode: 'HTML' })))
    results.forEach((result, index) => {
      if (result.status === 'rejected') console.warn(`Registration notification failed for admin ${adminIds[index]}: ${result.reason.message}`)
    })
  } catch (error) {
    console.warn(`Registration notifications failed: ${error.message}`)
  }
}

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

const apiServer = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, 'http://127.0.0.1')
  const origin = request.headers.origin
  const configuredOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  const allowedOrigins = new Set([...nativeApiOrigins, ...configuredOrigins])
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS')
    response.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Range, X-Elite-CSRF')
    response.setHeader('access-control-allow-credentials', 'true')
    response.setHeader('access-control-expose-headers', 'Accept-Ranges, Content-Range, Content-Length')
    response.setHeader('vary', 'Origin')
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(origin && !allowedOrigins.has(origin) ? 403 : 204)
    return response.end()
  }
  if (requiresCookieCsrfValidation(request)) {
    return jsonResponse(response, 403, { error: 'تعذر التحقق من مصدر الطلب.' })
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    return jsonResponse(response, 200, { ok: true })
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/catalog') {
    try {
      const catalog = await readCatalog()
      delete catalog.digitalCourses
      return jsonResponse(response, 200, catalog)
    } catch {
      return jsonResponse(response, 500, { error: 'تعذر قراءة كتالوج المركز.' })
    }
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/news') {
    try {
      const catalog = await readCatalog()
      const reactions = await readNewsReactions()
      let viewerEmail = ''
      const session = getValidAccessSession(getAccessToken(request, requestUrl))
      if (session) {
        const subscriptions = await readSubscriptions()
        if (findSessionSubscription(subscriptions, session)) viewerEmail = session.email
      }
      const publicNews = Array.isArray(catalog.news) ? [...catalog.news] : []
      const items = publicNews.map((item) => {
        const likes = Array.isArray(reactions[item.id]) ? reactions[item.id] : []
        return { ...item, reactionCount: likes.length, isLiked: viewerEmail ? likes.includes(viewerEmail) : false }
      })
      return jsonResponse(response, 200, { items })
    } catch {
      return jsonResponse(response, 500, { error: 'تعذر قراءة الأخبار.' })
    }
  }
  const newsReactionMatch = request.method === 'POST' && requestUrl.pathname.match(/^\/api\/news\/([\w-]+)\/reaction$/)
  if (newsReactionMatch) {
    try {
      const token = getAccessToken(request, requestUrl)
      const session = getValidAccessSession(token)
      if (!session) return jsonResponse(response, 401, { error: 'سجّل الدخول للتفاعل مع الأخبار.' })
      const subscriptions = await readSubscriptions()
      if (!findSessionSubscription(subscriptions, session)) {
        await revokeStudentSession(token)
        return jsonResponse(response, 403, { error: 'الاشتراك غير فعال.' })
      }
      const catalog = await readCatalog()
      if (!(catalog.news ?? []).some((item) => item.id === newsReactionMatch[1])) return jsonResponse(response, 404, { error: 'الخبر غير موجود.' })
      const reactions = await readNewsReactions()
      const likes = Array.isArray(reactions[newsReactionMatch[1]]) ? reactions[newsReactionMatch[1]] : []
      const existingIndex = likes.indexOf(session.email)
      if (existingIndex >= 0) likes.splice(existingIndex, 1)
      else likes.push(session.email)
      reactions[newsReactionMatch[1]] = likes
      await saveNewsReactions(reactions)
      return jsonResponse(response, 200, { isLiked: existingIndex < 0, reactionCount: likes.length })
    } catch {
      return jsonResponse(response, 500, { error: 'تعذر حفظ التفاعل.' })
    }
  }
  if (requestUrl.pathname.startsWith('/api/community/') || requestUrl.pathname === '/api/announcements' ||
      requestUrl.pathname === '/api/notifications' || requestUrl.pathname.startsWith('/api/notifications/') ||
      requestUrl.pathname === '/api/marks') {
    let authenticated
    try {
      authenticated = await authenticateStudentRequest(request, requestUrl)
    } catch (error) {
      console.error('Student session lookup failed for community request:', error.message)
      return jsonResponse(response, 500, { error: 'تعذر التحقق من جلسة الطالب.' })
    }
    if (authenticated.error) return jsonResponse(response, authenticated.error.status, { error: authenticated.error.message })
    const { subscription } = authenticated
    const ownerId = subscription.id
    try {
      if (request.method === 'GET' && requestUrl.pathname === '/api/community/posts') {
        const data = await communityStore.read()
        const offset = Number(requestUrl.searchParams.get('cursor') ?? 0)
        const query = (requestUrl.searchParams.get('q') ?? '').trim().toLocaleLowerCase('ar')
        if (query.length > 100) return jsonResponse(response, 400, { error: 'عبارة البحث طويلة جداً.' })
        if (!Number.isInteger(offset) || offset < 0 || offset > data.posts.length) return jsonResponse(response, 400, { error: 'مؤشر الصفحة غير صالح.' })
        const visible = data.posts.filter((post) => post.hiddenAt == null && (!query || `${post.text} ${post.author.studentName} ${post.author.grade}`.toLocaleLowerCase('ar').includes(query))).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        const page = visible.slice(offset, offset + 20)
        const items = page.map((post) => ({
          id: post.id,
          text: post.text,
          createdAt: post.createdAt,
          author: post.author,
          reactionCount: post.likes.length,
          isLiked: post.likes.includes(ownerId),
          isSaved: data.bookmarks.some((bookmark) => bookmark.subscriptionId === ownerId && bookmark.postId === post.id),
          comments: post.comments.slice(-20).map(({ id, author, text, createdAt }) => ({ id, author, text, createdAt })),
          commentCount: post.comments.length,
        }))
        return jsonResponse(response, 200, { items, nextCursor: offset + page.length < visible.length ? offset + page.length : null })
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/community/mine') {
        const data = await communityStore.read()
        const ownPosts = data.posts.filter((post) => post.subscriptionId === ownerId && post.hiddenAt == null)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        const items = ownPosts.slice(0, 30).map((post) => ({
          id: post.id,
          text: post.text,
          createdAt: post.createdAt,
          author: post.author,
          reactionCount: post.likes.length,
          isLiked: post.likes.includes(ownerId),
          isSaved: data.bookmarks.some((bookmark) => bookmark.subscriptionId === ownerId && bookmark.postId === post.id),
          comments: post.comments.slice(-20).map(({ id, author, text, createdAt }) => ({ id, author, text, createdAt })),
          commentCount: post.comments.length,
        }))
        return jsonResponse(response, 200, {
          items,
          count: ownPosts.length,
          reactionCount: ownPosts.reduce((total, post) => total + post.likes.length, 0),
        })
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/community/posts') {
        const body = await readJsonBody(request, 5000)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text || text.length > 2000) return jsonResponse(response, 400, { error: 'اكتب منشوراً من 1 إلى 2000 حرف.' })
        const post = {
          id: randomUUID(),
          subscriptionId: ownerId,
          author: { studentName: String(subscription.studentName ?? 'طالب').slice(0, 100), grade: String(subscription.grade ?? '').slice(0, 100) },
          text,
          createdAt: new Date().toISOString(),
          likes: [],
          comments: [],
          hiddenAt: null,
        }
        await communityStore.update((data) => { data.posts.push(post) })
        return jsonResponse(response, 201, { item: { id: post.id, text: post.text, createdAt: post.createdAt, author: post.author, reactionCount: 0, isLiked: false, isSaved: false, comments: [], commentCount: 0 } })
      }
      const postRoute = requestUrl.pathname.match(/^\/api\/community\/posts\/([\da-f-]{36})(?:\/(reaction|comments|bookmark|report))?$/i)
      if (postRoute) {
        const postId = postRoute[1]
        const action = postRoute[2]
        const data = await communityStore.read()
        const post = data.posts.find((item) => item.id === postId && item.hiddenAt == null)
        if (!post) return jsonResponse(response, 404, { error: 'المنشور غير موجود.' })
        if (request.method === 'DELETE' && !action) {
          if (post.subscriptionId !== ownerId) return jsonResponse(response, 403, { error: 'لا يمكنك حذف منشور طالب آخر.' })
          const deleted = await communityStore.update((current) => {
            const target = current.posts.find((item) => item.id === postId && item.subscriptionId === ownerId && item.hiddenAt == null)
            if (!target) return false
            target.hiddenAt = new Date().toISOString()
            current.bookmarks = current.bookmarks.filter((bookmark) => bookmark.postId !== postId)
            return true
          })
          return deleted ? jsonResponse(response, 200, { ok: true }) : jsonResponse(response, 404, { error: 'المنشور غير موجود.' })
        }
        if (request.method === 'POST' && action === 'reaction') {
          const result = await communityStore.update((current) => {
            const target = current.posts.find((item) => item.id === postId && item.hiddenAt == null)
            if (!target) return null
            const index = target.likes.indexOf(ownerId)
            if (index >= 0) target.likes.splice(index, 1)
            else target.likes.push(ownerId)
            return { isLiked: index < 0, reactionCount: target.likes.length }
          })
          return result ? jsonResponse(response, 200, result) : jsonResponse(response, 404, { error: 'المنشور غير موجود.' })
        }
        if (request.method === 'POST' && action === 'comments') {
          const body = await readJsonBody(request, 3000)
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (!text || text.length > 1000) return jsonResponse(response, 400, { error: 'اكتب تعليقاً من 1 إلى 1000 حرف.' })
          const comment = {
            id: randomUUID(),
            subscriptionId: ownerId,
            author: { studentName: String(subscription.studentName ?? 'طالب').slice(0, 100), grade: String(subscription.grade ?? '').slice(0, 100) },
            text,
            createdAt: new Date().toISOString(),
          }
          const added = await communityStore.update((current) => {
            const target = current.posts.find((item) => item.id === postId && item.hiddenAt == null)
            if (!target) return false
            target.comments.push(comment)
            return true
          })
          if (!added) return jsonResponse(response, 404, { error: 'المنشور غير موجود.' })
          return jsonResponse(response, 201, { item: { id: comment.id, author: comment.author, text: comment.text, createdAt: comment.createdAt } })
        }
        if (request.method === 'POST' && action === 'bookmark') {
          const saved = await communityStore.update((current) => {
            if (!current.posts.some((item) => item.id === postId && item.hiddenAt == null)) return null
            const existing = current.bookmarks.findIndex((bookmark) => bookmark.subscriptionId === ownerId && bookmark.postId === postId)
            if (existing >= 0) {
              current.bookmarks.splice(existing, 1)
              return false
            }
            current.bookmarks.push({ subscriptionId: ownerId, postId, createdAt: new Date().toISOString() })
            return true
          })
          return saved === null ? jsonResponse(response, 404, { error: 'المنشور غير موجود.' }) : jsonResponse(response, 200, { isSaved: saved })
        }
        if (request.method === 'POST' && action === 'report') {
          const body = await readJsonBody(request, 1000)
          const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
          if (!reason || reason.length > 300) return jsonResponse(response, 400, { error: 'اذكر سبب الإبلاغ (حتى 300 حرف).' })
          const result = await communityStore.update((current) => {
            if (current.reports.some((report) => report.postId === postId && report.subscriptionId === ownerId)) return false
            current.reports.push({ id: randomUUID(), postId, subscriptionId: ownerId, reason, createdAt: new Date().toISOString(), resolvedAt: null })
            return true
          })
          return result ? jsonResponse(response, 201, { reported: true }) : jsonResponse(response, 200, { reported: true, duplicate: true })
        }
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/community/saved') {
        const data = await communityStore.read()
        const savedIds = new Set(data.bookmarks.filter((bookmark) => bookmark.subscriptionId === ownerId).map((bookmark) => bookmark.postId))
        const items = data.posts.filter((post) => savedIds.has(post.id) && post.hiddenAt == null)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((post) => ({
            id: post.id, text: post.text, createdAt: post.createdAt, author: post.author,
            reactionCount: post.likes.length, isLiked: post.likes.includes(ownerId), isSaved: true,
            comments: post.comments.slice(-20).map(({ id, author, text, createdAt }) => ({ id, author, text, createdAt })),
            commentCount: post.comments.length,
          }))
        return jsonResponse(response, 200, { items })
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/announcements') {
        await communityStore.update((store) => {
          for (const announcement of store.announcements) {
            if (announcement.archivedAt || store.notifications.some((item) => item.type === 'announcement' && item.subscriptionId === ownerId && item.referenceId === announcement.id)) continue
            store.notifications.push({
              id: randomUUID(), subscriptionId: ownerId, type: 'announcement', referenceId: announcement.id,
              text: `إعلان إداري جديد: ${announcement.text.slice(0, 150)}`, createdAt: announcement.createdAt, readAt: null,
            })
          }
        })
        const data = await communityStore.read()
        const readById = new Map(data.notifications.filter((item) => item.subscriptionId === ownerId && item.type === 'announcement').map((item) => [item.referenceId, item]))
        const items = data.announcements.filter((item) => !item.archivedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => ({
          id: item.id, text: item.text, createdAt: item.createdAt, isRead: Boolean(readById.get(item.id)?.readAt), notificationId: readById.get(item.id)?.id ?? '',
        }))
        return jsonResponse(response, 200, { items })
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/notifications') {
        await communityStore.update((store) => {
          for (const announcement of store.announcements) {
            if (announcement.archivedAt || store.notifications.some((item) => item.type === 'announcement' && item.subscriptionId === ownerId && item.referenceId === announcement.id)) continue
            store.notifications.push({
              id: randomUUID(), subscriptionId: ownerId, type: 'announcement', referenceId: announcement.id,
              text: `إعلان إداري جديد: ${announcement.text.slice(0, 150)}`, createdAt: announcement.createdAt, readAt: null,
            })
          }
        })
        const data = await communityStore.read()
        const items = data.notifications.filter((item) => item.subscriptionId === ownerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => ({
          id: item.id, type: item.type, text: item.text, referenceId: item.referenceId, createdAt: item.createdAt, isRead: Boolean(item.readAt),
        }))
        return jsonResponse(response, 200, { items, unreadCount: items.filter((item) => !item.isRead).length })
      }
      const readNotificationMatch = request.method === 'POST' && requestUrl.pathname.match(/^\/api\/notifications\/([\da-f-]{36})\/read$/i)
      if (readNotificationMatch) {
        const result = await communityStore.update((data) => {
          const notification = data.notifications.find((item) => item.id === readNotificationMatch[1] && item.subscriptionId === ownerId)
          if (!notification) return false
          notification.readAt ??= new Date().toISOString()
          return true
        })
        return result ? jsonResponse(response, 200, { ok: true }) : jsonResponse(response, 404, { error: 'الإشعار غير موجود.' })
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/marks') {
        const data = await communityStore.read()
        const items = data.marks.filter((mark) => mark.subscriptionId === ownerId).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).map(({ id, subject, exam, term, score, maxScore, date }) => ({ id, subject, exam, term, score, maxScore, date }))
        return jsonResponse(response, 200, { items })
      }
      return jsonResponse(response, 404, { error: 'المسار غير موجود.' })
    } catch (error) {
      if (error instanceof SyntaxError || error.message.includes('حجم الطلب')) return jsonResponse(response, 400, { error: 'صيغة الطلب أو حجمه غير صالح.' })
      console.error('Student community request failed:', error.message)
      return jsonResponse(response, 500, { error: 'تعذر إتمام العملية. حاول مجدداً.' })
    }
  }
  if ((request.method === 'GET' || request.method === 'PUT') && requestUrl.pathname === '/api/profile') {
    const token = getAccessToken(request, requestUrl)
    const session = getValidAccessSession(token)
    if (!session) return jsonResponse(response, 401, { error: 'سجّل الدخول لعرض ملفك الشخصي.' })
    try {
      const subscriptions = await readSubscriptions()
      const subscription = findSessionSubscription(subscriptions, session)
      if (!subscription) {
        await revokeStudentSession(token)
        return jsonResponse(response, 403, { error: 'الاشتراك غير فعال.' })
      }
      const profiles = await readStudentProfiles()
      const profile = profiles[session.email] ?? {}
      if (request.method === 'GET') {
        if ('name' in profile || 'phone' in profile) {
          delete profile.name
          delete profile.phone
          await saveStudentProfiles(profiles)
        }
        let photoDataUrl = ''
        if (/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(profile.photoFile ?? '')) {
          try {
            const photo = await readFile(resolve(studentPhotosPath, profile.photoFile))
            const extension = profile.photoFile.split('.').at(-1)
            const mimeType = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`
            photoDataUrl = `data:${mimeType};base64,${photo.toString('base64')}`
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
        }
        return jsonResponse(response, 200, studentProfileResponse(profile, subscription, photoDataUrl))
      }

      const payload = await readJsonBody(request, maximumStudentPhotoBytes * 2 + 20_000)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).some((key) => key !== 'photoDataUrl')) {
        return jsonResponse(response, 400, { error: 'يمكن للطالب تعديل الصورة الشخصية فقط.' })
      }

      let photoFile = profile.photoFile ?? ''
      if (payload.photoDataUrl === '') {
        if (photoFile) await unlink(resolve(studentPhotosPath, photoFile)).catch(() => {})
        photoFile = ''
      } else if (payload.photoDataUrl !== undefined) {
        const parsedPhoto = parseStudentPhoto(payload.photoDataUrl)
        if (!parsedPhoto) return jsonResponse(response, 400, { error: 'اختر صورة PNG أو JPEG أو WebP بحجم لا يتجاوز 1.5 ميغابايت.' })
        await mkdir(studentPhotosPath, { recursive: true })
        const emailHash = createHash('sha256').update(session.email).digest('hex')
        photoFile = `${emailHash}.${parsedPhoto.extension}`
        await writeFile(resolve(studentPhotosPath, photoFile), parsedPhoto.buffer)
      }

      const { name: _name, phone: _phone, ...photoProfile } = profile
      profiles[session.email] = { ...photoProfile, photoFile, updatedAt: new Date().toISOString() }
      await saveStudentProfiles(profiles)
      let photoDataUrl = ''
      if (photoFile) {
        const photo = await readFile(resolve(studentPhotosPath, photoFile))
        const extension = photoFile.split('.').at(-1)
        photoDataUrl = `data:${extension === 'jpg' ? 'image/jpeg' : `image/${extension}`};base64,${photo.toString('base64')}`
      }
      return jsonResponse(response, 200, studentProfileResponse(profiles[session.email], subscription, photoDataUrl))
    } catch (error) {
      const badPayload = error instanceof SyntaxError || error.message.includes('حجم الطلب')
      return jsonResponse(response, badPayload ? 400 : 500, { error: badPayload ? 'صيغة الملف الشخصي غير صحيحة.' : 'تعذر حفظ الملف الشخصي.' })
    }
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/session') {
    const token = getAccessToken(request, requestUrl)
    const session = getValidAccessSession(token)
    if (!session) return jsonResponse(response, 401, { error: 'جلسة الطالب غير صالحة أو منتهية.' })
    try {
      const subscriptions = await readSubscriptions()
      const subscription = findSessionSubscription(subscriptions, session)
      if (!subscription) {
        await revokeStudentSession(token)
        return jsonResponse(response, 403, { error: 'الاشتراك غير فعال.' })
      }
      return jsonResponse(response, 200, {
        studentName: subscription.studentName ?? 'طالب',
        email: subscription.email,
        phone: subscription.phone ?? '',
        grade: subscription.grade ?? 'البكالوريا',
        programType: 'center',
        subjects: subscription.subjectNames ?? [],
        expiresAt: session.expiresAt,
      })
    } catch {
      return jsonResponse(response, 500, { error: 'تعذر التحقق من جلسة الطالب.' })
    }
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/logout') {
    const token = getAccessToken(request, requestUrl)
    await revokeStudentSession(token)
    response.setHeader('set-cookie', studentSessionCookie('', request, true))
    return jsonResponse(response, 200, { ok: true })
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/verify-code') {
    try {
      const clientAddress = request.socket.remoteAddress ?? 'unknown'
      const now = Date.now()
      const recentAttempts = (codeVerificationRateLimits.get(clientAddress) ?? []).filter((timestamp) => now - timestamp < registrationRateWindowMs)
      if (recentAttempts.length >= 10) return jsonResponse(response, 429, { error: 'محاولات كثيرة. انتظر قليلاً ثم حاول مجدداً.' })
      recentAttempts.push(now)
      codeVerificationRateLimits.set(clientAddress, recentAttempts)

      const payload = await readJsonBody(request)
      const rawCode = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : ''
      const rawEmail = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : ''
      if (!rawCode || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) return jsonResponse(response, 400, { error: 'أدخل البريد الإلكتروني ورمز الدخول.' })
      const subscriptions = await readSubscriptions()
      const match = /^[A-Z0-9-]{12,64}$/.test(rawCode)
        ? await findAccessCodeSubscription(subscriptions, rawCode, rawEmail)
        : null
      if (!match) return jsonResponse(response, 403, { error: 'رمز الدخول غير صالح أو لا يطابق البريد الإلكتروني.' })
      const sessionToken = randomBytes(32).toString('base64url')
      const expiresAt = Date.now() + studentSessionDurationMs
      studentAccessSessions.set(studentSessionId(sessionToken), { subscriptionId: match.id, email: rawEmail, expiresAt })
      await persistStudentSessions()
      const isNativeClient = nativeApiOrigins.has(origin)
      if (!isNativeClient) response.setHeader('set-cookie', studentSessionCookie(sessionToken, request))
      return jsonResponse(response, 200, {
        ok: true,
        ...(isNativeClient ? { sessionToken } : {}),
        expiresAt,
        studentName: match.studentName ?? 'طالب',
        grade: match.grade ?? 'البكالوريا',
      })
    } catch (error) {
      return jsonResponse(response, error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? 'صيغة الطلب غير صحيحة.' : 'تعذر التحقق من الرمز.' })
    }
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/requests') {
    try {
      const now = Date.now()
      const clientAddress = request.socket.remoteAddress ?? 'unknown'
      const recentRequests = (registrationRateLimits.get(clientAddress) ?? []).filter((timestamp) => now - timestamp < registrationRateWindowMs)
      if (recentRequests.length >= 4) return jsonResponse(response, 429, { error: 'وصلت إلى الحد المؤقت للطلبات. حاول بعد قليل.' })

      const payload = await readJsonBody(request)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return jsonResponse(response, 400, { error: 'صيغة الطلب غير صحيحة.' })
      const name = typeof payload.name === 'string' ? payload.name.trim() : ''
      const phone = typeof payload.phone === 'string' ? payload.phone.trim() : ''
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
      const gradeId = Number(payload.gradeId)
      const programType = payload.programType === undefined || payload.programType === 'center' ? 'center' : ''
      const subjectIds = Array.isArray(payload.subjectIds) ? [...new Set(payload.subjectIds.filter((id) => typeof id === 'string'))] : []
      const selectedCount = subjectIds.length
      if (name.length < 2 || name.length > 100 || !/^[+\d\s()-]{7,24}$/.test(phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !programType || selectedCount < 1 || selectedCount > 8) {
        return jsonResponse(response, 400, { error: 'تحقق من الاسم والهاتف والبريد والمواد المختارة.' })
      }

      const catalog = await readCatalog()
      if (catalog.settings?.registrationOpen === false || catalog.settings?.registrationOpen === 'false') {
        return jsonResponse(response, 403, { error: 'التسجيل مغلق حالياً. تواصل مع إدارة المركز.' })
      }
      const grade = catalog.grades.find((item) => item.id === gradeId)
      if (!grade) return jsonResponse(response, 400, { error: 'الصف المختار غير موجود.' })
      const selectedSubjects = subjectIds.map((id) => grade.subjects.find((subject) => subject.id === id))
      if (selectedSubjects.some((subject) => !subject)) return jsonResponse(response, 400, { error: 'إحدى المواد المختارة غير متاحة لهذا الصف.' })

      const requests = await readRegistrationRequests()
      const duplicateRequest = requests.find((item) => item.email === email && item.gradeId === gradeId && item.programType === programType && item.status === 'pending')
      if (duplicateRequest) return jsonResponse(response, 409, { error: 'لديك طلب قيد المراجعة لهذا الصف بالفعل.', requestId: duplicateRequest.id })

      const accountRequest = {
        id: randomUUID(),
        name,
        phone,
        email,
        gradeId,
        gradeTitle: grade.title,
        programType,
        subjectIds,
        subjectNames: selectedSubjects.map((subject) => subject.name),
        status: 'pending',
        statusMessage: '',
        createdAt: new Date(now).toISOString(),
      }
      const botUsername = String(process.env.TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, '')
      const telegramReady = process.env.TELEGRAM_BOT_TOKEN &&
        process.env.TELEGRAM_BOT_POLLING !== 'false' &&
        /^[A-Za-z0-9_]{5,32}$/.test(botUsername)
      let telegramLink = null
      if (telegramReady) {
        const binding = createTelegramBinding(now)
        accountRequest.telegramBindingTokenHash = binding.tokenHash
        accountRequest.telegramBindingExpiresAt = binding.expiresAt
        telegramLink = {
          url: `https://t.me/${botUsername}?start=link_${binding.token}`,
          expiresAt: binding.expiresAt,
        }
      }
      requests.unshift(accountRequest)
      await saveRegistrationRequests(requests)
      void notifyRegistrationAdmins(accountRequest)
      recentRequests.push(now)
      registrationRateLimits.set(clientAddress, recentRequests)
      return jsonResponse(response, 201, { ...accountRequestResponse(accountRequest), telegramLink })
    } catch (error) {
      const invalidRequest = error instanceof SyntaxError || error.message.includes('حجم الطلب')
      return jsonResponse(response, invalidRequest ? 400 : 500, { error: invalidRequest ? 'صيغة الطلب غير صحيحة.' : 'تعذر حفظ طلب التسجيل.' })
    }
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/my-requests') {
    const token = getAccessToken(request, requestUrl)
    const session = getValidAccessSession(token)
    if (!session) return jsonResponse(response, 401, { error: 'سجّل الدخول بكودك وبريدك لمتابعة الطلبات.' })
    try {
      const subscriptions = await readSubscriptions()
      if (!findSessionSubscription(subscriptions, session)) {
        await revokeStudentSession(token)
        return jsonResponse(response, 403, { error: 'الاشتراك غير فعال.' })
      }
      const requests = await readRegistrationRequests()
      const items = requests.filter((item) => String(item.email ?? '').toLowerCase() === session.email).map(accountRequestResponse)
      return jsonResponse(response, 200, { items })
    } catch {
      return jsonResponse(response, 500, { error: 'تعذر قراءة طلبات الطالب.' })
    }
  }
  const requestStatusMatch = request.method === 'GET' && requestUrl.pathname.match(/^\/api\/requests\/([\da-f-]{36})$/i)
  if (requestStatusMatch) {
    try {
      const token = getAccessToken(request, requestUrl)
      const session = getValidAccessSession(token)
      if (!session) return jsonResponse(response, 401, { error: 'سجّل الدخول لمتابعة حالة الطلب.' })
      const subscriptions = await readSubscriptions()
      if (!findSessionSubscription(subscriptions, session)) {
        await revokeStudentSession(token)
        return jsonResponse(response, 403, { error: 'الاشتراك غير فعال.' })
      }
      const requests = await readRegistrationRequests()
      const accountRequest = requests.find((item) => item.id === requestStatusMatch[1])
      if (!accountRequest || String(accountRequest.email ?? '').toLowerCase() !== session.email) {
        return jsonResponse(response, 404, { error: 'لم نعثر على طلب التسجيل.' })
      }
      return jsonResponse(response, 200, accountRequestResponse(accountRequest))
    } catch {
      return jsonResponse(response, 500, { error: 'تعذر قراءة حالة الطلب.' })
    }
  }
  return jsonResponse(response, 404, { error: 'المسار غير موجود.' })
})
function findSubject(catalog, gradeId, subjectId) {
  const grade = catalog.grades.find((item) => item.id === Number(gradeId))
  const subject = grade?.subjects.find((item) => item.id === subjectId)
  return { grade, subject }
}

function parsePipeFields(value) {
  return value.split('|').map((field) => field.trim())
}

function parseTeacherNames(value) {
  return [...new Set(value.split(/[،,]/).map((name) => name.trim()).filter(Boolean))]
}

async function telegramRequest(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.description ?? 'Telegram request failed')
  return result.result
}

async function reply(token, chatId, text) {
  return telegramRequest(token, 'sendMessage', { chat_id: chatId, text })
}

function marksImportKeyboard(importId, pending, page) {
  const { preview } = pending
  const pageCount = Math.ceil(preview.rows.length / marksPreviewPageSize)
  const navigation = []
  if (page > 0) navigation.push({ text: 'السابق', callback_data: `marks:page:${importId}:${page - 1}` })
  if (page + 1 < pageCount) navigation.push({ text: 'التالي', callback_data: `marks:page:${importId}:${page + 1}` })
  const rows = navigation.length ? [navigation] : []
  if (page + 1 === pageCount && pending.reviewedPages.size === pageCount && preview.blockingCount === 0) {
    rows.push([{ text: 'تأكيد استيراد / استبدال النتائج', callback_data: `marks:confirm:${importId}` }])
  }
  rows.push([{ text: 'إلغاء المعاينة', callback_data: `marks:cancel:${importId}` }])
  return { inline_keyboard: rows }
}

function marksImportPreviewText(pending, page) {
  const { preview, overwriteCount } = pending
  const pageSize = marksPreviewPageSize
  const pageRows = preview.rows.slice(page * pageSize, (page + 1) * pageSize)
  const rows = pageRows.map((row) => {
    const student = String(row.studentName || 'غير معروف').replace(/\s+/g, ' ').slice(0, 35)
    const studentId = String(row.studentId || 'معرّف مفقود').slice(0, 36)
    const subject = String(row.subject || '—').replace(/\s+/g, ' ').slice(0, 25)
    const exam = String(row.exam || '—').replace(/\s+/g, ' ').slice(0, 25)
    const term = String(row.term || '—').replace(/\s+/g, ' ').slice(0, 25)
    const detail = `${row.rowNumber}. ${student} (${studentId}) · ${subject} · ${exam} · ${term} · ${row.score ?? '—'}/${row.maxScore ?? '—'} · ${row.date || '—'}`
    return row.issues.length ? `${detail}\n⚠ ${row.issues.join('؛ ').slice(0, 160)}` : detail
  })
  const pageCount = Math.ceil(preview.rows.length / pageSize)
  return [
    'معاينة استيراد العلامات (لم يتم الحفظ بعد)',
    `الصفحة ${page + 1}/${pageCount} · الصفوف ${page * pageSize + 1}-${Math.min((page + 1) * pageSize, preview.rowCount)} من ${preview.rowCount}`,
    `الأعمدة: ${marksHeaders.join(', ')}`,
    `صالحة: ${preview.validCount} · تمنع الاستيراد: ${preview.blockingCount}`,
    `نتائج موجودة ستُستبدل عند التأكيد: ${overwriteCount}`,
    'سياسة التعارض: عند التأكيد تُستبدل النتيجة المطابقة للطالب/المادة/الاختبار/الفصل؛ أي خطأ أو تكرار يمنع الدفعة كلها.',
    ...rows,
    preview.blockingCount ? 'صحّح الأخطاء وارفع ملفاً جديداً؛ لا يمكن التأكيد مع وجود أخطاء.' : page + 1 === pageCount ? 'راجعت كامل الملف؛ أكّد صراحةً أو ألغِ العملية.' : 'انتقل عبر الصفحات لمراجعة الملف كاملاً؛ التأكيد متاح في الصفحة الأخيرة فقط.',
  ].join('\n')
}

function markRecordKey(item) {
  return [item.subscriptionId, item.subject, item.exam, item.term].join('\u0000')
}

async function handleMarksDocument(token, message) {
  const document = message.document
  const name = String(document.file_name ?? '')
  const mimeType = String(document.mime_type ?? '')
  if (!/\.xlsx$/i.test(name)) return reply(token, message.chat.id, 'ارفع ملفاً بامتداد .xlsx فقط.')
  if (mimeType && !['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'].includes(mimeType)) {
    return reply(token, message.chat.id, 'نوع الملف لا يطابق ملف Excel بصيغة XLSX.')
  }
  if (!Number.isInteger(document.file_size) || document.file_size < 1 || document.file_size > maximumMarksFileBytes) {
    return reply(token, message.chat.id, 'حجم الملف يجب ألا يتجاوز 5 ميغابايت.')
  }
  const tokenValue = process.env.TELEGRAM_BOT_TOKEN
  if (!tokenValue) return reply(token, message.chat.id, 'رفع ملفات العلامات غير متاح قبل إعداد البوت.')
  const file = await telegramRequest(tokenValue, 'getFile', { file_id: document.file_id })
  if (!file.file_path) throw new Error('Telegram did not return a document path.')
  const download = await fetch(`https://api.telegram.org/file/bot${tokenValue}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) })
  if (!download.ok || !download.body) throw new Error('Could not download marks workbook from Telegram.')
  const downloadedType = String(download.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (downloadedType && !['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'].includes(downloadedType)) {
    throw new Error('Telegram returned an unexpected file content type.')
  }
  const chunks = []
  let byteLength = 0
  for await (const chunk of download.body) {
    byteLength += chunk.length
    if (byteLength > maximumMarksFileBytes) throw new Error('Marks workbook exceeds the upload limit.')
    chunks.push(Buffer.from(chunk))
  }
  const buffer = Buffer.concat(chunks)
  const subscriptions = (await readSubscriptions()).codes.filter((item) => item.active !== false)
  const preview = await inspectMarksWorkbook(buffer, subscriptions)
  const data = await communityStore.read()
  const existingKeys = new Set(data.marks.map(markRecordKey))
  const overwriteCount = preview.records.filter((record) => record.valid && existingKeys.has(markRecordKey({ ...record, subscriptionId: record.studentId }))).length
  const importId = preview.previewId
  const pending = {
    adminId: String(message.from.id),
    expiresAt: Date.now() + pendingActionDurationMs,
    preview,
    overwriteCount,
    reviewedPages: new Set([0]),
  }
  pendingMarkImports.set(importId, pending)
  return telegramRequest(tokenValue, 'sendMessage', {
    chat_id: message.chat.id,
    text: marksImportPreviewText(pending, 0),
    reply_markup: marksImportKeyboard(importId, pending, 0),
  })
}

async function commitMarksImport(token, callbackQuery, importId) {
  const pending = pendingMarkImports.get(importId)
  if (!pending) return answerCallback(token, callbackQuery, 'انتهت صلاحية المعاينة أو سبق اعتمادها.')
  if (pending.adminId !== String(callbackQuery.from.id)) {
    return answerCallback(token, callbackQuery, 'المعاينة ليست لحسابك.')
  }
  if (pending.expiresAt <= Date.now()) {
    pendingMarkImports.delete(importId)
    return answerCallback(token, callbackQuery, 'انتهت صلاحية المعاينة أو سبق اعتمادها.')
  }
  if (pending.reviewedPages.size !== Math.ceil(pending.preview.rows.length / marksPreviewPageSize)) {
    return answerCallback(token, callbackQuery, 'راجع جميع صفحات المعاينة قبل التأكيد.')
  }
  if (pending.preview.blockingCount) return answerCallback(token, callbackQuery, 'توجد أخطاء تمنع استيراد هذا الملف.')
  if (pending.committing) return answerCallback(token, callbackQuery, 'عملية الاستيراد قيد التنفيذ.')
  pending.committing = true
  const batchId = pending.preview.fileHash
  try {
    const result = await communityStore.update((data) => {
      if (data.imports.some((item) => item.fileHash === batchId)) return { duplicate: true, count: 0 }
      const records = pending.preview.records.map((row) => ({
        id: randomUUID(),
        subscriptionId: row.studentId,
        subject: row.subject,
        exam: row.exam,
        term: row.term,
        score: row.score,
        maxScore: row.maxScore,
        date: row.date,
        batchId,
        createdAt: new Date().toISOString(),
      }))
      const affectedStudents = new Set()
      for (const record of records) {
        const key = markRecordKey(record)
        const index = data.marks.findIndex((mark) => markRecordKey(mark) === key)
        if (index >= 0) data.marks[index] = { ...data.marks[index], ...record }
        else data.marks.push(record)
        affectedStudents.add(record.subscriptionId)
      }
      const now = new Date().toISOString()
      data.imports.push({
        id: randomUUID(), fileHash: batchId, rowCount: records.length, replacedCount: pending.overwriteCount,
        importedByAdminId: String(callbackQuery.from.id), importedAt: now,
      })
      for (const subscriptionId of affectedStudents) data.notifications.push({
        id: randomUUID(), subscriptionId, type: 'marks', referenceId: batchId,
        text: 'نُشرت علامات جديدة في ملفك الدراسي.', createdAt: now, readAt: null,
      })
      return { duplicate: false, count: records.length }
    })
    pendingMarkImports.delete(importId)
    await answerCallback(token, callbackQuery, result.duplicate ? 'تم استيراد هذا الملف سابقاً؛ لم تُكرر العملية.' : 'تم حفظ العلامات وإشعار الطلاب.')
    return editCallbackMessage(token, callbackQuery, result.duplicate ? 'هذا الملف مستورد مسبقاً؛ لم تتم إضافة سجلات مكررة.' : `اكتمل الاستيراد بأمان: ${result.count} نتيجة.`, { inline_keyboard: [] }, null)
  } catch (error) {
    pending.committing = false
    throw error
  }
}

function settingPreview(value) {
  const text = value === '' || value == null ? 'غير محدد' : String(value)
  return text.length > 24 ? `${text.slice(0, 21)}...` : text
}

function settingsKeyboard(settings = {}) {
  const keys = Object.keys(settingLabels)
  const rows = []
  for (let index = 0; index < keys.length; index += 2) {
    rows.push(keys.slice(index, index + 2).map((key) => ({
      text: `${settingLabels[key]}: ${settingPreview(settings[key])}`,
      callback_data: `settings:edit:${key}`,
    })))
  }
  rows.push([{ text: settings.registrationOpen === false ? 'فتح التسجيل' : 'إيقاف التسجيل', callback_data: 'settings:toggle:registrationOpen' }])
  rows.push([{ text: 'مسح الإعلان', callback_data: 'settings:clear:announcement' }, { text: 'إغلاق القائمة', callback_data: 'settings:close' }])
  return { inline_keyboard: rows }
}

async function sendSettingsMenu(token, chatId) {
  const catalog = await readCatalog()
  return telegramRequest(token, 'sendMessage', {
    chat_id: chatId,
    text: `إعدادات ${catalog.settings?.centerName ?? 'المركز'}\nاختر الإعداد المطلوب. عند الاختيار أرسل القيمة الجديدة كرسالة.`,
    reply_markup: settingsKeyboard(catalog.settings),
  })
}

async function answerCallback(token, callbackQuery, text) {
  return telegramRequest(token, 'answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text,
  })
}

async function editSettingsMenu(token, callbackQuery, text) {
  const catalog = await readCatalog()
  return telegramRequest(token, 'editMessageText', {
    chat_id: callbackQuery.message.chat.id,
    message_id: callbackQuery.message.message_id,
    text,
    reply_markup: settingsKeyboard(catalog.settings),
  })
}

function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'الصفوف والمواد والأسعار', callback_data: 'menu:grades' }],
      [{ text: 'الأخبار العامة', callback_data: 'menu:news' }, { text: 'إعلانات الإدارة', callback_data: 'menu:announcements' }],
      [{ text: 'أكواد الاشتراك', callback_data: 'menu:codes' }, { text: 'طلبات التسجيل', callback_data: 'menu:requests' }],
      [{ text: 'الإشراف على الموجز', callback_data: 'menu:moderation' }, { text: 'استيراد العلامات', callback_data: 'menu:marks' }],
      [{ text: 'معرّفات الطلاب لاستيراد العلامات', callback_data: 'menu:studentids' }],
      [{ text: 'إعدادات المركز', callback_data: 'menu:settings' }],
    ],
  }
}

async function sendAdminMenu(token, chatId) {
  return telegramRequest(token, 'sendMessage', {
    chat_id: chatId,
    text: 'لوحة إدارة المعهد\nاختر القسم الذي تريد إدارته:',
    reply_markup: adminMenuKeyboard(),
  })
}

async function editCallbackMessage(token, callbackQuery, text, replyMarkup, parseMode = 'HTML') {
  const payload = {
    chat_id: callbackQuery.message.chat.id,
    message_id: callbackQuery.message.message_id,
    text,
    reply_markup: replyMarkup,
  }
  if (parseMode) payload.parse_mode = parseMode
  return telegramRequest(token, 'editMessageText', payload)
}

function gradeListKeyboard(catalog) {
  const rows = (catalog.grades ?? []).map((grade) => [{
    text: `${grade.title} (${grade.stage ?? 'عام'})`,
    callback_data: `grade:view:${grade.id}`,
  }])
  rows.push([{ text: 'إضافة صف', callback_data: 'grade:add' }])
  rows.push([{ text: 'القائمة الرئيسية', callback_data: 'menu:home' }])
  return { inline_keyboard: rows }
}

function gradeDetailKeyboard(grade) {
  const rows = (grade.subjects ?? []).map((subject) => [{
    text: `${subject.name} | ${subject.price ?? 0} ${subject.currency ?? ''}`,
    callback_data: `sub:view:${grade.id}:${subject.id}`,
  }])
  rows.push([
    { text: 'تعديل بيانات الصف', callback_data: `grade:edit:${grade.id}` },
    { text: 'حذف الصف', callback_data: `grade:delete:${grade.id}` },
  ])
  rows.push([{ text: 'إضافة مادة', callback_data: `sub:add:${grade.id}` }])
  rows.push([{ text: 'العودة للصفوف', callback_data: 'grade:back' }])
  return { inline_keyboard: rows }
}

function subjectDetailKeyboard(gradeId, subjectId) {
  return {
    inline_keyboard: [
      [
        { text: 'تعديل الاسم', callback_data: `sub:editName:${gradeId}:${subjectId}` },
        { text: 'تعديل السعر', callback_data: `sub:editPrice:${gradeId}:${subjectId}` },
      ],
      [
        { text: 'تعديل العملة', callback_data: `sub:editCurrency:${gradeId}:${subjectId}` },
        { text: 'تعديل المدرسين', callback_data: `sub:editTeachers:${gradeId}:${subjectId}` },
      ],
      [{ text: 'حذف المادة', callback_data: `sub:delete:${gradeId}:${subjectId}` }],
      [{ text: 'العودة للمواد', callback_data: `grade:view:${gradeId}` }],
    ],
  }
}

function newsListKeyboard(items = []) {
  const rows = items.map((item) => [{ text: item.title || 'خبر بلا عنوان', callback_data: `news:view:${item.id}` }])
  rows.push([{ text: 'إضافة خبر', callback_data: 'news:add' }])
  rows.push([{ text: 'القائمة الرئيسية', callback_data: 'menu:home' }])
  return { inline_keyboard: rows }
}

function newsDetailKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: 'تعديل العنوان', callback_data: `news:editTitle:${id}` },
        { text: 'تعديل الوصف', callback_data: `news:editDescription:${id}` },
      ],
      [{ text: 'تعديل الرابط', callback_data: `news:editLink:${id}` }, { text: 'حذف الخبر', callback_data: `news:delete:${id}` }],
      [{ text: 'العودة للأخبار', callback_data: 'menu:news' }],
    ],
  }
}

function subscriptionListKeyboard(codes = []) {
  const rows = codes.map((item) => [{
    text: `${item.studentName ?? 'بدون اسم'} | ${item.email ?? 'بلا بريد'} | ${item.active === false ? 'متوقف' : 'فعال'}`,
    callback_data: `code:view:${item.id}`,
  }])
  rows.push([{ text: 'إنشاء كود', callback_data: 'code:add' }])
  rows.push([{ text: 'القائمة الرئيسية', callback_data: 'menu:home' }])
  return { inline_keyboard: rows }
}

function subscriptionDetailKeyboard(subscriptionId) {
  return {
    inline_keyboard: [
      [
        { text: 'تعديل اسم الطالب', callback_data: `code:editStudent:${subscriptionId}` },
        { text: 'تعديل المرحلة', callback_data: `code:editGrade:${subscriptionId}` },
      ],
      [{ text: 'تعديل البريد الإلكتروني', callback_data: `code:editEmail:${subscriptionId}` }],
      [
        { text: 'إعادة إصدار كود', callback_data: `code:reissue:${subscriptionId}` },
        { text: 'تغيير حالة الكود', callback_data: `code:toggle:${subscriptionId}` },
      ],
      [{ text: 'حذف الكود', callback_data: `code:delete:${subscriptionId}` }],
      [{ text: 'العودة للأكواد', callback_data: 'menu:codes' }],
    ],
  }
}

async function handleTelegramCallback(token, callbackQuery) {
  if (callbackQuery.message?.chat.type !== 'private' ||
      String(callbackQuery.message.chat.id) !== String(callbackQuery.from.id)) {
    return answerCallback(token, callbackQuery, 'استخدم لوحة الإدارة في محادثة خاصة مع البوت.')
  }
  const userId = String(callbackQuery.from.id)
  const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
  const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
  if (!admins.includes(userId)) return answerCallback(token, callbackQuery, 'هذا الإعداد للمدراء فقط.')

  const [scope, action, key, extra] = (callbackQuery.data ?? '').split(':')
  
  if (scope === 'marks') {
    if (action === 'cancel') {
      const pending = pendingMarkImports.get(key)
      if (pending && pending.adminId !== userId) return answerCallback(token, callbackQuery, 'المعاينة ليست لحسابك.')
      pendingMarkImports.delete(key)
      await answerCallback(token, callbackQuery, 'أُلغيت المعاينة.')
      return editCallbackMessage(token, callbackQuery, 'أُلغيت معاينة ملف العلامات؛ لم تُحفظ أي نتيجة.', { inline_keyboard: [] }, null)
    }
    if (action === 'page') {
      const pending = pendingMarkImports.get(key)
      if (!pending) return answerCallback(token, callbackQuery, 'انتهت صلاحية المعاينة أو سبق إلغاؤها.')
      if (pending.adminId !== userId) return answerCallback(token, callbackQuery, 'المعاينة ليست لحسابك.')
      if (pending.expiresAt <= Date.now()) {
        pendingMarkImports.delete(key)
        return answerCallback(token, callbackQuery, 'انتهت صلاحية المعاينة؛ ارفع الملف مجدداً.')
      }
      const page = Number(extra)
      const pageCount = Math.ceil(pending.preview.rows.length / marksPreviewPageSize)
      if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
        return answerCallback(token, callbackQuery, 'رقم صفحة المعاينة غير صالح.')
      }
      pending.reviewedPages.add(page)
      await answerCallback(token, callbackQuery, `الصفحة ${page + 1} من ${pageCount}`)
      return editCallbackMessage(
        token,
        callbackQuery,
        marksImportPreviewText(pending, page),
        marksImportKeyboard(key, pending, page),
        null,
      )
    }
    if (action === 'confirm') return commitMarksImport(token, callbackQuery, key)
  }

  if (scope === 'announcement') {
    const data = await communityStore.read()
    if (action === 'new') {
      pendingAnnouncements.set(userId, { mode: 'text', expiresAt: Date.now() + pendingActionDurationMs })
      await answerCallback(token, callbackQuery, 'أرسل نص الإعلان')
      return reply(token, callbackQuery.message.chat.id, 'أرسل نص الإعلان (حتى 2000 حرف) لمعاينته قبل النشر. أرسل /cancel للإلغاء.')
    }
    if (action === 'publish') {
      const pending = pendingAnnouncements.get(userId)
      if (!pending || pending.id !== key || pending.expiresAt <= Date.now()) return answerCallback(token, callbackQuery, 'انتهت صلاحية معاينة الإعلان.')
      if (pending.committing) return answerCallback(token, callbackQuery, 'عملية النشر قيد التنفيذ.')
      pending.committing = true
      try {
        const subscriptions = (await readSubscriptions()).codes.filter((item) => item.active !== false)
        const published = await communityStore.update((store) => {
          if (store.announcements.some((item) => item.id === key)) return false
          const createdAt = new Date().toISOString()
          store.announcements.unshift({ id: key, text: pending.text, createdAt, publishedByAdminId: userId, archivedAt: null })
          for (const subscription of subscriptions) {
            if (store.notifications.some((notification) => notification.type === 'announcement' && notification.referenceId === key && notification.subscriptionId === subscription.id)) continue
            store.notifications.push({
              id: randomUUID(), subscriptionId: subscription.id, type: 'announcement', referenceId: key,
              text: `إعلان إداري جديد: ${pending.text.slice(0, 150)}`, createdAt, readAt: null,
            })
          }
          return true
        })
        pendingAnnouncements.delete(userId)
        await answerCallback(token, callbackQuery, published ? 'نُشر الإعلان وأُرسل للطلاب النشطين.' : 'الإعلان منشور مسبقاً.')
        return editCallbackMessage(token, callbackQuery, published ? 'تم نشر الإعلان وإشعار الطلاب النشطين.' : 'الإعلان منشور مسبقاً؛ لم تتكرر الإشعارات.', { inline_keyboard: [] }, null)
      } catch (error) {
        pending.committing = false
        throw error
      }
    }
    if (action === 'cancel') {
      const pending = pendingAnnouncements.get(userId)
      if (pending?.id === key) pendingAnnouncements.delete(userId)
      await answerCallback(token, callbackQuery, 'أُلغي الإعلان.')
      return editCallbackMessage(token, callbackQuery, 'أُلغي الإعلان؛ لم يُنشر.', { inline_keyboard: [] }, null)
    }
    const announcement = data.announcements.find((item) => item.id === key)
    if (action === 'archive') {
      if (!announcement || announcement.archivedAt) return answerCallback(token, callbackQuery, 'الإعلان غير موجود أو مؤرشف.')
      await answerCallback(token, callbackQuery, 'تأكيد الأرشفة')
      return editCallbackMessage(token, callbackQuery, `أرشفة الإعلان التالي؟\n${announcement.text.slice(0, 500)}`, { inline_keyboard: [
        [{ text: 'تأكيد الأرشفة', callback_data: `announcement:archiveConfirm:${key}` }, { text: 'إلغاء', callback_data: 'menu:announcements' }],
      ] }, null)
    }
    if (action === 'archiveConfirm') {
      const archived = await communityStore.update((store) => {
        const target = store.announcements.find((item) => item.id === key)
        if (!target || target.archivedAt) return false
        target.archivedAt = new Date().toISOString()
        return true
      })
      await answerCallback(token, callbackQuery, archived ? 'تمت أرشفة الإعلان.' : 'الإعلان مؤرشف مسبقاً.')
      return editCallbackMessage(token, callbackQuery, archived ? 'تمت أرشفة الإعلان وإخفاؤه من مساحة الطلاب.' : 'لم يتغير الإعلان.', { inline_keyboard: [] }, null)
    }
  }

  if (scope === 'report') {
    const store = await communityStore.read()
    const report = store.reports.find((item) => item.id === key)
    if (!report) return answerCallback(token, callbackQuery, 'البلاغ غير موجود.')
    const post = store.posts.find((item) => item.id === report.postId)
    if (action === 'review') {
      await answerCallback(token, callbackQuery, 'معاينة البلاغ')
      return editCallbackMessage(token, callbackQuery, `سبب البلاغ: ${report.reason}\nالمنشور: ${post?.text?.slice(0, 700) ?? 'المنشور غير متاح'}\nالحالة: ${report.resolvedAt ? 'مُعالج' : 'قيد المراجعة'}`, { inline_keyboard: [
        ...(report.resolvedAt ? [] : [[{ text: 'تأكيد إخفاء المنشور', callback_data: `report:confirmHide:${key}` }, { text: 'إغلاق البلاغ فقط', callback_data: `report:resolve:${key}` }]]),
        [{ text: 'العودة للبلاغات', callback_data: 'menu:moderation' }],
      ] }, null)
    }
    if (action === 'confirmHide' || action === 'resolve') {
      const changed = await communityStore.update((current) => {
        const targetReport = current.reports.find((item) => item.id === key)
        if (!targetReport || targetReport.resolvedAt) return false
        targetReport.resolvedAt = new Date().toISOString()
        if (action === 'confirmHide') {
          const targetPost = current.posts.find((item) => item.id === targetReport.postId)
          if (targetPost) targetPost.hiddenAt = targetReport.resolvedAt
        }
        return true
      })
      await answerCallback(token, callbackQuery, changed ? (action === 'confirmHide' ? 'تم إخفاء المنشور ومعالجة البلاغ.' : 'أُغلق البلاغ دون إخفاء المنشور.') : 'عولج البلاغ مسبقاً.')
      return editCallbackMessage(token, callbackQuery, 'تم تحديث حالة البلاغ.', { inline_keyboard: [] }, null)
    }
  }

  if (scope === 'settings') {
    if (action === 'close') {
      await answerCallback(token, callbackQuery, 'تم الإغلاق.')
      return telegramRequest(token, 'editMessageText', {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        text: 'أُغلقت قائمة الإعدادات. أرسل /settings لفتحها مجدداً.',
        reply_markup: { inline_keyboard: [] },
      })
    }
    if (action === 'edit') {
      if (!settingLabels[key] && key !== 'registrationOpen') return answerCallback(token, callbackQuery, 'إعداد غير معروف.')
      pendingSettingEdits.set(userId, key)
      await answerCallback(token, callbackQuery, 'أرسل القيمة الجديدة كرسالة.')
      return reply(token, callbackQuery.message.chat.id, `أرسل القيمة الجديدة لـ ${settingLabels[key] ?? 'حالة التسجيل'}. لإلغاء العملية أرسل /cancel.`)
    }
    if (action === 'toggle' && key === 'registrationOpen') {
      const catalog = await readCatalog()
      catalog.settings ??= {}
      catalog.settings.registrationOpen = catalog.settings.registrationOpen === false ? true : false
      await saveCatalog(catalog)
      await answerCallback(token, callbackQuery, catalog.settings.registrationOpen ? 'تم فتح التسجيل.' : 'تم إيقاف التسجيل.')
      return editSettingsMenu(token, callbackQuery, `إعدادات ${catalog.settings.centerName ?? 'المركز'}\nاختر الإعداد المطلوب.`)
    }
    if (action === 'clear' && editableSettingKeys.has(key)) {
      const catalog = await readCatalog()
      catalog.settings ??= {}
      catalog.settings[key] = ''
      await saveCatalog(catalog)
      await answerCallback(token, callbackQuery, `تم مسح ${settingLabels[key] ?? key}.`)
      return editSettingsMenu(token, callbackQuery, `إعدادات ${catalog.settings.centerName ?? 'المركز'}\nاختر الإعداد المطلوب.`)
    }
  }

  const catalog = await readCatalog()
  if (scope === 'menu') {
    if (action === 'home') {
      await answerCallback(token, callbackQuery, 'القائمة الرئيسية')
      return editCallbackMessage(token, callbackQuery, 'لوحة إدارة المعهد\nاختر القسم الذي تريد إدارته:', adminMenuKeyboard(), null)
    }
    if (action === 'grades') {
      await answerCallback(token, callbackQuery, 'إدارة الصفوف والمواد')
      return editCallbackMessage(token, callbackQuery, 'اختر صفاً لإدارة بياناته ومواده وأسعارها:', gradeListKeyboard(catalog), null)
    }
    if (action === 'news') {
      await answerCallback(token, callbackQuery, 'إدارة الأخبار')
      return editCallbackMessage(token, callbackQuery, 'اختر خبراً لتعديله أو حذفه، أو أضف خبراً جديداً:', newsListKeyboard(catalog.news), null)
    }
    if (action === 'announcements') {
      const store = await communityStore.read()
      const activeAnnouncements = store.announcements.filter((item) => !item.archivedAt)
      const rows = activeAnnouncements.slice(0, 30).map((item) => [{ text: `أرشفة: ${item.text.slice(0, 32)}`, callback_data: `announcement:archive:${item.id}` }])
      rows.unshift([{ text: 'إنشاء إعلان جديد', callback_data: 'announcement:new' }])
      rows.push([{ text: 'القائمة الرئيسية', callback_data: 'menu:home' }])
      await answerCallback(token, callbackQuery, 'إعلانات الإدارة')
      return editCallbackMessage(token, callbackQuery, 'الإعلانات منفصلة عن الأخبار العامة. أنشئ إعلاناً للمعاينة والتأكيد، أو اختر إعلاناً لأرشفته:', { inline_keyboard: rows }, null)
    }
    if (action === 'moderation') {
      const store = await communityStore.read()
      const reports = store.reports.filter((item) => !item.resolvedAt)
      const rows = reports.slice(0, 30).map((item) => [{ text: `بلاغ: ${item.reason.slice(0, 36)}`, callback_data: `report:review:${item.id}` }])
      rows.push([{ text: 'القائمة الرئيسية', callback_data: 'menu:home' }])
      await answerCallback(token, callbackQuery, `${reports.length} بلاغات`)
      return editCallbackMessage(token, callbackQuery, reports.length ? 'اختر بلاغاً لمعاينته قبل إخفاء منشور أو إغلاق البلاغ:' : 'لا توجد بلاغات معلقة.', { inline_keyboard: rows }, null)
    }
    if (action === 'marks') {
      await answerCallback(token, callbackQuery, 'استيراد العلامات')
      return reply(token, callbackQuery.message.chat.id, `ارفع ملف XLSX في هذه المحادثة الخاصة لمعاينته. الأعمدة بالترتيب: ${marksHeaders.join(', ')}. الحد الأقصى 5 ميغابايت و5000 صف. لن تُحفظ النتائج قبل تأكيد زر المعاينة.`)
    }
    if (action === 'studentids') {
      await answerCallback(token, callbackQuery, 'معرّفات الطلاب')
      return handleTelegramMessage(token, { text: '/studentids 1', from: callbackQuery.from, chat: callbackQuery.message.chat })
    }
    if (action === 'codes') {
      const subscriptions = await readSubscriptions()
      await answerCallback(token, callbackQuery, 'إدارة أكواد الاشتراك')
      return editCallbackMessage(token, callbackQuery, 'اختر كوداً لإدارته أو أنشئ كوداً جديداً:', subscriptionListKeyboard(subscriptions.codes), null)
    }
    if (action === 'settings') {
      await answerCallback(token, callbackQuery, 'إعدادات المركز')
      return editCallbackMessage(token, callbackQuery, `إعدادات ${catalog.settings?.centerName ?? 'المركز'}\nاختر الإعداد المطلوب:`, settingsKeyboard(catalog.settings), null)
    }
    if (action === 'requests') {
      await answerCallback(token, callbackQuery, 'طلبات التسجيل')
      return handleTelegramMessage(token, { text: '/requests', from: callbackQuery.from, chat: callbackQuery.message.chat })
    }
  }

  if (scope === 'grade') {
    if (action === 'view') {
      const gradeId = Number(key)
      const grade = catalog.grades.find((item) => item.id === gradeId)
      if (!grade) return answerCallback(token, callbackQuery, 'الصف غير موجود.')
      await answerCallback(token, callbackQuery, grade.title)
      return editCallbackMessage(token, callbackQuery, `الصف: ${grade.title}\nالمرحلة: ${grade.stage ?? 'غير محدد'}\nاختر مادة أو إجراءً:`, gradeDetailKeyboard(grade), null)
    }
    if (action === 'back') {
      await answerCallback(token, callbackQuery, 'العودة للصفوف')
      return editCallbackMessage(token, callbackQuery, 'اختر صفاً لإدارة بياناته ومواده وأسعارها:', gradeListKeyboard(catalog), null)
    }
    if (action === 'edit') {
      const grade = catalog.grades.find((item) => item.id === Number(key))
      if (!grade) return answerCallback(token, callbackQuery, 'الصف غير موجود.')
      const keyboard = { inline_keyboard: [
        [{ text: 'تعديل الاسم الظاهر', callback_data: `grade:field:${grade.id}:name` }],
        [{ text: 'تعديل العنوان', callback_data: `grade:field:${grade.id}:title` }],
        [{ text: 'تعديل المرحلة', callback_data: `grade:field:${grade.id}:stage` }],
        [{ text: 'رجوع', callback_data: `grade:view:${grade.id}` }],
      ] }
      await answerCallback(token, callbackQuery, 'اختر الحقل')
      return editCallbackMessage(token, callbackQuery, `تعديل بيانات ${grade.title}:`, keyboard, null)
    }
    if (action === 'field') {
      const grade = catalog.grades.find((item) => item.id === Number(key))
      if (!grade || !['name', 'title', 'stage'].includes(extra)) return answerCallback(token, callbackQuery, 'الحقل غير صالح.')
      pendingAdminEdits.set(userId, { type: 'grade', gradeId: grade.id, field: extra })
      await answerCallback(token, callbackQuery, 'أرسل القيمة الجديدة')
      return reply(token, callbackQuery.message.chat.id, `أرسل القيمة الجديدة لحقل ${extra} في ${grade.title}. أرسل /cancel للإلغاء.`)
    }
    if (action === 'add') {
      pendingAdminEdits.set(userId, { type: 'grade-add' })
      await answerCallback(token, callbackQuery, 'أرسل تفاصيل الصف')
      return reply(token, callbackQuery.message.chat.id, 'أرسل بيانات الصف بهذا الترتيب: رقم الصف | الاسم | العنوان | المرحلة. أرسل /cancel للإلغاء.')
    }
    if (action === 'delete') {
      const grade = catalog.grades.find((item) => item.id === Number(key))
      if (!grade) return answerCallback(token, callbackQuery, 'الصف غير موجود.')
      await answerCallback(token, callbackQuery, 'تأكيد حذف الصف')
      return editCallbackMessage(token, callbackQuery, `سيتم حذف ${grade.title} وجميع مواده. هل تريد المتابعة؟`, { inline_keyboard: [
        [{ text: 'تأكيد الحذف', callback_data: `grade:confirmDelete:${grade.id}` }, { text: 'إلغاء', callback_data: `grade:view:${grade.id}` }],
      ] }, null)
    }
    if (action === 'confirmDelete') {
      const gradeId = Number(key)
      const gradeIndex = catalog.grades.findIndex((item) => item.id === gradeId)
      if (gradeIndex < 0) return answerCallback(token, callbackQuery, 'الصف غير موجود.')
      const [deletedGrade] = catalog.grades.splice(gradeIndex, 1)
      await saveCatalog(catalog)
      await answerCallback(token, callbackQuery, `تم حذف ${deletedGrade.title}`)
      return editCallbackMessage(token, callbackQuery, 'تم الحذف. اختر صفاً آخر:', gradeListKeyboard(catalog), null)
    }
  }

  if (scope === 'sub' && action === 'view') {
    const gradeId = Number(key)
    const subjectId = extra
    const { grade, subject } = findSubject(catalog, gradeId, subjectId)
    if (!subject) return answerCallback(token, callbackQuery, 'المادة غير موجودة.')

    await answerCallback(token, callbackQuery, subject.name)
    return editCallbackMessage(token, callbackQuery, `المادة: ${subject.name}\nالصف: ${grade.title}\nالسعر: ${subject.price ?? 0} ${subject.currency ?? ''}\nالمدرسون: ${(subject.teachers ?? []).join('، ') || 'غير محدد'}`, subjectDetailKeyboard(gradeId, subjectId), null)
  }

  if (scope === 'sub' && action === 'add') {
    const grade = catalog.grades.find((item) => item.id === Number(key))
    if (!grade) return answerCallback(token, callbackQuery, 'الصف غير موجود.')
    pendingAdminEdits.set(userId, { type: 'subject-add', gradeId: grade.id })
    await answerCallback(token, callbackQuery, 'أرسل بيانات المادة')
    return reply(token, callbackQuery.message.chat.id, 'أرسل بيانات المادة: المعرف | الاسم | السعر | العملة | أسماء المدرسين مفصولة بفاصلة. أرسل /cancel للإلغاء.')
  }

  if (scope === 'sub' && action.startsWith('edit')) {
    const { grade, subject } = findSubject(catalog, Number(key), extra)
    const field = { editName: 'name', editPrice: 'price', editCurrency: 'currency', editTeachers: 'teachers' }[action]
    if (!grade || !subject || !field) return answerCallback(token, callbackQuery, 'المادة أو الحقل غير موجود.')
    pendingAdminEdits.set(userId, { type: 'subject', gradeId: grade.id, subjectId: subject.id, field })
    await answerCallback(token, callbackQuery, 'أرسل القيمة الجديدة')
    const prompt = field === 'teachers' ? 'أرسل أسماء المدرسين مفصولة بفاصلة.' : `أرسل القيمة الجديدة لحقل ${field} في ${subject.name}.`
    return reply(token, callbackQuery.message.chat.id, `${prompt} أرسل /cancel للإلغاء.`)
  }

  if (scope === 'sub' && action === 'delete') {
    const { grade, subject } = findSubject(catalog, Number(key), extra)
    if (!grade || !subject) return answerCallback(token, callbackQuery, 'المادة غير موجودة.')
    await answerCallback(token, callbackQuery, 'تأكيد حذف المادة')
    return editCallbackMessage(token, callbackQuery, `هل تريد حذف مادة ${subject.name} من ${grade.title}؟`, { inline_keyboard: [
      [{ text: 'تأكيد الحذف', callback_data: `sub:confirmDelete:${grade.id}:${subject.id}` }, { text: 'إلغاء', callback_data: `sub:view:${grade.id}:${subject.id}` }],
    ] }, null)
  }

  if (scope === 'sub' && action === 'confirmDelete') {
    const { grade, subject } = findSubject(catalog, Number(key), extra)
    if (!grade || !subject) return answerCallback(token, callbackQuery, 'المادة غير موجودة.')
    grade.subjects = grade.subjects.filter((item) => item.id !== subject.id)
    await saveCatalog(catalog)
    await answerCallback(token, callbackQuery, 'تم حذف المادة')
    return editCallbackMessage(token, callbackQuery, `مواد ${grade.title}:`, gradeDetailKeyboard(grade), null)
  }

  if (scope === 'news') {
    const item = catalog.news?.find((entry) => entry.id === key)
    if (action === 'view') {
      if (!item) return answerCallback(token, callbackQuery, 'الخبر غير موجود.')
      await answerCallback(token, callbackQuery, 'تفاصيل الخبر')
      return editCallbackMessage(token, callbackQuery, `العنوان: ${item.title ?? ''}\nالوصف: ${item.description ?? item.summary ?? ''}\nالرابط: ${item.link || 'لا يوجد'}`, newsDetailKeyboard(item.id), null)
    }
    if (action === 'add') {
      pendingAdminEdits.set(userId, { type: 'news-add' })
      await answerCallback(token, callbackQuery, 'أرسل تفاصيل الخبر')
      return reply(token, callbackQuery.message.chat.id, 'أرسل الخبر بهذا الترتيب: العنوان | الوصف | الرابط (اختياري). أرسل /cancel للإلغاء.')
    }
    if (action.startsWith('edit')) {
      const field = { editTitle: 'title', editDescription: 'description', editLink: 'link' }[action]
      if (!item || !field) return answerCallback(token, callbackQuery, 'الخبر أو الحقل غير موجود.')
      pendingAdminEdits.set(userId, { type: 'news', id: item.id, field })
      await answerCallback(token, callbackQuery, 'أرسل القيمة الجديدة')
      return reply(token, callbackQuery.message.chat.id, `أرسل القيمة الجديدة لحقل ${field} في الخبر. أرسل /cancel للإلغاء.`)
    }
    if (action === 'delete') {
      if (!item) return answerCallback(token, callbackQuery, 'الخبر غير موجود.')
      await answerCallback(token, callbackQuery, 'تأكيد الحذف')
      return editCallbackMessage(token, callbackQuery, `هل تريد حذف الخبر «${item.title}»؟`, { inline_keyboard: [
        [{ text: 'تأكيد الحذف', callback_data: `news:confirmDelete:${item.id}` }, { text: 'إلغاء', callback_data: `news:view:${item.id}` }],
      ] }, null)
    }
    if (action === 'confirmDelete') {
      const index = catalog.news?.findIndex((entry) => entry.id === key) ?? -1
      if (index < 0) return answerCallback(token, callbackQuery, 'الخبر غير موجود.')
      catalog.news.splice(index, 1)
      await saveCatalog(catalog)
      await answerCallback(token, callbackQuery, 'تم حذف الخبر')
      return editCallbackMessage(token, callbackQuery, 'إدارة الأخبار:', newsListKeyboard(catalog.news), null)
    }
  }

  if (scope === 'code') {
    const subscriptions = await readSubscriptions()
    const subscriptionId = String(key ?? '')
    const item = subscriptions.codes.find((entry) => entry.id === subscriptionId)
    if (action === 'view') {
      if (!item) return answerCallback(token, callbackQuery, 'الكود غير موجود.')
      await answerCallback(token, callbackQuery, 'تفاصيل الكود')
      const codeReady = /^[a-f0-9]{32}$/.test(item.codeSalt ?? '') && /^[a-f0-9]{128}$/.test(item.codeHash ?? '') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(item.email ?? ''))
      const status = item.active === false ? 'متوقف' : codeReady ? 'فعال' : 'يحتاج كوداً جديداً وبريداً مرتبطاً'
      return editCallbackMessage(token, callbackQuery, `الكود: ${codeReady ? 'مخزّن بشكل آمن ولا يُعرض مجدداً' : 'غير مهيأ'}\nالبريد: ${item.email ?? 'غير مربوط'}\nالطالب: ${item.studentName ?? 'غير محدد'}\nالمرحلة: ${item.grade ?? 'غير محددة'}\nالحالة: ${status}`, subscriptionDetailKeyboard(item.id), null)
    }
    if (action === 'add') {
      pendingAdminEdits.set(userId, { type: 'code-add' })
      await answerCallback(token, callbackQuery, 'أرسل بيانات الكود')
      return reply(token, callbackQuery.message.chat.id, 'أرسل: البريد الإلكتروني | اسم الطالب | المرحلة. سيُنشأ كود عشوائي ويُعرض مرة واحدة لك. أرسل /cancel للإلغاء.')
    }
    if (action === 'editStudent' || action === 'editGrade' || action === 'editEmail') {
      if (!item) return answerCallback(token, callbackQuery, 'الكود غير موجود.')
      const field = action === 'editStudent' ? 'studentName' : action === 'editGrade' ? 'grade' : 'email'
      pendingAdminEdits.set(userId, { type: 'code', id: item.id, field })
      await answerCallback(token, callbackQuery, 'أرسل القيمة الجديدة')
      return reply(token, callbackQuery.message.chat.id, `أرسل القيمة الجديدة لحقل ${field}. أرسل /cancel للإلغاء.`)
    }
    if (action === 'toggle') {
      if (!item) return answerCallback(token, callbackQuery, 'الكود غير موجود.')
      item.active = item.active === false
      if (!item.active) await revokeStudentSessions(item.id)
      await saveSubscriptions(subscriptions)
      await answerCallback(token, callbackQuery, item.active ? 'تم تفعيل الكود' : 'تم إيقاف الكود')
      return editCallbackMessage(token, callbackQuery, `البريد: ${item.email ?? 'غير مربوط'}\nالطالب: ${item.studentName ?? 'غير محدد'}\nالمرحلة: ${item.grade ?? 'غير محددة'}\nالحالة: ${item.active ? 'فعال' : 'متوقف'}`, subscriptionDetailKeyboard(item.id), null)
    }
    if (action === 'reissue') {
      if (!item) return answerCallback(token, callbackQuery, 'الكود غير موجود.')
      const newCode = generateAccessCode()
      Object.assign(item, await hashAccessCode(newCode))
      item.active = true
      item.updatedAt = new Date().toISOString()
      await revokeStudentSessions(item.id)
      await saveSubscriptions(subscriptions)
      await answerCallback(token, callbackQuery, 'تم إنشاء رمز جديد وإبطال الجلسات السابقة.')
      return editCallbackMessage(token, callbackQuery, `تم إصدار رمز جديد مرة واحدة للنسخ:\n<code>${newCode}</code>\nالطالب: ${escapeTelegramHtml(item.studentName)}\nالبريد: <code>${escapeTelegramHtml(item.email)}</code>`, subscriptionDetailKeyboard(item.id), 'HTML')
    }
    if (action === 'delete') {
      if (!item) return answerCallback(token, callbackQuery, 'الكود غير موجود.')
      await answerCallback(token, callbackQuery, 'تأكيد الحذف')
      return editCallbackMessage(token, callbackQuery, `هل تريد حذف كود الطالب ${item.studentName ?? ''}؟`, { inline_keyboard: [
        [{ text: 'تأكيد الحذف', callback_data: `code:confirmDelete:${item.id}` }, { text: 'إلغاء', callback_data: `code:view:${item.id}` }],
      ] }, null)
    }
    if (action === 'confirmDelete') {
      const index = subscriptions.codes.findIndex((entry) => entry.id === subscriptionId)
      if (index < 0) return answerCallback(token, callbackQuery, 'الكود غير موجود.')
      await revokeStudentSessions(subscriptionId)
      subscriptions.codes.splice(index, 1)
      await saveSubscriptions(subscriptions)
      await answerCallback(token, callbackQuery, 'تم حذف الكود')
      return editCallbackMessage(token, callbackQuery, 'إدارة أكواد الاشتراك:', subscriptionListKeyboard(subscriptions.codes), null)
    }
  }

  if (scope === 'req' && action === 'delete') {
    const requests = await readRegistrationRequests()
    const targetReq = requests.find((item) => item.id === key)
    if (!targetReq) return answerCallback(token, callbackQuery, 'الطلب غير موجود.')
    await answerCallback(token, callbackQuery, 'تأكيد حذف الطلب')
    return editCallbackMessage(token, callbackQuery, `هل تريد حذف طلب ${targetReq.name} نهائياً؟`, { inline_keyboard: [
      [{ text: 'تأكيد الحذف', callback_data: `req:confirmDelete:${targetReq.id}` }, { text: 'إلغاء', callback_data: `req:view:${targetReq.id}` }],
    ] }, null)
  }

  if (scope === 'req' && action === 'confirmDelete') {
    const requests = await readRegistrationRequests()
    const index = requests.findIndex((item) => item.id === key)
    if (index < 0) return answerCallback(token, callbackQuery, 'الطلب غير موجود.')
    const [deletedRequest] = requests.splice(index, 1)
    await saveRegistrationRequests(requests)
    await answerCallback(token, callbackQuery, 'تم حذف الطلب')
    return editCallbackMessage(token, callbackQuery, `تم حذف طلب ${deletedRequest.name}.`, { inline_keyboard: [] }, null)
  }

  if (scope === 'req' && action === 'view') {
    const requests = await readRegistrationRequests()
    const targetReq = requests.find((item) => item.id === key)
    if (!targetReq) return answerCallback(token, callbackQuery, 'الطلب غير موجود.')
    await answerCallback(token, callbackQuery, 'تفاصيل الطلب')
    const telegramLinkState = targetReq.telegramUserId ? 'مرتبط' : 'غير مرتبط'
    const deliveryStatus = targetReq.codeDeliveryStatus ? `\nحالة تسليم الكود: ${targetReq.codeDeliveryStatus}` : ''
    return editCallbackMessage(token, callbackQuery, `الاسم: ${targetReq.name}\nالهاتف: ${targetReq.phone}\nالبريد: ${targetReq.email}\nالصف: ${targetReq.gradeTitle}\nالمواد: ${(targetReq.subjectNames ?? []).join('، ')}\nتيليغرام: ${telegramLinkState}${deliveryStatus}\nالحالة: ${targetReq.status}`, { inline_keyboard: [
      [{ text: 'حذف الطلب', callback_data: `req:delete:${targetReq.id}` }],
    ] }, null)
  }

  if (scope === 'req' && action === 'action') {
    const requestId = key
    const newStatus = extra
    if (!['approved', 'rejected'].includes(newStatus)) return answerCallback(token, callbackQuery, 'حالة الطلب غير صالحة.')

    const requests = await readRegistrationRequests()
    const targetReq = requests.find((item) => item.id === requestId)
    if (!targetReq) return answerCallback(token, callbackQuery, 'الطلب غير موجود.')
    if (targetReq.status !== 'pending') return answerCallback(token, callbackQuery, 'تمت معالجة هذا الطلب مسبقاً.')
    if (newStatus === 'approved' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(targetReq.email ?? ''))) {
      return answerCallback(token, callbackQuery, 'لا يمكن قبول الطلب قبل إضافة بريد إلكتروني صحيح.')
    }

    const subscriptions = await readSubscriptions()
    let accessCode = subscriptions.codes.find((entry) => entry.requestId === requestId)
    let oneTimeCode = ''
    if (newStatus === 'approved') {
      oneTimeCode = generateAccessCode()
      const codeHash = await hashAccessCode(oneTimeCode)
      if (accessCode) {
        Object.assign(accessCode, codeHash)
        accessCode.active = true
        await revokeStudentSessions(accessCode.id)
      } else {
        accessCode = {
          id: randomUUID(),
          ...codeHash,
          email: targetReq.email.toLowerCase(),
          studentName: targetReq.name,
          phone: targetReq.phone,
          grade: targetReq.gradeTitle,
          programType: targetReq.programType ?? 'center',
          subjectIds: targetReq.subjectIds ?? [],
          subjectNames: targetReq.subjectNames ?? [],
          requestId,
          active: true,
          createdAt: new Date().toISOString(),
        }
        subscriptions.codes.unshift(accessCode)
      }
      await saveSubscriptions(subscriptions)
    } else if (accessCode) {
      accessCode.active = false
      await revokeStudentSessions(accessCode.id)
      await saveSubscriptions(subscriptions)
    }

    targetReq.status = newStatus
    targetReq.codeDeliveryStatus = newStatus === 'approved'
      ? targetReq.telegramUserId ? 'pending' : 'not_linked'
      : 'not_applicable'
    await saveRegistrationRequests(requests)
    await answerCallback(token, callbackQuery, newStatus === 'approved' ? 'تمت الموافقة وإنشاء الكود.' : 'تم رفض الطلب وإيقاف كوده إن وجد.')

    let telegramDeliveryConfirmed = false
    let telegramDeliveryError = null
    if (newStatus === 'approved' && targetReq.telegramUserId) {
      try {
        await telegramRequest(token, 'sendMessage', {
          chat_id: targetReq.telegramUserId,
          text: `تم قبول طلبك في مركز النخبة.\nكود الدخول: ${oneTimeCode}\nاستخدم الكود مع بريدك الإلكتروني لتسجيل الدخول.`,
        })
        telegramDeliveryConfirmed = true
        targetReq.codeDeliveryStatus = 'delivered'
        targetReq.codeDeliveredAt = new Date().toISOString()
        try {
          await saveRegistrationRequests(requests)
        } catch (error) {
          console.error(`Telegram delivery confirmed but status persistence failed for request ${requestId}:`, error.message)
        }
      } catch (error) {
        telegramDeliveryError = error
        targetReq.codeDeliveryStatus = 'undelivered'
        targetReq.codeDeliveryFailedAt = new Date().toISOString()
        try {
          await saveRegistrationRequests(requests)
        } catch (persistError) {
          console.error(`Telegram delivery failed and status persistence failed for request ${requestId}:`, persistError.message)
        }
        console.warn(`Telegram code delivery was not confirmed for request ${requestId}:`, error.message)
      }
    }

    const resultText = newStatus === 'approved'
      ? telegramDeliveryConfirmed
        ? `<b>تم قبول الطلب وتسليم الكود عبر تيليغرام</b>\nالطالب: ${escapeTelegramHtml(targetReq.name)}\nالبريد: <code>${escapeTelegramHtml(targetReq.email)}</code>\nحالة التسليم: مؤكدة من تيليغرام.\nرقم الطلب: <code>${targetReq.id}</code>`
        : `<b>تم قبول الطلب</b>\nالطالب: ${escapeTelegramHtml(targetReq.name)}\nالبريد: <code>${escapeTelegramHtml(targetReq.email)}</code>\nحالة التسليم: ${telegramDeliveryError ? 'تعذّر تأكيد التسليم عبر تيليغرام' : 'لم يربط الطالب حساب تيليغرام'}.\n${telegramDeliveryError ? 'تحقق مع الطالب قبل إعادة إصدار الرمز؛ قد يكون قد وصل رغم تعذر التأكيد.' : 'أرسل الرمز للطالب يدوياً.'}\nكود الدخول الجديد (يظهر مرة واحدة):\n<code>${oneTimeCode}</code>\nرقم الطلب: <code>${targetReq.id}</code>`
      : `<b>تم رفض الطلب</b>\nالطالب: ${escapeTelegramHtml(targetReq.name)}\nرقم الطلب: <code>${targetReq.id}</code>`
    try {
      return await editCallbackMessage(token, callbackQuery, resultText, { inline_keyboard: [
        [{ text: 'لوحة الإدارة', callback_data: 'menu:home' }],
      ] })
    } catch (error) {
      if (newStatus !== 'approved' || telegramDeliveryConfirmed) throw error
      console.error(`Could not display one-time code in the approval message for request ${requestId}:`, error.message)
      return telegramRequest(token, 'sendMessage', {
        chat_id: callbackQuery.message.chat.id,
        text: `تعذر عرض نتيجة الموافقة في الرسالة الأصلية. كود الدخول الجديد (يظهر مرة واحدة):\n${oneTimeCode}\nالطالب: ${targetReq.name}\nالبريد: ${targetReq.email}\nحالة التسليم: ${telegramDeliveryError ? 'غير مؤكدة؛ تحقق مع الطالب قبل إعادة الإصدار.' : 'لم يُربط تيليغرام؛ أرسله للطالب يدوياً.'}\nرقم الطلب: ${targetReq.id}`,
      })
    }
  }

  return answerCallback(token, callbackQuery, 'إجراء غير معروف.')
}

function validateSettingValue(key, rawValue) {
  const value = rawValue.trim()
  if (!editableSettingKeys.has(key) || !value || value.length > 300) return { error: 'القيمة مطلوبة ويجب ألا تتجاوز 300 حرف.' }
  if (key === 'registrationOpen') {
    const normalized = value.toLowerCase()
    if (!['true', 'false'].includes(normalized)) return { error: 'اكتب true لفتح التسجيل أو false لإيقافه.' }
    return { value: normalized === 'true' }
  }
  if (key === 'logoPath' && (!value.startsWith('/') || value.includes('..') || !/^\/[\w./-]+$/.test(value))) return { error: 'المسار يجب أن يبدأ بـ / وألا يحتوي على ..' }
  if (key === 'contactTelegram' && !/^https:\/\/t\.me\/[A-Za-z0-9_]+$/.test(value)) return { error: 'استخدم رابطاً مثل https://t.me/username' }
  if (key === 'contactPhone' && !/^[+\d\s()-]{5,24}$/.test(value)) return { error: 'رقم الهاتف غير صالح.' }
  return { value }
}

function isValidWebUrl(value) {
  if (!value) return true
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

async function applyPendingAdminEdit(token, message, edit, rawText) {
  const userId = String(message.from.id)
  const text = rawText.trim()
  const fields = parsePipeFields(rawText)
  const catalog = await readCatalog()
  let subscriptions
  let successMessage = ''

  if (!text || text.length > 2000) return reply(token, message.chat.id, 'القيمة مطلوبة ويجب ألا تتجاوز 2000 حرف. أعد المحاولة أو أرسل /cancel.')

  if (edit.type === 'grade-add') {
    const [idText, name, title, stage] = fields
    const id = Number(idText)
    if (!Number.isInteger(id) || id < 1 || id > 20 || !name || !title || !stage || [name, title, stage].some((value) => value.length > 100)) {
      return reply(token, message.chat.id, 'بيانات الصف غير صالحة. أرسل: رقم من 1 إلى 20 | الاسم | العنوان | المرحلة.')
    }
    if (catalog.grades.some((grade) => grade.id === id)) return reply(token, message.chat.id, 'رقم الصف موجود بالفعل. أرسل رقماً آخر أو /cancel.')
    catalog.grades.push({ id, name, title, stage, subjects: [] })
    catalog.grades.sort((left, right) => left.id - right.id)
    await saveCatalog(catalog)
    successMessage = `تمت إضافة الصف ${title}.`
  } else if (edit.type === 'grade') {
    const grade = catalog.grades.find((item) => item.id === edit.gradeId)
    if (!grade) return reply(token, message.chat.id, 'الصف غير موجود. أرسل /cancel لإلغاء العملية.')
    if (text.length > 100) return reply(token, message.chat.id, 'يجب ألا تتجاوز القيمة 100 حرف.')
    grade[edit.field] = text
    await saveCatalog(catalog)
    successMessage = `تم تحديث ${edit.field} للصف ${grade.title}.`
  } else if (edit.type === 'subject-add') {
    const [id, name, priceText, currency, teachersText] = fields
    const grade = catalog.grades.find((item) => item.id === edit.gradeId)
    const price = Number(priceText)
    if (!grade) return reply(token, message.chat.id, 'الصف غير موجود. أرسل /cancel لإلغاء العملية.')
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id ?? '') || !name || name.length > 100 || !Number.isFinite(price) || price < 0 || !currency || currency.length > 8) {
      return reply(token, message.chat.id, 'بيانات المادة غير صالحة. أرسل: معرف لاتيني قصير | الاسم | السعر | العملة | المدرسون.')
    }
    if ((grade.subjects ?? []).some((subject) => subject.id === id)) return reply(token, message.chat.id, 'معرف المادة موجود في هذا الصف. أرسل معرفاً آخر أو /cancel.')
    grade.subjects ??= []
    grade.subjects.push({ id, name, price, currency, teachers: parseTeacherNames(teachersText ?? '') })
    await saveCatalog(catalog)
    successMessage = `تمت إضافة مادة ${name} إلى ${grade.title}.`
  } else if (edit.type === 'subject') {
    const { grade, subject } = findSubject(catalog, edit.gradeId, edit.subjectId)
    if (!grade || !subject) return reply(token, message.chat.id, 'المادة غير موجودة. أرسل /cancel لإلغاء العملية.')
    if (edit.field === 'price') {
      const price = Number(text)
      if (!Number.isFinite(price) || price < 0) return reply(token, message.chat.id, 'أدخل سعراً رقمياً يساوي صفراً أو أكثر.')
      subject.price = price
    } else if (edit.field === 'teachers') {
      if (text.length > 500) return reply(token, message.chat.id, 'قائمة المدرسين طويلة جداً.')
      subject.teachers = parseTeacherNames(text)
    } else if (edit.field === 'currency') {
      if (text.length > 8) return reply(token, message.chat.id, 'اسم العملة يجب ألا يتجاوز 8 أحرف.')
      subject.currency = text
    } else {
      if (text.length > 100) return reply(token, message.chat.id, 'اسم المادة يجب ألا يتجاوز 100 حرف.')
      subject.name = text
    }
    await saveCatalog(catalog)
    successMessage = `تم تحديث ${subject.name} في ${grade.title}.`
  } else if (edit.type === 'news-add') {
    const [title, summary, link = ''] = fields
    if (!title || !summary || title.length > 150 || summary.length > 1000 || link.length > 500 || !isValidWebUrl(link)) {
      return reply(token, message.chat.id, 'بيانات الخبر غير صالحة. تأكد من العنوان والوصف، وأن الرابط يبدأ بـ http:// أو https://.')
    }
    catalog.news ??= []
    catalog.news.unshift({ id: randomUUID(), title, summary, description: summary, link, publishedAt: new Date().toISOString() })
    await saveCatalog(catalog)
    successMessage = `تمت إضافة الخبر: ${title}.`
  } else if (edit.type === 'news') {
    const item = catalog.news?.find((entry) => entry.id === edit.id)
    if (!item) return reply(token, message.chat.id, 'الخبر غير موجود. أرسل /cancel لإلغاء العملية.')
    if (edit.field === 'link' && !isValidWebUrl(text)) return reply(token, message.chat.id, 'الرابط يجب أن يبدأ بـ http:// أو https://، أو اتركه فارغاً.')
    if (text.length > (edit.field === 'description' ? 1000 : 500)) return reply(token, message.chat.id, 'القيمة أطول من الحد المسموح.')
    if (edit.field !== 'link' && !text) return reply(token, message.chat.id, 'هذه القيمة لا يمكن أن تكون فارغة.')
    item[edit.field] = text
    if (edit.field === 'description') item.summary = text
    await saveCatalog(catalog)
    successMessage = 'تم تحديث الخبر.'
  } else if (edit.type === 'code-add') {
    const [emailText, studentName, grade] = fields
    const email = String(emailText ?? '').toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !studentName || studentName.length > 100 || !grade || grade.length > 100) {
      return reply(token, message.chat.id, 'أرسل بريداً صحيحاً واسم الطالب والمرحلة مفصولة بعلامة |.')
    }
    subscriptions = await readSubscriptions()
    if (subscriptions.codes.some((entry) => String(entry.email ?? '').toLowerCase() === email && entry.active !== false)) {
      return reply(token, message.chat.id, 'يوجد اشتراك نشط لهذا البريد. استخدم خيار «إعادة إصدار كود» من /codes لإلغاء الكود السابق.')
    }
    const code = generateAccessCode()
    subscriptions.codes.unshift({
      id: randomUUID(),
      ...await hashAccessCode(code),
      email,
      studentName,
      grade,
      active: true,
      createdAt: new Date().toISOString(),
    })
    await saveSubscriptions(subscriptions)
    successMessage = `تم إنشاء كود دخول عشوائي للطالب ${studentName}.\nيظهر مرة واحدة للنسخ: ${code}`
  } else if (edit.type === 'code') {
    subscriptions = await readSubscriptions()
    const item = subscriptions.codes.find((entry) => entry.id === edit.id)
    if (!item) return reply(token, message.chat.id, 'الكود غير موجود. أرسل /cancel لإلغاء العملية.')
    if (text.length > 100) return reply(token, message.chat.id, 'يجب ألا تتجاوز القيمة 100 حرف.')
    if (edit.field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return reply(token, message.chat.id, 'أدخل بريداً إلكترونياً صحيحاً.')
    item[edit.field] = edit.field === 'email' ? text.toLowerCase() : text
    if (edit.field === 'email') await revokeStudentSessions(item.id)
    await saveSubscriptions(subscriptions)
    successMessage = `تم تحديث بيانات اشتراك ${item.studentName ?? 'الطالب'}.`
  }

  if (!successMessage) return reply(token, message.chat.id, 'تعذر تطبيق التعديل. أرسل /cancel ثم ابدأ من جديد.')
  pendingAdminEdits.delete(userId)
  pendingSettingEdits.delete(userId)
  await reply(token, message.chat.id, successMessage)
  return sendAdminMenu(token, message.chat.id)
}

async function handleTelegramMessage(token, message) {
  const text = message.text?.trim() ?? ''
  const userId = String(message.from.id)
  if (message.chat.type !== 'private' || String(message.chat.id) !== userId) return
  if (message.document) {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, message.chat.id, 'رفع ملفات العلامات متاح للمراجعين المخوّلين فقط.')
    try {
      return await handleMarksDocument(token, message)
    } catch (error) {
      console.error('Marks workbook processing failed:', error.message)
      const userMessage = /[\u0600-\u06FF]/.test(error.message)
        ? error.message
        : 'تعذر تنزيل أو تحليل ملف العلامات. تحقق من الامتداد والنوع وصحة جدول XLSX، ثم حاول مجدداً.'
      return reply(token, message.chat.id, userMessage)
    }
  }
  if (!message.text) return
  if (!text.startsWith('/')) {
    const pendingAnnouncement = pendingAnnouncements.get(userId)
    if (pendingAnnouncement?.mode === 'text') {
      const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
      const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
      if (!admins.includes(userId)) {
        pendingAnnouncements.delete(userId)
        return reply(token, message.chat.id, 'إنشاء الإعلانات للمدراء فقط.')
      }
      if (pendingAnnouncement.expiresAt <= Date.now()) {
        pendingAnnouncements.delete(userId)
        return reply(token, message.chat.id, 'انتهت مهلة إعداد الإعلان. ابدأ من لوحة الإدارة مجدداً.')
      }
      if (!text || text.length > 2000) return reply(token, message.chat.id, 'يجب أن يكون نص الإعلان من 1 إلى 2000 حرف.')
      const id = randomUUID()
      pendingAnnouncements.set(userId, { id, text, mode: 'preview', expiresAt: Date.now() + pendingActionDurationMs })
      return telegramRequest(token, 'sendMessage', {
        chat_id: message.chat.id,
        text: `معاينة الإعلان (لم يُنشر بعد):\n\n${text}\n\nهل تؤكد نشره لجميع الطلاب النشطين؟`,
        reply_markup: { inline_keyboard: [
          [{ text: 'تأكيد النشر', callback_data: `announcement:publish:${id}` }],
          [{ text: 'إلغاء', callback_data: `announcement:cancel:${id}` }],
        ] },
      })
    }
    const pendingAdminEdit = pendingAdminEdits.get(userId)
    if (pendingAdminEdit) {
      const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
      const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
      if (!admins.includes(userId)) {
        pendingAdminEdits.delete(userId)
        return reply(token, message.chat.id, 'هذا التعديل للمدراء فقط.')
      }
      return applyPendingAdminEdit(token, message, pendingAdminEdit, text)
    }

    const pendingKey = pendingSettingEdits.get(userId)
    if (!pendingKey) return
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) {
      pendingSettingEdits.delete(userId)
      return reply(token, message.chat.id, 'هذا الإعداد للمدراء فقط.')
    }
    const validation = validateSettingValue(pendingKey, text)
    if (validation.error) return reply(token, message.chat.id, validation.error)
    const catalog = await readCatalog()
    catalog.settings ??= {}
    catalog.settings[pendingKey] = validation.value
    await saveCatalog(catalog)
    pendingSettingEdits.delete(userId)
    await reply(token, message.chat.id, `تم تحديث ${settingLabels[pendingKey] ?? 'حالة التسجيل'}.`)
    return sendSettingsMenu(token, message.chat.id)
  }

  const [commandToken, ...argumentParts] = text.split(/\s+/)
  const command = commandToken.split('@')[0].toLowerCase()
  const args = argumentParts
  const chatId = message.chat.id

  if (command === '/cancel') {
    pendingSettingEdits.delete(userId)
    pendingAdminEdits.delete(userId)
    pendingAnnouncements.delete(userId)
    return reply(token, chatId, 'تم إلغاء العملية المعلقة.')
  }

  if (command === '/myid') {
    return reply(token, chatId, `رقم حساب تيليغرام الخاص بك: ${userId}`)
  }
  
  if (command === '/start' || command === '/help' || command === '/menu') {
    if (command === '/start' && args[0]?.startsWith('link_')) {
      if (message.chat.type !== 'private' || String(chatId) !== userId) {
        return reply(token, chatId, 'افتح رابط الربط في محادثة خاصة مع البوت.')
      }
      const requests = await readRegistrationRequests()
      const linkedRequest = claimTelegramBinding(requests, args[0].slice('link_'.length), userId)
      if (!linkedRequest) return reply(token, chatId, 'رابط الربط غير صالح أو انتهت صلاحيته. أرسل طلب تسجيل جديد للحصول على رابط آخر.')
      await saveRegistrationRequests(requests)
      return reply(token, chatId, 'تم ربط حساب تيليغرام بطلب التسجيل. بعد موافقة الإدارة سيصل كود الدخول إلى هذه المحادثة.')
    }
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'أهلاً بك. لا تتوفر أوامر إدارية لهذا الحساب.')
    return sendAdminMenu(token, chatId)
  }

  const catalog = await readCatalog()

  if (command === '/grades' || command === '/subjects') {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'هذا القسم للمدراء فقط.')
    return telegramRequest(token, 'sendMessage', {
      chat_id: chatId,
      text: 'اختر صفاً لإدارة بياناته ومواده وأسعارها:',
      reply_markup: gradeListKeyboard(catalog),
    })
  }

  if (command === '/requests') {
    try {
      const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
      const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
      if (!admins.includes(userId)) {
        return reply(token, chatId, 'هذا الأمر للمدراء فقط.')
      }

      const requests = await readRegistrationRequests()
      const pendingRequests = requests.filter(r => r.status === 'pending')
      if (pendingRequests.length === 0) {
        return reply(token, chatId, 'لا توجد طلبات تسجيل معلقة حالياً.')
      }
      
      for (const reqItem of pendingRequests.slice(0, 5)) {
        const telegramLinkState = reqItem.telegramUserId ? 'مرتبط' : 'غير مرتبط'
        const reqText = `👤 <b>الاسم:</b> ${escapeTelegramHtml(reqItem.name)}\n📚 <b>الصف:</b> ${escapeTelegramHtml(reqItem.gradeTitle)}\n📋 <b>المواد:</b> ${escapeTelegramHtml((reqItem.subjectNames ?? []).join('، '))}\n📞 <b>الهاتف:</b> <code>${escapeTelegramHtml(reqItem.phone)}</code>\n✉️ <b>البريد:</b> <code>${escapeTelegramHtml(reqItem.email)}</code>\n🔗 <b>تيليغرام:</b> ${telegramLinkState}\n🆔 <b>رقم الطلب:</b> <code>${reqItem.id}</code>`
        const keyboard = {
          inline_keyboard: [
            [
              { text: '✅ قبول', callback_data: `req:action:${reqItem.id}:approved` },
              { text: '❌ رفض', callback_data: `req:action:${reqItem.id}:rejected` },
            ],
            [{ text: 'عرض / حذف', callback_data: `req:view:${reqItem.id}` }],
          ]
        }
        await telegramRequest(token, 'sendMessage', {
          chat_id: chatId,
          text: reqText,
          parse_mode: 'HTML',
          reply_markup: keyboard
        })
      }
      return
    } catch {
      return reply(token, chatId, 'تعذر جلب الطلبات.')
    }
  }

  if (command === '/settings') {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'هذا الأمر للمدراء فقط.')
    return sendSettingsMenu(token, chatId)
  }

  if (command === '/news') {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'هذا القسم للمدراء فقط.')
    return telegramRequest(token, 'sendMessage', {
      chat_id: chatId,
      text: 'اختر خبراً لتعديله أو حذفه، أو أضف خبراً جديداً:',
      reply_markup: newsListKeyboard(catalog.news),
    })
  }

  if (command === '/announcements') {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'هذا القسم للمدراء فقط.')
    const store = await communityStore.read()
    const rows = store.announcements.filter((item) => !item.archivedAt).slice(0, 30).map((item) => [{ text: `أرشفة: ${item.text.slice(0, 32)}`, callback_data: `announcement:archive:${item.id}` }])
    rows.unshift([{ text: 'إنشاء إعلان جديد', callback_data: 'announcement:new' }])
    rows.push([{ text: 'القائمة الرئيسية', callback_data: 'menu:home' }])
    return telegramRequest(token, 'sendMessage', {
      chat_id: chatId,
      text: 'إعلانات الإدارة منفصلة عن الأخبار العامة. أنشئ إعلاناً للمعاينة والتأكيد أو اختر إعلاناً لأرشفته:',
      reply_markup: { inline_keyboard: rows },
    })
  }

  if (command === '/reports') {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'هذا القسم للمدراء فقط.')
    const store = await communityStore.read()
    const rows = store.reports.filter((item) => !item.resolvedAt).slice(0, 30).map((item) => [{ text: `بلاغ: ${item.reason.slice(0, 36)}`, callback_data: `report:review:${item.id}` }])
    rows.push([{ text: 'القائمة الرئيسية', callback_data: 'menu:home' }])
    return telegramRequest(token, 'sendMessage', {
      chat_id: chatId,
      text: store.reports.some((item) => !item.resolvedAt) ? 'اختر بلاغاً لمعاينته ومعالجته:' : 'لا توجد بلاغات معلقة.',
      reply_markup: { inline_keyboard: rows },
    })
  }

  if (command === '/marks') {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'هذا القسم للمدراء فقط.')
    return reply(token, chatId, `ارفع ملف XLSX هنا لمعاينته. الأعمدة بالترتيب: ${marksHeaders.join(', ')}. الحد الأقصى 5 ميغابايت و5000 صف. لن تُحفظ النتائج قبل تأكيد المعاينة.`)
  }

  if (command === '/studentids') {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'هذا القسم للمدراء فقط.')
    const page = Number(args[0] ?? 1)
    if (!Number.isInteger(page) || page < 1) return reply(token, chatId, 'استخدم رقم صفحة موجباً مثل /studentids 1.')
    const subscriptions = (await readSubscriptions()).codes.filter((item) => item.active !== false)
    const pageSize = 20
    const start = (page - 1) * pageSize
    const pageItems = subscriptions.slice(start, start + pageSize)
    if (!pageItems.length) return reply(token, chatId, `لا توجد سجلات في الصفحة ${page}.`)
    const rows = pageItems.map((item) => `${item.studentName ?? 'طالب'} · ${item.grade ?? '—'}\n${item.id}`)
    const totalPages = Math.ceil(subscriptions.length / pageSize)
    return reply(token, chatId, `معرّفات الطلاب النشطين (صفحة ${page}/${totalPages})\nاستخدم قيمة المعرف في عمود student_id:\n\n${rows.join('\n\n')}`)
  }

  if (command === '/addnews') {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'هذا الأمر للمدراء فقط.')
    const parts = parsePipeFields(args.join(' '))
    if (parts.length < 2) return reply(token, chatId, 'الصيغة غير صحيحة. استخدم:\n/addnews <العنوان> | <الوصف> | <رابط>')
    catalog.news ??= []
    catalog.news.unshift({ id: randomUUID(), title: parts[0], description: parts[1], link: parts[2] ?? '' })
    await saveCatalog(catalog)
    return reply(token, chatId, 'تمت إضافة الخبر بنجاح.')
  }

  if (command === '/delnews') {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'هذا الأمر للمدراء فقط.')
    const id = args[0]
    if (!id) return reply(token, chatId, 'حدد معرف الخبر للحذف. مثال:\n/delnews <id>')
    const initialLength = catalog.news?.length ?? 0
    catalog.news = catalog.news?.filter(item => item.id !== id) ?? []
    if (catalog.news.length === initialLength) return reply(token, chatId, 'لم يتم العثور على الخبر بهذا المعرف.')
    await saveCatalog(catalog)
    return reply(token, chatId, 'تم حذف الخبر بنجاح.')
  }

  if (command === '/codes') {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'هذا الأمر للمدراء فقط.')
    const subscriptions = await readSubscriptions()
    return telegramRequest(token, 'sendMessage', {
      chat_id: chatId,
      text: 'اختر كوداً لإدارته أو أنشئ كوداً جديداً:',
      reply_markup: subscriptionListKeyboard(subscriptions.codes),
    })
  }

  if (command === '/newcode') {
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8'))
    const admins = Array.isArray(permissions.telegramAdminIds) ? permissions.telegramAdminIds.map(String) : []
    if (!admins.includes(userId)) return reply(token, chatId, 'هذا الأمر للمدراء فقط.')
    const parts = parsePipeFields(args.join(' '))
    if (parts.length < 3) return reply(token, chatId, 'الصيغة: /newcode <البريد> | <اسم الطالب> | <المرحلة>. سيُنشأ كود عشوائي يظهر مرة واحدة.')
    const subscriptions = await readSubscriptions()
    const email = parts[0].toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !parts[1] || parts[1].length > 100 || !parts[2] || parts[2].length > 100) {
      return reply(token, chatId, 'أدخل بريداً صحيحاً واسم طالب ومرحلة بطول لا يتجاوز 100 حرف.')
    }
    if (subscriptions.codes.some((entry) => String(entry.email ?? '').toLowerCase() === email && entry.active !== false)) {
      return reply(token, chatId, 'يوجد اشتراك نشط لهذا البريد. استخدم خيار «إعادة إصدار كود» من /codes لإلغاء الكود السابق.')
    }
    const code = generateAccessCode()
    subscriptions.codes.push({
      id: randomUUID(),
      ...await hashAccessCode(code),
      email,
      studentName: parts[1],
      grade: parts[2],
      active: true,
    })
    await saveSubscriptions(subscriptions)
    return telegramRequest(token, 'sendMessage', { chat_id: chatId, text: `تم إنشاء كود اشتراك عشوائي جديد مرة واحدة:\n<code>${code}</code>\nالطالب: ${escapeTelegramHtml(parts[1])}\nالبريد: <code>${escapeTelegramHtml(email)}</code>`, parse_mode: 'HTML' })
  }

  return reply(token, chatId, 'الأمر غير معروف. أكتب /start لعرض قائمة الأوامر.')
}

async function startTelegramPolling() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.warn('TELEGRAM_BOT_TOKEN is not set. Telegram bot polling is disabled.')
    return
  }

  let offset = 0
  console.log('Telegram bot polling started...')
  while (true) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeout: 30 })
      })
      const result = await response.json()
      if (!result.ok) {
        console.warn(`Telegram polling warning: ${result.description}`)
        await new Promise((resolve) => setTimeout(resolve, 5000))
        continue
      }

      for (const update of result.result) {
        offset = update.update_id + 1
        try {
          if (update.message) {
            await handleTelegramMessage(token, update.message)
          } else if (update.callback_query) {
            await handleTelegramCallback(token, update.callback_query)
          }
        } catch (error) {
          console.error('Error handling Telegram update:', error)
        }
      }
    } catch (error) {
      console.error('Telegram polling error:', error.message)
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }
}

async function main() {
  await loadLocalEnvironment()
  await initializeRuntimeData({
    dataDirectory,
    catalogSeedPath: resolve(projectDirectory, 'server', 'catalog.json'),
    adminIds: process.env.TELEGRAM_ADMIN_IDS ?? '',
  })
  await loadStudentSessions()
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001)
  const host = process.env.API_HOST ?? '0.0.0.0'
  apiServer.listen(port, host, () => {
    console.log(`Server listening on http://${host}:${port}`)
  })
  if (process.env.TELEGRAM_BOT_POLLING === 'false') {
    console.log('Telegram bot polling is disabled by TELEGRAM_BOT_POLLING=false.')
  } else {
    void startTelegramPolling()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
