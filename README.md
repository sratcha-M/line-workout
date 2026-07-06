# LINE Exercise Tracker Bot

บอทเช็คว่าวันนี้ออกกำลังกายหรือยัง กี่นาที และสรุปผลรายสัปดาห์

## วิธีใช้งาน (คุยกับบอท)

| พิมพ์ | บอทจะทำ |
|---|---|
| `ออกกำลังกาย 30 นาที` | บันทึกว่าออกกำลังกาย 30 นาที |
| `วิ่ง 1 ชั่วโมง` | บันทึก 60 นาที (รองรับทั้ง ชม./ชั่วโมง/นาที รวมกันได้ เช่น `1 ชม 30 นาที`) |
| `วันนี้` | ดูสรุปว่าวันนี้ออกกำลังกายไปกี่นาที |
| `สรุปสัปดาห์` | ดูสรุปรายวันของสัปดาห์นี้ (จันทร์-อาทิตย์) + รวมทั้งหมด |
| `ของฉัน` | ดูสรุปเฉพาะของตัวเอง (ใช้ได้ทั้งแชทเดี่ยวและในกลุ่ม) |

มีปุ่ม Quick Reply ให้กดลัดด้วย ไม่ต้องพิมพ์เองก็ได้

## ใช้งานในกลุ่ม (Group Chat)

เชิญบอทเข้ากลุ่ม LINE ได้เลย ข้อมูลจะแยกเก็บ**ต่อกลุ่ม** (คนละกลุ่มไม่ปนกัน) และมีพฤติกรรมต่างจากแชทเดี่ยวเล็กน้อย:

- `ออกกำลังกาย 30 นาที` → บันทึกของคนที่พิมพ์ ผูกกับกลุ่มนั้น
- `วันนี้` ในกลุ่ม → แสดงสรุป**รวมของทุกคนในกลุ่ม** วันนี้ (แยกเป็นรายชื่อ)
- `สรุปสัปดาห์` ในกลุ่ม → แสดงยอดรวมของกลุ่มรายวัน + จัดอันดับสมาชิก (🥇🥈🥉)
- `ของฉัน` ในกลุ่ม → แสดงสรุปเฉพาะของตัวเองในกลุ่มนั้น (วันนี้ + สัปดาห์นี้)

**ข้อจำกัดสำคัญเรื่องชื่อสมาชิก:** LINE จะให้บอทดึงชื่อ (`displayName`) ของสมาชิกในกลุ่มได้ ก็ต่อเมื่อสมาชิกคนนั้น**เคยเพิ่มบอทเป็นเพื่อนแบบ 1:1 ด้วย** ถ้าใครไม่เคยแอดบอทเป็นเพื่อนเลย บอทจะดึงชื่อไม่ได้และจะแสดงเป็น `สมาชิก#xxxx` แทน แนะนำให้บอกสมาชิกในกลุ่มแอดบอทเป็นเพื่อนก่อนใช้งาน (สแกน QR เดียวกับที่ใช้เชิญเข้ากลุ่มได้เลย)

## ขั้นตอนติดตั้ง

### 1. สร้าง LINE Official Account
1. ไปที่ https://developers.line.biz/console/
2. สร้าง Provider ใหม่ (ถ้ายังไม่มี) แล้วสร้าง Channel แบบ **Messaging API**
3. ในหน้า Channel ไปที่แท็บ **Basic settings** → คัดลอก `Channel secret`
4. ไปที่แท็บ **Messaging API** → เลื่อนลงไปกด **Issue** เพื่อสร้าง `Channel access token (long-lived)` แล้วคัดลอกเก็บไว้
5. ในหน้าเดียวกัน ปิด **"Auto-reply messages"** และ **"Greeting messages"** ที่เป็นค่า default ของ LINE (ไม่งั้นจะตีกับบอทของเรา)

### 2. รันบนเครื่องตัวเอง (ทดสอบ)
```bash
cd line-exercise-bot
npm install
cp .env.example .env
# แก้ไข .env ใส่ Channel secret และ Access token ที่คัดลอกมา
npm start
```
เซิร์ฟเวอร์จะรันที่ `http://localhost:3000` แต่ LINE ต้องการ HTTPS public URL ดังนั้นตอนทดสอบบนเครื่องให้ใช้ `ngrok` ช่วย:
```bash
ngrok http 3000
```
แล้วเอา URL ที่ได้ (เช่น `https://xxxx.ngrok-free.app/webhook`) ไปตั้งใน LINE Console

### 3. Deploy ขึ้นจริง (แนะนำ Railway หรือ Render เพราะฟรีและง่าย)

**Railway** (https://railway.app)
1. สร้างโปรเจกต์ใหม่ → Deploy from GitHub repo (push โค้ดนี้ขึ้น GitHub ก่อน) หรือใช้ Railway CLI
2. ไปที่ Variables → เพิ่ม `LINE_CHANNEL_SECRET` และ `LINE_CHANNEL_ACCESS_TOKEN`
3. Deploy เสร็จแล้วจะได้ public URL เช่น `https://your-app.up.railway.app`

**Render** (https://render.com)
1. New → Web Service → เชื่อม GitHub repo
2. Build command: `npm install`, Start command: `npm start`
3. ไปที่ Environment → เพิ่ม env variables เหมือนกัน

### 4. ตั้งค่า Webhook URL ใน LINE Console
1. กลับไปที่แท็บ **Messaging API** ใน LINE Developers Console
2. ใส่ Webhook URL เป็น `https://<your-domain>/webhook`
3. กด **Verify** เพื่อเช็คว่าเชื่อมต่อได้
4. เปิด **Use webhook** เป็น ON

### 5. เพิ่มบอทเป็นเพื่อน
สแกน QR Code ที่อยู่ในหน้า Messaging API ของ Console เพื่อเพิ่มบอทเป็นเพื่อนใน LINE แล้วลองพิมพ์คุยได้เลย

## หมายเหตุเรื่องการเก็บข้อมูล

โค้ดนี้เก็บ log ลงไฟล์ `db.json` แบบง่ายๆ เพื่อให้ deploy ง่ายไม่ต้องพึ่ง database แยก
**ข้อควรระวัง:** บาง hosting (เช่น Render free tier, หรือ container ที่ restart บ่อย) ไฟล์ที่เขียนไว้อาจหายเมื่อ container รีสตาร์ท เพราะ filesystem ไม่ persistent

ถ้าต้องการให้ข้อมูลอยู่ถาวรจริงจัง แนะนำให้เปลี่ยนไปใช้:
- Railway/Render **Persistent Disk** (mount volume แล้วเก็บ db.json ไว้ในนั้น) หรือ
- database จริงเช่น PostgreSQL/SQLite ที่ hosting รองรับ (บอกผมได้ถ้าอยากให้ช่วยปรับเป็นแบบนี้)

## โครงสร้างไฟล์
```
line-exercise-bot/
├── index.js          # โค้ดหลักของบอท
├── package.json
├── db.json           # ที่เก็บข้อมูล log (จะถูกสร้าง/อัปเดตอัตโนมัติ)
├── .env.example      # ตัวอย่างไฟล์ env
└── README.md
```
