import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { test } from 'node:test'
import { inspectMarksWorkbook, maximumMarksFileBytes, marksHeaders } from '../server/marks-import.js'

const studentId = '11111111-1111-4111-8111-111111111111'
const student = { id: studentId, studentName: 'طالب اختبار', active: true }

async function workbookBuffer(rows, headers = marksHeaders) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Marks')
  sheet.addRow(headers)
  rows.forEach((row) => sheet.addRow(row))
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

const validRow = (id = studentId) => [id, 'رياضيات', 'اختبار 1', 'الفصل الأول', 90, 100, '2026-10-15']

test('previews valid XLSX rows using a stable student ID', async () => {
  const preview = await inspectMarksWorkbook(await workbookBuffer([validRow()]), [student])
  assert.equal(preview.rowCount, 1)
  assert.equal(preview.validCount, 1)
  assert.equal(preview.blockingCount, 0)
  assert.equal(preview.records[0].studentId, studentId)
  assert.equal(preview.records[0].studentName, 'طالب اختبار')
  assert.equal(preview.records[0].date, '2026-10-15')
  assert.match(preview.fileHash, /^[a-f0-9]{64}$/)
})

test('blocks missing, unknown, ambiguous, and duplicated student/subject/exam/term rows', async () => {
  const bytes = await workbookBuffer([
    validRow(''),
    validRow('99999999-9999-4999-8999-999999999999'),
    validRow(studentId),
    validRow(studentId),
  ])
  const preview = await inspectMarksWorkbook(bytes, [student, { ...student }])
  assert.equal(preview.validCount, 0)
  assert.equal(preview.blockingCount, 4)
  assert.ok(preview.records[0].issues.includes('معرّف الطالب مفقود'))
  assert.ok(preview.records[1].issues.includes('معرّف الطالب غير معروف'))
  assert.ok(preview.records[2].issues.includes('معرّف الطالب ملتبس'))
  assert.ok(preview.records[3].issues.includes('صف مكرر ضمن الملف'))
})

test('rejects formula cells rather than evaluating their cached values', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Marks')
  sheet.addRow(marksHeaders)
  sheet.addRow([studentId, 'رياضيات', 'اختبار 1', 'الفصل الأول', { formula: '45+45', result: 90 }, 100, '2026-10-15'])
  await assert.rejects(
    inspectMarksWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), [student]),
    /الصيغ غير مسموحة/,
  )
})

test('rejects malformed workbooks, wrong columns, extra sheets, and oversized uploads', async () => {
  await assert.rejects(inspectMarksWorkbook(Buffer.from('not an xlsx'), [student]))
  await assert.rejects(inspectMarksWorkbook(await workbookBuffer([validRow()], ['student_id', 'score']), [student]), /ترتيب عناوين الأعمدة/)
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Marks').addRow(marksHeaders)
  workbook.addWorksheet('Unexpected')
  await assert.rejects(inspectMarksWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), [student]), /ورقة عمل واحدة/)
  await assert.rejects(inspectMarksWorkbook(Buffer.alloc(maximumMarksFileBytes + 1), [student]), /5 ميغابايت/)
})

test('rejects invalid marks, impossible maxima, and malformed dates', async () => {
  const preview = await inspectMarksWorkbook(await workbookBuffer([
    [studentId, 'رياضيات', 'اختبار', 'الأول', 101, 100, '2026-02-30'],
  ]), [student])
  assert.equal(preview.blockingCount, 1)
  assert.ok(preview.records[0].issues.includes('العلامة تتجاوز العلامة العظمى'))
  assert.ok(preview.records[0].issues.includes('التاريخ يجب أن يكون بصيغة YYYY-MM-DD'))
})
