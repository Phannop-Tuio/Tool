const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function b64url(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(value) {
  const s = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - s.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2", salt: fromB64url(salt), iterations: 210000, hash: "SHA-256"
  }, key, 256);
  return b64url(bits);
}
async function newPasswordRecord(password) {
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await passwordHash(password, salt) };
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
async function issueToken(user, secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    sub: user.id, username: user.username, role: user.role, exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60
  })));
  const signature = b64url(await hmac(secret, payload));
  return `${payload}.${signature}`;
}
async function getUser(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !env.SESSION_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = b64url(await hmac(env.SESSION_SECRET, parts[0]));
  if (!safeEqual(expected, parts[1])) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    const user = await env.DB.prepare("SELECT id, username, role, active FROM users WHERE id = ?").bind(payload.sub).first();
    if (!user || !user.active) return null;
    return user;
  } catch { return null; }
}
async function requireUser(request, env) {
  const user = await getUser(request, env);
  return user || null;
}
function dateToday() { return new Date().toISOString().slice(0, 10); }
function validText(value, max = 200) { return typeof value === "string" && value.trim().length <= max; }
async function stockFor(env, toolId) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN movement_type = 'IN' THEN quantity
      WHEN movement_type = 'OUT' THEN -quantity
      WHEN movement_type = 'ADJUST' THEN quantity
      ELSE 0 END), 0) AS stock
    FROM movements WHERE tool_id = ?
  `).bind(toolId).first();
  return Number(row?.stock || 0);
}
async function toolDetail(env, id) {
  return await env.DB.prepare(`
    SELECT t.*,
      COALESCE(SUM(CASE WHEN m.movement_type='IN' THEN m.quantity
                        WHEN m.movement_type='OUT' THEN -m.quantity
                        WHEN m.movement_type='ADJUST' THEN m.quantity ELSE 0 END), 0) AS stock,
      MIN(
  CASE
    WHEN m.movement_type = 'IN'
    THEN m.movement_date
  END
) AS received_date
    FROM tools t LEFT JOIN movements m ON m.tool_id=t.id
    WHERE t.id=? AND t.archived=0 GROUP BY t.id
  `).bind(id).first();
}
async function savePhoto(file, env, oldKey = null) {
  if (!file || !file.size) return oldKey;
  if (!file.type || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("รูปภาพต้องเป็น JPG, PNG หรือ WebP");
  }
  if (file.size > MAX_PHOTO_BYTES) throw new Error("ขนาดรูปภาพต้องไม่เกิน 5 MB");
  const key = `${crypto.randomUUID()}.${file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg"}`;
  await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  if (oldKey && oldKey !== key) await env.PHOTOS.delete(oldKey);
  return key;
}
async function parseBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    const out = {};
    for (const [k, v] of form.entries()) out[k] = v;
    return out;
  }
  return await request.json();
}
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN || "";
  const headers = { "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "Content-Type, Authorization, X-Setup-Key" };
  if (origin && allowed && origin === allowed) headers["access-control-allow-origin"] = origin;
  if (origin && !allowed) headers["access-control-allow-origin"] = origin;
  headers["vary"] = "Origin";
  return headers;
}
function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}
async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status: 204 });
  if (path === "/api/health" && method === "GET") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    return json({ ok: true, setupRequired: Number(row.n) === 0 });
  }

  if (path === "/api/setup" && method === "POST") {
    if (!env.SETUP_SECRET) return json({ error: "ยังไม่ได้ตั้งค่า SETUP_SECRET ใน Cloudflare" }, 500);
    if (!safeEqual(request.headers.get("x-setup-key") || "", env.SETUP_SECRET)) return json({ error: "Setup key ไม่ถูกต้อง" }, 403);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    if (Number(count.n) > 0) return json({ error: "สร้างผู้ดูแลระบบแล้ว ไม่สามารถใช้ Setup ซ้ำได้" }, 409);
    const body = await request.json();
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) return json({ error: "Username ต้องมี 3-40 ตัว ใช้ a-z, 0-9, จุด ขีด หรือขีดล่าง" }, 400);
    if (password.length < 12) return json({ error: "รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร" }, 400);
    const record = await newPasswordRecord(password);
    await env.DB.prepare("INSERT INTO users (username,password_salt,password_hash,role) VALUES (?,?,?,'admin')")
      .bind(username, record.salt, record.hash).run();
    return json({ ok: true, message: "สร้าง Admin สำเร็จ กรุณาเข้าสู่ระบบ" }, 201);
  }

  if (path === "/api/login" && method === "POST") {
    const body = await request.json();
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const user = await env.DB.prepare("SELECT * FROM users WHERE username=? AND active=1").bind(username).first();
    if (!user || !safeEqual(await passwordHash(password, user.password_salt), user.password_hash)) {
      return json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, 401);
    }
    if (!env.SESSION_SECRET) return json({ error: "ยังไม่ได้ตั้งค่า SESSION_SECRET ใน Cloudflare" }, 500);
    return json({ token: await issueToken(user, env.SESSION_SECRET), user: { id: user.id, username: user.username, role: user.role } });
  }

  const user = await requireUser(request, env);
  if (!user) return json({ error: "กรุณาเข้าสู่ระบบใหม่" }, 401);

  if (path === "/api/me" && method === "GET") return json({ id: user.id, username: user.username, role: user.role });

  if (path === "/api/tools" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const like = `%${q}%`;
    const rows = await env.DB.prepare(`
      SELECT t.*,
        COALESCE(SUM(CASE WHEN m.movement_type='IN' THEN m.quantity
                          WHEN m.movement_type='OUT' THEN -m.quantity
                          WHEN m.movement_type='ADJUST' THEN m.quantity ELSE 0 END), 0) AS stock
      FROM tools t LEFT JOIN movements m ON m.tool_id=t.id
      WHERE t.archived=0 AND (?='' OR t.tool_code LIKE ? OR t.tool_name LIKE ? OR t.production_line LIKE ? OR t.process_machine LIKE ?)
      GROUP BY t.id ORDER BY t.updated_at DESC LIMIT 500
    `).bind(q, like, like, like, like).all();
    return json({ items: rows.results || [] });
  }

  const toolMatch = path.match(/^\/api\/tools\/(\d+)$/);
  if (path === "/api/tools" && method === "POST") {
    const body = await parseBody(request);
    const code = String(body.tool_code || "").trim();
    const name = String(body.tool_name || "").trim();
    const qty = Number(body.initial_qty || 0);
    if (!code || !name) return json({ error: "กรุณาระบุรหัสและชื่อเครื่องมือ" }, 400);
    if (code.length > 60 || name.length > 200) return json({ error: "รหัสหรือชื่อยาวเกินกำหนด" }, 400);
    if (!Number.isInteger(qty) || qty < 0 || qty > 1000000) return json({ error: "จำนวนเริ่มต้นไม่ถูกต้อง" }, 400);
    const fields = ["category","unit","production_line","process_machine","storage_location","notes"];
    for (const field of fields) if (body[field] !== undefined && !validText(String(body[field]), 500)) return json({ error: `ข้อมูล ${field} ยาวเกินกำหนด` }, 400);
    let photoKey = null;
    try { photoKey = await savePhoto(body.photo instanceof File ? body.photo : null, env); }
    catch (e) { return json({ error: e.message }, 400); }
    try {
      const result = await env.DB.prepare(`
        INSERT INTO tools (tool_code,tool_name,category,unit,production_line,process_machine,storage_location,photo_key,notes,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).bind(code, name, String(body.category || ""), String(body.unit || "ชิ้น"), String(body.production_line || ""),
        String(body.process_machine || ""), String(body.storage_location || ""), photoKey, String(body.notes || ""), user.id).run();
      const id = result.meta.last_row_id;
      if (qty > 0) await env.DB.prepare(`
        INSERT INTO movements (tool_id,movement_type,quantity,movement_date,purpose,notes,created_by)
        VALUES (?,'IN',?,?,?, ?,?)
      `).bind(id, qty, String(body.received_date || dateToday()), "ยอดรับเข้าเริ่มต้น", "ยอดตั้งต้นตอนสร้างรายการ", user.id).run();
      return json({ item: await toolDetail(env, id) }, 201);
    } catch (e) {
      if (photoKey) await env.PHOTOS.delete(photoKey);
      if (String(e).includes("UNIQUE")) return json({ error: "รหัสเครื่องมือนี้มีอยู่แล้ว" }, 409);
      throw e;
    }
  }

  if (toolMatch && method === "PUT") {
    const id = Number(toolMatch[1]);
    const existing = await env.DB.prepare("SELECT * FROM tools WHERE id=? AND archived=0").bind(id).first();
    if (!existing) return json({ error: "ไม่พบเครื่องมือ" }, 404);
    const body = await parseBody(request);
    const code = String(body.tool_code || "").trim();
    const name = String(body.tool_name || "").trim();
    if (!code || !name) return json({ error: "กรุณาระบุรหัสและชื่อเครื่องมือ" }, 400);
    let photoKey = existing.photo_key;
    try {
      if (body.remove_photo === "true") { if (photoKey) await env.PHOTOS.delete(photoKey); photoKey = null; }
      if (body.photo instanceof File && body.photo.size) photoKey = await savePhoto(body.photo, env, photoKey);
    } catch (e) { return json({ error: e.message }, 400); }
    try {
      await env.DB.prepare(`
        UPDATE tools SET tool_code=?,tool_name=?,category=?,unit=?,production_line=?,process_machine=?,storage_location=?,photo_key=?,notes=?,updated_at=datetime('now')
        WHERE id=?
      `).bind(code, name, String(body.category || ""), String(body.unit || "ชิ้น"), String(body.production_line || ""),
        String(body.process_machine || ""), String(body.storage_location || ""), photoKey, String(body.notes || ""), id).run();
    } catch (e) {
      if (String(e).includes("UNIQUE")) return json({ error: "รหัสเครื่องมือนี้มีอยู่แล้ว" }, 409);
      throw e;
    }
    return json({ item: await toolDetail(env, id) });
  }

  if (toolMatch && method === "DELETE") {
    if (user.role !== "admin") return json({ error: "เฉพาะ Admin เท่านั้นที่ลบรายการได้" }, 403);
    const id = Number(toolMatch[1]);
    await env.DB.prepare("UPDATE tools SET archived=1,updated_at=datetime('now') WHERE id=?").bind(id).run();
    return json({ ok: true, message: "ซ่อนรายการแล้ว โดยเก็บประวัติไว้" });
  }

  const movementMatch = path.match(/^\/api\/tools\/(\d+)\/movements$/);
  if (movementMatch && method === "GET") {
    const id = Number(movementMatch[1]);
    const rows = await env.DB.prepare(`
      SELECT m.*,u.username FROM movements m LEFT JOIN users u ON u.id=m.created_by
      WHERE m.tool_id=? ORDER BY m.movement_date DESC,m.id DESC LIMIT 500
    `).bind(id).all();
    return json({ items: rows.results || [] });
  }
  if (movementMatch && method === "POST") {
    const id = Number(movementMatch[1]);
    const tool = await toolDetail(env, id);
    if (!tool) return json({ error: "ไม่พบเครื่องมือ" }, 404);
    const body = await request.json();
    const type = String(body.movement_type || "");
    const qty = Number(body.quantity);
    const movementDate = String(body.movement_date || dateToday());
    if (!["IN", "OUT"].includes(type)) return json({ error: "ประเภทต้องเป็นรับเข้า หรือเบิกออก" }, 400);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000000) return json({ error: "จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป" }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(movementDate)) return json({ error: "รูปแบบวันที่ไม่ถูกต้อง" }, 400);
    const current = Number(tool.stock || 0);
    if (type === "OUT" && current < qty) return json({ error: `ยอดคงเหลือไม่พอ (คงเหลือ ${current})` }, 409);
    await env.DB.prepare(`
      INSERT INTO movements (tool_id,movement_type,quantity,movement_date,reference_no,purpose,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).bind(id, type, qty, movementDate, String(body.reference_no || ""), String(body.purpose || ""),
      String(body.notes || ""), user.id).run();
    return json({ item: await toolDetail(env, id) }, 201);
  }

  const imageMatch = path.match(/^\/api\/images\/([a-zA-Z0-9._-]+)$/);
  if (imageMatch && method === "GET") {
    const photo = await env.PHOTOS.get(imageMatch[1]);
    if (!photo) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    photo.writeHttpMetadata(headers);
    headers.set("cache-control", "private, max-age=300");
    headers.set("x-content-type-options", "nosniff");
    return new Response(photo.body, { headers });
  }

  if (path === "/api/users" && method === "GET") {
    if (user.role !== "admin") return json({ error: "เฉพาะ Admin เท่านั้น" }, 403);
    const rows = await env.DB.prepare("SELECT id,username,role,active,created_at FROM users ORDER BY id").all();
    return json({ items: rows.results || [] });
  }
  if (path === "/api/users" && method === "POST") {
    if (user.role !== "admin") return json({ error: "เฉพาะ Admin เท่านั้น" }, 403);
    const body = await request.json();
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const role = body.role === "admin" ? "admin" : "user";
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) return json({ error: "Username ต้องมี 3-40 ตัวอักษร" }, 400);
    if (password.length < 12) return json({ error: "รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร" }, 400);
    const record = await newPasswordRecord(password);
    try {
      await env.DB.prepare("INSERT INTO users (username,password_salt,password_hash,role) VALUES (?,?,?,?)")
        .bind(username, record.salt, record.hash, role).run();
      return json({ ok: true }, 201);
    } catch (e) {
      if (String(e).includes("UNIQUE")) return json({ error: "Username นี้มีแล้ว" }, 409);
      throw e;
    }
  }

  return json({ error: "ไม่พบ API ที่เรียก" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        const response = await api(request, env);
        return withCors(response, request, env);
      }
      if (request.method === "GET" && env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: "เกิดข้อผิดพลาดภายในระบบ" }, 500);
    }
  }
};
