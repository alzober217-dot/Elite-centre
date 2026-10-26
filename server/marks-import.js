import { createHash, randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'

export const maximumMarksFileBytes = 5 * 1024 * 1024
export const maximumMarksRows = 5000
export const marksHeaders = ['student_id', 'subject', 'exam', 'term', 'score', 'max_score', 'date']

function textValue(value) {
  if (value && typeof value === 'object' && 'text' in value) return String(value.text ?? '').trim()
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function dateValue(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 2_958_465) {
    const date = new Date(Math.round((value - 25569) * 86_400_000))
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ''
  }
  const text = textValue(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ''
  const date = new Date(`${text}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : ''
}

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export async function inspectMarksWorkbook(buffer, subscriptions) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > maximumMarksFileBytes) {
    throw new Error('حجم ملف العلامات فارغ أو يتجاوز 5 ميغابايت.')
  }
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  if (workbook.worksheets.length !== 1) throw new Error('يجب أن يحتوي الملف على ورقة عمل واحدة فقط.')
  const worksheet = workbook.worksheets[0]
  if (worksheet.rowCount < 2 || worksheet.rowCount > maximumMarksRows + 1 || worksheet.columnCount !== marksHeaders.length) {
    throw new Error(`يجب أن يحتوي الملف على صف عناوين و1 إلى ${maximumMarksRows} صفوف بيانات بالأعمدة السبعة المحددة.`)
  }
  const headerRow = worksheet.getRow(1)
  const headers = marksHeaders.map((_, index) => textValue(headerRow.getCell(index + 1).value))
  if (headers.some((header, index) => header !== marksHeaders[index])) {
    throw new Error(`ترتيب عناوين الأعمدة يجب أن يكون: ${marksHeaders.join(', ')}`)
  }

  const subscriptionsById = new Map()
  for (const subscription of subscriptions) {
    if (subscription.active === false) continue
    if (typeof subscription.id === 'string' && subscription.id) {
      const matches = subscriptionsById.get(subscription.id) ?? []
      matches.push(subscription)
      subscriptionsById.set(subscription.id, matches)
    }
  }
  const seenKeys = new Set()
  const rows = []
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
    if (row.values.slice(1).every((value) => value === null || value === undefined || value === '')) continue
    for (let column = 1; column <= marksHeaders.length; column += 1) {
      if (row.getCell(column).value && typeof row.getCell(column).value === 'object' && 'formula' in row.getCell(column).value) {
        throw new Error(`الصيغ غير مسموحة في الملف (الصف ${rowNumber}).`)
      }
    }
    const studentId = textValue(row.getCell(1).value)
    const subject = textValue(row.getCell(2).value)
    const exam = textValue(row.getCell(3).value)
    const term = textValue(row.getCell(4).value)
    const score = numericValue(row.getCell(5).value)
    const maxScore = numericValue(row.getCell(6).value)
    const date = dateValue(row.getCell(7).value)
    const issues = []
    const students = subscriptionsById.get(studentId) ?? []
    if (!studentId) issues.push('معرّف الطالب مفقود')
    else if (students.length === 0) issues.push('معرّف الطالب غير معروف')
    else if (students.length > 1) issues.push('معرّف الطالب ملتبس')
    if (!subject || subject.length > 120) issues.push('اسم المادة مطلوب وبحد أقصى 120 حرفاً')
    if (!exam || exam.length > 120) issues.push('اسم الاختبار مطلوب وبحد أقصى 120 حرفاً')
    if (!term || term.length > 120) issues.push('الفصل مطلوب وبحد أقصى 120 حرفاً')
    if (score === null || score < 0 || score > 100000) issues.push('العلامة يجب أن تكون رقماً بين 0 و100000')
    if (maxScore === null || maxScore <= 0 || maxScore > 100000) issues.push('العلامة العظمى يجب أن تكون رقماً بين 0 و100000')
    if (score !== null && maxScore !== null && score > maxScore) issues.push('العلامة تتجاوز العلامة العظمى')
    if (!date) issues.push('التاريخ يجب أن يكون بصيغة YYYY-MM-DD')
    const key = `${studentId}\u0000${subject}\u0000${exam}\u0000${term}`
    if (seenKeys.has(key)) issues.push('صف مكرر ضمن الملف')
    seenKeys.add(key)
    rows.push({
      rowNumber,
      studentId,
      subject,
      exam,
      term,
      score,
      maxScore,
      date,
      studentName: students.length === 1 ? String(students[0].studentName ?? 'طالب') : '',
      issues,
      valid: issues.length === 0,
      key,
    })
  }
  if (!rows.length) throw new Error('لا توجد صفوف علامات في الملف.')
  const blockingCount = rows.filter((row) => !row.valid).length
  return {
    previewId: randomUUID(),
    fileHash: createHash('sha256').update(buffer).digest('hex'),
    rowCount: rows.length,
    validCount: rows.length - blockingCount,
    blockingCount,
    rows: rows.map(({ key: _key, ...row }) => row),
    records: rows,
  }
}
