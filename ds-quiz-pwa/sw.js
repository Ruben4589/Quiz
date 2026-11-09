/* DS Quiz – Service Worker
   - Code & Daten (HTML/JS/JSON): sofort aus dem Cache, im Hintergrund aktualisiert
     -> Änderungen kommen beim nächsten Öffnen an, auch ohne CACHE-Version zu erhöhen.
   - Bilder & Schriften: aus dem Cache (spart mobiles Datenvolumen).
   Die Dateiliste FILES erzeugt tools/verschluesseln.mjs automatisch. */
var CACHE='ds-quiz-v23';
var FILES=["./", "./index.html", "./manifest.json", "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png", "./fonts/geist-400.woff2", "./fonts/geist-500.woff2", "./fonts/geist-600.woff2", "./fonts/newsreader-500.woff2", "./fach/bauzeichnen/data.js", "./fach/bauzeichnen/p1.jpg.enc", "./fach/bauzeichnen/p2.jpg.enc", "./fach/bauzeichnen/p3.jpg.enc", "./fach/bauzeichnen/p4.jpg.enc", "./fach/bauzeichnen/p5.jpg.enc", "./fach/bauzeichnen/p6.jpg.enc", "./fach/bauzeichnen/p7.jpg.enc", "./fach/bauzeichnen/p8.jpg.enc", "./fach/bauzeichnen/p9.jpg.enc", "./fach/bauzeichnen/p10.jpg.enc", "./fach/bauzeichnen/p11.jpg.enc", "./fach/bauzeichnen/p12.jpg.enc", "./fach/bauzeichnen/p13.jpg.enc", "./fach/bauzeichnen/p14.jpg.enc", "./fach/bauzeichnen/p15.jpg.enc", "./fach/bauzeichnen/p16.jpg.enc", "./fach/btk/data.js", "./fach/btk/p1.jpg.enc", "./fach/btk/p2.jpg.enc", "./fach/btk/p3.jpg.enc", "./fach/btk/p4.jpg.enc", "./fach/btk/p5.jpg.enc", "./fach/btk/p6.jpg.enc", "./schutz.json", "./klausuren.enc"];
var STATIC=/\.(jpe?g|png|webp|gif|svg|woff2?)(\.enc)?$/i; // Bilder (auch verschlüsselt) & Schriften

self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){return Promise.all(FILES.map(function(f){return c.add(f).catch(function(){})}))}));
  self.skipWaiting();
});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}));
});
self.addEventListener('fetch',function(e){
  var req=e.request;if(req.method!=='GET')return;
  var url=new URL(req.url);if(url.origin!==location.origin)return;
  e.respondWith(caches.open(CACHE).then(function(c){
    return c.match(req).then(function(hit){
      if(hit&&STATIC.test(url.pathname))return hit;            // Bilder/Schriften: Cache
      var net=fetch(req).then(function(res){if(res&&res.ok)c.put(req,res.clone());return res});
      if(hit){e.waitUntil(net.catch(function(){}));return hit}  // Code/Daten: Cache + Hintergrund-Update
      return net.catch(function(){return req.mode==='navigate'?c.match('./index.html'):Response.error()}); // offline
    });
  }));
});
