/* 6529 Town bell: service worker (unofficial, not made by 6529).
   It only shows fixed notification texts and opens the town page.
   No network calls, nothing stored, no handlers other than the four below. */
"use strict";

/* The two pictures of a notification are kept inside this file as base64 text, so showing one needs no download.
   BELL_ICON is icon-192.png, BELL_BADGE is badge.png (white on see-through, for the status bar).
   Made by embed-pics.py; do not change by hand. */
var BELL_ICON = "data:image/png;base64," +
  "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" +
  "LQ27ILlR8dsOb1oesBu/g3xhmeXR70/ug/cd3aBvUACYolhsuZxxTuil+rw7QAn+E6cJssK5Dxq+" +
  "wZ77HeQLyywvn1y95m44drabSKVLi6FqKQ2KvKWX6tN9m1VLg3JStFL4jx3fuGpV67L2d5AvLLO8" +
  "/vao1eLm8lv3qSiWg0aykvOz/4FSw5yMTMVnz6qDW473fmiPSk+z7yBfWGZ5AfcHVorbLtk4WKA/" +
  "V9c8duWRBzkANRpMOlGOdPwdJzceor6e0cp3kC8ss3wF4MRScdvJ3rrzemKsWjYu1NIA5STZ7Otj" +
  "oj20M7r1RO/oor6DfGGZ5RvTh7ru5kt6D19Sn+E4umaly+LXRIFssxDsiu7oppODA6kH7O1+B/nC" +
  "Mss3pvd13Y3rvccuK7uoBZlRzB049sjZcnC/L3UTKHEPWr4DpN6ArkYi1/kffverrvnRKzK27EK2" +
  "O//9Ky98xTvKteodVvy+afWqK/v+K335tXzJlbzPGrzNSt9wpa+3VoWVAqVvOkKOR9p5vmfG7rD0" +
  "FW5uRxav0FkPYS3cFspp2M49zYvY6t1jUzqyOWne7Febm47c2B4Up9AWvDfy7lDXTqLnuVVN9fji" +
  "MLLJ80mCG/be4lVY3gbPIUJfVNbm/pnnCWkAKPuZxS483BeKZWaZBtcEQM1YaC/M7UImW9jkFvZ/" +
  "suW8byTGZnxY86A1scXuZPy29gVqneEpN0695uFg1D3q3cpcZ+L8Vmd4Sv69jan5YmXUPTrXmSzG" +
  "zhVAbZ4le3pf3LPxbxZPX6yeOfqc+THk/NaBUze7cT/tCjDY+4TB3se3ODj7Y4nztsWGsPlYd8v0" +
  "N7wBwI37nZ3T85tJZ+e0kR4A6G5bp30+28UAUN6Zl/HLFfmW1/nF8J2AcwXQxbDvzjM7N7v0Ikmi" +
  "27UHzpz9h8/+651f+PJ37z0FACfWj15z9VVP/fFrDuxPvbO9+2yxAHl/nl/Jb21tv/v6G9//oVv7" +
  "8YvJH735E2trqy950c+9/CXPW1lZPlfTM9liv2q5mBDWeJMWsk/u/d6p5/3Ste/807/oc6+193r9" +
  "P37PR57/y9fe+71Ti5hNC5tM/4hd+7NIABT//LlxsBbmvXjr9fovfsXrv/yfd+tuX/qPu1/0q6/d" +
  "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" +
  "UvH3KwAAAABJRU5ErkJggg==";
var BELL_BADGE = "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAABmJLR0QA/wD/AP+gvaeTAAADsElE" +
  "QVR4nO2cv4tcVRTHP9dVFxYjLGhhCiubbQQt0timELazTqV/QBACgj9qLTVWoo1oFSsxqMQUIdiY" +
  "zhRJEwstFBKxiAgSNR+LnTHqZmbuzLz7zr555wNbzbvvnXs+zLz53vtmIUmSJEmSJEmSZCCoRX1L" +
  "fUd9ILqeUaFuqR94j4/Uh6LrGgXqjnrew3ylHouub6NRd9Wv79P8Kd+oj0XXuZGox9Vv5zR/yjX1" +
  "yeh6Nwp1T/2+ovlTflSfjq57I1BPqLeWaP6UX9TnousfNOpJ9fYKzZ/ym7ofPY9Bop5S76zR/Cl/" +
  "qi/NuU4Vfc49HPW0+lcHzZ9yV31lxrVSwBTvpdtWHErNtQOjetIbHk63rfhPaq4dFNmb5jg73bbi" +
  "n9RcO6DV3EurE9ei7gKfAX1/ZbwC7AO3ag4upTTpVagA9TjwBRAVmq4DezUHbpwAdQ/4EhjEskEr" +
  "ASHr6OoJ4DIDaX5LehegngQuArlqSc8C1FPA50Cu20/oTYB6GvgQyJ2rf9FcgJN0C7zdx/WGxoMt" +
  "T65uAe8BMxfDxk4zAeoOcI6DsJPMoMlHwiTdXmCDmm+jvebOBUzS7SX6X1pozWUb7DV3mu6Glm5X" +
  "4Cfg+VLK1a5O2Nk7YCTp9gngkh3uNXciYGTpdhe4YEd7zWsLGGm63QE+dc5ecy1rCRh5ut0C3nfG" +
  "XnMtK92E1QK8Cax18Q3iLPByKeXusgOXFpDpdiYfAy+WUv5YZtBSAjLdLuQi8EIp5dfaAdUCAvdu" +
  "h8YVYL+U8nPNwVUCjsDe7dC4zkFg+2HRgQsFjCDdtqIqNc/9GjqSdNuKqtQ8U8DI0m0rFqbm+woY" +
  "abptxdzUfEjAyNNtK2am5rWWo1s+Mzkk1nloKzfJg0kBwaSAYFJAMCkgmBQQTAoIJgUE01rAq8B2" +
  "mQOwDbzWuI4jW1vrJLxdSrlTcZ5t4Pd1almBzmpbJwk3FbBMYX0va3RZWy5FDJghCrgJvA48Azwy" +
  "+XsWeGPy2njo8tfllT9YP+ec/wunHlM/qTlR1Dw7pc9JetD8mj3sYoWEqHn+n6HchG8CT9U+b6M+" +
  "CtwAHu+htlHchM8u9bBTKbeBdxvW0xlNBagPVx63veCQ8ytcfu6YDmtbi9bvgDOLJjp5/cyC83y3" +
  "wrVvLHi9q9rWYhB7wqt+xh71+mA494CNJQUEkwKCSQHBpIBgUkAwKSCYFBBMCggmBQSTAoJJAcGk" +
  "gGBSQDApIJgUEEwKCCYFBJMCkiRJkiRJkiRJeuZvoHgovIhHeUUAAAAASUVORK5CYII=";
var MAX_TEXT = 4096;
var FALLBACK = {
  title: "6529 Town",
  body: "Something changed in the town. Tap to look.",
  tag: "town"
};
var HOUSE_BODY_SOON = "Signing closes soon. Is your validator running?";

function smallInt(x) {
  return typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= 99;
}

/* Only own fields of the message count, never anything from its prototype. */
function own(m, name) {
  return Object.prototype.hasOwnProperty.call(m, name) ? m[name] : undefined;
}

function readMessage(event) {
  var d = event ? event.data : null;
  if (!d || typeof d !== "object") return null;
  var m;
  if (typeof d.text === "function") {
    var t = d.text();
    if (typeof t !== "string" || t.length === 0 || t.length > MAX_TEXT) return null;
    m = JSON.parse(t);
  } else if (typeof d.json === "function") {
    m = d.json();
  } else {
    return null;
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
  return m;
}

function closeTime(close) {
  if (typeof close !== "number" || !Number.isInteger(close)) return null;
  var now = Math.floor(Date.now() / 1000);
  if (close < now - 86400 || close > now + 172800) return null;
  var s = new Date(close * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return typeof s === "string" && s.length > 0 && s.length <= 40 ? s : null;
}

function noteFor(m) {
  if (!m) return FALLBACK;
  var k = own(m, "k");
  if (typeof k !== "string") return FALLBACK;
  switch (k) {
    case "test":
      return {
        title: "6529 Town",
        body: "The bell on your house works. Unofficial, not made by 6529.",
        tag: "test"
      };
    case "house": {
      var n = own(m, "n");
      var of = own(m, "of");
      if (!smallInt(n) || !smallInt(of) || n > of) {
        n = 1;
        of = 1;
      }
      var time = closeTime(own(m, "close"));
      return {
        title: of === 1
          ? "Your house has not signed yet today"
          : n + " of your " + of + " houses have not signed yet today",
        body: time === null
          ? HOUSE_BODY_SOON
          : "Signing closes around " + time + ". Is your validator running?",
        tag: "house"
      };
    }
    case "pause":
      return {
        title: "6529 Town",
        body: "Your house has not signed for 3 days. The bell stays quiet until it signs again.",
        tag: "house"
      };
    case "empty":
      return {
        title: "Your house is empty today",
        body: "Your validator is not taking part today.",
        tag: "empty"
      };
    case "version": {
      var v = own(m, "v");
      var ok = typeof v === "string" && /^rc\.\d{1,3}$/.test(v);
      return {
        title: ok ? "New validator version: " + v : "New validator version",
        body: "Already on it? Nothing to do. Update only from the official source.",
        tag: "version"
      };
    }
    default:
      return FALLBACK;
  }
}

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var note;
  try {
    note = noteFor(readMessage(event));
  } catch (e) {
    note = FALLBACK;
  }
  event.waitUntil(self.registration.showNotification(note.title, {
    body: note.body,
    tag: note.tag,
    icon: BELL_ICON,
    badge: BELL_BADGE
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
