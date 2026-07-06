require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

const app = express();

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---------- Storage (JSON file แบบง่าย) ----------
function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ logs: [], profiles: {} }, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  if (!db.profiles) db.profiles = {};
  return db;
}
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------- เวลาแบบ Asia/Bangkok (UTC+7) ----------
function bangkokNow() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}
function dateKeyOf(shiftedDate) {
  return shiftedDate.toISOString().slice(0, 10);
}
function addDays(shiftedDate, n) {
  return new Date(shiftedDate.getTime() + n * 86400000);
}

const THAI_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const THAI_DAYS_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function formatThaiDate(shiftedDate) {
  const day = THAI_DAYS[shiftedDate.getUTCDay()];
  const date = shiftedDate.getUTCDate();
  const month = THAI_MONTHS[shiftedDate.getUTCMonth()];
  return `${day} ${date} ${month}`;
}
function shortDayLabel(shiftedDate) {
  return `${THAI_DAYS_SHORT[shiftedDate.getUTCDay()]} ${shiftedDate.getUTCDate()}/${shiftedDate.getUTCMonth() + 1}`;
}
function getWeekDateKeys(shiftedToday) {
  const dow = shiftedToday.getUTCDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = addDays(shiftedToday, diffToMonday);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
function formatMinutes(total) {
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return hours > 0 ? `${hours} ชม. ${mins} นาที` : `${mins} นาที`;
}

// ---------- ประเภทกีฬา ----------
const TYPE_MAP = {
  running: { label: 'วิ่ง', emoji: '🏃' },
  swimming: { label: 'ว่ายน้ำ', emoji: '🏊' },
  weights: { label: 'ยกเวท', emoji: '🏋️' },
  yoga: { label: 'โยคะ', emoji: '🧘' },
  cycling: { label: 'ปั่นจักรยาน', emoji: '🚴' },
  walking: { label: 'เดิน', emoji: '🚶' },
  badminton: { label: 'แบดมินตัน', emoji: '🏸' },
  football: { label: 'ฟุตบอล', emoji: '⚽' },
  basketball: { label: 'บาสเกตบอล', emoji: '🏀' },
  other: { label: 'อื่นๆ', emoji: '💪' },
};
const TYPE_KEYWORDS = [
  { key: 'swimming', words: ['ว่ายน้ำ', 'ว่ายนํ้า'] },
  { key: 'running', words: ['วิ่ง'] },
  { key: 'weights', words: ['ยกเวท', 'ยกน้ำหนัก', 'เข้ายิม', 'เล่นกล้าม', 'เวท'] },
  { key: 'yoga', words: ['โยคะ'] },
  { key: 'cycling', words: ['ปั่นจักรยาน', 'ปั่น', 'จักรยาน', 'ไบค์'] },
  { key: 'badminton', words: ['แบดมินตัน', 'แบด'] },
  { key: 'basketball', words: ['บาสเกตบอล', 'บาส'] },
  { key: 'football', words: ['ฟุตบอล'] },
  { key: 'walking', words: ['เดิน'] },
];
function detectExerciseType(text) {
  for (const t of TYPE_KEYWORDS) {
    if (t.words.some((w) => text.includes(w))) return t.key;
  }
  return 'other';
}

const CHART_COLORS = ['#06C755', '#FFC107', '#FF7043', '#42A5F5', '#AB47BC', '#26A69A', '#8D6E63', '#EC407A', '#78909C', '#9CCC65'];

// ---------- แปลงข้อความเป็นจำนวนนาที + ประเภทกีฬา ----------
function parseExerciseText(text) {
  let total = 0;
  let matched = false;

  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(ชั่วโมง|ชม\.?)/);
  if (hourMatch) {
    total += parseFloat(hourMatch[1]) * 60;
    matched = true;
  }
  const minMatch = text.match(/(\d+(?:\.\d+)?)\s*นาที/);
  if (minMatch) {
    total += parseFloat(minMatch[1]);
    matched = true;
  }
  if (!matched) return null;

  return { minutes: Math.round(total), type: detectExerciseType(text) };
}

// ---------- แยกประเภทแชท (ส่วนตัว / กลุ่ม / ห้อง) ----------
function getContext(source) {
  if (source.type === 'group') return { type: 'group', id: source.groupId };
  if (source.type === 'room') return { type: 'room', id: source.roomId };
  return { type: 'user', id: source.userId };
}
function contextKeyOf(context) {
  return context.type === 'user' ? `user:${context.id}` : `${context.type}:${context.id}`;
}

// ---------- ดึงชื่อผู้ใช้ (พร้อม cache) ----------
async function getDisplayName(userId, context) {
  const db = readDB();
  if (db.profiles[userId]) return db.profiles[userId];
  try {
    let url;
    if (context.type === 'group') url = `https://api.line.me/v2/bot/group/${context.id}/member/${userId}`;
    else if (context.type === 'room') url = `https://api.line.me/v2/bot/room/${context.id}/member/${userId}`;
    else url = `https://api.line.me/v2/bot/profile/${userId}`;
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } });
    const name = res.data.displayName || 'เพื่อนสมาชิก';
    db.profiles[userId] = name;
    writeDB(db);
    return name;
  } catch (err) {
    return `สมาชิก#${userId.slice(-4)}`;
  }
}

// ---------- สร้างรูปกราฟผ่าน QuickChart (ฟรี ไม่ต้องมี API key) ----------
async function createChartUrl(chartConfig, { width = 600, height = 300, backgroundColor = 'white' } = {}) {
  try {
    const res = await axios.post(
      'https://quickchart.io/chart/create',
      { chart: chartConfig, width, height, backgroundColor, devicePixelRatio: 2 },
      { timeout: 8000 }
    );
    if (res.data && res.data.success) return res.data.url;
    return null;
  } catch (err) {
    return null; // ถ้าสร้างกราฟไม่ได้ ให้ fallback ไม่มีรูป ไม่ทำให้บอทพัง
  }
}

// ---------- Quick Reply เมนู ----------
function buildQuickReply() {
  const durations = [15, 30, 45, 60];
  return {
    items: [
      ...durations.map((m) => ({
        type: 'action',
        action: { type: 'message', label: `${m} นาที`, text: `ออกกำลังกาย ${m} นาที` },
      })),
      { type: 'action', action: { type: 'message', label: 'สรุปวันนี้', text: 'วันนี้' } },
      { type: 'action', action: { type: 'message', label: 'สรุปสัปดาห์', text: 'สรุปสัปดาห์' } },
      { type: 'action', action: { type: 'message', label: 'ของฉัน', text: 'ของฉัน' } },
    ],
  };
}

// ---------- Flex Message builders ----------
function flexRow(label, value, opts = {}) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#666666', flex: 3, wrap: true },
      {
        type: 'text',
        text: value,
        size: 'sm',
        color: opts.color || '#111111',
        align: 'end',
        flex: 2,
        weight: opts.bold ? 'bold' : 'regular',
      },
    ],
  };
}
function flexBubble({ title, subtitle, heroUrl, rows, footer }) {
  const bodyContents = [{ type: 'text', text: title, weight: 'bold', size: 'lg', color: '#06C755', wrap: true }];
  if (subtitle) bodyContents.push({ type: 'text', text: subtitle, size: 'xs', color: '#999999', margin: 'xs' });
  bodyContents.push({ type: 'separator', margin: 'md' });
  bodyContents.push({ type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm', contents: rows });
  if (footer) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'text', text: footer, size: 'xs', color: '#999999', margin: 'md', wrap: true });
  }
  const bubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: bodyContents } };
  if (heroUrl) bubble.hero = { type: 'image', url: heroUrl, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' };
  return bubble;
}
function toFlexMessage(altText, bubbles) {
  const contents = bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles };
  return { type: 'flex', altText, contents, quickReply: buildQuickReply() };
}

// ---------- ตอบกลับ LINE ----------
async function replyMessage(replyToken, messages) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    { replyToken, messages },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } }
  );
}

// ---------- บันทึกข้อมูล ----------
function logExercise(userId, contextKey, minutes, type) {
  const db = readDB();
  db.logs.push({
    userId,
    contextKey,
    dateKey: dateKeyOf(bangkokNow()),
    minutes,
    type,
    createdAt: new Date().toISOString(),
  });
  writeDB(db);
}

// ---------- Aggregation helpers ----------
function getWeekDailyMinutes(contextKey, userId = null) {
  const db = readDB();
  const weekDates = getWeekDateKeys(bangkokNow());
  const weekKeys = weekDates.map(dateKeyOf);
  const perDay = {};
  weekKeys.forEach((k) => (perDay[k] = 0));
  db.logs.forEach((l) => {
    if (l.contextKey !== contextKey) return;
    if (userId && l.userId !== userId) return;
    if (weekKeys.includes(l.dateKey)) perDay[l.dateKey] += l.minutes;
  });
  return { weekDates, weekKeys, perDay };
}
function getTypeBreakdown(contextKey, { userId = null, onlyToday = false } = {}) {
  const db = readDB();
  const weekKeys = getWeekDateKeys(bangkokNow()).map(dateKeyOf);
  const todayKey = dateKeyOf(bangkokNow());
  const perType = {};
  db.logs.forEach((l) => {
    if (l.contextKey !== contextKey) return;
    if (userId && l.userId !== userId) return;
    if (onlyToday && l.dateKey !== todayKey) return;
    if (!onlyToday && !weekKeys.includes(l.dateKey)) return;
    const key = l.type || 'other';
    perType[key] = (perType[key] || 0) + l.minutes;
  });
  return perType;
}
function getPerUserMinutes(contextKey, { onlyToday = false } = {}) {
  const db = readDB();
  const weekKeys = getWeekDateKeys(bangkokNow()).map(dateKeyOf);
  const todayKey = dateKeyOf(bangkokNow());
  const perUser = {};
  db.logs.forEach((l) => {
    if (l.contextKey !== contextKey) return;
    if (onlyToday && l.dateKey !== todayKey) return;
    if (!onlyToday && !weekKeys.includes(l.dateKey)) return;
    perUser[l.userId] = (perUser[l.userId] || 0) + l.minutes;
  });
  return perUser;
}

function typeBreakdownRows(perType) {
  return Object.entries(perType)
    .sort((a, b) => b[1] - a[1])
    .map(([key, mins]) => {
      const meta = TYPE_MAP[key] || TYPE_MAP.other;
      return flexRow(`${meta.emoji} ${meta.label}`, formatMinutes(mins));
    });
}

// ---------- Flex: สรุปวันนี้ (ส่วนตัว/ในกลุ่มเฉพาะตัวเอง) ----------
async function buildTodayFlex({ contextKey, userId, isGroup }) {
  const { weekDates, perDay } = getWeekDailyMinutes(contextKey, userId);
  const todayKey = dateKeyOf(bangkokNow());
  const todayIndex = weekDates.findIndex((d) => dateKeyOf(d) === todayKey);
  const dayLabels = weekDates.map(shortDayLabel);
  const dayValues = weekDates.map((d) => perDay[dateKeyOf(d)] || 0);

  const chartConfig = {
    type: 'bar',
    data: {
      labels: dayLabels,
      datasets: [
        { label: 'นาที', data: dayValues, backgroundColor: dayValues.map((_, i) => (i === todayIndex ? '#06C755' : '#BFE8CB')) },
      ],
    },
    options: { legend: { display: false }, scales: { yAxes: [{ ticks: { beginAtZero: true, precision: 0 } }] } },
  };
  const chartUrl = await createChartUrl(chartConfig, { width: 600, height: 280 });

  const todayTotal = dayValues[todayIndex] || 0;
  const rows = [flexRow('รวมวันนี้', formatMinutes(todayTotal), { bold: true, color: '#06C755' })];
  const typeToday = getTypeBreakdown(contextKey, { userId, onlyToday: true });
  rows.push(...typeBreakdownRows(typeToday));

  const bubble = flexBubble({
    title: '✅ สรุปวันนี้',
    subtitle: isGroup ? 'เฉพาะของคุณในกลุ่มนี้' : null,
    heroUrl: chartUrl,
    rows,
    footer: todayTotal === 0 ? 'ยังไม่ได้บันทึกวันนี้เลย ลองกดปุ่มด้านล่างได้เลย 💪' : null,
  });
  return toFlexMessage('สรุปวันนี้', [bubble]);
}

// ---------- Flex: สรุปสัปดาห์ (ส่วนตัว) ----------
async function buildPersonalWeekFlex({ contextKey, userId, isGroup }) {
  const { weekDates, perDay } = getWeekDailyMinutes(contextKey, userId);
  const dayLabels = weekDates.map(shortDayLabel);
  const dayValues = weekDates.map((d) => perDay[dateKeyOf(d)] || 0);
  const totalMinutes = dayValues.reduce((a, b) => a + b, 0);
  const daysActive = dayValues.filter((v) => v > 0).length;

  const barConfig = {
    type: 'bar',
    data: { labels: dayLabels, datasets: [{ label: 'นาที', data: dayValues, backgroundColor: '#06C755' }] },
    options: { legend: { display: false }, scales: { yAxes: [{ ticks: { beginAtZero: true, precision: 0 } }] } },
  };
  const chartUrl = await createChartUrl(barConfig, { width: 600, height: 280 });

  const bubbles = [
    flexBubble({
      title: '📊 สรุปสัปดาห์นี้',
      subtitle: isGroup ? 'เฉพาะของคุณในกลุ่มนี้' : null,
      heroUrl: chartUrl,
      rows: [
        flexRow('รวมทั้งสัปดาห์', formatMinutes(totalMinutes), { bold: true, color: '#06C755' }),
        flexRow('ออกกำลังกาย', `${daysActive}/7 วัน`),
      ],
    }),
  ];

  const typeBreakdown = getTypeBreakdown(contextKey, { userId });
  const typeEntries = Object.entries(typeBreakdown).sort((a, b) => b[1] - a[1]);
  if (typeEntries.length > 0) {
    const doughnutConfig = {
      type: 'doughnut',
      data: {
        labels: typeEntries.map(([k]) => (TYPE_MAP[k] || TYPE_MAP.other).label),
        datasets: [{ data: typeEntries.map(([, v]) => v), backgroundColor: CHART_COLORS }],
      },
      options: { legend: { position: 'right' } },
    };
    const doughnutUrl = await createChartUrl(doughnutConfig, { width: 500, height: 320 });
    bubbles.push(
      flexBubble({ title: '🏷️ แยกตามประเภทกีฬา', heroUrl: doughnutUrl, rows: typeBreakdownRows(typeBreakdown) })
    );
  }

  return toFlexMessage('สรุปสัปดาห์นี้', bubbles);
}

// ---------- Flex: สรุปวันนี้ (กลุ่ม รวมทุกคน) ----------
async function buildGroupTodayFlex({ contextKey, context }) {
  const perUser = getPerUserMinutes(contextKey, { onlyToday: true });
  const ranking = Object.entries(perUser).sort((a, b) => b[1] - a[1]);

  if (ranking.length === 0) {
    const bubble = flexBubble({
      title: '✅ สรุปวันนี้ (กลุ่ม)',
      rows: [],
      footer: 'วันนี้ยังไม่มีใครในกลุ่มบันทึกออกกำลังกายเลย ลองเริ่มคนแรกกันเลย 💪',
    });
    return toFlexMessage('สรุปวันนี้ (กลุ่ม)', [bubble]);
  }

  const names = [];
  for (const [uid] of ranking) names.push(await getDisplayName(uid, context));

  const chartConfig = {
    type: 'bar',
    data: { labels: names, datasets: [{ label: 'นาที', data: ranking.map(([, v]) => v), backgroundColor: '#06C755' }] },
    options: { legend: { display: false }, scales: { yAxes: [{ ticks: { beginAtZero: true, precision: 0 } }] } },
  };
  const chartUrl = await createChartUrl(chartConfig, { width: 600, height: 300 });

  const total = ranking.reduce((sum, [, m]) => sum + m, 0);
  const rows = [flexRow('รวมทั้งกลุ่มวันนี้', formatMinutes(total), { bold: true, color: '#06C755' })];
  ranking.forEach(([, mins], i) => rows.push(flexRow(names[i], formatMinutes(mins))));

  const bubble = flexBubble({ title: '✅ สรุปวันนี้ (กลุ่ม)', heroUrl: chartUrl, rows });
  return toFlexMessage('สรุปวันนี้ (กลุ่ม)', [bubble]);
}

// ---------- Flex: สรุปสัปดาห์ (กลุ่ม) ----------
async function buildGroupWeekFlex({ contextKey, context }) {
  const { weekDates, perDay } = getWeekDailyMinutes(contextKey);
  const dayLabels = weekDates.map(shortDayLabel);
  const dayValues = weekDates.map((d) => perDay[dateKeyOf(d)] || 0);
  const totalMinutes = dayValues.reduce((a, b) => a + b, 0);
  const daysActive = dayValues.filter((v) => v > 0).length;

  const barConfig = {
    type: 'bar',
    data: { labels: dayLabels, datasets: [{ label: 'นาที', data: dayValues, backgroundColor: '#06C755' }] },
    options: { legend: { display: false }, scales: { yAxes: [{ ticks: { beginAtZero: true, precision: 0 } }] } },
  };
  const chartUrl = await createChartUrl(barConfig, { width: 600, height: 280 });

  const bubbles = [
    flexBubble({
      title: '📊 สรุปสัปดาห์นี้ (กลุ่ม)',
      heroUrl: chartUrl,
      rows: [
        flexRow('รวมทั้งกลุ่ม', formatMinutes(totalMinutes), { bold: true, color: '#06C755' }),
        flexRow('วันที่มีคนออกกำลังกาย', `${daysActive}/7 วัน`),
      ],
    }),
  ];

  const typeBreakdown = getTypeBreakdown(contextKey);
  const typeEntries = Object.entries(typeBreakdown).sort((a, b) => b[1] - a[1]);
  if (typeEntries.length > 0) {
    const doughnutConfig = {
      type: 'doughnut',
      data: {
        labels: typeEntries.map(([k]) => (TYPE_MAP[k] || TYPE_MAP.other).label),
        datasets: [{ data: typeEntries.map(([, v]) => v), backgroundColor: CHART_COLORS }],
      },
      options: { legend: { position: 'right' } },
    };
    const doughnutUrl = await createChartUrl(doughnutConfig, { width: 500, height: 320 });
    bubbles.push(
      flexBubble({ title: '🏷️ แยกตามประเภทกีฬา', heroUrl: doughnutUrl, rows: typeBreakdownRows(typeBreakdown) })
    );
  }

  const perUser = getPerUserMinutes(contextKey);
  const ranking = Object.entries(perUser).sort((a, b) => b[1] - a[1]);
  if (ranking.length > 0) {
    const names = [];
    for (const [uid] of ranking) names.push(await getDisplayName(uid, context));
    const rankConfig = {
      type: 'bar',
      data: { labels: names, datasets: [{ label: 'นาที', data: ranking.map(([, v]) => v), backgroundColor: CHART_COLORS }] },
      options: { legend: { display: false }, scales: { yAxes: [{ ticks: { beginAtZero: true, precision: 0 } }] } },
    };
    const rankUrl = await createChartUrl(rankConfig, { width: 600, height: 300 });
    const medals = ['🥇', '🥈', '🥉'];
    const rankRows = ranking.map(([, mins], i) => flexRow(`${medals[i] || `${i + 1}.`} ${names[i]}`, formatMinutes(mins)));
    bubbles.push(flexBubble({ title: '🏆 อันดับสมาชิก', heroUrl: rankUrl, rows: rankRows }));
  }

  return toFlexMessage('สรุปสัปดาห์นี้ (กลุ่ม)', bubbles);
}

// ---------- ข้อความสำรอง (fallback) แบบ text ล้วน เผื่อสร้าง Flex/กราฟพลาด ----------
function fallbackTodayText(contextKey, userId) {
  const { perDay } = getWeekDailyMinutes(contextKey, userId);
  const total = perDay[dateKeyOf(bangkokNow())] || 0;
  return total === 0
    ? '📌 วันนี้ยังไม่มีการบันทึกออกกำลังกายเลยนะ ลองกดปุ่มด้านล่างเพื่อบันทึกได้เลย 💪'
    : `✅ วันนี้ออกกำลังกายไปแล้ว ${formatMinutes(total)} เก่งมาก!`;
}
function fallbackWeekText(contextKey, userId) {
  const { weekDates, perDay } = getWeekDailyMinutes(contextKey, userId);
  const lines = weekDates.map((d) => {
    const mins = perDay[dateKeyOf(d)] || 0;
    return `${formatThaiDate(d)}: ${mins > 0 ? mins + ' นาที' : 'ไม่ได้ออกกำลังกาย'}`;
  });
  const total = Object.values(perDay).reduce((a, b) => a + b, 0);
  return `📊 สรุปสัปดาห์นี้\n${lines.join('\n')}\n\nรวมทั้งสัปดาห์: ${formatMinutes(total)}`;
}

// ---------- จัดการข้อความที่เข้ามา ----------
async function handleTextMessage(event) {
  const userId = event.source.userId;
  if (!userId) return;
  const context = getContext(event.source);
  const contextKey = contextKeyOf(context);
  const isGroup = context.type === 'group' || context.type === 'room';
  const text = event.message.text.trim();

  const parsed = parseExerciseText(text);
  let messages;

  try {
    if (parsed) {
      logExercise(userId, contextKey, parsed.minutes, parsed.type);
      const meta = TYPE_MAP[parsed.type];
      if (isGroup) {
        const name = await getDisplayName(userId, context);
        messages = [
          {
            type: 'text',
            text: `บันทึกแล้ว! ${meta.emoji} ${name} ${meta.label} ${parsed.minutes} นาที`,
            quickReply: buildQuickReply(),
          },
        ];
      } else {
        messages = [
          {
            type: 'text',
            text: `บันทึกแล้ว! ${meta.emoji} ${meta.label} ${parsed.minutes} นาที`,
            quickReply: buildQuickReply(),
          },
        ];
      }
    } else if (text.includes('ของฉัน')) {
      const flex = await buildPersonalWeekFlexOrToday(contextKey, userId, isGroup, context);
      messages = [flex];
    } else if (text.includes('สัปดาห์')) {
      const flex = isGroup
        ? await buildGroupWeekFlex({ contextKey, context })
        : await buildPersonalWeekFlex({ contextKey, userId, isGroup });
      messages = [flex];
    } else if (text.includes('วันนี้')) {
      const flex = isGroup
        ? await buildGroupTodayFlex({ contextKey, context })
        : await buildTodayFlex({ contextKey, userId, isGroup });
      messages = [flex];
    } else {
      messages = [
        {
          type: 'text',
          text:
            'สวัสดี! 👋 พิมพ์แบบนี้ได้เลย:\n' +
            '• "วิ่ง 30 นาที" หรือ "ยกเวท 1 ชม" เพื่อบันทึก\n' +
            '• "วันนี้" เพื่อดูสรุปวันนี้\n' +
            '• "สรุปสัปดาห์" เพื่อดูสรุปรายสัปดาห์\n' +
            (isGroup ? '• "ของฉัน" เพื่อดูสรุปเฉพาะของคุณ\n' : '') +
            '\nหรือกดปุ่มด้านล่างได้เลย 👇',
          quickReply: buildQuickReply(),
        },
      ];
    }
  } catch (err) {
    console.error('Flex build error, falling back to text:', err.message);
    const fallbackText = text.includes('สัปดาห์') ? fallbackWeekText(contextKey, userId) : fallbackTodayText(contextKey, userId);
    messages = [{ type: 'text', text: fallbackText, quickReply: buildQuickReply() }];
  }

  await replyMessage(event.replyToken, messages);
}

// ของฉัน = แสดงทั้งวันนี้และสัปดาห์นี้เฉพาะของตัวเอง (ใช้ flex สัปดาห์เป็นหลัก อ่านง่ายกว่า)
async function buildPersonalWeekFlexOrToday(contextKey, userId, isGroup, context) {
  return buildPersonalWeekFlex({ contextKey, userId, isGroup });
}

// ---------- Webhook ----------
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-line-signature'];
  const hash = crypto.createHmac('sha256', CHANNEL_SECRET).update(req.rawBody).digest('base64');
  if (signature !== hash) return res.status(401).send('Invalid signature');

  res.status(200).send('OK');

  const events = req.body.events || [];
  for (const event of events) {
    try {
      if (event.type === 'message' && event.message.type === 'text') {
        await handleTextMessage(event);
      } else if (event.type === 'join') {
        await replyMessage(event.replyToken, [
          {
            type: 'text',
            text:
              'สวัสดีทุกคน! 👋 ผมเป็นบอทช่วยเช็คการออกกำลังกายของกลุ่มนี้\n' +
              'พิมพ์ "วิ่ง 30 นาที" เพื่อบันทึก หรือ "สรุปสัปดาห์" เพื่อดูอันดับกลุ่มได้เลย',
            quickReply: buildQuickReply(),
          },
        ]);
      }
    } catch (err) {
      console.error('Error handling event:', err.response?.data || err.message);
    }
  }
});

app.get('/', (req, res) => res.send('LINE Exercise Tracker Bot is running ✅'));

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
