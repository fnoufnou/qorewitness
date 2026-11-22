/* Copy buttons. The pages work without this file. */
(function () {
  var buttons = document.querySelectorAll("[data-copy]");
  buttons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = document.getElementById(btn.getAttribute("data-copy"));
      if (!target) return;
      var text = target.textContent.trim();
      var label = btn.querySelector("span");
      function done(ok) {
        if (!label) return;
        var old = label.getAttribute("data-label") || label.textContent;
        label.setAttribute("data-label", old);
        label.textContent = ok ? "Copied" : "Press Ctrl+C";
        setTimeout(function () { label.textContent = old; }, 2000);
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        var range = document.createRange();
        range.selectNodeContents(target);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        try { done(document.execCommand("copy")); } catch (e) { done(false); }
      }
    });
  });
})();

/* Menu button on small screens. Without this file the menu shows as a plain list. */
(function () {
  var header = document.querySelector(".site-header");
  var btn = header && header.querySelector(".menu-btn");
  var nav = document.getElementById("site-nav");
  if (!btn || !nav) return;
  btn.hidden = false;
  function set(open, focusBtn) {
    header.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open && focusBtn) btn.focus();
  }
  btn.addEventListener("click", function () {
    var open = btn.getAttribute("aria-expanded") !== "true";
    set(open, false);
    if (open) { var first = nav.querySelector("a"); if (first) first.focus(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") set(false, true);
  });
  document.addEventListener("click", function (e) {
    if (btn.getAttribute("aria-expanded") === "true" && !header.contains(e.target)) set(false, false);
  });
})();

/* Rows of app screens and wide tables: a keyboard stop only while they scroll sideways. */
(function () {
  var rows = document.querySelectorAll(".screens, .tablewrap");
  function check() {
    rows.forEach(function (r) {
      if (r.scrollWidth > r.clientWidth + 1) r.setAttribute("tabindex", "0");
      else r.removeAttribute("tabindex");
    });
  }
  check();
  window.addEventListener("resize", check);
})();
