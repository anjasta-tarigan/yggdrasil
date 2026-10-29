/* Small page behaviors; progressive enhancement only. */

(function () {
  "use strict";

  function flashCopied(btn) {
    btn.classList.add("copied");
    btn.textContent = "Copied";
    window.setTimeout(function () {
      btn.classList.remove("copied");
      btn.textContent = "Copy command";
    }, 1600);
  }

  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        legacyCopy(text, done);
      });
      return;
    }
    legacyCopy(text, done);
  }

  function legacyCopy(text, done) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "absolute";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
    } catch {
      /* clipboard unavailable; nothing else to try */
    }
    document.body.removeChild(area);
    done();
  }

  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(".copy-btn") : null;
    if (!btn) return;
    var box = btn.closest(".install-box");
    var code = box && box.querySelector("code");
    if (!code) return;
    copyText(code.textContent.trim(), function () {
      flashCopied(btn);
    });
  });
})();
