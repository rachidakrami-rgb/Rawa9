// ====================================================================
// Cloudflare Pages Function: /api/brevo/send-code
// ====================================================================
// هذا الملف يُنشر تلقائياً على شبكة Cloudflare عند رفع مجلد work/ إلى
// Cloudflare Pages. يقوم بمعالجة طلبات POST على المسار /api/brevo/send-code
// وإرسال بريد أكواد التحقق/استعادة كلمة المرور عبر Brevo API.
//
// متغيرات البيئة المطلوبة (تُضبط في لوحة Cloudflare Pages:
//   Settings > Environment variables > Production):
//   - BREVO_API_KEY        : مفتاح Brevo API v3 (يبدأ بـ xkeysib-...)
//   - BREVO_SENDER_EMAIL   : بريد مُرسِل مُوثَّق في Brevo
//   - BREVO_SENDER_NAME    : اسم المُرسِل (افتراضي: ميثاق)
// ====================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

async function handleSendCode(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json(
      { success: false, error: 'صيغة الطلب غير صحيحة (JSON متوقع).' },
      400
    );
  }

  const email = body && body.email;
  const code = body && body.code;
  const type = body && body.type === 'reset' ? 'reset' : 'verify';

  if (!email || !code) {
    return json(
      { success: false, error: 'البريد الإلكتروني وكود التحقق مطلوبان.' },
      400
    );
  }

  // Basic email format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    return json(
      { success: false, error: 'صيغة البريد الإلكتروني غير صحيحة.' },
      400
    );
  }

  const BREVO_API_KEY = env && env.BREVO_API_KEY;
  const BREVO_SENDER_EMAIL =
    (env && env.BREVO_SENDER_EMAIL) || 'no-reply@meetha9.pages.dev';
  const BREVO_SENDER_NAME = (env && env.BREVO_SENDER_NAME) || 'ميثاق';

  if (!BREVO_API_KEY) {
    console.error('[brevo/send-code] BREVO_API_KEY is not set in environment.');
    return json(
      {
        success: false,
        error:
          'خدمة البريد غير مُهيّأة من طرف الإدارة (BREVO_API_KEY غير مضبوط في Cloudflare).',
      },
      500
    );
  }

  const isReset = type === 'reset';
  const subject = isReset
    ? 'كود استعادة كلمة المرور — منصة ميثاق'
    : 'كود التحقق من البريد الإلكتروني — منصة ميثاق';

  const heading = isReset
    ? 'طلب استعادة كلمة المرور'
    : 'تأكيد بريدك الإلكتروني';
  const intro = isReset
    ? 'تلقّينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك في منصة ميثاق. استخدم الكود التالي:'
    : 'شكراً لتسجيلك في منصة ميثاق. استخدم الكود التالي لتأكيد بريدك الإلكتروني:';

  const safeCode = String(code).replace(/[<>"]/g, '');
  const htmlContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f9;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,#ffd76e 0%,#b8860b 100%);padding:24px 32px;text-align:center;">
              <div style="font-size:26px;font-weight:800;color:#3a2a00;letter-spacing:0.5px;">ميثاق</div>
              <div style="font-size:13px;color:#5a4a00;margin-top:4px;">منصة ميثاق للربط الشرعي والآمن</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 12px;color:#1f2937;font-size:20px;text-align:center;">${heading}</h2>
              <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.7;text-align:center;">${intro}</p>
              <div style="margin:24px auto 24px;text-align:center;">
                <div style="display:inline-block;padding:18px 36px;background-color:#fef3c7;border:2px dashed #f59e0b;border-radius:12px;">
                  <span style="font-size:34px;font-weight:800;letter-spacing:10px;color:#b45309;font-family:'Courier New',monospace;">${safeCode}</span>
                </div>
              </div>
              <p style="margin:0 0 8px;color:#6b7280;font-size:13px;text-align:center;">هذا الكود صالح لمدة <strong>10 دقائق</strong> فقط.</p>
              <p style="margin:0 0 0;color:#6b7280;font-size:13px;text-align:center;">إذا لم تطلب هذا الكود، يمكنك تجاهل هذه الرسالة بأمان.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">© منصة ميثاق — رسالة آلية، يرجى عدم الرد عليها.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textContent = `${heading}\n\n${intro}\n\nالكود: ${safeCode}\n\nصالح لمدة 10 دقائق.\n— منصة ميثاق`;

  let brevoResponse;
  try {
    brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email }],
        subject,
        htmlContent,
        textContent,
      }),
    });
  } catch (networkErr) {
    console.error('[brevo/send-code] Network error to Brevo:', networkErr);
    return json(
      {
        success: false,
        error: 'تعذّر الاتصال بخوادم Brevo. تحقق من اتصال الشبكة.',
      },
      502
    );
  }

  if (!brevoResponse.ok) {
    const errText = await brevoResponse.text().catch(() => '');
    console.error(
      `[brevo/send-code] Brevo API error: ${brevoResponse.status} ${brevoResponse.statusText}`,
      errText
    );

    let userMsg = 'تعذّر إرسال البريد عبر خدمة Brevo. يرجى المحاولة لاحقاً.';
    const lowerErr = (errText || '').toLowerCase();

    // Detect "Authorised IPs" restriction first
    if (
      lowerErr.includes('unrecognised ip address') ||
      lowerErr.includes('unrecognized ip address') ||
      lowerErr.includes('authorised_ips')
    ) {
      userMsg =
        'مفتاح Brevo صالح، لكن حسابك يفعّل ميزة "Authorised IPs" (تقييد عناوين IP). ' +
        'لا يمكن قبول 0.0.0.0/0. الحل الوحيد: إيقاف هذه الميزة بالكامل من لوحة Brevo ' +
        '(Security > Authorised IPs > إيقاف الميزة)، لأن Cloudflare Pages Functions ' +
        'تعمل من عشرات عناوين IP المتغيرة.';
    } else if (brevoResponse.status === 401 || brevoResponse.status === 403) {
      userMsg = 'مفتاح Brevo API غير صالح أو منتهي الصلاحية. يرجى مراجعة الإعدادات.';
    } else if (brevoResponse.status === 400) {
      userMsg =
        'تعذّر إرسال البريد: تحقق من أن بريد المُرسِل (BREVO_SENDER_EMAIL) مُوثَّق في لوحة Brevo.';
    } else if (brevoResponse.status === 429) {
      userMsg = 'تم تجاوز حد الإرسال المسموح في Brevo. حاول لاحقاً.';
    }

    return json(
      { success: false, error: userMsg, brevoStatus: brevoResponse.status },
      502
    );
  }

  return json({ success: true });
}

// Cloudflare Pages Functions entry point
export async function onRequestPost(context) {
  return handleSendCode(context.request, context.env);
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}
