# Tool Inventory — Cloudflare Workers + D1 + R2

ระบบคลังเครื่องมือภาษาไทย: Login, CRUD, รูปถ่าย, ไลน์การผลิต, ขบวนการ/เครื่องจักร และประวัติรับเข้า–เบิกออก

## โครงสร้าง

- `src/index.js` — API, Login, authorization, upload ภาพไป R2
- `public/index.html` — Responsive frontend, Sarabun, Earth tone
- `migrations/0001_initial.sql` — schema ของ D1
- `wrangler.jsonc` — bindings สำหรับ Worker, D1, R2 และ static assets

## ขั้นตอนติดตั้งแบบ Dashboard (ไม่ต้องใช้ terminal)

1. สร้าง D1 database ชื่อ `tool-inventory-db` ใน Cloudflare Dashboard > Storage & databases > D1 SQL database > Create.
2. คัดลอก Database ID แล้วแทน `REPLACE_WITH_D1_DATABASE_ID` ใน `wrangler.jsonc`.
3. เปิด D1 > database ที่สร้าง > Console แล้วรัน SQL ทั้งหมดใน `migrations/0001_initial.sql`.
4. สร้าง R2 bucket ชื่อ `tool-inventory-photos` ที่ Cloudflare Dashboard > R2 Object Storage > Create bucket.
5. อัปโหลดโฟลเดอร์/ไฟล์ทั้งหมดเข้า GitHub repository โดยรักษาโครงสร้างโฟลเดอร์.
6. Cloudflare Dashboard > Workers & Pages > Create application > Workers > Connect to Git. เลือก repository และ branch `main`.
7. ตั้ง root directory เป็น `/` (repository root) และ deploy command/build command ให้ตรงกับหน้าจอ Cloudflare. ถ้าไม่ต้อง build ให้ปล่อย build command ว่าง หากระบบต้องการคำสั่ง ให้ใช้ `npx wrangler deploy`.
8. หลัง deploy ตรวจสอบ Worker name ให้ตรงกับ `"name": "tool-inventory-app"` ใน `wrangler.jsonc`.
9. Worker > Settings > Variables and Secrets > Add secret:
   - `SESSION_SECRET`: สุ่มสตริงลับที่ยาวและคาดเดายาก อย่างน้อย 32 bytes
   - `SETUP_SECRET`: สุ่มสตริงลับอีกชุด ใช้สร้าง Admin ครั้งแรกเท่านั้น
10. ตรวจสอบ Bindings ว่ามี D1 binding `DB`, R2 binding `PHOTOS` และ Assets binding `ASSETS` ตาม `wrangler.jsonc`. หากสร้างจาก config แล้วไม่ต้องเพิ่มซ้ำ.
11. เปิด URL ของ Worker. ครั้งแรกจะมีช่องสร้าง Admin คนแรก: ใส่ username, password อย่างน้อย 12 ตัว และ Setup Key ที่ตั้งเป็น `SETUP_SECRET`.
12. เข้าสู่ระบบด้วย Admin จากนั้นเพิ่ม User ได้จากส่วน “เพิ่มผู้ใช้งาน”.

## Deploy อัตโนมัติ

เมื่อ Workers Builds เชื่อมกับ GitHub แล้ว การ push commit ไป branch ที่กำหนดจะ trigger build/deploy อัตโนมัติ. อย่า commit secret หรือ `.dev.vars` ลง GitHub.

## หมายเหตุสำคัญ

- Bucket R2 ต้องเป็น private; รูปอ่านผ่าน Worker ที่ต้องมี token เท่านั้น.
- รูปที่รองรับ: JPG, PNG, WebP ไม่เกิน 5 MB.
- ลบรายการเครื่องมือเป็นการ archive เพื่อรักษาประวัติรับเข้า–เบิกออก.
- การรับเข้า/เบิกออกถูกบันทึกเป็น movement; ยอดคงเหลือคำนวณจาก movement.
- ทดสอบใน staging ก่อนใช้งานจริง และสำรองข้อมูล D1 ตามนโยบายโรงงาน.
- Frontend ใช้ Google Fonts CDN สำหรับ Sarabun; หากเครือข่ายบล็อก Google Fonts จะ fallback เป็น sans-serif.
- ตัวอย่างนี้เป็น starter implementation ควรทดสอบ role, backup/restore, rate limiting และนโยบายรหัสผ่านก่อนใช้ใน production.
