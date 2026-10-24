const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const UNIT_SECONDS = { m: 60, h: 3600, d: 86400 }

class WhenError extends Error {}

// "18:00", "9am", "9:30pm" → { hour, minute }, or null when the text is not a clock time.
function parseClock(text) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text)
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  const meridiem = match[3]
  if (!meridiem && match[2] === undefined) return null
  if (meridiem) {
    if (hour < 1 || hour > 12) throw new WhenError(`"${text}" is not a valid time`)
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0)
  }
  if (hour > 23 || minute > 59) throw new WhenError(`"${text}" is not a valid time`)
  return { hour, minute }
}

function at(base, { hour, minute }) {
  const date = new Date(base)
  date.setHours(hour, minute, 0, 0)
  return date
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

// Returns unix seconds for a "when" text, in this Mac's local time zone. `now` is a Date.
function parseWhen(input, now = new Date()) {
  const text = String(input).trim().toLowerCase().replace(/\s+/g, ' ')
  const nowSeconds = Math.floor(now.getTime() / 1000)

  const relative = /^\+(\d+)\s*([mhd])$/.exec(text)
  if (relative) {
    const amount = Number(relative[1])
    if (amount === 0) throw new WhenError('use a delay above 0, or leave the time out to run now')
    return nowSeconds + amount * UNIT_SECONDS[relative[2]]
  }

  const clock = parseClock(text)
  if (clock) {
    const today = at(now, clock)
    return Math.floor((today > now ? today : addDays(today, 1)).getTime() / 1000)
  }

  const words = text.split(' ')
  const tail = words.slice(1).join(' ')
  const tailClock = tail ? parseClock(tail) : null

  if (words[0] === 'today' || words[0] === 'tomorrow') {
    if (!tailClock) throw new WhenError(`add a time, e.g. "${words[0]} 9am"`)
    const date = at(addDays(now, words[0] === 'tomorrow' ? 1 : 0), tailClock)
    return checkFuture(date, now, input)
  }

  const dayIndex = DAYS.findIndex((name) => name === words[0] || name.slice(0, 3) === words[0])
  if (dayIndex !== -1) {
    if (!tailClock) throw new WhenError(`add a time, e.g. "${words[0]} 10:00"`)
    let ahead = (dayIndex - now.getDay() + 7) % 7
    let date = at(addDays(now, ahead), tailClock)
    if (date <= now) date = addDays(date, 7)
    return Math.floor(date.getTime() / 1000)
  }

  const dated = /^(\d{1,2}) ([a-z]{3})[a-z]*(?: (\d{4}))? (.+)$/.exec(text)
  if (dated) {
    const month = MONTHS.indexOf(dated[2])
    const time = parseClock(dated[4])
    if (month === -1 || !time) throw new WhenError(`could not read "${input}"`)
    const year = dated[3] ? Number(dated[3]) : now.getFullYear()
    const date = new Date(year, month, Number(dated[1]), time.hour, time.minute, 0, 0)
    if (date.getMonth() !== month) throw new WhenError(`"${input}" is not a real date`)
    return checkFuture(date, now, input)
  }

  throw new WhenError(`could not read "${input}". Try +30m, +2h, 18:00, 9am, "tomorrow 9am", "mon 10:00", "28 oct 18:00"`)
}

// "30m", "2h", "1d" → seconds. Shorter than one runner tick is refused: it could never run that often.
function parseEvery(input, minimumSeconds) {
  const match = /^(\d+)\s*([mhd])$/.exec(String(input).trim().toLowerCase())
  if (!match) throw new WhenError(`could not read "${input}" as an interval. Try 30m, 2h, 1d`)
  const value = Number(match[1]) * UNIT_SECONDS[match[2]]
  if (value < minimumSeconds) throw new WhenError(`the runner ticks every ${minimumSeconds / 60} minutes, so use ${minimumSeconds / 60}m or more`)
  return value
}

function checkFuture(date, now, input) {
  if (date <= now) throw new WhenError(`"${input}" has already passed`)
  return Math.floor(date.getTime() / 1000)
}

function describe(unixSeconds, now = new Date()) {
  const date = new Date(unixSeconds * 1000)
  const label = date.toLocaleString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  })
  const diff = unixSeconds - Math.floor(now.getTime() / 1000)
  return `${label} (${diff >= 0 ? 'in ' + span(diff) : 'late by ' + span(-diff)})`
}

function span(totalSeconds) {
  const minutes = Math.round(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export { parseWhen, parseEvery, describe, span, WhenError }
