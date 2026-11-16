/* 6529 Town bell: self-removing service worker (unofficial, not made by 6529).
   Served in place of the bell worker when the bell is taken away.
   It drops the push subscription, then removes itself. No network calls, nothing stored. */
"use strict";

var BELL_ICON = "/icon-192.png";

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  var reg = self.registration;
  var drop;
  try {
    drop = reg.pushManager
      ? Promise.resolve(reg.pushManager.getSubscription()).then(function (sub) {
          return sub ? sub.unsubscribe() : undefined;
        })
      : Promise.resolve();
  } catch (e) {
    drop = Promise.resolve();
  }
  event.waitUntil(
    drop
      .catch(function () { return undefined; })
      .then(function () { return reg.unregister(); })
      .catch(function () { return undefined; })
  );
});

/* A push must always show a note, so a late one gets the plain town note. */
self.addEventListener("push", function (event) {
  event.waitUntil(self.registration.showNotification("6529 Town", {
    body: "Something changed in the town. Tap to look.",
    tag: "town",
    icon: BELL_ICON,
    badge: BELL_ICON
  }));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var scope = self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(function (list) {
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          if (c && typeof c.url === "string" && c.url.indexOf(scope) === 0) return c.focus();
        }
        return self.clients.openWindow(scope);
      })
      .catch(function () { return undefined; })
  );
});
