// ====================================================================
// FCM Push Notification Relay Worker — uses FCM HTTP v1 API
// (بديل Legacy Server Key المُلغى — يستخدم Service Account + OAuth2)
//
// التشغيل المحلي:  bun run dev    ← المنفذ 3020
// النشر على Cloudflare Workers:  wrangler deploy
// ====================================================================

const PORT = 3020;
const PROJECT_ID = 'roua-8484e';

// ⚠️ يجب نسخ بيانات ملف service account JSON هنا (من Firebase Console):
// Firebase Console > إعدادات المشروع > Service accounts > Generate new private key
const SERVICE_ACCOUNT = {
    type: 'service_account',
    project_id: PROJECT_ID,
    private_key_id: '4efbbc533aa43d4f721adb1878ea5c1d97cc936a',
    // ⚠️ الصق المفتاح الخاص الكامل هنا (يبدأ بـ "-----BEGIN PRIVATE KEY-----")
    private_key: 'PASTE_YOUR_PRIVATE_KEY_HERE',
    client_email: 'firebase-adminsdk-fbsvc@roua-8484e.iam.gserviceaccount.com',
    client_id: '102905511242753403802',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40roua-8484e.iam.gserviceaccount.com',
    universe_domain: 'googleapis.com'
};

let cachedAccessToken = null;
let tokenExpiry = 0;

// ==================== JWT Creation (without external libraries) ====================
function base64urlEncode(str) {
    let buf;
    if (typeof Buffer !== 'undefined') {
        buf = Buffer.from(str);
    } else if (typeof TextEncoder !== 'undefined') {
        buf = new TextEncoder().encode(str);
    } else {
        buf = new Uint8Array([]);
        for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
    }
    let binary = '';
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    for (let b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createJWT() {
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: SERVICE_ACCOUNT.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: SERVICE_ACCOUNT.token_uri,
        iat: now,
        exp: now + 3600
    };

    const headerB64 = base64urlEncode(JSON.stringify(header));
    const payloadB64 = base64urlEncode(JSON.stringify(payload));
    const unsignedToken = headerB64 + '.' + payloadB64;

    // Sign with RSA-SHA256 using SubtleCrypto (available in Workers and modern Node)
    const signer = typeof crypto !== 'undefined' && crypto.subtle
        ? crypto.subtle
        : null;

    if (!signer) {
        console.error('crypto.subtle not available');
        return null;
    }

    // We need to use the signer — but this is async
    return { unsignedToken, signer };
}

// ==================== Get OAuth2 Access Token ====================
async function getAccessToken() {
    if (cachedAccessToken && Date.now() < tokenExpiry) {
        return cachedAccessToken;
    }

    const jwtResult = createJWT();
    if (!jwtResult || !jwtResult.signer) {
        throw new Error('Could not create JWT');
    }

    const { unsignedToken, signer } = jwtResult;

    // Import the private key for signing
    const privateKeyPEM = SERVICE_ACCOUNT.private_key;
    // Remove PEM headers and convert to ArrayBuffer
    const pemContents = privateKeyPEM
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\s/g, '');
    const keyBytes = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    const key = await signer.importKey(
        'pkcs8',
        keyBytes.buffer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await signer.sign(
        'RSASSA-PKCS1-v1_5',
        new TextEncoder().encode(unsignedToken),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
    );

    const signatureB64 = base64urlEncode(
        String.fromCharCode(...new Uint8Array(signature))
    );

    const jwt = unsignedToken + '.' + signatureB64;

    const tokenResponse = await fetch(SERVICE_ACCOUNT.token_uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt
    });

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
        throw new Error('Failed to get access token: ' + JSON.stringify(tokenData));
    }

    cachedAccessToken = tokenData.access_token;
    tokenExpiry = Date.now() + (tokenData.expires_in || 3600) * 1000 - 60000; // refresh 1 min early

    return cachedAccessToken;
}

// ==================== Send FCM Notification (HTTP v1) ====================
async function sendFCMMessage(token, title, body, data) {
    const accessToken = await getAccessToken();

    const message = {
        message: {
            token: token,
            notification: { title, body },
            data: data || {},
            android: { priority: 'HIGH', notification: { sound: 'default', channel_id: 'rawa9_notifications' } },
            apns: { payload: { aps: { sound: 'default', badge: 1, 'content-available': 1 } } },
            webpush: { headers: { Urgency: 'high' } }
        }
    };

    const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
        {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + accessToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(message)
        }
    );

    const result = await response.json();
    return { ok: response.ok, status: response.status, result };
}

// ==================== HTTP Handler ====================
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

async function handler(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok', project: PROJECT_ID, time: new Date().toISOString() }), {
            status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
    }

    if (url.pathname === '/send' && request.method === 'POST') {
        try {
            const rawBody = await request.text();
            let body;
            try { body = JSON.parse(rawBody); } catch (e) {
                return new Response(JSON.stringify({ success: false, error: 'Invalid JSON' }), {
                    status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
            }

            const { tokens, title, body: notifBody, data } = body;

            if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
                return new Response(JSON.stringify({ success: false, error: 'No tokens' }), {
                    status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
            }
            if (!title) {
                return new Response(JSON.stringify({ success: false, error: 'Title required' }), {
                    status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
            }
            if (SERVICE_ACCOUNT.private_key === 'PASTE_YOUR_PRIVATE_KEY_HERE') {
                return new Response(JSON.stringify({ success: false, error: 'Service account private key not configured' }), {
                    status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
            }

            // Send to each token (FCM HTTP v1 sends one at a time)
            const uniqueTokens = [...new Set(tokens)];
            let successCount = 0;
            let failureCount = 0;
            const invalidTokens = [];

            for (const token of uniqueTokens) {
                try {
                    const res = await sendFCMMessage(token, title, notifBody || '', data || {});
                    if (res.ok) {
                        successCount++;
                    } else {
                        failureCount++;
                        // Check if token is invalid
                        const errMsg = res.result?.error?.message || '';
                        if (errMsg.includes('registration-token-not-registered') ||
                            errMsg.includes('invalid-registration-token') ||
                            errMsg.includes('invalid-argument')) {
                            invalidTokens.push(token);
                        }
                    }
                } catch (e) {
                    failureCount++;
                }
            }

            return new Response(JSON.stringify({ success: true, successCount, failureCount, invalidTokens }), {
                status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        } catch (error) {
            return new Response(JSON.stringify({ success: false, error: error.message }), {
                status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}

// ========== Bun server (local development) ==========
if (typeof Bun !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('🔧 FCM v1 Relay Worker — running on port ' + PORT);
    console.log('   Health: http://localhost:' + PORT + '/health');
    console.log('   Send:   POST http://localhost:' + PORT + '/send');
    Bun.serve({ port: PORT, fetch: handler });
}
