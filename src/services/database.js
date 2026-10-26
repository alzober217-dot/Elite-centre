import { Capacitor } from '@capacitor/core'
import { createNativeSessionStore } from './nativeSessionStore.js'
import fallbackCatalog from '../../server/catalog.json'

const enrollmentStorageKey = 'elite-center:enrollments'
const favoriteStorageKey = 'elite-center:favorites'
const studentAccessSessionKey = 'elite-center:student-access-session'
const subjectColors = ['mint', 'coral', 'yellow', 'rose', 'sage', 'blue']
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')
let browserSessionActive = false
const nativeSessionStore = createNativeSessionStore()
let secureStoragePromise

function isNativeClient() {
  return Capacitor.isNativePlatform()
}

function apiUrl(path) {
  return `${apiBaseUrl}${path}`
}

async function getSecureStorage() {
  secureStoragePromise ??= import('@aparajita/capacitor-secure-storage').then(({ SecureStorage }) => SecureStorage)
  return secureStoragePromise
}

export async function initializeStudentAccess() {
  if (!isNativeClient()) return null
  const { SecureStorage, KeychainAccess } = await import('@aparajita/capacitor-secure-storage')
  secureStoragePromise = Promise.resolve(SecureStorage)
  await SecureStorage.setSynchronize(false)
  await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly)
  const storage = SecureStorage
  return nativeSessionStore.initialize(storage, window.localStorage)
}

async function loadCatalog() {
  try {
    const response = await fetch(apiUrl('/api/catalog'), { cache: 'no-store' })
    if (!response.ok) throw new Error('Catalog API is unavailable')
    const catalog = await response.json()
    if (!Array.isArray(catalog.grades)) throw new Error('Catalog format is invalid')
    delete catalog.digitalCourses
    return { catalog, source: 'live' }
  } catch {
    const catalog = { ...fallbackCatalog }
    delete catalog.digitalCourses
    return { catalog, source: 'demo' }
  }
}

function flattenCourses(catalog) {
  return catalog.grades.flatMap((grade) => grade.subjects.map((subject, index) => ({
    id: `${grade.id}-${subject.id}`,
    gradeId: grade.id,
    gradeTitle: grade.title,
    subjectId: subject.id,
    title: subject.name,
    category: subject.name,
    level: grade.stage,
    teacher: subject.teachers.join('، ') || 'سيعلن لاحقاً',
    teachers: subject.teachers,
    price: subject.price,
    currency: subject.currency,
    color: subjectColors[index % subjectColors.length],
  })))
}

function readEnrollments() {
  try {
    const storedEnrollments = JSON.parse(window.localStorage.getItem(enrollmentStorageKey) ?? '[]')
    return Array.isArray(storedEnrollments) ? storedEnrollments.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

function readStoredIds(storageKey) {
  try {
    const ids = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]')
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

function createTeacherId(name) {
  return [...name].map((character) => character.codePointAt(0).toString(16)).join('-')
}

export async function getCatalogSnapshot() { return loadCatalog() }

function readStudentAccessSession() {
  if (!isNativeClient()) {
    try {
      window.localStorage.removeItem(studentAccessSessionKey)
    } catch {
      return browserSessionActive ? { token: '' } : null
    }
    return browserSessionActive ? { token: '' } : null
  }
  return nativeSessionStore.get()
}

export async function clearStudentAccess() {
  browserSessionActive = false
  if (isNativeClient()) {
    const storage = await getSecureStorage()
    await nativeSessionStore.clear(storage)
    return
  }
  try {
    window.localStorage.removeItem(studentAccessSessionKey)
  } catch {
    return
  }
}

export function hasStudentAccess() {
  return Boolean(readStudentAccessSession() || browserSessionActive)
}

function studentRequestHeaders({ csrf = false } = {}) {
  const session = readStudentAccessSession()
  return {
    ...(session ? { authorization: `Bearer ${session.token}` } : {}),
    ...(csrf && !session ? { 'X-Elite-CSRF': '1' } : {}),
  }
}

async function logoutStudentWithBearer() {
  const session = readStudentAccessSession()
  if (!session) return
  const response = await fetch(apiUrl('/api/logout'), {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` },
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'تعذر إنهاء الجلسة.')
  await clearStudentAccess()
}

export async function logoutStudent() {
  if (isNativeClient()) return logoutStudentWithBearer()
  const response = await fetch(apiUrl('/api/logout'), {
    method: 'POST',
    headers: { 'X-Elite-CSRF': '1' },
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'تعذر إنهاء الجلسة.')
  await clearStudentAccess()
}

async function verifyAccessCodeWithBearer(email, code) {
  const response = await fetch(apiUrl('/api/verify-code'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: String(email).trim().toLowerCase(), code: String(code).trim() }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'رمز الوصول غير صالح.')
  if (!result.sessionToken || !Number.isFinite(result.expiresAt)) throw new Error('لم ينشئ الخادم جلسة دخول صالحة.')
  const storage = await getSecureStorage()
  try {
    await nativeSessionStore.set(storage, { token: result.sessionToken, expiresAt: result.expiresAt })
  } catch (error) {
    const revokeResponse = await fetch(apiUrl('/api/logout'), {
      method: 'POST',
      headers: { authorization: `Bearer ${result.sessionToken}` },
    }).catch((logoutError) => {
      console.error('Could not revoke a native session after secure storage failed:', logoutError)
      return null
    })
    if (revokeResponse && !revokeResponse.ok) {
      console.error('The server did not revoke a native session after secure storage failed:', revokeResponse.status)
    }
    throw error
  }
  return result
}

export async function verifyAccessCode(email, code) {
  if (isNativeClient()) return verifyAccessCodeWithBearer(email, code)
  const response = await fetch(apiUrl('/api/verify-code'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: String(email).trim().toLowerCase(), code: String(code).trim() }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'رمز الوصول غير صالح.')
  if (!Number.isFinite(result.expiresAt) || result.sessionToken) throw new Error('تعذر إنشاء جلسة آمنة للمتصفح.')
  browserSessionActive = true
  return result
}

async function verifyStudentSessionWithBearer() {
  const session = readStudentAccessSession()
  if (!session) return null
  let response
  try {
    response = await fetch(apiUrl('/api/session'), {
      cache: 'no-store',
      headers: { authorization: `Bearer ${session.token}` },
    })
  } catch {
    throw new Error('تعذر التحقق من جلسة الطالب. تحقق من الاتصال ثم أعد المحاولة.')
  }
  if (response.status === 401 || response.status === 403) {
    await clearStudentAccess()
    return null
  }
  if (!response.ok) throw new Error('تعذر التحقق من جلسة الطالب.')
  return response.json()
}

export async function verifyStudentSession() {
  if (isNativeClient()) return verifyStudentSessionWithBearer()
  try {
    const response = await fetch(apiUrl('/api/session'), {
      cache: 'no-store',
      headers: studentRequestHeaders(),
    })
    if (response.status === 401 || response.status === 403) {
      await clearStudentAccess()
      return null
    }
    if (!response.ok) throw new Error('تعذر التحقق من جلسة الطالب.')
    const student = await response.json()
    browserSessionActive = true
    return student
  } catch {
    throw new Error('تعذر التحقق من جلسة الطالب. تحقق من الاتصال ثم أعد المحاولة.')
  }
}

export async function getNews() {
  const session = readStudentAccessSession()
  try {
    const response = await fetch(apiUrl('/api/news'), {
      cache: 'no-store',
      headers: session ? { authorization: `Bearer ${session.token}` } : {},
    })
    if (!response.ok) throw new Error('تعذر تحميل الأخبار.')
    const result = await response.json()
    return Array.isArray(result.items) ? result.items : []
  } catch {
    const { catalog } = await loadCatalog()
    return (Array.isArray(catalog.news) ? catalog.news : []).map((item) => ({ ...item, reactionCount: 0, isLiked: false }))
  }
}

export async function toggleNewsReaction(newsId) {
  const session = readStudentAccessSession()
  if (!session) throw new Error('سجّل الدخول للتفاعل مع الأخبار.')
  const response = await fetch(apiUrl(`/api/news/${encodeURIComponent(newsId)}/reaction`), {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` },
  })
  const result = await response.json()
  if (response.status === 401 || response.status === 403) await clearStudentAccess()
  if (!response.ok) throw new Error(result.error ?? 'تعذر حفظ التفاعل.')
  return result
}

async function studentApi(path, options = {}) {
  const session = readStudentAccessSession()
  if (!session) throw new Error('سجّل الدخول للوصول إلى مساحة الطالب.')
  const response = await fetch(apiUrl(path), {
    cache: 'no-store',
    ...options,
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const result = await response.json()
  if (response.status === 401 || response.status === 403) await clearStudentAccess()
  if (!response.ok) throw new Error(result.error ?? 'تعذر إتمام العملية.')
  return result
}

export async function getCommunityPosts(cursor = null, query = '') {
  const params = new URLSearchParams()
  if (cursor !== null) params.set('cursor', String(cursor))
  if (query) params.set('q', query)
  const queryString = params.toString()
  const suffix = queryString ? `?${queryString}` : ''
  return studentApi(`/api/community/posts${suffix}`)
}

export async function getMyCommunityPosts() {
  return studentApi('/api/community/mine')
}

export async function createCommunityPost(text) {
  return studentApi('/api/community/posts', { method: 'POST', body: JSON.stringify({ text }) })
}

export async function deleteCommunityPost(postId) {
  return studentApi(`/api/community/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' })
}

export async function toggleCommunityReaction(postId) {
  return studentApi(`/api/community/posts/${encodeURIComponent(postId)}/reaction`, { method: 'POST' })
}

export async function addCommunityComment(postId, text) {
  return studentApi(`/api/community/posts/${encodeURIComponent(postId)}/comments`, { method: 'POST', body: JSON.stringify({ text }) })
}

export async function toggleCommunityBookmark(postId) {
  return studentApi(`/api/community/posts/${encodeURIComponent(postId)}/bookmark`, { method: 'POST' })
}

export async function reportCommunityPost(postId, reason) {
  return studentApi(`/api/community/posts/${encodeURIComponent(postId)}/report`, { method: 'POST', body: JSON.stringify({ reason }) })
}

export async function getSavedCommunityPosts() {
  return studentApi('/api/community/saved')
}

export async function getAnnouncements() {
  return studentApi('/api/announcements')
}

export async function getNotifications() {
  return studentApi('/api/notifications')
}

export async function markNotificationRead(notificationId) {
  return studentApi(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST' })
}

export async function getMyMarks() {
  return studentApi('/api/marks')
}

export async function getStudentProfile() {
  const session = readStudentAccessSession()
  if (!session) throw new Error('سجّل الدخول لعرض ملفك الشخصي.')
  const response = await fetch(apiUrl('/api/profile'), {
    cache: 'no-store',
    headers: { authorization: `Bearer ${session.token}` },
  })
  const result = await response.json()
  if (response.status === 401 || response.status === 403) await clearStudentAccess()
  if (!response.ok) throw new Error(result.error ?? 'تعذر تحميل الملف الشخصي.')
  return result
}

export async function saveStudentProfile(profile) {
  const session = readStudentAccessSession()
  if (!session) throw new Error('انتهت الجلسة. سجّل الدخول مجدداً.')
  const response = await fetch(apiUrl('/api/profile'), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ photoDataUrl: profile.photoDataUrl ?? '' }),
  })
  const result = await response.json()
  if (response.status === 401 || response.status === 403) await clearStudentAccess()
  if (!response.ok) throw new Error(result.error ?? 'تعذر حفظ الملف الشخصي.')
  return result
}

export async function getGrades() {
  const { catalog } = await loadCatalog()
  return catalog.grades
}

export async function getGradeById(id) {
  const { catalog } = await loadCatalog()
  return catalog.grades.find((grade) => grade.id === Number(id)) ?? null
}

export async function getCourses() {
  const { catalog } = await loadCatalog()
  return flattenCourses(catalog)
}

export async function getCourseById(id) {
  const courses = await getCourses()
  return courses.find((course) => course.id === id) ?? null
}

export async function getTeachers() {
  const { catalog } = await loadCatalog()
  const teacherSubjects = new Map()
  for (const grade of catalog.grades) {
    for (const subject of grade.subjects) {
      for (const name of subject.teachers) {
        const subjects = teacherSubjects.get(name) ?? new Set()
        subjects.add(subject.name)
        teacherSubjects.set(name, subjects)
      }
    }
  }
  return [...teacherSubjects].map(([name, subjects], index) => ({
    id: createTeacherId(name),
    name: name.replace(/^أ\.\s*/, ''),
    subject: [...subjects].join('، '),
    experience: 'مدرس متخصص',
    initials: name.replace(/^أ\.\s*/, '').slice(0, 2),
    color: subjectColors[index % subjectColors.length],
  }))
}

export async function getTeacherById(id) {
  const teachers = await getTeachers()
  return teachers.find((teacher) => teacher.id === id) ?? null
}

export async function submitRegistrationRequest(request) {
  const response = await fetch(apiUrl('/api/requests'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'تعذر إرسال الطلب.')
  return result
}

export async function getRegistrationRequest(id) {
  const session = readStudentAccessSession()
  if (!session) throw new Error('سجّل الدخول لمتابعة حالة الطلب.')
  const response = await fetch(apiUrl(`/api/requests/${encodeURIComponent(id)}`), {
    cache: 'no-store',
    headers: { authorization: `Bearer ${session.token}` },
  })
  if (response.status === 404) return null
  if (response.status === 401 || response.status === 403) await clearStudentAccess()
  if (!response.ok) throw new Error('تعذر قراءة حالة الطلب.')
  return response.json()
}

export async function getMyRegistrationRequests() {
  const session = readStudentAccessSession()
  if (!session) return []
  const response = await fetch(apiUrl('/api/my-requests'), {
    cache: 'no-store',
    headers: { authorization: `Bearer ${session.token}` },
  })
  if (response.status === 401 || response.status === 403) {
    await clearStudentAccess()
    return []
  }
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'تعذر قراءة طلباتك.')
  return Array.isArray(result.items) ? result.items : []
}

export async function toggleCourseFavorite(courseId) {
  if (!(await getCourseById(courseId))) throw new Error('هذه المادة غير متاحة.')
  const favorites = new Set(readStoredIds(favoriteStorageKey))
  if (favorites.has(courseId)) favorites.delete(courseId)
  else favorites.add(courseId)
  window.localStorage.setItem(favoriteStorageKey, JSON.stringify([...favorites]))
  return favorites.has(courseId)
}

export async function isCourseFavorite(courseId) {
  return readStoredIds(favoriteStorageKey).includes(courseId)
}

export async function getFavoriteCourses() {
  const favorites = new Set(readStoredIds(favoriteStorageKey))
  return (await getCourses()).filter((course) => favorites.has(course.id))
}

export async function getEnrolledCourses() {
  const enrollmentIds = new Set(readEnrollments())
  return (await getCourses()).filter((course) => enrollmentIds.has(course.id))
}
export async function isCourseEnrolled(courseId) { return readEnrollments().includes(courseId) }
export async function enrollInCourse(courseId) {
  if (!(await getCourseById(courseId))) throw new Error('هذه المادة غير متاحة.')
  const enrollments = new Set(readEnrollments())
  enrollments.add(courseId)
  try {
    window.localStorage.setItem(enrollmentStorageKey, JSON.stringify([...enrollments]))
  } catch {
    throw new Error('تعذر حفظ التسجيل على هذا الجهاز.')
  }
  return [...enrollments]
}