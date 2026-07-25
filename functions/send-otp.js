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
 *                                (مثال: "Rawaa <no-reply@yourdomain.com>").
 *                                إن لم يُضبط يُستعمل "onboarding@resend.dev" (للاختبار فقط،
 *                                يصل فقط لبريد مالك حساب Resend).
 *   OTP_EMAIL_SUBJECT (اختياري) — موضوع الرسالة. افتراضي: "كود التحقق الخاص بك".
 *
 * ── ملاحظة أمنية ──
 *   المفتاح السري RESEND_API_KEY محفوظ حصراً في متغيرات بيئة Cloudflare Pages
 *   ولا يُكتب في هذا الملف إطلاقاً. لا تضع المفتاح في الكود ولا في المستودع.
 * ====================================================================
 */

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'onboarding@resend.dev';
const DEFAULT_SUBJECT = 'كود التحقق الخاص بك';

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

/** يبني محتوى البريد بصيغة HTML (RTL، بنفس هوية الموقع) */
function buildOtpHtml(otp) {
    return ''
        + '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;'
        + 'border:1px solid #eee;border-radius:12px;padding:24px;text-align:center;background:#ffffff">'
        +   '<h2 style="color:#c8102e;margin:0 0 12px;font-size:20px">كود التحقق</h2>'
        +   '<p style="color:#444;font-size:15px;margin:0 0 8px">'
        +     'استعمل الكود التالي لإتمام التحقق من بريدك الإلكتروني:'
        +   '</p>'
        +   '<div style="font-size:34px;letter-spacing:8px;font-weight:bold;color:#c8102e;'
        +     'background:#fafafa;border:1px dashed #ddd;border-radius:8px;padding:14px;margin:16px 0">'
        +     String(otp)
        +   '</div>'
        +   '<p style="color:#888;font-size:12px;margin:0">'
        +     'الكود صالح لمدة 10 دقائق. إن لم تطلب هذا الكود بنفسك فتجاهل هذه الرسالة.'
        +   '</p>'
        + '</div>';
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
    const subject = (env && env.OTP_EMAIL_SUBJECT) || DEFAULT_SUBJECT;

    // 4) استدعاء واجهة Resend لإرسال البريد
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
                subject: subject,
                html: buildOtpHtml(otp)
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
