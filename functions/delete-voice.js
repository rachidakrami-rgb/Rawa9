/**
 * ====================================================================
 * Cloudflare Pages Function  —  /delete-voice
 * ====================================================================
 * نقطة نهاية تُحذف ملفّات الرسائل الصوتية المنتهية صلاحيتها من Cloudinary.
 *
 * السبب: رفع الرسائل الصوتية يتم عبر upload preset غير موقّع (Rawa9voice)
 * من المتصفّح مباشرةً، لكن الحذف يتطلّب توقيعاً بالـ API Secret — وهو سرّ لا
 * يمكن كشفه للعميل. لذلك يُنفَّذ الحذف هنا على الخادم.
 *
 * يُستعمل من طرف الواجهة (index.html) عبر الدالة deleteVoiceAssetsFromCloudinary()
 * التي تُستدعى بدورها من sweepExpiredVoiceMessages() كلما حُذفت رسالة صوتية
 * انتهت صلاحيتها (أكثر من 24 ساعة على إرسالها) من Firestore.
 *
 * ── طلب الاستدعاء ──
 *   POST /delete-voice
 *   Content-Type: application/json
 *   Body (إحدى الصيغتين):
 *     { "urls":      ["https://res.cloudinary.com/<cloud>/<rtype>/upload/v123/voice_messages/abc.webm", ...] }
 *     { "publicIds": ["voice_messages/abc", "voice_messages/xyz"] }
 *
 * ── الاستجابة ──
 *   نجاح:  200  { "ok": true, "deleted": N, "skipped": [...], "failed": [...] }
 *   فشل:   400  { "ok": false, "error": "INVALID_JSON" | "NO_INPUT" | "TOO_MANY" }
 *          405  { "ok": false, "error": "METHOD_NOT_ALLOWED" }
 *          500  { "ok": false, "error": "CLOUDINARY_NOT_CONFIGURED" }
 *
 * ── متغيرات البيئة المطلوبة (تُضبط في Cloudflare Pages > Settings > Environment variables) ──
 *   CLOUDINARY_CLOUD_NAME   (إلزامي) — اسم السحابة (نفسه المستخدم في الرفع، مثال: ofamxqkm).
 *   CLOUDINARY_API_KEY      (إلزامي) — مفتاح Cloudinary API (لوحة Cloudinary → Dashboard).
 *   CLOUDINARY_API_SECRET   (إلزامي) — سرّ Cloudinary API. يُقرأ من env ولن يظهر في الكود.
 *
 * ── حماية ──
 *   • لا يُسمح إلا بالملفّات داخل مجلد voice_messages/ (يُتحقَّق من بادئة public_id)،
 *     فلا يمكن لأحد استعمال هذه النقطة لحذف صور الأعضاء أو أي أصول أخرى.
 *   • حد أقصى 50 ملفّاً لكل طلب (تفادي الإساءة).
 *   • المفتاح السري محفوظ حصراً في متغيرات بيئة Cloudflare Pages.
 * ====================================================================
 */

const MAX_BATCH = 50;
const ALLOWED_PREFIX = 'voice_messages/';

/** مساعد: استجابة JSON موحّدة */
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

/**
 * يستخرج {resource_type, public_id} من رابط Cloudinary secure_url.
 * أمثلة مدعومة:
 *   https://res.cloudinary.com/<cloud>/video/upload/v123456/voice_messages/abc.webm
 *     → { resourceType:'video', publicId:'voice_messages/abc' }
 *   https://res.cloudinary.com/<cloud>/auto/upload/voice_messages/xyz.mp4
 *     → { resourceType:'auto',  publicId:'voice_messages/xyz' }
 *   https://res.cloudinary.com/<cloud>/raw/upload/v1/voice_messages/foo.ogg
 *     → { resourceType:'raw',   publicId:'voice_messages/foo' }
 * يُرجع null عند الفشل.
 */
function parseCloudinaryUrl(url) {
    const s = String(url || '').trim();
    // نلتقط:  .../<resourceType>/upload/[v<digits>/]<publicId>.<ext>
    const m = s.match(/\/([^/]+)\/upload\/(?:v\d+\/)?(.+)$/);
    if (!m) return null;
    const resourceType = m[1];
    let publicId = m[2];
    // إزالة الامتداد إن وُجد (آخر نقطة بعد آخر شرطة مائلة)
    const slashIdx = publicId.lastIndexOf('/');
    const lastSegment = slashIdx >= 0 ? publicId.slice(slashIdx + 1) : publicId;
    const dotIdx = lastSegment.lastIndexOf('.');
    if (dotIdx > 0) {
        // إزالة الامتداد من المقطع الأخير فقط (المجلدات قد تحوي نقاطاً)
        const cleanLast = lastSegment.slice(0, dotIdx);
        publicId = slashIdx >= 0 ? publicId.slice(0, slashIdx + 1) + cleanLast : cleanLast;
    }
    if (!resourceType || !publicId) return null;
    return { resourceType, publicId };
}

/**
 * يحسب توقيع Cloudinary عبر Web Crypto API (SHA-1 متاح في Cloudflare Workers).
 * الصيغة المطلوبة: SHA1("public_id=<pid>&timestamp=<ts><api_secret>")
 */
async function cloudinarySignature(publicId, timestamp, apiSecret) {
    const str = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
    const buf = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-1', buf);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

/** يحذف ملفاً واحداً من Cloudinary عبر واجهة destroy الموقّعة */
async function destroyOne(cloudName, apiKey, apiSecret, resourceType, publicId) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await cloudinarySignature(publicId, timestamp, apiSecret);
    const params = new URLSearchParams();
    params.append('public_id', publicId);
    params.append('signature', signature);
    params.append('api_key', apiKey);
    params.append('timestamp', String(timestamp));

    const url = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`;
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        const data = await resp.json().catch(() => ({}));
        // Cloudinary يُرجع { result: 'ok' | 'not found' | ... }
        if (resp.ok && data && (data.result === 'ok' || data.result === 'not found')) {
            return { ok: true, result: data.result };
        }
        return { ok: false, result: data && data.result, detail: data && data.error ? data.error.message : '' };
    } catch (e) {
        return { ok: false, detail: String((e && e.message) || e) };
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;

    // 1) متغيرات البيئة الإلزامية
    const cloudName = env && env.CLOUDINARY_CLOUD_NAME;
    const apiKey = env && env.CLOUDINARY_API_KEY;
    const apiSecret = env && env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
        return jsonResponse({ ok: false, error: 'CLOUDINARY_NOT_CONFIGURED' }, 500);
    }

    // 2) قراءة الجسم
    let body;
    try {
        body = await request.json();
    } catch (_) {
        return jsonResponse({ ok: false, error: 'INVALID_JSON' }, 400);
    }

    // 3) بناء قائمة {resourceType, publicId} من urls أو publicIds
    /** @type {{resourceType:string, publicId:string, source:string}[]} */
    const targets = [];
    const urls = Array.isArray(body && body.urls) ? body.urls : [];
    const publicIds = Array.isArray(body && body.publicIds) ? body.publicIds : [];

    if (urls.length === 0 && publicIds.length === 0) {
        return jsonResponse({ ok: false, error: 'NO_INPUT' }, 400);
    }
    if (urls.length + publicIds.length > MAX_BATCH) {
        return jsonResponse({ ok: false, error: 'TOO_MANY', max: MAX_BATCH }, 400);
    }

    // من urls: نستخرج resource_type + public_id من الرابط نفسه (الأدق)
    for (const u of urls) {
        const parsed = parseCloudinaryUrl(u);
        if (!parsed) continue;
        targets.push({ resourceType: parsed.resourceType, publicId: parsed.publicId, source: String(u) });
    }
    // من publicIds: لا نعرف resource_type بدقة → نجرّب video أولاً (الأكثر شيوعاً للصوت
    // المرفوع عبر resource_type=auto) ثم raw كاحتياط في destroyOneRetry.
    for (const pid of publicIds) {
        targets.push({ resourceType: 'video', publicId: String(pid), source: String(pid) });
    }

    // 4) تصفية: نسمح فقط بالملفّات داخل مجلد voice_messages/
    const skipped = [];
    const allowed = [];
    for (const t of targets) {
        if (!t.publicId || !String(t.publicId).startsWith(ALLOWED_PREFIX)) {
            skipped.push(t.publicId || t.source);
        } else {
            allowed.push(t);
        }
    }

    // 5) حذف كل ملف (مع إعادة محاولة بنوع مورد بديل إن فشل الأول)
    let deleted = 0;
    const failed = [];
    for (const t of allowed) {
        let res = await destroyOne(cloudName, apiKey, apiSecret, t.resourceType, t.publicId);
        // إن فشل الأول وكان resourceType غير raw، نُحاول بـ raw (بعض الملفات الصوتية تُخزَّن raw)
        if (!res.ok && t.resourceType !== 'raw') {
            res = await destroyOne(cloudName, apiKey, apiSecret, 'raw', t.publicId);
        }
        // إن فشل أيضاً ونوع الأصل video، نُحاول بـ image استثناءً (لم يحصل أبداً لكن احتياطاً)
        if (!res.ok && t.resourceType === 'video') {
            res = await destroyOne(cloudName, apiKey, apiSecret, 'image', t.publicId);
        }
        if (res.ok) {
            deleted++;
        } else {
            failed.push({ publicId: t.publicId, detail: res.detail || res.result || 'UNKNOWN' });
        }
    }

    return jsonResponse({
        ok: true,
        deleted,
        skipped,
        failed
    });
}

/** تقييد طريقة الطلب: POST فقط */
export async function onRequestGet() {
    return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
}
