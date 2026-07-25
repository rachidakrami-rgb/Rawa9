/**
 * ====================================================================
 * Cloud Functions لموقع "بوابة رواق" — إشعارات Push حتى والتطبيق مغلق
 * ====================================================================
 * هذا الملف اختياري (المرحلة 2). بدونه، الإشعارات تشتغل فقط بينما
 * الموقع مفتوح في المتصفح (خلفية أو واجهة) — وهو ما يعمل تلقائياً
 * الآن بدون أي نشر. هذا الملف يضيف إشعارات تصل حتى لو التطبيق مغلق
 * تماماً (Push حقيقي عبر Firebase Cloud Messaging).
 *
 * طريقة النشر: راجع README-الإشعارات.md المرفق.
 *
 * ملاحظة على بنية البيانات: المشروع يخزّن كل مستخدمي/طلبات التطبيق
 * كمصفوفة "list" واحدة داخل وثيقة واحدة (وليس وثيقة منفصلة لكل عنصر)،
 * لذلك هذه الدوال "تقارن" حالة القائمة قبل وبعد كل تحديث لتكتشف ماذا
 * تغيّر بالضبط (عضو جديد، تغيّر حالة طلب، حظر عضو...).
 * ====================================================================
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();

/** يُرجع كل رموز أجهزة العضو (يدعم fcmTokens الجديد كمصفوفة، و fcmToken القديم أحادي الرمز كتوافق رجعي) */
function getUserTokens(user) {
    if (!user) return [];
    if (Array.isArray(user.fcmTokens) && user.fcmTokens.length) return user.fcmTokens;
    if (user.fcmToken) return [user.fcmToken];
    return [];
}

/** يحذف رموزاً غير صالحة (جهاز أُزيل منه التطبيق/انتهت صلاحية الرمز) من سجل العضو في Firestore */
async function removeInvalidTokens(userId, invalidTokens) {
    if (!invalidTokens.length) return;
    const ref = getFirestore().collection('appData').doc('users');
    await getFirestore().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const list = snap.data().list || [];
        const idx = list.findIndex(u => u.id === userId);
        if (idx === -1) return;
        const user = list[idx];
        if (Array.isArray(user.fcmTokens)) {
            user.fcmTokens = user.fcmTokens.filter(t => !invalidTokens.includes(t));
        }
        if (user.fcmToken && invalidTokens.includes(user.fcmToken)) {
            delete user.fcmToken;
        }
        list[idx] = user;
        tx.update(ref, { list });
    });
}

/** يبعث إشعاراً لكل أجهزة عضو واحد (قد يملك أكثر من رمز/جهاز مسجّل) */
async function sendToUser(user, title, body, url) {
    const tokens = getUserTokens(user);
    if (!tokens.length) return;
    try {
        const response = await getMessaging().sendEachForMulticast({
            tokens,
            notification: { title, body },
            data: { url: url || './index.html', tag: `push-${Date.now()}` },
            webpush: {
                fcmOptions: { link: url || './index.html' },
                notification: { icon: '/icons/icon-192.png' }
            }
        });
        const invalidTokens = [];
        response.responses.forEach((r, i) => {
            if (!r.success) {
                const code = r.error && r.error.code;
                if (code === 'messaging/registration-token-not-registered' ||
                    code === 'messaging/invalid-registration-token' ||
                    code === 'messaging/invalid-argument') {
                    invalidTokens.push(tokens[i]);
                }
            }
        });
        if (invalidTokens.length) await removeInvalidTokens(user.id, invalidTokens);
    } catch (e) {
        console.error('فشل إرسال إشعار للعضو', user.id, e.message);
    }
}

/** يبعث نفس الإشعار لكل الإداريين المخوّلين بإدارة الأعضاء */
async function sendToAdmins(usersList, title, body, url) {
    const admins = usersList.filter(u => u.isAdmin && getUserTokens(u).length &&
        (u.username === 'admin' || u.role === 'super_admin' || (u.permissions && u.permissions.manageMembers)));
    await Promise.all(admins.map(a => sendToUser(a, title, body, url)));
}

// ==================== مستمع تغييرات appData/users ====================
// يكتشف: (1) عضوية جديدة بانتظار المراجعة → إشعار الإدارة
//        (2) حظر/رفع حظر عضو → إشعار العضو نفسه
exports.onUsersChange = onDocumentUpdated('appData/users', async (event) => {
    const before = event.data.before.data()?.list || [];
    const after = event.data.after.data()?.list || [];
    const beforeById = new Map(before.map(u => [u.id, u]));

    for (const user of after) {
        const prev = beforeById.get(user.id);

        // عضوية جديدة معلّقة (لم تكن موجودة، أو كانت بحالة مختلفة والآن pending)
        if (!user.isAdmin && user.status === 'pending' && (!prev || prev.status !== 'pending')) {
            await sendToAdmins(after, '📋 طلب عضوية جديد', `${user.fullName} (${user.profileNumber}) بانتظار المراجعة`, './index.html');
        }

        // تحوّل حالة العضو إلى "محظور"
        if (prev && prev.status !== 'flagged' && user.status === 'flagged') {
            const reason = (user.notes || '').replace('[محظور مؤقتاً] السبب: ', '');
            await sendToUser(user, '🚫 تم حظر حسابك', reason ? `السبب: ${reason}` : 'تم حظر حسابك مؤقتاً من قبل الإدارة.', './index.html');
        }
    }
});

// ==================== مستمع تغييرات appData/requests ====================
// يكتشف: (1) طلب اهتمام جديد وارد → إشعار العضو المستقبِل
//        (2) تغيّر حالة الطلب (قبول/رفض) → إشعار العضو المُرسِل
exports.onRequestsChange = onDocumentUpdated('appData/requests', async (event) => {
    const before = event.data.before.data()?.list || [];
    const after = event.data.after.data()?.list || [];
    const beforeById = new Map(before.map(r => [r.id, r]));

    // نحتاج قائمة الأعضاء لمعرفة رموز أجهزتهم (fcmTokens) ومطابقة profileNumber بالمعرّف
    const usersSnap = await getFirestore().collection('appData').doc('users').get();
    const users = usersSnap.exists ? (usersSnap.data().list || []) : [];
    const userById = new Map(users.map(u => [u.id, u]));
    const userByProfileNum = new Map(users.map(u => [u.profileNumber, u]));

    for (const req of after) {
        const prev = beforeById.get(req.id);

        // طلب اهتمام جديد لم يكن موجوداً من قبل
        if (!prev) {
            const receiver = userByProfileNum.get(req.receiverNum);
            const sender = userById.get(req.senderId);
            if (receiver && sender) {
                await sendToUser(receiver, '💌 طلب اهتمام جديد', `العضو ${sender.profileNumber} يرغب بالتواصل معك`, './index.html');
            }
            continue;
        }

        // تغيّر حالة الطلب من "معلّقة" إلى "متكفل بها/مرفوضة"
        if (prev.status === 'pending' && req.status !== 'pending') {
            const sender = userById.get(req.senderId);
            if (sender) {
                const approved = req.status === 'handled';
                await sendToUser(
                    sender,
                    approved ? '✅ تم قبول طلب اهتمامك' : '❌ تم رفض طلب اهتمامك',
                    `بخصوص طلب التواصل مع العضو ${req.receiverNum}`,
                    './index.html'
                );
            }
        }
    }
});
