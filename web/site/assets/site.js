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
