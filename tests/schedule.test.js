'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shiftWeek, weekViewFor } = require('../src/main/schedule');

function lesson(date, time = '10:00:00') {
  return { title: '测试课', start: `${date}T${time}`, end: `${date}T11:00:00` };
}

test('shiftWeek 按周前后偏移（含跨年）', () => {
  assert.equal(shiftWeek('2026-09-21', 1), '2026-09-28');
  assert.equal(shiftWeek('2026-09-21', -2), '2026-09-07');
  assert.equal(shiftWeek('2026-12-28', 1), '2027-01-04');
});

test('weekViewFor 取指定周的课并算出周次', () => {
  const events = [lesson('2026-09-21'), lesson('2026-09-23'), lesson('2026-09-28')];
  const term = { termStartMonday: '2026-08-31', totalWeeks: 17 };
  const now = new Date('2026-09-24T09:00:00');

  const current = weekViewFor(events, term, '2026-09-21', now);
  assert.equal(current.weekNumber, 4);
  assert.equal(current.label, '第 4 周');
  assert.equal(current.isCurrentWeek, true);
  assert.equal(current.count, 2, '只包含 9/21 与 9/23');
  assert.equal(current.weekEnd, '2026-09-27');

  const next = weekViewFor(events, term, '2026-09-28', now);
  assert.equal(next.isCurrentWeek, false);
  assert.equal(next.label, '第 5 周');
  assert.equal(next.count, 1);

  const empty = weekViewFor(events, term, '2026-10-05', now);
  assert.equal(empty.count, 0, '没有课的周返回 0');
  assert.equal(empty.isCurrentWeek, false);
});

test('weekViewFor 会给出未开学 / 假期标签', () => {
  const term = { termStartMonday: '2026-08-31', totalWeeks: 17 };
  assert.equal(weekViewFor([], term, '2026-08-24').label, '未开学');
  assert.equal(weekViewFor([], term, '2027-01-04').label, '假期');
  assert.equal(weekViewFor([], { termStartMonday: null, totalWeeks: null }, '2026-09-21').label, '');
});

