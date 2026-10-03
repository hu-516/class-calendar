#!/usr/bin/env node
'use strict';

// 开发用工具：解析一个 ICS 文件并打印结果，方便核对解析是否符合预期。
//
// 用法：
//   node tools/inspect-ics.js "C:\path\to\日历.ics" [--date YYYY-MM-DD] [--limit 20]

const path = require('node:path');
const { readIcsFile, expandIcs } = require('../src/main/ics');
const { summarize, formatCountdown, toDateKey } = require('../src/main/schedule');

function parseArgs(argv) {
  const args = { file: null, date: null, limit: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') args.date = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (!args.file) args.file = arg;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('用法：node tools/inspect-ics.js <ics 文件路径> [--date YYYY-MM-DD] [--limit N]');
    process.exit(1);
  }

  const filePath = path.resolve(args.file);
  const { text, encoding, bytes } = readIcsFile(filePath);
  const { events, meta, warnings } = expandIcs(text, {
    fileBaseName: path.basename(filePath, path.extname(filePath)),
  });

  console.log(`文件：${filePath}`);
  console.log(`编码：${encoding}（${bytes} 字节）`);
  console.log(
    `事件：VEVENT ${meta.sourceEventCount} 条 -> 展开 ${meta.occurrenceCount} 节课` +
      `（去重 ${meta.duplicatesRemoved}，调课覆盖 ${meta.exceptionCount}，全天 ${meta.allDayCount}）`,
  );
  console.log(`时间范围：${meta.firstStart} ~ ${meta.lastStart}`);
  console.log(`学期首周周一：${meta.termStartMonday}`);
  console.log(`学期周数：${meta.totalWeeks ?? '-'} 周`);
  console.log(`课程（${meta.courses.length} 门）：${meta.courses.join('、')}`);
  console.log(`日历名：${meta.calendarName ?? '-'}    建议显示名：${meta.suggestedName ?? '-'}`);
  console.log(
    `时区：引用 ${meta.timezones.referenced.join(',') || '-'}` +
      ` / 文件内 ${meta.timezones.fromFile.join(',') || '-'}` +
      ` / 兜底 ${meta.timezones.fromFallback.join(',') || '-'}` +
      ` / 未解析 ${meta.timezones.unresolved.join(',') || '-'}`,
  );
  if (meta.truncated) console.log('警告：展开被上限截断');
  for (const warning of warnings) console.log(`警告：${warning}`);

  const now = args.date ? new Date(`${args.date}T12:00:00`) : new Date();
  const summary = summarize(events, now, {
    termStartMonday: meta.termStartMonday,
    totalWeeks: meta.totalWeeks,
  });
  console.log(`\n=== ${toDateKey(now)}（${summary.weekLabel || '周次未知'}）===`);
  if (!summary.today.length) {
    console.log('今天没有课');
  } else {
    for (const event of summary.today) {
      const marks = [event.period, event.room, event.teacher].filter(Boolean).join(' · ');
      console.log(
        `  ${event.start.slice(11, 16)}-${event.end.slice(11, 16)}  ${event.title}${marks ? `  [${marks}]` : ''}`,
      );
    }
  }
  if (summary.current.length) {
    console.log(`进行中：${summary.current.map((event) => event.title).join('、')}`);
  }
  if (summary.next) {
    console.log(
      `下一节：${summary.next.title} ${formatCountdown(now, new Date(summary.next.start))}` +
        `（${summary.next.start.slice(5, 16).replace('T', ' ')}）`,
    );
  }

  console.log(`\n=== 前 ${args.limit} 条展开结果 ===`);
  for (const event of events.slice(0, args.limit)) {
    const weeks = weeksLabel(event);
    console.log(
      `  ${event.start.slice(0, 16).replace('T', ' ')} ~ ${event.end.slice(11, 16)}  ${event.title}` +
        `${event.period ? `  ${event.period}` : ''}${event.room ? `  ${event.room}` : ''}` +
        `${event.teacher ? `  ${event.teacher}` : ''}${weeks ? `  ${weeks}` : ''}` +
        `${event.overridden ? '  (调课)' : ''}`,
    );
  }
}

// 周次文案：优先用 ICS 里写的原文（如「第 4-17 周」），否则由周次数组拼出来
function weeksLabel(event) {
  if (event.weeksText) return event.weeksText.replace(/\s+/g, '');
  if (Array.isArray(event.weeks) && event.weeks.length) {
    const first = event.weeks[0];
    const last = event.weeks[event.weeks.length - 1];
    return event.weeks.length === 1 ? `第${first}周` : `第${first}-${last}周`;
  }
  return '';
}

main();
