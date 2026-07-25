/**
 * ====================================================================
 * Cloudflare Pages Function  —  /send-otp
 * ====================================================================
 * نقطة نهاية تُرسل كود التحقق (OTP) عبر خدمة Brevo (سابقاً Sendinblue).
 *
 * تُستعمل من طرف الواجهة (index.html) عبر الدالة المشتركة sendOtpEmail()
 * في ثلاث حالات فقط:
 *   1) تأكيد البريد عند تسجيل عضو جديد
 *   2) تأكيد تغيير بريد العضو من الملف الشخصي
 *   3) تأكيد تغيير بريد المسؤول
 * (إعادة تعيين كلمة المرور تبقى على EmailJS ولا تمر من هنا).
 *
 * لماذا Brevo بدل Resend؟ Brevo يمنح 300 رسالة/يوم مجاناً للأبد (≈9000/شهر)
 * مقابل 100/يوم في Resend، ويكفي توثيق عنوان بريد مُرسِل واحد (بدل توثيق نطاق كامل)
 * ليصبح جاهزاً للإنتاج.
 *
 * ── طلب الاستدعاء ──
 *   POST /send-otp
 *   Content-Type: application/json
 *   Body: { "email": "user@example.com", "otp": "123456" }
 *
 * ── الاستجابة ──
 *   نجاح:  200  { "ok": true,  "messageId": "<brevo-message-id>" }   (Brevo يُرجع 201، نُوحّده إلى 200)
 *   فشل:   400  { "ok": false, "error": "INVALID_EMAIL" | "MISSING_OTP" | "INVALID_JSON" }
 *           405  { "ok": false, "error": "METHOD_NOT_ALLOWED" }
 *           500  { "ok": false, "error": "BREVO_API_KEY_NOT_CONFIGURED" | "BREVO_FROM_NOT_CONFIGURED" }
 *           502  { "ok": false, "error": "BREVO_API_ERROR" | "BREVO_FETCH_EXCEPTION",
 *                  "status": <number>, "detail": "<text>" }
 *
 * ── متغيرات البيئة المطلوبة (تُضبط في Cloudflare Pages > Settings > Environment variables) ──
 *   BREVO_API_KEY    (إلزامي) — مفتاح Brevo السري. يُولَّد من Brevo → Companies/Organization → SMTP & API → API Keys.
 *                             يُقرأ من env ولن يظهر في الكود أبداً.
 *   BREVO_FROM       (إلزامي) — عنوان المُرسِل. صيغتان مقبولتان:
 *                                • بريد فقط:        "no-reply@yourdomain.com"
 *                                • اسم + بريد:      "Rawaa <no-reply@yourdomain.com>"
 *                              يجب أن يكون العنوان مُوثَّقاً في Brevo → Senders & IP.
 *   BREVO_FROM_NAME  (اختياري) — اسم المُرسِل الظاهر عند استخدام BREVO_FROM كبريد فقط.
 *                                افتراضي: "Rawaa".
 *   OTP_EMAIL_SUBJECT (اختياري) — موضوع الرسالة. افتراضي: "كود التحقق الخاص بك".
 *
 * ── ملاحظة أمنية ──
 *   المفتاح السري BREVO_API_KEY محفوظ حصراً في متغيرات بيئة Cloudflare Pages
 *   ولا يُكتب في هذا الملف إطلاقاً. لا تضع المفتاح في الكود ولا في المستودع.
 * ====================================================================
 */

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_FROM_NAME = 'Rawaa';
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

/**
 * يحلّل قيمة BREVO_FROM إلى كائن المُرسِل الذي يتوقّعه Brevo {name, email}.
 * يقبل صيغتين:
 *   • "Rawaa <no-reply@yourdomain.com>"  → { name:"Rawaa", email:"no-reply@yourdomain.com" }
 *   • "no-reply@yourdomain.com"          → { name:<defaultName>, email:"no-reply@yourdomain.com" }
 */
function parseSender(fromStr, defaultName) {
    const s = String(fromStr || '').trim();
    // مطابقة: "Name" <email>   أو   Name <email>
    const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
    if (m) {
        const name = m[1].trim();
        return { name: name || defaultName, email: m[2].trim() };
    }
    // بريد فقط
    return { name: defaultName, email: s };
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
    const apiKey = env && env.BREVO_API_KEY;
    if (!apiKey) {
        return jsonResponse({ ok: false, error: 'BREVO_API_KEY_NOT_CONFIGURED' }, 500);
    }

    // 2) عنوان المُرسِل (إلزامي في Brevo — لا يوجد عنوان افتراضي عالمي)
    const fromStr = env && env.BREVO_FROM;
    if (!fromStr || !String(fromStr).trim()) {
        return jsonResponse({ ok: false, error: 'BREVO_FROM_NOT_CONFIGURED' }, 500);
    }
    const fromName = (env && env.BREVO_FROM_NAME) || DEFAULT_FROM_NAME;
    const sender = parseSender(fromStr, fromName);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender.email)) {
        return jsonResponse({ ok: false, error: 'INVALID_BREVO_FROM' }, 500);
    }

    // 3) قراءة جسم الطلب {email, otp}
    let body;
    try {
        body = await request.json();
    } catch (_) {
        return jsonResponse({ ok: false, error: 'INVALID_JSON' }, 400);
    }

    const email = (body && body.email != null) ? String(body.email).trim() : '';
    const otp = (body && body.otp != null) ? String(body.otp).trim() : '';

    // 4) تحقق بسيط من المدخلات
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ ok: false, error: 'INVALID_EMAIL' }, 400);
    }
    if (!otp) {
        return jsonResponse({ ok: false, error: 'MISSING_OTP' }, 400);
    }

    const subject = (env && env.OTP_EMAIL_SUBJECT) || DEFAULT_SUBJECT;

    // 5) استدعاء واجهة Brevo لإرسال البريد
    //    Brevo يتوقّع: ترويسة api-key (وليس Authorization)، وجسم بـ sender/to/subject/htmlContent.
    try {
        const resp = await fetch(BREVO_API_URL, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'content-type': 'application/json',
                'api-key': apiKey
            },
            body: JSON.stringify({
                sender: { name: sender.name, email: sender.email },
                to: [{ email: email }],
                subject: subject,
                htmlContent: buildOtpHtml(otp)
            })
        });

        // Brevo يُرجع 201 Created عند النجاح؛ resp.ok يغطّي 200–299
        if (!resp.ok && resp.status !== 201) {
            const errText = await resp.text().catch(() => '');
            return jsonResponse({
                ok: false,
                error: 'BREVO_API_ERROR',
                status: resp.status,
                detail: errText
            }, 502);
        }

        const data = await resp.json().catch(() => ({ messageId: null }));
        return jsonResponse({ ok: true, messageId: (data && data.messageId) || null });
    } catch (e) {
        return jsonResponse({
            ok: false,
            error: 'BREVO_FETCH_EXCEPTION',
            detail: String((e && e.message) || e)
        }, 502);
    }
}

/** تقييد طريقة الطلب: POST فقط */
export async function onRequestGet() {
    return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
}
