const C="nuvicon-v2";
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(["/","/icon-192.png"])).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
 const u=new URL(e.request.url);
 if(e.request.method!=="GET"||u.origin!==location.origin)return;
 e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match("/"))));
});

self.addEventListener("push",e=>{
 let d={};try{d=e.data.json()}catch(x){d={title:"Nuvicon",body:e.data?e.data.text():""}}
 e.waitUntil(self.registration.showNotification(d.title||"Nuvicon",{body:d.body||"",icon:"/icon-192.png",badge:"/icon-192.png",tag:d.tag||undefined,data:{url:d.url||"/"}}))});
self.addEventListener("notificationclick",e=>{
 e.notification.close();const u=(e.notification.data&&e.notification.data.url)||"/";
 e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(l=>{for(const c of l){if("focus" in c)return c.focus()}return clients.openWindow(u)}))});
