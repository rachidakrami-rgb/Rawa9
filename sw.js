/* ============================================================
   Service Worker — بوابة ميثاق
   استراتيجية: Stale-While-Revalidate للأصول الثابتة،
   Network-First لطلبات Firestore/Firebase،
   و Cache-First للصور والخطوط.
   ============================================================ */

const CACHE_VERSION = 'mithaq-v1';
const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.rtl.min.css',
    'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// تثبيت الـ Service Worker: تخزين الأصول الأساسية في الكاش
self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_VERSION).then(function(cache) {
            // استخدام addAll مع تقبّل فشل بعض الطلبات (مثل الموارد الخارجية غير المتاحة)
            return Promise.allSettled(
                STATIC_ASSETS.map(function(url) {
                    return cache.add(url).catch(function() { /* تجاهل الفشل الفردي */ });
                })
            );
        }).then(function() {
            return self.skipWaiting();
        })
    );
});

// تفعيل الـ Service Worker: حذف النسخ القديمة من الكاش
self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(cacheNames) {
            return Promise.all(
                cacheNames.filter(function(name) {
                    return name !== CACHE_VERSION;
                }).map(function(name) {
                    return caches.delete(name);
                })
            );
        }).then(function() {
            return self.clients.claim();
        })
    );
});

// اعتراض الطلبات واختيار الاستراتيجية المناسبة
self.addEventListener('fetch', function(event) {
    const request = event.request;

    // تجاهل الطلبات غير GET (POST, PUT, DELETE ...)
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // === Firebase / Firestore: Network-Only (لا يُخزّن مؤقتاً) ===
    if (url.hostname.includes('firestore.googleapis.com') ||
        url.hostname.includes('gstatic.com') ||
        url.hostname.includes('fcm.googleapis.com')) {
        return; // اترك المتصفح يتعامل معها طبيعياً
    }

    // === Cloudinary: Network-First (الصور قد تتغير) ===
    if (url.hostname.includes('cloudinary.com') || url.hostname.includes('ibb.co')) {
        event.respondWith(
            fetch(request).catch(function() {
                return caches.match(request);
            })
        );
        return;
    }

    // === الأصول الثابتة (CSS, JS, Fonts): Stale-While-Revalidate ===
    if (url.hostname.includes('cdn.jsdelivr.net') ||
        url.hostname.includes('fonts.googleapis.com') ||
        url.hostname.includes('fonts.gstatic.com') ||
        url.hostname.includes('cdnjs.cloudflare.com')) {
        event.respondWith(
            caches.match(request).then(function(cachedResponse) {
                const fetchPromise = fetch(request).then(function(networkResponse) {
                    if (networkResponse && networkResponse.ok) {
                        const responseClone = networkResponse.clone();
                        caches.open(CACHE_VERSION).then(function(cache) {
                            cache.put(request, responseClone).catch(function() {});
                        });
                    }
                    return networkResponse;
                }).catch(function() {
                    return cachedResponse;
                });
                return cachedResponse || fetchPromise;
            })
        );
        return;
    }

    // === الطلبات المحلية (نفس الأصل): Network-First مع fallback للكاش ===
    if (url.origin === self.location.origin) {
        event.respondWith(
            fetch(request).then(function(networkResponse) {
                if (networkResponse && networkResponse.ok && request.mode === 'navigate') {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_VERSION).then(function(cache) {
                        cache.put(request, responseClone).catch(function() {});
                    });
                }
                return networkResponse;
            }).catch(function() {
                return caches.match(request).then(function(cachedResponse) {
                    return cachedResponse || caches.match('./index.html');
                });
            })
        );
        return;
    }
});

// استقبال رسائل من الصفحة (مثل طلب تحديث فوري)
self.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
