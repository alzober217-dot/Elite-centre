const nativeSessionKey = 'access-session'
const nativeSessionPrefix = 'elite-center:student'

function isValidSession(session) {
  return Boolean(
    session &&
    typeof session.token === 'string' &&
    session.token &&
    Number.isFinite(session.expiresAt) &&
    session.expiresAt > Date.now(),
  )
}

export function createNativeSessionStore() {
  let session = null
  let initialized = false
  let initializationPromise = null

  return {
    get() {
      if (session && session.expiresAt <= Date.now()) {
        session = null
        return null
      }
      return session
    },

    initialize(storage, legacyStorage) {
      if (initialized) return session
      if (!initializationPromise) {
        initializationPromise = (async () => {
          await storage.setKeyPrefix(nativeSessionPrefix)
          const storedSession = await storage.get(nativeSessionKey)
          if (isValidSession(storedSession)) {
            session = { token: storedSession.token, expiresAt: storedSession.expiresAt }
            legacyStorage.removeItem('elite-center:student-access-session')
            initialized = true
            return session
          }
          if (storedSession != null) await storage.remove(nativeSessionKey)

          const legacyValue = legacyStorage.getItem('elite-center:student-access-session')
          if (legacyValue) {
            let legacySession
            try {
              legacySession = JSON.parse(legacyValue)
            } catch {
              legacySession = null
            }
            if (isValidSession(legacySession)) {
              session = { token: legacySession.token, expiresAt: legacySession.expiresAt }
              await storage.set(nativeSessionKey, session)
            }
            legacyStorage.removeItem('elite-center:student-access-session')
          }
          initialized = true
          return session
        })().catch((error) => {
          initializationPromise = null
          throw error
        })
      }
      return initializationPromise
    },

    async set(storage, nextSession) {
      if (!isValidSession(nextSession)) throw new Error('بيانات جلسة الطالب غير صالحة.')
      await storage.set(nativeSessionKey, nextSession)
      session = { token: nextSession.token, expiresAt: nextSession.expiresAt }
      initialized = true
    },

    async clear(storage) {
      session = null
      initialized = true
      await storage.remove(nativeSessionKey)
    },
  }
}
