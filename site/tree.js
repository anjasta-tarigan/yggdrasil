/* Draws the hero tree into #tree: recursive branches above the ground line,
   hearth-colored roots below it feeding toward the data files they represent.
   Deterministic output (fixed seed), so the drawing is identical on every visit.
   The whole drawing animates once on load; prefers-reduced-motion skips it. */

(function () {
  "use strict";

  var host = document.getElementById("tree");
  if (!host) return;

  var NS = "http://www.w3.org/2000/svg";
  var W = 520;
  var H = 580;
  var GROUND_Y = 440;
  var MID_X = 262;

  // Mulberry32 — small seeded PRNG so the tree is identical every load.
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var rand = mulberry32(15871);
  var reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("role", "img");
  svg.classList.add("tree-svg");

  var drawCounter = 0;
  var STEP_S = reduceMotion ? 0 : 0.012;

  function nextDelay() {
    return (drawCounter++ * STEP_S).toFixed(2) + "s";
  }

  function addPath(d, className, width, opacitySec) {
    var p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("class", className);
    p.setAttribute("stroke-width", width);
    if (opacitySec) p.setAttribute("opacity", opacitySec);
    svg.appendChild(p);
    p.classList.add("draw");
    p.style.setProperty("--len", p.getTotalLength().toFixed(1));
    p.style.setProperty("--delay", nextDelay());
    if (reduceMotion) p.style.strokeDasharray = "none";
    return p;
  }

  function addTip(x, y, delay) {
    var c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", x.toFixed(1));
    c.setAttribute("cy", y.toFixed(1));
    c.setAttribute("r", 1.7);
    c.setAttribute("class", "tip");
    c.style.setProperty("--delay", (parseFloat(delay) + 0.25).toFixed(2) + "s");
    c.style.setProperty("--final-o", "0.85");
    c.style.opacity = "0.85";
    svg.appendChild(c);
  }

  // angle 0 points up (branches) or down (roots); dx/dy built from that.
  function curvedPath(x, y, angle, len, downward) {
    var dx = Math.sin(angle) * len;
    var dy = (downward ? 1 : -1) * Math.cos(angle) * len;
    var ex = x + dx;
    var ey = y + dy;
    var mx = (x + ex) / 2;
    var my = (y + ey) / 2;
    var nx = Math.cos(angle);
    var ny = Math.sin(angle);
    var n = (downward ? 1 : -1) * (rand() * 2 - 1) * len * 0.18;
    return {
      d:
        "M" + x.toFixed(1) + " " + y.toFixed(1) +
        " Q" + (mx + nx * n).toFixed(1) + " " + (my + ny * n).toFixed(1) +
        " " + ex.toFixed(1) + " " + ey.toFixed(1),
      end: { x: ex, y: ey }
    };
  }

  function grow(x, y, angle, len, width, depth) {
    var path = curvedPath(x, y, angle, len, false);
    var delay = nextDelay();
    var p = addPath(path.d, "branch", width.toFixed(2));
    p.style.setProperty("--delay", delay);
    if (depth === 0) addTip(path.end.x, path.end.y, delay);
    if (depth === 0 || len < 13 || path.end.y < 30) return;
    var spread = 0.32 + rand() * 0.34;
    var lean = (rand() * 2 - 1) * 0.16;
    grow(path.end.x, path.end.y, angle - spread + lean, len * (0.68 + rand() * 0.1), width * 0.72, depth - 1);
    grow(path.end.x, path.end.y, angle + spread + lean, len * (0.68 + rand() * 0.1), width * 0.72, depth - 1);
  }

  function growRoot(x, y, angle, len, width, depth) {
    var path = curvedPath(x, y, angle, len, true);
    addPath(path.d, "root", width.toFixed(2));
    if (depth === 0 || path.end.y > H - 60 || path.end.x < 40 || path.end.x > W - 40) {
      return path.end;
    }
    var spread = 0.32 + rand() * 0.3;
    growRoot(path.end.x, path.end.y, angle - spread, len * (0.46 + rand() * 0.12), width * 0.62, depth - 1);
    growRoot(path.end.x, path.end.y, angle + spread, len * (0.46 + rand() * 0.12), width * 0.62, depth - 1);
    return path.end;
  }

  // --- soil hatching (static texture, no draw animation) ---
  var hatch;
  for (var hx = 34; hx < W - 30; hx += 8 + rand() * 10) {
    var hy = GROUND_Y + 6 + rand() * 6;
    hatch = document.createElementNS(NS, "path");
    hatch.setAttribute(
      "d",
      "M" + hx.toFixed(1) + " " + hy.toFixed(1) +
      " L" + (hx - 7).toFixed(1) + " " + (hy + 5).toFixed(1)
    );
    hatch.setAttribute("class", "soil");
    svg.appendChild(hatch);
  }

  // --- ground line ---
  addPath("M18 " + GROUND_Y + " L" + (W - 18) + " " + GROUND_Y, "ground", 1.5);

  // --- trunk and canopy ---
  grow(MID_X - 2, GROUND_Y, -0.03, 96, 4.6, 5);
  grow(MID_X + 2, GROUND_Y, 0.04, 88, 4.2, 5);

  // --- four data roots, each labeled with the file it stands for ---
  var roots = [
    { a: -1.08, len: 60, o: MID_X - 6 },
    { a: -0.45, len: 46, o: MID_X },
    { a: 0.5, len: 42, o: MID_X },
    { a: 1.05, len: 62, o: MID_X + 6 }
  ];
  var labels = [
    { text: "yggdrasil.db", anchor: "end", lx: -4, ly: 18 },
    { text: "providers.secrets.env", anchor: "end", lx: -8, ly: 44 },
    { text: "models/", anchor: "start", lx: 4, ly: 18 },
    { text: "backups/", anchor: "start", lx: 8, ly: 44 }
  ];
  for (var i = 0; i < roots.length; i++) {
    var end = growRoot(roots[i].o, GROUND_Y, roots[i].a, roots[i].len, 2.6, 2);
    var cfg = labels[i];
    var t = document.createElementNS(NS, "text");
    t.setAttribute("x", (end.x + cfg.lx).toFixed(1));
    t.setAttribute("y", (end.y + cfg.ly).toFixed(1));
    t.setAttribute("text-anchor", cfg.anchor);
    t.setAttribute("class", "root-label");
    t.style.setProperty("--delay", ((drawCounter + i) * STEP_S + 0.2).toFixed(2) + "s");
    t.style.setProperty("--final-o", "1");
    t.style.opacity = "1";
    t.textContent = cfg.text;
    svg.appendChild(t);
  }

  host.appendChild(svg);
})();
