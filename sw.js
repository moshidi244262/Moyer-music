importScripts('https://unpkg.com/workbox-sw@6.5.4/build/workbox-sw.js');

if (workbox) {
  console.log('Workbox 加载成功，已切换至 终极后台静默缓存策略');

  self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
      self.skipWaiting();
    }
  });
  workbox.core.clientsClaim();

  // 1. 网页 HTML 和 JSON 配置：网络优先
  workbox.routing.registerRoute(
    ({request, url}) => request.mode === 'navigate' || url.pathname.endsWith('.json'),
    new workbox.strategies.NetworkFirst({
      cacheName: 'html-json-cache',
      networkTimeoutSeconds: 3 
    })
  );

  // 2. 【核心修复】：分离“即时播放”与“离线缓存”
  // 解决边下边播导致 206 状态无法被 Workbox 缓存，从而耗费无尽流量的问题！
  const mediaCacheName = 'media-ultimate-cache-v5';
  const mediaStrategy = new workbox.strategies.CacheFirst({
    cacheName: mediaCacheName,
    plugins: [
      new workbox.cacheableResponse.CacheableResponsePlugin({
        statuses: [200] // 缓存池底层只认完整的 200 响应
      }),
      new workbox.rangeRequests.RangeRequestsPlugin(), // 负责将完整的缓存切片伪装成 206 返回给 <audio>
      new workbox.expiration.ExpirationPlugin({
        maxEntries: 200, 
        maxAgeSeconds: 30 * 24 * 60 * 60, // 本地存 30 天，断网可播
        purgeOnQuotaError: true 
      })
    ],
  });

  workbox.routing.registerRoute(
    ({url}) => url.pathname.match(/\.(mp3|flac|wav|mp4|m4a|ogg|enc)$/i),
    async (options) => {
      const { request, event } = options;
      const cache = await caches.open(mediaCacheName);
      const cachedResponse = await cache.match(request, { ignoreSearch: true });

      // 【情况 A】：如果本地已经有完整缓存，直接通过 Range 插件秒切片播放 (完全不走流量，支持离线)
      if (cachedResponse) {
        console.log('[SW] 命中完整本地缓存，免流量离线播放:', request.url);
        return mediaStrategy.handle(options);
      }

      // 【情况 B】：如果没有缓存。
      // 1. 触发一个后台静默全量下载任务（去除 Range 头），偷偷把这首歌完整拉取到缓存池里。
      console.log('[SW] 无缓存，开启秒播并启动后台静默缓存:', request.url);
      event.waitUntil((async () => {
        try {
          const fullRequest = new Request(request.url, { 
            mode: 'cors',
            credentials: 'omit'
          });
          fullRequest.headers.delete('range'); // 强制要求服务器给完整文件
          
          const fullResponse = await fetch(fullRequest);
          if (fullResponse.ok && fullResponse.status === 200) {
            await cache.put(request, fullResponse);
            console.log('[SW] 后台静默下载完成并永久存入缓存:', request.url);
          }
        } catch (error) {
          console.error('[SW] 后台静默下载缓存失败:', error);
        }
      })());

      // 2. 立刻返回最原始的 HTTP 网络请求给 <audio> 标签，让歌曲【瞬间】开始播放，绝不卡顿！
      return fetch(request);
    }
  );

  // 3. 封面图片缓存
  workbox.routing.registerRoute(
    ({request, url}) => request.destination === 'image' || url.pathname.match(/\.(png|jpg|jpeg|gif|svg)$/i),
    new workbox.strategies.CacheFirst({
      cacheName: 'image-cache',
      plugins: [
        new workbox.cacheableResponse.CacheableResponsePlugin({ statuses: [200] }),
        new workbox.expiration.ExpirationPlugin({
          maxEntries: 500, maxAgeSeconds: 365 * 24 * 60 * 60, purgeOnQuotaError: true
        })
      ]
    })
  );

  // 4. 第三方 CDN 资源缓存
  workbox.routing.registerRoute(
    ({url}) => url.origin === 'https://cdn.tailwindcss.com' || url.origin === 'https://unpkg.com' || url.origin === 'https://cdnjs.cloudflare.com',
    new workbox.strategies.StaleWhileRevalidate({
      cacheName: 'cdn-cache',
    })
  );

  workbox.routing.setDefaultHandler(new workbox.strategies.NetworkFirst());
} else {
  console.error('Workbox 加载失败');
}