'use strict';

// ICS（iCalendar / RFC 5545）解析与重复展开。
//
// 职责：
//   1. 读文件并按 UTF-8(BOM) -> UTF-8 -> GBK 的顺序解码
//   2. 注册时区（文件内 VTIMEZONE 优先，缺失时用 @touch4it/ical-timezones 兜底）
//   3. 展开 RRULE，处理 EXDATE 停课与 RECURRENCE-ID 调课覆盖
//   4. 归一化为组件渲染用的本地时间事件对象

const fs = require('node:fs');
const ICAL = require('ical.js');
const { getVtimezoneComponent, timezoneExists } = require('@touch4it/ical-timezones');

// 展开上限，防止异常 RRULE 造成无限循环
const MAX_OCCURRENCES = 5000;
// 缺少 DTEND/DURATION 且非全天事件时的默认时长（分钟）
const DEFAULT_TIMED_MINUTES = 60;
// DESCRIPTION 中的节次写法，例如「第1 - 2节」「第9节」
const PERIOD_LABEL = /^第\s*(\d+)\s*(?:[-–—~至]\s*(\d+))?\s*节/;
// 教室特征：含数字或场地类关键词（A101、综合楼214、体育馆）
const ROOM_HINT = /[\d]|楼|场|馆|区|室|房|教室|机房|实验室|中心/;
// 教师姓名特征：2-4 个汉字（可带间隔号），且不像教室
const TEACHER_NAME = /^[\u4e00-\u9fa5·]{2,4}(?:[,，、]\s*[\u4e00-\u9fa5·]{2,4})*$/;

function looksLikeRoom(text) {
  return ROOM_HINT.test(text);
}

function looksLikeTeacher(text) {
  return TEACHER_NAME.test(text) && !looksLikeRoom(text);
}

function icsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

// 本地墙上时间，形如 2026-09-24T08:00:00
function formatLocal(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

function formatDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// 返回该日期所在周的周一（按本地时间计算）
function mondayOfDateKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00`);
  const shift = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - shift);
  return formatDateKey(date);
}

// UTF-8(BOM) -> UTF-8 -> GBK 自动识别解码
function decodeIcsBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('gbk').decode(buffer), encoding: 'gbk' };
  }
}

function readIcsFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const { text, encoding } = decodeIcsBuffer(buffer);
  return { text, encoding, bytes: buffer.length };
}

function collectReferencedTzids(vcalendar) {
  const tzids = new Set();
  for (const vevent of vcalendar.getAllSubcomponents('vevent')) {
    for (const property of vevent.getAllProperties()) {
      const tzid = property.getParameter('tzid');
      if (tzid) tzids.add(String(tzid));
    }
  }
  return tzids;
}

// 注册事件用到的时间。先注册文件自带的 VTIMEZONE，再为缺失的 TZID 从离线时区数据补注册。
function registerTimezones(vcalendar) {
  const fromFile = [];
  for (const tzComponent of vcalendar.getAllSubcomponents('vtimezone')) {
    const tzid = tzComponent.getFirstPropertyValue('tzid');
    if (!tzid || ICAL.TimezoneService.has(tzid)) continue;
    try {
      ICAL.TimezoneService.register(tzComponent);
      fromFile.push(String(tzid));
    } catch {
      // 个别时区定义异常时忽略，后续按浮动时间处理
    }
  }

  const referenced = collectReferencedTzids(vcalendar);
  const unresolved = [];
  const fromFallback = [];
  for (const tzid of referenced) {
    if (ICAL.TimezoneService.has(tzid)) continue;
    if (!timezoneExists(tzid)) {
      unresolved.push(tzid);
      continue;
    }
    try {
      ICAL.TimezoneService.register(new ICAL.Component(ICAL.parse(getVtimezoneComponent(tzid))));
      fromFallback.push(tzid);
    } catch {
      unresolved.push(tzid);
    }
  }

  return { referenced: [...referenced], fromFile, fromFallback, unresolved };
}

function describeTime(icalTime) {
  const date = icalTime.toJSDate();
  return { local: formatLocal(date), utc: date.toISOString(), allDay: Boolean(icalTime.isDate) };
}

// 事件结束时间：优先 DURATION/DTEND，缺失时按全天或定时默认值补齐
function resolveEndTime(event, occurrenceStart) {
  const seconds = event.duration ? event.duration.toSeconds() : 0;
  const end = occurrenceStart.clone();
  const addSeconds = seconds > 0 ? seconds : occurrenceStart.isDate ? 86400 : DEFAULT_TIMED_MINUTES * 60;
  end.addDuration(ICAL.Duration.fromSeconds(addSeconds));
  return end;
}

// 从 DESCRIPTION（多为「第1 - 2节 / 教室 / 教师」三行）与 LOCATION（「A101 张明」）提取信息。
// 注意：部分导出里教室为空、LOCATION 只剩教师名，因此不能盲取 LOCATION 的第一个词当教室。
function parseClassMeta(description, location) {
  const lines = String(description || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let period = null;
  let room = null;
  let teacher = null;

  for (const line of lines) {
    const matched = PERIOD_LABEL.exec(line);
    if (matched && !period) {
      period = matched[2] ? `第${matched[1]}-${matched[2]}节` : `第${matched[1]}节`;
      continue;
    }
    if (!room && looksLikeRoom(line)) {
      room = line;
      continue;
    }
    if (!teacher && looksLikeTeacher(line)) {
      teacher = line;
    }
  }

  const locationParts = String(location || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const part of locationParts) {
    if (!room && looksLikeRoom(part)) {
      room = part;
      continue;
    }
    if (!teacher && looksLikeTeacher(part)) {
      teacher = part;
    }
  }
  // 兜底：只有一个词且既不像教室也不像人名时，仍按教室处理
  if (!room && locationParts.length === 1 && !looksLikeTeacher(locationParts[0])) {
    room = locationParts[0];
  }

  return { period, room, teacher };
}

function buildOccurrence(event, occurrenceStart, extra = {}) {
  const occurrenceEnd = resolveEndTime(event, occurrenceStart);
  const start = describeTime(occurrenceStart);
  const end = describeTime(occurrenceEnd);
  const description = event.description || '';
  const location = event.location || '';
  const meta = parseClassMeta(description, location);

  return {
    id: `${event.uid || 'event'}@${start.local}`,
    uid: event.uid || null,
    title: event.summary || '(未命名课程)',
    location,
    description,
    room: meta.room,
    teacher: meta.teacher,
    period: meta.period,
    allDay: start.allDay,
    recurring: typeof event.isRecurring === 'function' ? event.isRecurring() : false,
    overridden: extra.overridden === true,
    start: start.local,
    end: end.local,
    startUtc: start.utc,
    endUtc: end.utc,
  };
}

function isWithinWindow(occurrence, windowStart, windowEnd) {
  const startUtc = Date.parse(occurrence.startUtc);
  if (windowStart && startUtc < windowStart.getTime()) return false;
  if (windowEnd && startUtc > windowEnd.getTime()) return false;
  return true;
}

function collectFromMaster(master, context, out) {
  const { overrides, warnings } = context;
  const exceptionByInstant = new Map(
    (overrides.get(master.uid) || []).map((exception) => [
      exception.recurrenceId.toUnixTime(),
      exception,
    ]),
  );

  if (!master.isRecurring()) {
    const occurrence = buildOccurrence(master, master.startDate);
    if (isWithinWindow(occurrence, context.windowStart, context.windowEnd)) out.push(occurrence);
    return;
  }

  const iterator = master.iterator();
  let count = 0;
  let next;
  while ((next = iterator.next())) {
    if (context.windowEnd && next.toJSDate() > context.windowEnd) break;
    count += 1;
    if (count > context.maxOccurrences) {
      context.truncated = true;
      warnings.push(`「${master.summary || master.uid}」的重复次数超过上限，已截断。`);
      break;
    }

    const instant = next.toUnixTime();
    const exception = exceptionByInstant.get(instant);
    if (exception) {
      exceptionByInstant.delete(instant);
      const occurrence = buildOccurrence(exception, exception.startDate, { overridden: true });
      if (isWithinWindow(occurrence, context.windowStart, context.windowEnd)) out.push(occurrence);
      continue;
    }

    const occurrence = buildOccurrence(master, next);
    if (isWithinWindow(occurrence, context.windowStart, context.windowEnd)) out.push(occurrence);
  }

  // 未落在展开窗口内的调课事件同样保留，避免丢课
  for (const exception of exceptionByInstant.values()) {
    const occurrence = buildOccurrence(exception, exception.startDate, { overridden: true });
    if (isWithinWindow(occurrence, context.windowStart, context.windowEnd)) out.push(occurrence);
  }
}

// 同一门课同一时段的重复条目去重
function dedupeOccurrences(occurrences) {
  const seen = new Set();
  const events = [];
  let removed = 0;
  for (const occurrence of occurrences) {
    const key = `${occurrence.title}|${occurrence.start}|${occurrence.end}`;
    if (seen.has(key)) {
      removed += 1;
      continue;
    }
    seen.add(key);
    events.push(occurrence);
  }
  return { events, removed };
}

// 解析并展开 ICS
function expandIcs(text, options = {}) {
  const windowStart = options.windowStart ? new Date(options.windowStart) : null;
  const windowEnd = options.windowEnd ? new Date(options.windowEnd) : null;
  const maxOccurrences = options.maxOccurrences || MAX_OCCURRENCES;
  const warnings = [];

  let vcalendar;
  try {
    vcalendar = new ICAL.Component(ICAL.parse(String(text ?? '')));
  } catch (error) {
    throw icsError('ICS_PARSE_ERROR', `ICS 文件结构无法解析：${error.message}`);
  }

  const veventComponents = vcalendar.getAllSubcomponents('vevent');
  if (veventComponents.length === 0) {
    throw icsError('ICS_NO_EVENT', '这个 ICS 文件里没有任何课程事件（VEVENT）。');
  }

  const timezones = registerTimezones(vcalendar);

  const overrides = new Map();
  const masters = [];
  for (const component of veventComponents) {
    try {
      const event = new ICAL.Event(component);
      if (event.isRecurrenceException()) {
        const list = overrides.get(event.uid) || [];
        list.push(event);
        overrides.set(event.uid, list);
      } else {
        masters.push(event);
      }
    } catch (error) {
      warnings.push(`跳过一条无法解析的事件：${error.message}`);
    }
  }

  const context = { overrides, warnings, windowStart, windowEnd, maxOccurrences, truncated: false };
  const collected = [];
  for (const master of masters) {
    try {
      collectFromMaster(master, context, collected);
    } catch (error) {
      warnings.push(`展开「${master.summary || master.uid}」失败：${error.message}`);
    }
  }

  const { events, removed } = dedupeOccurrences(collected);
  events.sort((a, b) =>
    a.start === b.start ? a.title.localeCompare(b.title, 'zh-Hans-CN') : a.start < b.start ? -1 : 1,
  );

  const firstStart = events.length ? events[0].start : null;
  const lastStart = events.length ? events[events.length - 1].start : null;
  const termStartMonday = firstStart ? mondayOfDateKey(firstStart.slice(0, 10)) : null;
  const totalWeeks =
    termStartMonday && lastStart
      ? Math.floor(
          (new Date(`${mondayOfDateKey(lastStart.slice(0, 10))}T00:00:00`) -
            new Date(`${termStartMonday}T00:00:00`)) /
            604800000,
        ) + 1
      : null;

  return {
    events,
    warnings,
    meta: {
      sourceEventCount: veventComponents.length,
      masterCount: masters.length,
      exceptionCount: [...overrides.values()].reduce((sum, list) => sum + list.length, 0),
      occurrenceCount: events.length,
      duplicatesRemoved: removed,
      allDayCount: events.filter((event) => event.allDay).length,
      firstStart,
      lastStart,
      termStartMonday,
      totalWeeks,
      courses: [...new Set(events.map((event) => event.title))],
      timezones,
      truncated: context.truncated,
    },
  };
}

module.exports = {
  MAX_OCCURRENCES,
  decodeIcsBuffer,
  readIcsFile,
  expandIcs,
  mondayOfDateKey,
  parseClassMeta,
  formatLocal,
  looksLikeRoom,
  looksLikeTeacher,
};
