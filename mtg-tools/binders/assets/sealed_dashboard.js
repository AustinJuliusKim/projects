/* Sealed commander deck triage.
 *
 * Money: integer cents throughout. The one live computation is the marked
 * pile's total, and cents keep it exact.
 *
 * There are deliberately no cash/credit rate bands here. The singles page has
 * them because Card Kingdom publishes buylist rates for singles; sealed product
 * isn't going to CK, so applying those percentages would invent a number that
 * corresponds to no real offer. The sell figure is market value, full stop.
 */
(function () {
  "use strict";

  var DATA = JSON.parse(document.getElementById("payload").textContent);
  var STORE_KEY = "mtg-sealed-verdicts-v1";   // distinct from the singles page
  var THEME_KEY = "mtg-triage-theme";          // shared, so the theme follows you

  // --- storage ------------------------------------------------------------

  var storage = (function () {
    try {
      window.localStorage.setItem("__probe__", "1");
      window.localStorage.removeItem("__probe__");
      return window.localStorage;
    } catch (err) {
      return null;
    }
  })();

  var verdicts = {};
  if (storage) {
    try {
      verdicts = JSON.parse(storage.getItem(STORE_KEY) || "{}") || {};
    } catch (err) {
      verdicts = {};
    }
  }

  function persist() {
    if (!storage) return;
    try {
      storage.setItem(STORE_KEY, JSON.stringify(verdicts));
    } catch (err) {
      note("Couldn't save verdicts — browser storage is full or blocked.");
    }
  }

  // --- helpers ------------------------------------------------------------

  function money(c) {
    if (c === null || c === undefined) return "—";
    var sign = c < 0 ? "-" : "";
    var a = Math.abs(c);
    return sign + "$" + Math.floor(a / 100).toLocaleString("en-US") +
      "." + String(a % 100).padStart(2, "0");
  }

  function signed(c) {
    if (c === null || c === undefined) return "—";
    return (c >= 0 ? "+" : "") + money(c);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function el(id) { return document.getElementById(id); }

  function note(msg) {
    var b = el("banner");
    b.textContent = msg || "";
    b.hidden = !msg;
  }

  function shortMoney(c) {
    var d = (c || 0) / 100;
    if (d >= 1000) return "$" + (d / 1000).toFixed(d >= 10000 ? 0 : 1) + "k";
    return "$" + Math.round(d);
  }

  // --- filters ------------------------------------------------------------

  var filters = {
    price: 0, year: "", set: "", verdict: "",
    unpriced: false, flagged: false, name: "",
  };

  function verdictOf(deck) { return verdicts[deck.id] || "undecided"; }

  function inScope(d) {
    if (filters.price && (d.cents === null || d.cents < filters.price * 100)) return false;
    if (filters.year && d.year !== filters.year) return false;
    if (filters.set && d.setCode !== filters.set) return false;
    if (filters.verdict && verdictOf(d) !== filters.verdict) return false;
    if (filters.unpriced && d.cents !== null) return false;
    if (filters.flagged && !d.flags.length) return false;
    if (filters.name) {
      var n = filters.name.toLowerCase();
      if (d.name.toLowerCase().indexOf(n) === -1 &&
          (d.setName || "").toLowerCase().indexOf(n) === -1) return false;
    }
    return true;
  }

  function scoped() { return DATA.decks.filter(inScope); }

  // --- svg ----------------------------------------------------------------

  function svgOpen(w, h) {
    return '<svg viewBox="0 0 ' + w + " " + h + '" role="img" ' +
      'preserveAspectRatio="xMinYMin meet" style="max-width:100%">';
  }

  function barUp(x, y, w, h, r) {
    if (h <= 0) return "";
    r = Math.min(r, w / 2, h);
    return "M" + x + "," + (y + h) + "V" + (y + r) +
      "Q" + x + "," + y + " " + (x + r) + "," + y +
      "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) +
      "V" + (y + h) + "Z";
  }

  function barRight(x, y, w, h, r) {
    if (w <= 0) return "";
    r = Math.min(r, h / 2, w);
    return "M" + x + "," + y + "H" + (x + w - r) +
      "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) +
      "V" + (y + h - r) +
      "Q" + (x + w) + "," + (y + h) + " " + (x + w - r) + "," + (y + h) +
      "H" + x + "Z";
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) {
      if (mag * steps[i] >= v) return mag * steps[i];
    }
    return mag * 10;
  }

  // --- tooltip ------------------------------------------------------------

  var tip = el("tip");

  function showTip(evt, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    var r = tip.getBoundingClientRect();
    var x = evt.clientX + 12, y = evt.clientY + 12;
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 12;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - 12;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }

  function hideTip() { tip.hidden = true; }

  function bindTips(container) {
    container.querySelectorAll("[data-tip]").forEach(function (node) {
      node.addEventListener("mousemove", function (e) { showTip(e, node.dataset.tip); });
      node.addEventListener("mouseleave", hideTip);
      node.addEventListener("focus", function () {
        var b = node.getBoundingClientRect();
        showTip({ clientX: b.left + b.width / 2, clientY: b.top }, node.dataset.tip);
      });
      node.addEventListener("blur", hideTip);
    });
  }

  function dataTable(headers, rows) {
    var h = "<table class='data-table'><thead><tr>";
    headers.forEach(function (c) { h += "<th>" + esc(c) + "</th>"; });
    h += "</tr></thead><tbody>";
    rows.forEach(function (r) {
      h += "<tr>";
      r.forEach(function (c) { h += "<td>" + esc(c) + "</td>"; });
      h += "</tr>";
    });
    return h + "</tbody></table>";
  }

  // --- chart: concentration ------------------------------------------------

  function renderConcentration(decks) {
    var host = el("chart-conc");
    // Priced decks only: an unpriced deck contributing 0 would flatten the tail
    // and misrepresent the curve.
    var priced = decks.filter(function (d) { return d.cents !== null && d.totalCents > 0; })
      .sort(function (a, b) { return b.totalCents - a.totalCents; });
    var total = priced.reduce(function (s, d) { return s + d.totalCents; }, 0);

    if (priced.length < 2 || total <= 0) {
      host.innerHTML = "";
      el("conc-caption").textContent = priced.length
        ? "Needs at least two priced decks to show a curve."
        : "No priced decks in scope.";
      el("chart-conc-table").innerHTML = "";
      return;
    }

    var W = 460, H = 210, L = 38, R = 12, T = 12, B = 30;
    var pw = W - L - R, ph = H - T - B;
    var run = 0, pts = [], marks = [], want = [50, 80, 90], next = 0;

    for (var i = 0; i < priced.length; i++) {
      run += priced[i].totalCents;
      var vp = run / total * 100;
      var rp = (i + 1) / priced.length * 100;
      pts.push([L + rp / 100 * pw, T + ph - vp / 100 * ph]);
      while (next < want.length && vp >= want[next]) {
        marks.push({ pct: want[next], rows: i + 1, rowPct: rp });
        next++;
      }
    }

    var line = pts.map(function (p, i) {
      return (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1);
    }).join("");
    var area = line + "L" + pts[pts.length - 1][0].toFixed(1) + "," + (T + ph) +
      "L" + L + "," + (T + ph) + "Z";

    var s = svgOpen(W, H);
    s += "<title>Cumulative share of shelf value by deck, most valuable first</title>";
    [0, 25, 50, 75, 100].forEach(function (v) {
      var y = T + ph - v / 100 * ph;
      s += '<line class="gridline" x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '"/>';
      s += '<text class="tick" x="' + (L - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + v + '%</text>';
    });
    s += '<path d="' + area + '" fill="var(--series-1)" fill-opacity="0.1"/>';
    s += '<path d="' + line + '" fill="none" stroke="var(--series-1)" stroke-width="2" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>';

    marks.forEach(function (m) {
      var x = L + m.rowPct / 100 * pw;
      var y = T + ph - m.pct / 100 * ph;
      s += '<line class="annot-rule" x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>';
      s += '<line class="annot-rule" x1="' + x.toFixed(1) + '" y1="' + y.toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + (T + ph) + '"/>';
      s += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>';
      s += '<text class="mark-label" x="' + (x + 7).toFixed(1) + '" y="' + (y - 5).toFixed(1) + '">' + m.rows + ' decks</text>';
    });

    s += '<line class="axisline" x1="' + L + '" y1="' + (T + ph) + '" x2="' + (W - R) + '" y2="' + (T + ph) + '"/>';
    s += '<text class="tick" x="' + L + '" y="' + (H - 8) + '">most valuable</text>';
    s += '<text class="tick" x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end">' + priced.length + ' priced decks</text>';

    var bands = Math.min(48, priced.length);
    var cum = 0, idx = 0;
    for (var b = 0; b < bands; b++) {
      var upto = Math.floor((b + 1) / bands * priced.length);
      while (idx < upto) { cum += priced[idx].totalCents; idx++; }
      var pct = (cum / total * 100).toFixed(1);
      s += '<rect x="' + (L + b / bands * pw).toFixed(1) + '" y="' + T + '" width="' +
        (pw / bands).toFixed(2) + '" height="' + ph + '" fill="transparent" tabindex="0" ' +
        'data-tip="Top <b>' + Math.max(1, upto) + '</b> of ' + priced.length +
        ' priced decks = <span class=\'tip-num\'>' + pct + '%</span> of value"/>';
    }

    s += "</svg>";
    host.innerHTML = s;
    bindTips(host);

    el("conc-caption").textContent = marks.length
      ? marks.map(function (m) { return m.rows + " decks hold " + m.pct + "%"; }).join(" · ")
      : "Cumulative share of value, most valuable deck first.";

    el("chart-conc-table").innerHTML = dataTable(
      ["Share of value", "Decks", "Share of decks"],
      marks.map(function (m) { return [m.pct + "%", m.rows, m.rowPct.toFixed(1) + "%"]; })
    );
  }

  // --- chart: value by year -----------------------------------------------

  function renderYears(decks) {
    var host = el("chart-years");
    var buckets = {};
    decks.forEach(function (d) {
      var y = d.year || "—";
      var row = buckets[y] || (buckets[y] = { year: y, cents: 0, qty: 0, unpriced: 0 });
      row.cents += d.totalCents;
      row.qty += d.qty;
      if (d.cents === null) row.unpriced += d.qty;
    });
    // Chronological, not sorted by value — the shape of the series is the point.
    var rows = Object.keys(buckets).sort().map(function (k) { return buckets[k]; });

    if (!rows.length) { host.innerHTML = ""; el("chart-years-table").innerHTML = ""; return; }

    var max = niceMax(Math.max.apply(null, rows.map(function (r) { return r.cents; }).concat([1])));
    var W = 460, H = 210, L = 40, R = 10, T = 12, B = 34;
    var pw = W - L - R, ph = H - T - B;
    var band = pw / rows.length;
    var barW = Math.min(24, band - 4);

    var s = svgOpen(W, H);
    s += "<title>Sealed value by release year</title>";
    [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
      var y = T + ph - f * ph;
      s += '<line class="gridline" x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '"/>';
      s += '<text class="tick" x="' + (L - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + shortMoney(max * f) + '</text>';
    });

    rows.forEach(function (r, i) {
      var h = max > 0 ? r.cents / max * ph : 0;
      var x = L + i * band + (band - barW) / 2;
      var y = T + ph - h;
      s += '<path d="' + barUp(x, y, barW, h, 4) + '" fill="var(--series-1)" tabindex="0" ' +
        'data-tip="<b>' + esc(r.year) + '</b><br><span class=\'tip-num\'>' + money(r.cents) +
        '</span> · ' + r.qty + ' decks' +
        (r.unpriced ? '<br>' + r.unpriced + ' unpriced' : '') + '"/>';
      // Label every other year when they get tight, so labels never collide.
      if (rows.length <= 10 || i % 2 === 0) {
        s += '<text class="tick" x="' + (x + barW / 2).toFixed(1) + '" y="' + (T + ph + 14) +
          '" text-anchor="middle">' + esc(r.year.slice(-2)) + '</text>';
      }
    });

    s += '<line class="axisline" x1="' + L + '" y1="' + (T + ph) + '" x2="' + (W - R) + '" y2="' + (T + ph) + '"/>';
    s += '<text class="tick" x="' + L + '" y="' + (H - 6) + '">release year</text>';
    s += "</svg>";
    host.innerHTML = s;
    bindTips(host);

    el("chart-years-table").innerHTML = dataTable(
      ["Year", "Decks", "Value", "Unpriced"],
      rows.map(function (r) { return [r.year, r.qty, money(r.cents), r.unpriced || ""]; })
    );
  }

  // --- chart: top decks ---------------------------------------------------

  function renderTop(decks) {
    var host = el("chart-top");
    var top = decks.slice()
      .filter(function (d) { return d.totalCents > 0; })
      .sort(function (a, b) { return b.totalCents - a.totalCents; })
      .slice(0, 12);

    if (!top.length) {
      host.innerHTML = "";
      el("top-caption").textContent = "No priced decks in scope.";
      el("chart-top-table").innerHTML = "";
      return;
    }
    el("top-caption").textContent = "The shortlist worth pricing carefully.";

    var rowH = 24, W = 460, L = 150, R = 58, T = 6;
    var H = T + top.length * rowH + 10;
    var pw = W - L - R;
    var max = Math.max.apply(null, top.map(function (d) { return d.totalCents; }));

    var s = svgOpen(W, H);
    s += "<title>Highest-value sealed decks</title>";
    top.forEach(function (d, i) {
      var y = T + i * rowH;
      var barH = Math.min(24, rowH - 8);
      var w = d.totalCents / max * pw;
      var label = d.name.length > 24 ? d.name.slice(0, 23) + "…" : d.name;
      s += '<text class="tick" x="' + (L - 8) + '" y="' + (y + barH / 2 + 3).toFixed(1) +
        '" text-anchor="end">' + esc(label) + '</text>';
      s += '<path d="' + barRight(L, y + 2, w, barH, 4) + '" fill="var(--series-1)" tabindex="0" ' +
        'data-tip="<b>' + esc(d.name) + '</b><br>' + esc(d.setCode) + ' ' + esc(d.year) +
        '<br><span class=\'tip-num\'>' + money(d.totalCents) + '</span> · x' + d.qty + '"/>';
      s += '<text class="mark-label" x="' + (L + w + 6).toFixed(1) + '" y="' +
        (y + barH / 2 + 3).toFixed(1) + '">' + shortMoney(d.totalCents) + '</text>';
    });
    s += '<line class="axisline" x1="' + L + '" y1="' + (T + top.length * rowH + 2) +
      '" x2="' + (W - R) + '" y2="' + (T + top.length * rowH + 2) + '"/>';
    s += "</svg>";
    host.innerHTML = s;
    bindTips(host);

    el("chart-top-table").innerHTML = dataTable(
      ["Deck", "Set", "Qty", "Value"],
      top.map(function (d) { return [d.name, d.setCode, d.qty, money(d.totalCents)]; })
    );
  }

  // --- chart: price coverage ----------------------------------------------

  function renderCoverage(decks) {
    var host = el("chart-coverage");
    var priced = 0, unpriced = 0;
    decks.forEach(function (d) {
      if (d.cents === null) unpriced += d.qty; else priced += d.qty;
    });
    var total = priced + unpriced;

    if (!total) {
      host.innerHTML = "";
      el("coverage-caption").textContent = "Nothing in scope.";
      el("chart-coverage-table").innerHTML = "";
      return;
    }

    var pct = Math.round(priced / total * 100);
    el("coverage-caption").textContent = pct === 100
      ? "Every deck in scope has a price."
      : pct + "% of decks priced — the value figures cover only those.";

    // A single proportion: one bar, labelled, rather than a two-slice pie.
    var W = 460, H = 96, L = 10, R = 10, T = 30;
    var pw = W - L - R, barH = 24;
    var pricedW = priced / total * pw;

    var s = svgOpen(W, H);
    s += "<title>Priced versus unpriced decks</title>";
    s += '<text class="tick" x="' + L + '" y="' + (T - 10) + '">' + priced + ' priced</text>';
    s += '<text class="tick" x="' + (W - R) + '" y="' + (T - 10) + '" text-anchor="end">' +
      unpriced + ' need a price</text>';

    if (pricedW > 0) {
      s += '<path d="' + barRight(L, T, Math.max(0, pricedW - (unpriced ? 2 : 0)), barH, 4) +
        '" fill="var(--series-1)" tabindex="0" data-tip="<b>' + priced +
        '</b> decks priced<br><span class=\'tip-num\'>' + money(DATA.coverage.pricedCents) + '</span>"/>';
    }
    if (unpriced > 0) {
      // The gap is the 2px surface spacer, not a stroke around the marks.
      s += '<path d="' + barRight(L + pricedW, T, pw - pricedW, barH, 4) +
        '" fill="var(--axis)" tabindex="0" data-tip="<b>' + unpriced +
        '</b> decks with no price yet — filter to <i>Needs a price</i>"/>';
    }

    s += '<text class="mark-label" x="' + L + '" y="' + (T + barH + 16) + '">' + pct + '% priced</text>';
    s += "</svg>";
    host.innerHTML = s;
    bindTips(host);

    el("chart-coverage-table").innerHTML = dataTable(
      ["State", "Decks", "Value"],
      [["Priced", priced, money(DATA.coverage.pricedCents)],
       ["Needs a price", unpriced, "—"]]
    );
  }

  // --- table --------------------------------------------------------------

  var sortKey = "totalCents";
  var sortDir = -1;

  function renderTable(decks) {
    var body = el("rows");
    var sorted = decks.slice().sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (x === null) x = -1;
      if (y === null) y = -1;
      if (typeof x === "string") return String(x).localeCompare(String(y)) * sortDir;
      return (x - y) * sortDir;
    });

    body.textContent = "";
    el("empty").hidden = sorted.length > 0;

    var frag = document.createDocumentFragment();
    sorted.forEach(function (d) {
      var tr = document.createElement("tr");
      tr.dataset.id = d.id;
      tr.dataset.verdict = verdictOf(d);

      var nameCell = document.createElement("td");
      var strong = document.createElement("div");
      strong.className = "name";
      strong.textContent = d.name;
      nameCell.append(strong);
      if (d.setName || d.condition !== "sealed") {
        var sub = document.createElement("div");
        sub.className = "sub";
        sub.textContent = [d.setName, d.condition !== "sealed" ? d.condition : ""]
          .filter(Boolean).join(" · ");
        nameCell.append(sub);
      }
      tr.append(nameCell);

      tr.append(cell(d.setCode || "—", "set"));
      tr.append(cell(d.year || "—", "set"));
      tr.append(cell("×" + d.qty, "num"));
      tr.append(cell(d.cents === null ? "—" : money(d.cents), "num"));
      tr.append(cell(d.cents === null ? "—" : money(d.totalCents), "num"));
      tr.append(cell(d.gainCents === null ? "—" : signed(d.gainCents), "num"));

      var flagCell = document.createElement("td");
      if (d.flags.length) {
        var box = document.createElement("span");
        box.className = "flags";
        d.flags.forEach(function (f) {
          var mark = document.createElement("span");
          mark.className = "flag";
          mark.textContent = "⚑";
          var label = DATA.flagLabels[f] || f;
          if (f === "ambiguous" && d.candidates.length) {
            label += ": " + d.candidates.join(" or ");
          }
          mark.title = label;
          box.append(mark);
        });
        flagCell.append(box);
      }
      tr.append(flagCell);

      // Outbound navigation, not a fetched subresource — prices are manual, so
      // this is the difference between a click and a search.
      var linkCell = document.createElement("td");
      if (d.url) {
        var a = document.createElement("a");
        a.href = d.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "look up ↗";
        a.title = "Open this product on TCGplayer";
        linkCell.append(a);
      } else {
        linkCell.textContent = "—";
        linkCell.className = "sub";
      }
      tr.append(linkCell);

      var vCell = document.createElement("td");
      var group = document.createElement("span");
      group.className = "verdict";
      [["keep", "Keep"], ["sell", "Sell"], ["undecided", "?"]].forEach(function (pair) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.v = pair[0];
        btn.textContent = pair[1];
        btn.setAttribute("aria-pressed", verdictOf(d) === pair[0] ? "true" : "false");
        btn.setAttribute("aria-label", pair[1] + " " + d.name);
        group.append(btn);
      });
      vCell.append(group);
      tr.append(vCell);

      frag.append(tr);
    });
    body.append(frag);
  }

  function cell(text, cls) {
    var td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  // --- totals -------------------------------------------------------------

  function sellPile() {
    return DATA.decks.filter(function (d) { return verdictOf(d) === "sell"; });
  }

  function renderTotals() {
    var pile = sellPile();
    var market = pile.reduce(function (s, d) { return s + d.totalCents; }, 0);
    var qty = pile.reduce(function (s, d) { return s + d.qty; }, 0);
    var unpriced = pile.reduce(function (s, d) { return s + (d.cents === null ? d.qty : 0); }, 0);

    el("sell-total").textContent = money(market);
    el("export").disabled = pile.length === 0;

    if (!pile.length) {
      el("sell-sub").textContent = "Nothing marked yet — start with the top rows.";
      return;
    }
    var share = DATA.meta.totalCents
      ? Math.round(market / DATA.meta.totalCents * 100) : 0;
    var text = "<b>" + qty + "</b> decks · " + share + "% of shelf value";
    if (unpriced) {
      text += " · <b>" + unpriced + "</b> of them unpriced, so this is a floor";
    }
    el("sell-sub").innerHTML = text;
  }

  // --- export -------------------------------------------------------------

  function csvCell(v) {
    var s = String(v === null || v === undefined ? "" : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv() {
    var head = ["Name", "Set", "Quantity", "Condition", "Price", "Price date",
      "Source", "Cost basis", "Notes"];
    var lines = [head.join(",")];
    sellPile().slice()
      .sort(function (a, b) { return b.totalCents - a.totalCents; })
      .forEach(function (d) {
        lines.push([
          d.name, d.setCode, d.qty, d.condition,
          d.cents === null ? "" : (d.cents / 100).toFixed(2),
          d.priceDate, d.priceSource,
          d.costCents === null ? "" : (d.costCents / d.qty / 100).toFixed(2),
          d.notes,
        ].map(csvCell).join(","));
      });
    return lines.join("\r\n") + "\r\n";
  }

  function localDownload(filename, text) {
    var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function exportSellList() {
    var text = buildCsv();
    var name = "sealed-sell-list.csv";
    var host = window.claude && window.claude.downloads;

    if (!host) {
      localDownload(name, text);
      note("Downloaded " + name + " — " + sellPile().length + " decks. It reloads as a sealed.csv.");
      return;
    }
    try {
      await host.save({ filename: name, data: text });
      note("Saved " + name + ".");
    } catch (err) {
      if (err && err.code === "extension_not_enabled") {
        // csv is in the runtime's extended extension set and may be off.
        try {
          await host.save({ filename: "sealed-sell-list.txt", data: text });
          note("CSV downloads aren't enabled here, so it saved as sealed-sell-list.txt — identical CSV contents.");
        } catch (inner) { reportSaveError(inner); }
      } else {
        reportSaveError(err);
      }
    }
  }

  function reportSaveError(err) {
    var code = (err && err.code) || "unavailable";
    if (code === "declined") {
      note("Download cancelled. The sell list is still marked here.");
    } else if (code === "rate_limited") {
      note("A download prompt is already open — finish it, then try again.");
    } else if (code === "too_large") {
      note("Too large to download. Narrow it with filters first.");
    } else if (code === "bad_request" || code === "transform_error") {
      note("Couldn't build the file. This is a bug worth reporting.");
    } else {
      el("export").hidden = true;
      note("Downloads aren't available in this view. Copy the numbers from the table instead.");
    }
  }

  // --- wiring -------------------------------------------------------------

  function rerender() {
    var decks = scoped();
    var n = DATA.decks.length;
    var scope = el("scope");
    scope.textContent = decks.length === n
      ? n + " decks"
      : "showing " + decks.length + " of " + n + " decks";
    scope.classList.toggle("is-filtered", decks.length !== n);

    renderConcentration(decks);
    renderYears(decks);
    renderTop(decks);
    renderCoverage(decks);
    renderTable(decks);
    renderTotals();
  }

  function fillSelect(id, values) {
    var sel = el(id);
    values.forEach(function (v) {
      var o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      sel.append(o);
    });
  }

  function init() {
    var m = DATA.meta;
    el("tile-total").textContent = m.totalValue;
    el("tile-decks").textContent = m.quantity.toLocaleString("en-US");
    el("tile-unpriced").textContent = m.unpricedQuantity;
    el("file").textContent = m.file || "—";

    if (m.gainCents !== null && m.gainCents !== undefined) {
      el("tile-gain-wrap").hidden = false;
      el("tile-gain").textContent = signed(m.gainCents);
    }

    // The headline caveat goes up top, not in a footnote.
    if (!m.fullyPriced) {
      var b = el("coverage-banner");
      b.hidden = false;
      b.innerHTML = "<b>" + m.unpricedQuantity + " of " + m.quantity +
        " decks have no price yet</b> — " + m.totalValue +
        " is a floor, not the shelf's value. Filter to <i>Needs a price</i> and use the " +
        "look-up links to fill them in.";
    }
    if (m.unresolvedRows) {
      note(m.unresolvedRows + " row(s) didn't match a known deck — run `sealed doctor` to fix the names.");
    }

    el("storage-note").textContent = storage
      ? "Verdicts are saved in this browser."
      : "Storage is blocked here — verdicts last until you reload.";

    var years = [], sets = [];
    DATA.decks.forEach(function (d) {
      if (d.year && years.indexOf(d.year) === -1) years.push(d.year);
      if (d.setCode && sets.indexOf(d.setCode) === -1) sets.push(d.setCode);
    });
    fillSelect("f-year", years.sort());
    fillSelect("f-set", sets.sort());

    [
      ["f-price", "input", function (e) { filters.price = parseFloat(e.target.value) || 0; }],
      ["f-year", "change", function (e) { filters.year = e.target.value; }],
      ["f-set", "change", function (e) { filters.set = e.target.value; }],
      ["f-verdict", "change", function (e) { filters.verdict = e.target.value; }],
      ["f-unpriced", "change", function (e) { filters.unpriced = e.target.checked; }],
      ["f-flagged", "change", function (e) { filters.flagged = e.target.checked; }],
      ["f-name", "input", function (e) { filters.name = e.target.value.trim(); }],
    ].forEach(function (b) {
      el(b[0]).addEventListener(b[1], function (e) { b[2](e); rerender(); });
    });

    el("clear-filters").addEventListener("click", function () {
      filters = { price: 0, year: "", set: "", verdict: "", unpriced: false, flagged: false, name: "" };
      ["f-price", "f-name"].forEach(function (i) { el(i).value = ""; });
      ["f-year", "f-set", "f-verdict"].forEach(function (i) { el(i).value = ""; });
      ["f-unpriced", "f-flagged"].forEach(function (i) { el(i).checked = false; });
      rerender();
    });

    el("rows").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-v]");
      if (!btn) return;
      var tr = btn.closest("tr");
      var next = btn.dataset.v;
      if (next === "undecided") delete verdicts[tr.dataset.id];
      else verdicts[tr.dataset.id] = next;
      persist();
      tr.dataset.verdict = next;
      tr.querySelectorAll("button[data-v]").forEach(function (b) {
        b.setAttribute("aria-pressed", b.dataset.v === next ? "true" : "false");
      });
      renderTotals();
      if (filters.verdict) rerender();
    });

    document.querySelectorAll("th.sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.dataset.sort;
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = (key === "display" || key === "setCode" || key === "year") ? 1 : -1; }
        document.querySelectorAll("th.sortable").forEach(function (o) {
          o.removeAttribute("aria-sort");
          var a = o.querySelector(".arrow");
          if (a) a.remove();
        });
        th.setAttribute("aria-sort", sortDir === 1 ? "ascending" : "descending");
        var arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.textContent = sortDir === 1 ? " ↑" : " ↓";
        th.append(arrow);
        renderTable(scoped());
      });
    });

    document.querySelectorAll(".card-toggle").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var plot = el(btn.dataset.table);
        var table = el(btn.dataset.table + "-table");
        var showTable = plot.hidden;
        plot.hidden = !showTable;
        table.hidden = showTable;
        btn.textContent = showTable ? "Table" : "Chart";
      });
    });

    el("reset").addEventListener("click", function () {
      if (!Object.keys(verdicts).length) { note("No verdicts to clear."); return; }
      verdicts = {};
      persist();
      rerender();
      note("Verdicts cleared.");
    });

    el("export").addEventListener("click", exportSellList);

    var themeBtn = el("theme-toggle");
    var stored = storage && storage.getItem(THEME_KEY);
    if (stored) document.documentElement.setAttribute("data-theme", stored);
    function syncThemeLabel() {
      var attr = document.documentElement.getAttribute("data-theme");
      var dark = attr === "dark" ||
        (!attr && window.matchMedia("(prefers-color-scheme: dark)").matches);
      themeBtn.textContent = dark ? "Light" : "Dark";
    }
    syncThemeLabel();
    themeBtn.addEventListener("click", function () {
      var next = themeBtn.textContent === "Light" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      if (storage) { try { storage.setItem(THEME_KEY, next); } catch (e) {} }
      syncThemeLabel();
      rerender();
    });

    window.addEventListener("scroll", hideTip, { passive: true });
    rerender();
  }

  init();
})();
