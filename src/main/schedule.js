'use strict';

// 课表查询与展示相关的纯函数：周次计算、某天/某周筛选、下一节课与倒计时文案。
// 不依赖 Electron，主进程与渲染进程都可复用，也便于单元测试。

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toDateKey(input) {
  const date = input instanceof Date ? input : new Date(input);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function toLocalDate(input) {
  return input instanceof Date ? input : new Date(String(input));
}

function weekStartOf(input) {
  const date = toLocalDate(input);
  const shift = (date.getDay() + 6) % 7;
  return toDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - shift));
}

// 第几周：以 termStartMonday 为第 1 周
function weekNumberFor(input, termStartMonday) {
  if (!termStartMonday) return null;
  const target = new Date(`${weekStartOf(input)}T00:00:00`);
  const base = new Date(`${termStartMonday}T00:00:00`);
  const days = Math.round((target - base) / 86400000);
  return Math.floor(days / 7) + 1;
}

// 周次文案：开学前显示「未开学」，放假后显示「假期」
function formatWeekLabel(weekNumber, totalWeeks = null) {
  if (weekNumber === null || weekNumber === undefined) return '';
  if (weekNumber < 1) return '未开学';
  if (totalWeeks && weekNumber > totalWeeks) return '假期';
  return `第 ${weekNumber} 周`;
}

function eventsOnDate(events, dateKey) {
  return events.filter((event) => event.start.slice(0, 10) === dateKey);
}

function eventsInWeek(events, weekStartKey) {
  const start = new Date(`${weekStartKey}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return events.filter((event) => {
    const at = new Date(event.start);
    return at >= start && at < end;
  });
}

function eventEndDate(event) {
  return new Date(event.end ?? event.start);
}

// 正在上的课（已开始且尚未结束）
function currentEvents(events, now = new Date()) {
  return events.filter((event) => new Date(event.start) <= now && eventEndDate(event) > now);
}

// 下一节课：尚未开始的最近一节
function nextEvent(events, now = new Date()) {
  return events.find((event) => new Date(event.start) > now) ?? null;
}

function formatCountdown(from, to) {
  const minutes = Math.round((new Date(to) - new Date(from)) / 60000);
  if (minutes <= 0) return '即将开始';
  if (minutes < 60) return `还有 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `还有 ${hours} 小时 ${rest} 分` : `还有 ${hours} 小时`;
  return `还有 ${Math.floor(hours / 24)} 天`;
}

// 首屏所需的汇总信息
// 今天没课时，往后找最近有课的一天
// 把某个周一开始的周做偏移（用于周课表翻页）
function shiftWeek(weekStartKey, offsetWeeks) {
  const date = new Date(`${weekStartKey}T00:00:00`);
  date.setDate(date.getDate() + offsetWeeks * 7);
  return toDateKey(date);
}

// 指定某一周的课表视图：日期范围、第几周、那周的课
function weekViewFor(events, term, weekStartKey, now = new Date()) {
  const { termStartMonday = null, totalWeeks = null } = term || {};
  const start = new Date(`${weekStartKey}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const inWeek = events.filter((event) => {
    const at = new Date(event.start);
    return at >= start && at < end;
  });
  const weekNumber = weekNumberFor(weekStartKey, termStartMonday);
  return {
    weekStart: weekStartKey,
    weekEnd: toDateKey(new Date(end.getTime() - 86400000)),
    weekNumber,
    label: formatWeekLabel(weekNumber, totalWeeks),
    isCurrentWeek: weekStartKey === weekStartOf(toDateKey(now)),
    events: inWeek,
    count: inWeek.length,
  };
}

function nextDayWithEvents(events, fromDate, limitDays = 14) {
  for (let offset = 1; offset <= limitDays; offset += 1) {
    const date = new Date(fromDate);
    date.setDate(date.getDate() + offset);
    const dateKey = toDateKey(date);
    const list = eventsOnDate(events, dateKey);
    if (list.length) return { dateKey, offset, events: list };
  }
  return null;
}

function describeDayLabel(dateKey, todayKey) {
  const diff = Math.round(
    (new Date(`${dateKey}T00:00:00`) - new Date(`${todayKey}T00:00:00`)) / 86400000,
  );
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
    new Date(`${dateKey}T00:00:00`).getDay()
  ];
}

// 卡片主区域展示哪一天：有课就展示今天，今天没课就展示下一个有课的日子
function displayDayFor(events, now = new Date()) {
  const todayKey = toDateKey(now);
  const today = eventsOnDate(events, todayKey);
  if (today.length) {
    return { dateKey: todayKey, label: '今天', isToday: true, events: today };
  }
  const next = nextDayWithEvents(events, new Date(`${todayKey}T00:00:00`));
  if (!next) return null;
  return {
    dateKey: next.dateKey,
    label: describeDayLabel(next.dateKey, todayKey),
    isToday: false,
    events: next.events,
  };
}

function summarize(events, now = new Date(), term = {}) {
  const { termStartMonday = null, totalWeeks = null } = term || {};
  const todayKey = toDateKey(now);
  const weekStart = weekStartOf(todayKey);
  const weekNumber = weekNumberFor(todayKey, termStartMonday);
  return {
    todayKey,
    weekStart,
    weekNumber,
    weekLabel: formatWeekLabel(weekNumber, totalWeeks),
    today: eventsOnDate(events, todayKey),
    displayDay: displayDayFor(events, now),
    week: eventsInWeek(events, weekStart),
    current: currentEvents(events, now),
    next: nextEvent(events, now),
  };
}

module.exports = {
  toDateKey,
  weekStartOf,
  weekNumberFor,
  formatWeekLabel,
  eventsOnDate,
  eventsInWeek,
  currentEvents,
  nextEvent,
  nextDayWithEvents,
  describeDayLabel,
  displayDayFor,
  shiftWeek,
  weekViewFor,
  formatCountdown,
  summarize,
};
