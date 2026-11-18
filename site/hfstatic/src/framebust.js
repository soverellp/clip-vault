// A meta CSP cannot set frame-ancestors, so this keeps the vault out of other people's frames.
// Hugging Face shows a Static Space inside its own page; we try to open the vault as the top page, and if the browser refuses, hide it.
(function () {
  if (window.top === window.self) return;
  var root = document.documentElement;
  root.setAttribute('data-framed', '1');
  try { window.top.location.replace(window.location.href); } catch (e) { /* cross-origin top navigation can be blocked */ }
  window.addEventListener('DOMContentLoaded', function () {
    var p = document.createElement('p'); p.className = 'framed-msg';
    p.textContent = 'For safety, Clip Vault does not run inside another page. ';
    var a = document.createElement('a'); a.href = window.location.href; a.target = '_top'; a.rel = 'noopener'; a.textContent = 'Open it directly';
    p.appendChild(a); document.body.appendChild(p);
  });
})();
