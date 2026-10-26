export function isValidEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) }
export function requiredMessage(value, label) { return value.trim() ? '' : `${label} مطلوب.` }