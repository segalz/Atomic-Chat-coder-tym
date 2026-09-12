const RTL_REGEX =
  /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/

const LEADING_FORMAT_REGEX = /^[\s#*>\-0-9.•·"'`\[\](){}]+/

export const isRtlText = (text?: string | null): boolean => {
  if (!text) return false

  const stripped = text.replace(LEADING_FORMAT_REGEX, '')
  const firstChar = stripped.charAt(0)
  if (firstChar && RTL_REGEX.test(firstChar)) {
    return true
  }

  return RTL_REGEX.test(text)
}

export const getTextDirection = (text?: string | null): 'rtl' | 'ltr' =>
  isRtlText(text) ? 'rtl' : 'ltr'
