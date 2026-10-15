// © 2026 Totem Forge. All rights reserved.
// Installing the web app on an Android phone. It's installed from Chrome: Chrome makes it a real app
// (in the app list, full screen), and Chrome is the Android browser whose MIDI the app is tested
// with. Other browsers (Edge, Samsung Internet, Firefox…) and the browsers inside other apps
// (Instagram, Facebook…) are asked to open the page in Chrome first.

// Browsers on Android that aren't Chrome, though most say "Chrome/…" in their user agent too;
// "; wv)" is a web view inside another app
const NOT_CHROME = /EdgA\/|SamsungBrowser\/|Firefox\/|OPR\/|Opera|YaBrowser\/|UCBrowser\/|MiuiBrowser\/|HuaweiBrowser\/|HeyTapBrowser\/|DuckDuckGo\/|Vivaldi|; wv\)|FBAN|FBAV|Instagram|Line\//;

// 'install' in Chrome on Android, 'chrome' in any other Android browser, null elsewhere and once
// the app runs installed
export function installRoute(ua, installed) {
  if (installed || !/Android/.test(ua)) return null;
  return /Chrome\/\d/.test(ua) && !NOT_CHROME.test(ua) ? 'install' : 'chrome';
}

// A link that opens this page in Chrome on Android; without Chrome, its page in the Play Store
export function chromeLink(href) {
  const u = new URL(href);
  const store = encodeURIComponent('https://play.google.com/store/apps/details?id=com.android.chrome');
  return `intent://${u.host}${u.pathname}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${store};end`;
}
