/**
 * ====================================================================
 * Cloudflare Pages Function  —  /send-otp
 * ====================================================================
 * نقطة نهاية تُرسل كود التحقق (OTP) عبر خدمة Resend.
 *
 * تُستعمل من طرف الواجهة (index.html) عبر الدالة المشتركة sendOtpViaResend()
 * في ثلاث حالات فقط:
 *   1) تأكيد البريد عند تسجيل عضو جديد
 *   2) تأكيد تغيير بريد العضو من الملف الشخصي
 *   3) تأكيد تغيير بريد المسؤول
 * (إعادة تعيين كلمة المرور تبقى على EmailJS ولا تمر من هنا).
 *
 * ── طلب الاستدعاء ──
 *   POST /send-otp
 *   Content-Type: application/json
 *   Body: { "email": "user@example.com", "otp": "123456" }
 *
 * ── الاستجابة ──
 *   نجاح:  200  { "ok": true,  "id": "<resend-message-id>" }
 *   فشل:   400  { "ok": false, "error": "INVALID_EMAIL" | "MISSING_OTP" | "INVALID_JSON" }
 *           405  { "ok": false, "error": "METHOD_NOT_ALLOWED" }
 *           500  { "ok": false, "error": "RESEND_API_KEY_NOT_CONFIGURED" }
 *           502  { "ok": false, "error": "RESEND_API_ERROR" | "RESEND_FETCH_EXCEPTION",
 *                  "status": <number>, "detail": "<text>" }
 *
 * ── متغيرات البيئة المطلوبة (تُضبط في Cloudflare Pages > Settings > Environment variables) ──
 *   RESEND_API_KEY   (إلزامي)  — مفتاح Resend السري، يُقرأ من env ولن يظهر في الكود أبداً.
 *   RESEND_FROM      (اختياري) — عنوان المُرسِل من نطاقك المُوثّق في Resend
 *                                (مثال: "meetha9 <noreply@meetha9.pages.dev>").
 *                                إن لم يُضبط يُستعمل "noreply@meetha9.pages.dev" (للاختبار فقط،
 *                                يصل فقط لبريد مالك حساب Resend).
 *   RESEND_TEMPLATE_ID (اختياري) — معرّف قالب "رمز التحقق" على لوحة Resend > Templates.
 *                                  إن لم يُضبط يُستعمل المعرّف الافتراضي المكتوب في الكود.
 *
 * ── ملاحظة أمنية ──
 *   المفتاح السري RESEND_API_KEY محفوظ حصراً في متغيرات بيئة Cloudflare Pages
 *   ولا يُكتب في هذا الملف إطلاقاً. لا تضع المفتاح في الكود ولا في المستودع.
 * ====================================================================
 */

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'ميثاق <onboarding@resend.dev>';
// معرّف قالب "رمز التحقق" المحفوظ والمنشور على لوحة تحكم Resend (Templates)
const DEFAULT_TEMPLATE_ID = '6f6d13c9-a595-44a7-b22d-c69e653dc3a2';

/** مساعد: يُرجع استجابة JSON موحّدة */
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            // لا نخزّن أكواد OTP مؤقتاً (حساسة وزمنية)
            'Cache-Control': 'no-store'
        }
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;

    // 1) قراءة المفتاح السري من البيئة فقط (لا يُكتب في الكود)
    const apiKey = env && env.RESEND_API_KEY;
    if (!apiKey) {
        return jsonResponse({ ok: false, error: 'RESEND_API_KEY_NOT_CONFIGURED' }, 500);
    }

    // 2) قراءة جسم الطلب {email, otp}
    let body;
    try {
        body = await request.json();
    } catch (_) {
        return jsonResponse({ ok: false, error: 'INVALID_JSON' }, 400);
    }

    const email = (body && body.email != null) ? String(body.email).trim() : '';
    const otp = (body && body.otp != null) ? String(body.otp).trim() : '';

    // 3) تحقق بسيط من المدخلات
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ ok: false, error: 'INVALID_EMAIL' }, 400);
    }
    if (!otp) {
        return jsonResponse({ ok: false, error: 'MISSING_OTP' }, 400);
    }

    const fromAddress = (env && env.RESEND_FROM) || DEFAULT_FROM;
    const templateId = (env && env.RESEND_TEMPLATE_ID) || DEFAULT_TEMPLATE_ID;

    // 4) استدعاء واجهة Resend لإرسال البريد عبر القالب المحفوظ (Templates)
    try {
        const resp = await fetch(RESEND_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: fromAddress,
                to: email,
                template: {
                    id: templateId,
                    variables: {
                        OTP_CODE: otp
                    }
                }
            })
        });

        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            return jsonResponse({
                ok: false,
                error: 'RESEND_API_ERROR',
                status: resp.status,
                detail: errText
            }, 502);
        }

        const data = await resp.json().catch(() => ({ id: null }));
        return jsonResponse({ ok: true, id: (data && data.id) || null });
    } catch (e) {
        return jsonResponse({
            ok: false,
            error: 'RESEND_FETCH_EXCEPTION',
            detail: String((e && e.message) || e)
        }, 502);
    }
}

/** تقييد طريقة الطلب: POST فقط */
export async function onRequestGet() {
    return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
}
