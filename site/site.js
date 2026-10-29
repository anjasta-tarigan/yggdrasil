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

  /* The Ko-fi widget draws its button wherever it likes; keep it inside the
     fixed dock if it landed elsewhere (e.g. below the footer). */
  function dockKofi() {
    var dock = document.getElementById("kofi-support");
    if (!dock) return;
    var wrapped = dock.querySelector(".btn-container");
    var btn = wrapped || document.querySelector(".btn-container");
    if (btn && btn.parentElement !== dock) dock.appendChild(btn);
  }
  dockKofi();
  document.addEventListener("DOMContentLoaded", dockKofi);

  /* Floating back-to-top: appears once the reader is past the fold and
     glides back up. */
  var toTop = document.getElementById("to-top");
  var prefersReduced =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var lastShown = false;
  var ticking = false;

  function checkToTop() {
    var show = window.scrollY > 480;
    if (show !== lastShown) {
      toTop.classList.toggle("is-visible", show);
      lastShown = show;
    }
  }

  if (toTop) {
    checkToTop();
    window.addEventListener(
      "scroll",
      function () {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(function () {
          checkToTop();
          ticking = false;
        });
      },
      { passive: true }
    );
    toTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: prefersReduced ? "auto" : "smooth" });
    });
  }
})();
