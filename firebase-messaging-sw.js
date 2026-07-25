// ====================================================================
// firebase-messaging-sw.js
// Service Worker خاص بموقع "بوابة رواق"
// مهامه:
//   1) تخزين مؤقت (Cache) للملفات الثابتة — يعمل بدون إنترنت
//   2) يسمح بإظهار إشعارات نظام التشغيل (حتى والتطبيق في الخلفية)
//   3) يستقبل إشعارات Firebase Cloud Messaging (FCM)
//   4) يفتح/يركّز نافذة التطبيق عند الضغط على الإشعار.
// ====================================================================

const CACHE_NAME = 'rawa9-v2';
const STATIC_ASSETS = [
    './',
    './index.html',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './manifest.json'
];
const CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.rtl.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore-compat.js',
    'https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js',
    'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js'
];

// ==================== تخزين مؤقت عند التثبيت ====================
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // تخزين الملفات المحلية أولاً
            return cache.addAll(STATIC_ASSETS).then(() => {
                // محاولة تخزين CDN assets (لا يفشل التثبيت إذا فشل أحدها)
                return Promise.allSettled(
                    CDN_ASSETS.map(url => cache.add(url).catch(() => {}))
                );
            });
        })
    );
    self.skipWaiting();
});

// ==================== تنظيف الكاش القديم عند التفعيل ====================
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
            );
        })
    );
    event.waitUntil(self.clients.claim());
});

// ==================== استراتيجية التخزين المؤقت ====================
// — ملفات CDN (CSS/JS خارجية): cache-first (سريع، يُحدَّث عند تغيير الإصدار)
// — ملفات المحلية (HTML): network-first (يُفضّل الأحدث)
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // طلبات Firebase/Firestore: لا تخزّن مؤقتاً
    if (url.hostname.includes('firebaseio.com') ||
        url.hostname.includes('googleapis.com') ||
        url.hostname.includes('cloudinary.com') ||
        url.pathname.includes('/v1/projects/')) {
        return;
    }

    // CDN assets: cache-first
    if (url.hostname === 'cdn.jsdelivr.net' ||
        url.hostname === 'cdnjs.cloudflare.com' ||
        url.hostname === 'fonts.googleapis.com' ||
        url.hostname === 'fonts.gstatic.com' ||
        url.hostname === 'www.gstatic.com') {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                });
            })
        );
        return;
    }

    // ملفات محلية: network-first, fallback to cache
    event.respondWith(
        fetch(event.request).then((response) => {
            if (response.ok) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
        }).catch(() => caches.match(event.request))
    );
});

// ==================== Firebase Cloud Messaging ====================
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyCdmhc2MqGpK6IjojlAa-LHl4T3yb-sca4",
    authDomain: "roua-8484e.firebaseapp.com",
    projectId: "roua-8484e",
    storageBucket: "roua-8484e.firebasestorage.app",
    messagingSenderId: "330296859647",
    appId: "1:330296859647:web:381504998d15bdbdaba5ca"
});

try {
    const messaging = firebase.messaging();
    messaging.onBackgroundMessage((payload) => {
        const data = payload.data || {};
        const title = data.title || (payload.notification && payload.notification.title) || 'رواق';
        const body = data.body || (payload.notification && payload.notification.body) || '';
        self.registration.showNotification(title, {
            body: body,
            icon: 'icons/icon-192.png',
            badge: 'icons/icon-192.png',
            dir: 'rtl',
            lang: 'ar',
            tag: data.tag || undefined,
            data: { url: data.url || './index.html' }
        });
    });
} catch (e) {
    // بيئات لا تدعم Firebase Messaging
}

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(targetUrl);
        })
    );
});
