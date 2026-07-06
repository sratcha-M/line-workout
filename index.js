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

// ---------- เวลาแบบ Asia/Bangkok (UTC+7) โดยไม่ต้องพึ่ง timezone DB ----------
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
const THAI_MONTHS = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

function formatThaiDate(shiftedDate) {
  const day = THAI_DAYS[shiftedDate.getUTCDay()];
  const date = shiftedDate.getUTCDate();
  const month = THAI_MONTHS[shiftedDate.getUTCMonth()];
  return `${day} ${date} ${month}`;
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

// ---------- แปลงข้อความเป็นจำนวนนาที ----------
function parseDurationMinutes(text) {
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
  return Math.round(total);
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

// ---------- ดึงชื่อผู้ใช้ (พร้อม cache ใน db.profiles) ----------
async function getDisplayName(userId, context) {
  const db = readDB();
  if (db.profiles[userId]) return db.profiles[userId];

  try {
    let url;
    if (context.type === 'group') {
      url = `https://api.line.me/v2/bot/group/${context.id}/member/${userId}`;
    } else if (context.type === 'room') {
      url = `https://api.line.me/v2/bot/room/${context.id}/member/${userId}`;
    } else {
      url = `https://api.line.me/v2/bot/profile/${userId}`;
    }
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    });
    const name = res.data.displayName || 'เพื่อนสมาชิก';
    db.profiles[userId] = name;
    writeDB(db);
    return name;
  } catch (err) {
    // เกิดขึ้นได้ถ้าผู้ใช้ยังไม่ได้เพิ่มบอทเป็นเพื่อน ทำให้ดึงโปรไฟล์ไม่ได้
    return `สมาชิก#${userId.slice(-4)}`;
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

// ---------- ตอบกลับ LINE ----------
async function replyMessage(replyToken, messages) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    { replyToken, messages },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
}

// ---------- บันทึกข้อมูล ----------
function logExercise(userId, contextKey, minutes) {
  const db = readDB();
  const today = bangkokNow();
  db.logs.push({
    userId,
    contextKey,
    dateKey: dateKeyOf(today),
    minutes,
    createdAt: new Date().toISOString(),
  });
  writeDB(db);
}

// ---------- สรุปส่วนตัว (ใช้ได้ทั้งแชทส่วนตัวและในกลุ่ม กรองเฉพาะของคนนั้น) ----------
function getPersonalTodayMinutes(userId, contextKey) {
  const db = readDB();
  const todayKey = dateKeyOf(bangkokNow());
  return db.logs
    .filter((l) => l.userId === userId && l.contextKey === contextKey && l.dateKey === todayKey)
    .reduce((sum, l) => sum + l.minutes, 0);
}

function getPersonalWeekMinutes(userId, contextKey) {
  const db = readDB();
  const weekKeys = getWeekDateKeys(bangkokNow()).map(dateKeyOf);
  return db.logs
    .filter((l) => l.userId === userId && l.contextKey === contextKey && weekKeys.includes(l.dateKey))
    .reduce((sum, l) => sum + l.minutes, 0);
}

function getPersonalSummaryText(userId, contextKey) {
  const today = getPersonalTodayMinutes(userId, contextKey);
  const week = getPersonalWeekMinutes(userId, contextKey);
  const todayText = today > 0 ? formatMinutes(today) : 'ยังไม่ได้ออกกำลังกาย';
  return `👤 สรุปของฉัน (ในแชทนี้)\nวันนี้: ${todayText}\nสัปดาห์นี้รวม: ${formatMinutes(week)}`;
}

// ---------- สรุปแบบเดี่ยว (1:1) ----------
function getTodaySummaryText(userId, contextKey) {
  const total = getPersonalTodayMinutes(userId, contextKey);
  if (total === 0) {
    return '📌 วันนี้ยังไม่มีการบันทึกออกกำลังกายเลยนะ ลองกดปุ่มด้านล่างเพื่อบันทึกได้เลย 💪';
  }
  return `✅ วันนี้ออกกำลังกายไปแล้ว ${formatMinutes(total)} เก่งมาก!`;
}

function getWeeklySummaryText(userId, contextKey) {
  const db = readDB();
  const today = bangkokNow();
  const weekDates = getWeekDateKeys(today);
  const weekKeys = weekDates.map(dateKeyOf);

  const userLogs = db.logs.filter(
    (l) => l.userId === userId && l.contextKey === contextKey && weekKeys.includes(l.dateKey)
  );

  const perDay = {};
  weekKeys.forEach((k) => (perDay[k] = 0));
  userLogs.forEach((l) => {
    perDay[l.dateKey] += l.minutes;
  });

  const lines = weekDates.map((d) => {
    const key = dateKeyOf(d);
    const mins = perDay[key];
    const label = formatThaiDate(d);
    const isFuture = d.getTime() > today.getTime();
    if (isFuture) return `${label}: -`;
    return mins > 0 ? `${label}: ${mins} นาที` : `${label}: ไม่ได้ออกกำลังกาย`;
  });

  const totalMinutes = Object.values(perDay).reduce((a, b) => a + b, 0);
  const daysExercised = Object.values(perDay).filter((m) => m > 0).length;

  return (
    `📊 สรุปสัปดาห์นี้\n` +
    lines.join('\n') +
    `\n\nรวมทั้งสัปดาห์: ${formatMinutes(totalMinutes)}\n` +
    `ออกกำลังกาย ${daysExercised}/7 วัน`
  );
}

// ---------- สรุปแบบกลุ่ม (รวมทุกคนในกลุ่ม) ----------
async function getGroupTodaySummaryText(contextKey, context) {
  const db = readDB();
  const todayKey = dateKeyOf(bangkokNow());
  const todayLogs = db.logs.filter((l) => l.contextKey === contextKey && l.dateKey === todayKey);

  if (todayLogs.length === 0) {
    return '📌 วันนี้ยังไม่มีใครในกลุ่มบันทึกออกกำลังกายเลย ลองเริ่มคนแรกกันเลย 💪';
  }

  const perUser = {};
  todayLogs.forEach((l) => {
    perUser[l.userId] = (perUser[l.userId] || 0) + l.minutes;
  });

  const entries = Object.entries(perUser).sort((a, b) => b[1] - a[1]);
  const lines = [];
  for (const [userId, mins] of entries) {
    const name = await getDisplayName(userId, context);
    lines.push(`• ${name}: ${mins} นาที`);
  }

  const total = entries.reduce((sum, [, m]) => sum + m, 0);
  return (
    `✅ วันนี้ในกลุ่มออกกำลังกายรวม ${formatMinutes(total)} (${entries.length} คน)\n` +
    lines.join('\n')
  );
}

async function getGroupWeeklySummaryText(contextKey, context) {
  const db = readDB();
  const today = bangkokNow();
  const weekDates = getWeekDateKeys(today);
  const weekKeys = weekDates.map(dateKeyOf);

  const weekLogs = db.logs.filter((l) => l.contextKey === contextKey && weekKeys.includes(l.dateKey));

  // รวมต่อวัน (ทุกคนรวมกัน)
  const perDay = {};
  weekKeys.forEach((k) => (perDay[k] = 0));
  weekLogs.forEach((l) => {
    perDay[l.dateKey] += l.minutes;
  });

  const dayLines = weekDates.map((d) => {
    const key = dateKeyOf(d);
    const mins = perDay[key];
    const label = formatThaiDate(d);
    const isFuture = d.getTime() > today.getTime();
    if (isFuture) return `${label}: -`;
    return mins > 0 ? `${label}: ${mins} นาที` : `${label}: ไม่มีใครออกกำลังกาย`;
  });

  // จัดอันดับต่อคน
  const perUser = {};
  weekLogs.forEach((l) => {
    perUser[l.userId] = (perUser[l.userId] || 0) + l.minutes;
  });
  const ranking = Object.entries(perUser).sort((a, b) => b[1] - a[1]);

  const medals = ['🥇', '🥈', '🥉'];
  const rankLines = [];
  for (let i = 0; i < ranking.length; i++) {
    const [userId, mins] = ranking[i];
    const name = await getDisplayName(userId, context);
    const medal = medals[i] || `${i + 1}.`;
    rankLines.push(`${medal} ${name} - ${mins} นาที`);
  }

  const totalMinutes = Object.values(perDay).reduce((a, b) => a + b, 0);

  let text = `📊 สรุปสัปดาห์นี้ (กลุ่ม)\n` + dayLines.join('\n') + `\n\nรวมทั้งกลุ่ม: ${formatMinutes(totalMinutes)}`;
  if (rankLines.length > 0) {
    text += `\n\n🏆 อันดับสมาชิก\n` + rankLines.join('\n');
  }
  return text;
}

// ---------- จัดการข้อความที่เข้ามา ----------
async function handleTextMessage(event) {
  const userId = event.source.userId;
  const context = getContext(event.source);
  const contextKey = contextKeyOf(context);
  const isGroup = context.type === 'group' || context.type === 'room';
  const text = event.message.text.trim();

  if (!userId) {
    // บาง event ในกลุ่มอาจไม่มี userId (ผู้ใช้ปิดการแชร์ข้อมูล) ข้ามไปเลย
    return;
  }

  const minutes = parseDurationMinutes(text);
  let replyText;

  if (minutes !== null && minutes > 0) {
    logExercise(userId, contextKey, minutes);
    if (isGroup) {
      const name = await getDisplayName(userId, context);
      const personalToday = getPersonalTodayMinutes(userId, contextKey);
      replyText = `บันทึกแล้ว! 🏃‍♂️ ${name} ออกกำลังกาย ${minutes} นาที\nวันนี้ของคุณรวม: ${formatMinutes(personalToday)}`;
    } else {
      replyText = `บันทึกแล้ว! 🏃‍♂️ ออกกำลังกาย ${minutes} นาที\n\n${getTodaySummaryText(userId, contextKey)}`;
    }
  } else if (text.includes('ของฉัน')) {
    replyText = getPersonalSummaryText(userId, contextKey);
  } else if (text.includes('สัปดาห์')) {
    replyText = isGroup
      ? await getGroupWeeklySummaryText(contextKey, context)
      : getWeeklySummaryText(userId, contextKey);
  } else if (text.includes('วันนี้')) {
    replyText = isGroup
      ? await getGroupTodaySummaryText(contextKey, context)
      : getTodaySummaryText(userId, contextKey);
  } else {
    replyText =
      'สวัสดี! 👋 พิมพ์แบบนี้ได้เลย:\n' +
      '• "ออกกำลังกาย 30 นาที" เพื่อบันทึก\n' +
      '• "วันนี้" เพื่อดูสรุปวันนี้\n' +
      '• "สรุปสัปดาห์" เพื่อดูสรุปรายสัปดาห์\n' +
      (isGroup ? '• "ของฉัน" เพื่อดูสรุปเฉพาะของคุณในกลุ่มนี้\n' : '') +
      '\nหรือกดปุ่มด้านล่างได้เลย 👇';
  }

  await replyMessage(event.replyToken, [
    {
      type: 'text',
      text: replyText,
      quickReply: buildQuickReply(),
    },
  ]);
}

// ---------- Webhook ----------
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-line-signature'];
  const hash = crypto
    .createHmac('sha256', CHANNEL_SECRET)
    .update(req.rawBody)
    .digest('base64');

  if (signature !== hash) {
    return res.status(401).send('Invalid signature');
  }

  res.status(200).send('OK');

  const events = req.body.events || [];
  for (const event of events) {
    try {
      if (event.type === 'message' && event.message.type === 'text') {
        await handleTextMessage(event);
      } else if (event.type === 'join') {
        // บอทถูกเชิญเข้ากลุ่ม/ห้อง -- ทักทายแนะนำตัว
        await replyMessage(event.replyToken, [
          {
            type: 'text',
            text:
              'สวัสดีทุกคน! 👋 ผมเป็นบอทช่วยเช็คการออกกำลังกายของกลุ่มนี้\n' +
              'พิมพ์ "ออกกำลังกาย 30 นาที" เพื่อบันทึก หรือ "สรุปสัปดาห์" เพื่อดูอันดับกลุ่มได้เลย',
            quickReply: buildQuickReply(),
          },
        ]);
      }
    } catch (err) {
      console.error('Error handling event:', err.response?.data || err.message);
    }
  }
});

app.get('/', (req, res) => {
  res.send('LINE Exercise Tracker Bot is running ✅');
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
