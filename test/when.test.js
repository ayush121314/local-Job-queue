import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWhen, WhenError } from '../src/when.js'

const now = new Date(2026, 9, 25, 14, 0, 0) // Sun 25 Oct 2026, 14:00 local
const local = (...parts) => Math.floor(new Date(...parts).getTime() / 1000)

test('relative delays', () => {
  assert.equal(parseWhen('+30m', now), local(2026, 9, 25, 14, 30))
  assert.equal(parseWhen('+2h', now), local(2026, 9, 25, 16, 0))
  assert.equal(parseWhen('+1d', now), local(2026, 9, 26, 14, 0))
  assert.throws(() => parseWhen('+0m', now), WhenError)
})

test('clock time: today if still ahead, else tomorrow', () => {
  assert.equal(parseWhen('18:00', now), local(2026, 9, 25, 18, 0))
  assert.equal(parseWhen('9am', now), local(2026, 9, 26, 9, 0))
  assert.equal(parseWhen('9:30pm', now), local(2026, 9, 25, 21, 30))
  assert.equal(parseWhen('14:00', now), local(2026, 9, 26, 14, 0))
  assert.equal(parseWhen('12am', now), local(2026, 9, 26, 0, 0))
  assert.equal(parseWhen('12pm', now), local(2026, 9, 26, 12, 0))
})

test('words', () => {
  assert.equal(parseWhen('tomorrow 9am', now), local(2026, 9, 26, 9, 0))
  assert.equal(parseWhen('today 6pm', now), local(2026, 9, 25, 18, 0))
  assert.throws(() => parseWhen('today 9am', now), /already passed/)
  assert.equal(parseWhen('mon 10:00', now), local(2026, 9, 26, 10, 0))
  assert.equal(parseWhen('sunday 13:00', now), local(2026, 10, 1, 13, 0))
  assert.equal(parseWhen('Sun 15:00', now), local(2026, 9, 25, 15, 0))
})

test('full dates', () => {
  assert.equal(parseWhen('28 oct 18:00', now), local(2026, 9, 28, 18, 0))
  assert.equal(parseWhen('2 november 2026 9am', now), local(2026, 10, 2, 9, 0))
  assert.throws(() => parseWhen('24 oct 10:00', now), /already passed/)
  assert.throws(() => parseWhen('31 feb 10:00', now), /not a real date/)
})

test('bad input is refused', () => {
  assert.throws(() => parseWhen('soon', now), WhenError)
  assert.throws(() => parseWhen('25:00', now), WhenError)
  assert.throws(() => parseWhen('13pm', now), WhenError)
  assert.throws(() => parseWhen('18', now), WhenError)
  assert.throws(() => parseWhen('tomorrow', now), /add a time/)
})
