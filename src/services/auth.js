export async function signIn({ email, password }) {
  if (!email || !password) throw new Error('البريد الإلكتروني وكلمة المرور مطلوبان.')
  throw new Error('خدمة تسجيل الدخول غير مهيأة بعد.')
}

export async function signOut() { return undefined }