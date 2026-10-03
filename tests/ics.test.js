'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  expandIcs,
  decodeIcsBuffer,
  parseClassMeta,
  parseWeeks,
  deriveDisplayName,
} = require('../src/main/ics');
const {
  weekNumberFor,
  weekStartOf,
  formatWeekLabel,
  displayDayFor,
  summarize,
  formatCountdown,
} = require('../src/main/schedule');

const VTIMEZONE_SHANGHAI = [
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Shanghai',
  'BEGIN:STANDARD',
  'TZNAME:CST',
  'TZOFFSETFROM:+0800',
  'TZOFFSETTO:+0800',
  'DTSTART:19700101T000000',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

function buildCalendar(vevents, { withTimezone = true } = {}) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//class-calendar//test//CN',
    ...(withTimezone ? [VTIMEZONE_SHANGHAI] : []),
    ...vevents,
    'END:VCALENDAR',
  ].join('\r\n');
}

function vevent(lines) {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

const BASIC_EVENT = vevent([
  'UID:course-1',
  'SUMMARY:高等数学（1）',
  'DTSTART;TZID=Asia/Shanghai:20260914T100000',
  'DTEND;TZID=Asia/Shanghai:20260914T114500',
  'RRULE:FREQ=WEEKLY;UNTIL=20260928T020000Z;INTERVAL=1',
  'LOCATION:A101 张明',
  'DESCRIPTION:第3 - 4节\\nA101\\n张明',
]);

test('解析基本事件并展开每周重复', () => {
  const { events, meta } = expandIcs(buildCalendar([BASIC_EVENT]));
  assert.equal(events.length, 3, '应展开为 9/14、9/21、9/28 三次');
  assert.deepEqual(
    events.map((event) => event.start),
    ['2026-09-14T10:00:00', '2026-09-21T10:00:00', '2026-09-28T10:00:00'],
  );
  assert.equal(events[0].title, '高等数学（1）');
  assert.equal(events[0].room, 'A101');
  assert.equal(events[0].teacher, '张明');
  assert.equal(events[0].period, '第3-4节');
  assert.equal(events[0].end, '2026-09-14T11:45:00');
  assert.equal(events[0].startUtc, '2026-09-14T02:00:00.000Z', 'TZID 应按 +0800 换算成 UTC');
  assert.equal(meta.occurrenceCount, 3);
  assert.equal(meta.termStartMonday, '2026-09-14');
});

test('UNTIL 写成 UTC 时不会多算一次课', () => {
  // UNTIL=20260923T160000Z 即北京时间 9/24 00:00，因此只应包含 9/17 这一次
  const event = vevent([
    'UID:course-until',
    'SUMMARY:线性代数',
    'DTSTART;TZID=Asia/Shanghai:20260917T100000',
    'DTEND;TZID=Asia/Shanghai:20260917T114500',
    'RRULE:FREQ=WEEKLY;UNTIL=20260923T160000Z;INTERVAL=1',
  ]);
  const { events } = expandIcs(buildCalendar([event]));
  assert.deepEqual(
    events.map((item) => item.start),
    ['2026-09-17T10:00:00'],
  );
});

test('INTERVAL=2 表示隔周上课', () => {
  const event = vevent([
    'UID:course-biweekly',
    'SUMMARY:大学物理',
    'DTSTART;TZID=Asia/Shanghai:20260914T183000',
    'DTEND;TZID=Asia/Shanghai:20260914T221500',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3',
  ]);
  const { events } = expandIcs(buildCalendar([event]));
  assert.deepEqual(
    events.map((item) => item.start.slice(0, 10)),
    ['2026-09-14', '2026-09-28', '2026-10-12'],
  );
});

test('EXDATE 去掉停课的那一次', () => {
  const event = vevent([
    'UID:course-exdate',
    'SUMMARY:体育（羽毛球）',
    'DTSTART;TZID=Asia/Shanghai:20260914T134500',
    'DTEND;TZID=Asia/Shanghai:20260914T153000',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'EXDATE;TZID=Asia/Shanghai:20260921T134500',
  ]);
  const { events } = expandIcs(buildCalendar([event]));
  assert.deepEqual(
    events.map((item) => item.start.slice(0, 10)),
    ['2026-09-14', '2026-09-28'],
  );
});

test('RECURRENCE-ID 调课覆盖原实例', () => {
  const master = vevent([
    'UID:course-move',
    'SUMMARY:程序设计基础',
    'DTSTART;TZID=Asia/Shanghai:20260914T134500',
    'DTEND;TZID=Asia/Shanghai:20260914T153000',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'LOCATION:B203',
  ]);
  const exception = vevent([
    'UID:course-move',
    'RECURRENCE-ID;TZID=Asia/Shanghai:20260921T134500',
    'SUMMARY:程序设计基础（调课）',
    'DTSTART;TZID=Asia/Shanghai:20260922T080000',
    'DTEND;TZID=Asia/Shanghai:20260922T094500',
    'LOCATION:C301',
  ]);
  const { events, meta } = expandIcs(buildCalendar([master, exception]));
  assert.equal(events.length, 3);
  assert.equal(meta.exceptionCount, 1);
  const moved = events.find((item) => item.overridden);
  assert.ok(moved, '应产出被覆盖的那次课');
  assert.equal(moved.start, '2026-09-22T08:00:00');
  assert.equal(moved.room, 'C301');
  assert.equal(
    events.some((item) => item.start === '2026-09-21T13:45:00'),
    false,
    '原时间点应被替换掉',
  );
});

test('全天事件与缺少 DTEND 时的默认时长', () => {
  const allDay = vevent([
    'UID:all-day',
    'SUMMARY:校运会',
    'DTSTART;VALUE=DATE:20260919',
    'DTEND;VALUE=DATE:20260920',
  ]);
  const noEnd = vevent([
    'UID:no-end',
    'SUMMARY:讲座',
    'DTSTART;TZID=Asia/Shanghai:20260919T140000',
  ]);
  const { events } = expandIcs(buildCalendar([allDay, noEnd]));
  const holiday = events.find((item) => item.uid === 'all-day');
  const lecture = events.find((item) => item.uid === 'no-end');
  assert.equal(holiday.allDay, true);
  assert.equal(holiday.start.slice(0, 10), '2026-09-19');
  assert.equal(lecture.end, '2026-09-19T15:00:00', '缺少 DTEND 时应默认 1 小时');
});

test('DURATION 生效', () => {
  const event = vevent([
    'UID:with-duration',
    'SUMMARY:实验课',
    'DTSTART;TZID=Asia/Shanghai:20260915T140000',
    'DURATION:PT3H',
  ]);
  const { events } = expandIcs(buildCalendar([event]));
  assert.equal(events[0].end, '2026-09-15T17:00:00');
});

test('重复冗余条目会被去重', () => {
  const { events, meta } = expandIcs(buildCalendar([BASIC_EVENT, BASIC_EVENT]));
  assert.equal(events.length, 3);
  assert.equal(meta.duplicatesRemoved, 3);
});

test('窗口过滤只保留范围内的课', () => {
  const { events } = expandIcs(buildCalendar([BASIC_EVENT]), {
    windowStart: new Date('2026-09-21T00:00:00+08:00'),
    windowEnd: new Date('2026-09-27T23:59:59+08:00'),
  });
  assert.deepEqual(
    events.map((item) => item.start.slice(0, 10)),
    ['2026-09-21'],
  );
});

test('缺失 VTIMEZONE 时用离线时区数据兜底', () => {
  const event = vevent([
    'UID:berlin',
    'SUMMARY:海外交换课程',
    'DTSTART;TZID=Europe/Berlin:20260914T100000',
    'DTEND;TZID=Europe/Berlin:20260914T114500',
  ]);
  const { events, meta } = expandIcs(buildCalendar([event], { withTimezone: false }));
  assert.equal(events[0].startUtc, '2026-09-14T08:00:00.000Z', '夏令时 +0200');
  assert.ok(meta.timezones.fromFallback.includes('Europe/Berlin'));
});

test('折行与转义字符还原', () => {
  const text = buildCalendar([
    vevent([
      'UID:folded',
      'SUMMARY:很长的课程名称前半段\r\n 后半段',
      'DTSTART;TZID=Asia/Shanghai:20260914T080000',
      'DTEND;TZID=Asia/Shanghai:20260914T094500',
      'DESCRIPTION:第1 - 2节\\nA100\\n张三、李四',
    ]),
  ]);
  const { events } = expandIcs(text);
  assert.equal(events[0].title, '很长的课程名称前半段后半段');
  assert.equal(events[0].teacher, '张三、李四');
});

test('没有 VEVENT 或结构损坏时报错', () => {
  assert.throws(
    () => expandIcs('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'),
    /没有任何课程事件/,
  );
  assert.throws(() => expandIcs('这不是 ICS'), (error) => error.code === 'ICS_PARSE_ERROR');
});

test('单条事件损坏不影响其它事件', () => {
  const broken = vevent(['UID:broken', 'SUMMARY:坏事件', 'DTSTART;TZID=Asia/Shanghai:坏时间']);
  const { events } = expandIcs(buildCalendar([broken, BASIC_EVENT]));
  assert.equal(events.length, 3, '正常事件仍然应该解析出来');
  assert.equal(events.some((item) => item.uid === 'broken'), false, '损坏事件不应产出结果');
});

test('GBK 编码的 ICS 也能解码', () => {
  // "数学" 的 GBK 编码是 CA FD D1 A7
  const header = Buffer.from('BEGIN:VCALENDAR\r\nSUMMARY:', 'ascii');
  const gbkBytes = Buffer.concat([header, Buffer.from([0xca, 0xfd, 0xd1, 0xa7]), Buffer.from('\r\n', 'ascii')]);
  const { text, encoding } = decodeIcsBuffer(gbkBytes);
  assert.equal(encoding, 'gbk');
  assert.match(text, /SUMMARY:数学/);
});

test('周次计算、今日课程与倒计时', () => {
  const { meta, events } = expandIcs(buildCalendar([BASIC_EVENT]));
  assert.equal(meta.termStartMonday, '2026-09-14');
  assert.equal(meta.totalWeeks, 3);
  assert.equal(weekStartOf('2026-09-16'), '2026-09-14');
  assert.equal(weekNumberFor('2026-09-14', meta.termStartMonday), 1);
  assert.equal(weekNumberFor('2026-09-21', meta.termStartMonday), 2);
  assert.equal(weekNumberFor('2026-09-20', meta.termStartMonday), 1, '周日仍属于第 1 周');
  assert.equal(formatWeekLabel(0, 3), '未开学');
  assert.equal(formatWeekLabel(1, 3), '第 1 周');
  assert.equal(formatWeekLabel(9, 3), '假期');

  const summary = summarize(events, new Date('2026-09-21T09:00:00'), {
    termStartMonday: meta.termStartMonday,
    totalWeeks: meta.totalWeeks,
  });
  assert.equal(summary.weekNumber, 2);
  assert.equal(summary.weekLabel, '第 2 周');
  assert.equal(summary.today.length, 1);
  assert.equal(summary.next.title, '高等数学（1）');
  assert.equal(
    formatCountdown(new Date('2026-09-21T09:00:00'), new Date('2026-09-21T10:00:00')),
    '还有 1 小时',
  );

  const beforeTerm = summarize(events, new Date('2026-09-13T09:00:00'), {
    termStartMonday: meta.termStartMonday,
    totalWeeks: meta.totalWeeks,
  });
  assert.equal(beforeTerm.weekLabel, '未开学');
});

test('parseClassMeta 能分别识别节次、教室、教师', () => {
  assert.deepEqual(parseClassMeta('第9 - 12节\nA100\n张三', 'A100 张三'), {
    period: '第9-12节',
    room: 'A100',
    teacher: '张三',
    weeks: null,
    weeksText: null,
  });
  assert.deepEqual(parseClassMeta('', 'A101 张明'), {
    period: null,
    room: 'A101',
    teacher: '张明',
    weeks: null,
    weeksText: null,
  });
  // 教室为空的导出：LOCATION 只剩教师名，不能当成教室
  assert.deepEqual(parseClassMeta('第3 - 4节\n\n李华', ' 李华'), {
    period: '第3-4节',
    room: null,
    teacher: '李华',
    weeks: null,
    weeksText: null,
  });
  // 场地类教室没有数字，也要认出来
  assert.deepEqual(parseClassMeta('第5 - 6节\n体育馆\n赵敏', '体育馆 赵敏'), {
    period: '第5-6节',
    room: '体育馆',
    teacher: '赵敏',
    weeks: null,
    weeksText: null,
  });
});

// HITA Aura 这类导出：LOCATION 只有教室，DESCRIPTION 是「标签：值」，另有 X- 自定义字段
const HITA_STYLE_EVENT = vevent([
  'UID:math-1-li-ke-b42-1-1000-1145-3-1-0@hita-ios',
  'SUMMARY:高等数学（1）',
  'LOCATION:B42',
  'DTSTART;TZID=Asia/Shanghai:20260914T100000',
  'DTEND;TZID=Asia/Shanghai:20260914T114500',
  'DESCRIPTION:教师：李科\\n周次：第 3 周\\n学期：2026-2027秋季\\n来源：HITA Aura 当前学期课表',
  'X-HITA-CLASSROOM:B42',
  'X-HITA-TEACHER:李科',
  'X-HITA-WEEKS:3',
  'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=2;BYDAY=MO',
]);

test('标签式描述 + X- 自定义字段（HITA Aura 格式）', () => {
  const { events } = expandIcs(buildCalendar([HITA_STYLE_EVENT]));
  const [first] = events;
  assert.equal(first.room, 'B42');
  assert.equal(first.teacher, '李科');
  assert.equal(first.period, null, '这种导出没有节次信息');
  assert.deepEqual(first.weeks, [3]);
  assert.equal(first.weeksText, '第 3 周');
});

test('「周次」不会被误判成教室（回归）', () => {
  const { events } = expandIcs(buildCalendar([HITA_STYLE_EVENT]));
  for (const event of events) {
    assert.ok(!String(event.room ?? '').includes('周'), `教室不应是周次：${event.room}`);
    assert.ok(!String(event.teacher ?? '').includes('周'), `教师不应是周次：${event.teacher}`);
  }
});

test('只有标签式描述、没有 X- 字段时也能解析', () => {
  const labeledOnly = vevent([
    'UID:physics-1',
    'SUMMARY:大学物理',
    'LOCATION:A102',
    'DTSTART;TZID=Asia/Shanghai:20260915T080000',
    'DTEND;TZID=Asia/Shanghai:20260915T094000',
    'DESCRIPTION:教师：张明\\n周次：第 4-17 周\\n学期：2026秋季',
  ]);
  const { events } = expandIcs(buildCalendar([labeledOnly]));
  assert.equal(events[0].room, 'A102');
  assert.equal(events[0].teacher, '张明');
  assert.deepEqual(events[0].weeks, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
});

test('周次行存在时，LOCATION 仍能提供教室与教师', () => {
  const event = vevent([
    'UID:room-from-location',
    'SUMMARY:程序设计基础',
    'LOCATION:B203 王强',
    'DTSTART;TZID=Asia/Shanghai:20260916T140000',
    'DTEND;TZID=Asia/Shanghai:20260916T154000',
    'DESCRIPTION:周次：第 3-5 周',
  ]);
  const { events } = expandIcs(buildCalendar([event]));
  assert.equal(events[0].room, 'B203');
  assert.equal(events[0].teacher, '王强');
  assert.deepEqual(events[0].weeks, [3, 4, 5]);
});

test('parseWeeks 支持区间、列表与单周', () => {
  assert.deepEqual(parseWeeks('第 3 周'), [3]);
  assert.deepEqual(parseWeeks('第 4-8 周'), [4, 5, 6, 7, 8]);
  assert.deepEqual(parseWeeks('1,3,5'), [1, 3, 5]);
  assert.deepEqual(parseWeeks('第1-4周(单)'), [1, 2, 3, 4]);
  assert.deepEqual(parseWeeks('4\\,5\\,6'), [4, 5, 6]);
  assert.equal(parseWeeks(''), null);
});

test('deriveDisplayName 从日历名 / 文件名推断干净的名字', () => {
  assert.equal(
    deriveDisplayName('HITA Aura 课表', 'HITA-Aura-2026-20272026秋季-课表'),
    'HITA Aura',
  );
  assert.equal(deriveDisplayName(null, '日历-示例大学'), '示例大学');
  assert.equal(deriveDisplayName(null, '课表'), null);
  assert.equal(deriveDisplayName('示例大学 2026秋季', null), '示例大学');
});

test('今天没课时展示下一个有课的日子', () => {
  const { events } = expandIcs(buildCalendar([BASIC_EVENT]));
  // 2026-09-13 是周日，第一节在 9/14，应提示「明天」
  const sunday = displayDayFor(events, new Date('2026-09-13T10:00:00'));
  assert.equal(sunday.label, '明天');
  assert.equal(sunday.dateKey, '2026-09-14');
  assert.equal(sunday.isToday, false);
  assert.equal(sunday.events.length, 1);

  // 当天有课就直接展示当天
  const monday = displayDayFor(events, new Date('2026-09-21T09:00:00'));
  assert.equal(monday.label, '今天');
  assert.equal(monday.isToday, true);
  assert.equal(monday.events.length, 1);

  // 课程全部结束之后不应再返回某一天
  assert.equal(displayDayFor(events, new Date('2026-10-30T09:00:00')), null);
});
