(function () {
  'use strict';
  var storageKey = 'liney.site.theme';
  var mode = 'system';
  try {
    var saved = window.localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark' || saved === 'system') mode = saved;
  } catch (_) { /* Private browsing or disabled storage */ }
  var systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  document.documentElement.setAttribute('data-theme-preference', mode);
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.style.colorScheme = resolved;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#101815' : '#f6f7f2');
})();
