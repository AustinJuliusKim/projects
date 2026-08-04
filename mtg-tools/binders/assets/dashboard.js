/* Collection triage.
 *
 * Money rule: every figure is integer cents. The only arithmetic done here is
 * summing the current selection, and cents keep that exact — float dollars
 * would reintroduce the drift the Python side uses Decimal to avoid.
 *
 * Cash and credit estimates are computed per tier (sum the band, then apply its
 * rate once), which is how `aggregate.price_tiers` does it. Applying the rate
 * per card and summing would round 400 times and drift from the CLI's answer.
 */
(function () {
  "use strict";

  var DATA = JSON.parse(document.getElementById("payload").textContent);
  var STORE_KEY = "mtg-triage-verdicts-v1";
  var THEME_KEY = "mtg-triage-theme";

  var RATES = {};
  DATA.rates.forEach(function (r) {
    // "0.47" -> 47 hundredths, kept integral so the estimate stays exact.
    RATES[r.tier] = {
      cash: Math.round(parseFloat(r.cash) * 100),
      credit: Math.round(parseFloat(r.credit) * 100),
    };
  });

  // --- storage (may be unavailable in a sandboxed frame) -------------------

  var storage = (function () {
    try {
      var probe = "__probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
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
    var sign = c < 0 ? "-" : "";
    var a = Math.abs(c);
    var d = Math.floor(a / 100).toLocaleString("en-US");
    return sign + "$" + d + "." + String(a % 100).padStart(2, "0");
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function el(id) { return document.getElementById(id); }

  function note(msg) {
    var b = el("banner");
    b.textContent = msg;
    b.hidden = !msg;
  }

  // --- filtering ----------------------------------------------------------

  var filters = {
    price: 0, rarity: "", set: "", source: "", verdict: "",
    foil: false, flagged: false, name: "",
  };

  function verdictOf(card) { return verdicts[card.id] || "undecided"; }

  function inScope(card) {
    if (filters.price && card.cents < filters.price * 100) return false;
    if (filters.rarity && card.rarity !== filters.rarity) return false;
    if (filters.set && card.setName !== filters.set) return false;
    if (filters.source && card.sources.indexOf(filters.source) === -1) return false;
    if (filters.verdict && verdictOf(card) !== filters.verdict) return false;
    if (filters.foil && !card.foil) return false;
    if (filters.flagged && !card.flags.length) return false;
    if (filters.name) {
      var needle = filters.name.toLowerCase();
      if (card.name.toLowerCase().indexOf(needle) === -1 &&
          card.setName.toLowerCase().indexOf(needle) === -1) return false;
    }
    return true;
  }

  function scoped() { return DATA.cards.filter(inScope); }

  // --- SVG plumbing -------------------------------------------------------

  function svgOpen(w, h) {
    return '<svg viewBox="0 0 ' + w + " " + h + '" role="img" ' +
      'preserveAspectRatio="xMinYMin meet" style="max-width:100%">';
  }

  // Bars: 4px rounded data-end, square at the baseline.
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

  function shortMoney(c) {
    var d = c / 100;
    if (d >= 1000) return "$" + (d / 1000).toFixed(d >= 10000 ? 0 : 1) + "k";
    return "$" + Math.round(d);
  }

  // --- tooltip ------------------------------------------------------------

  var tip = el("tip");

  function showTip(evt, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    var pad = 12;
    var r = tip.getBoundingClientRect();
    var x = evt.clientX + pad;
    var y = evt.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
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

  // --- chart: value concentration -----------------------------------------

  function renderConcentration(cards) {
    var host = el("chart-conc");
    var sorted = cards.slice().sort(function (a, b) { return b.totalCents - a.totalCents; });
    var total = sorted.reduce(function (s, c) { return s + c.totalCents; }, 0);

    if (!sorted.length || total <= 0) {
      host.innerHTML = "";
      el("conc-caption").textContent = "No cards in scope.";
      el("chart-conc-table").innerHTML = "";
      return;
    }

    var W = 460, H = 210, L = 38, R = 12, T = 12, B = 30;
    var pw = W - L - R, ph = H - T - B;
    var run = 0, pts = [], marks = [], want = [50, 80, 90], next = 0;

    for (var i = 0; i < sorted.length; i++) {
      run += sorted[i].totalCents;
      var vp = (run / total) * 100;
      var rp = ((i + 1) / sorted.length) * 100;
      pts.push([L + (rp / 100) * pw, T + ph - (vp / 100) * ph]);
      while (next < want.length && vp >= want[next]) {
        marks.push({ pct: want[next], rows: i + 1, rowPct: rp });
        next++;
      }
    }

    var line = pts.map(function (p, i) {
      return (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1);
    }).join("");
    var area = line + "L" + pts[pts.length - 1][0].toFixed(1) + "," + (T + ph) + "L" + L + "," + (T + ph) + "Z";

    var s = svgOpen(W, H);
    s += '<title>Cumulative share of collection value by card, richest first</title>';

    [0, 25, 50, 75, 100].forEach(function (v) {
      var y = T + ph - (v / 100) * ph;
      s += '<line class="gridline" x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '"/>';
      s += '<text class="tick" x="' + (L - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + v + '%</text>';
    });

    // Area wash at ~10%, line at 2px — a wash, never a saturated block.
    s += '<path d="' + area + '" fill="var(--series-1)" fill-opacity="0.1"/>';
    s += '<path d="' + line + '" fill="none" stroke="var(--series-1)" stroke-width="2" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>';

    marks.forEach(function (m) {
      var x = L + (m.rowPct / 100) * pw;
      var y = T + ph - (m.pct / 100) * ph;
      s += '<line class="annot-rule" x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>';
      s += '<line class="annot-rule" x1="' + x.toFixed(1) + '" y1="' + y.toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + (T + ph) + '"/>';
      // 8px marker with a 2px surface ring so it stays legible over the line.
      s += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4" fill="var(--series-1)" ' +
        'stroke="var(--surface)" stroke-width="2"/>';
      s += '<text class="mark-label" x="' + (x + 7).toFixed(1) + '" y="' + (y - 5).toFixed(1) + '">' +
        m.rows + ' cards</text>';
    });

    s += '<line class="axisline" x1="' + L + '" y1="' + (T + ph) + '" x2="' + (W - R) + '" y2="' + (T + ph) + '"/>';
    s += '<text class="tick" x="' + L + '" y="' + (H - 8) + '">richest</text>';
    s += '<text class="tick" x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end">' +
      sorted.length + ' rows</text>';

    // One transparent hit band per 1% of rows, so hover targets stay generous.
    var bands = 60;
    for (var b = 0; b < bands; b++) {
      var idx = Math.min(sorted.length - 1, Math.floor((b / bands) * sorted.length));
      var cum = 0;
      for (var k = 0; k <= idx; k++) cum += sorted[k].totalCents;
      var pct = ((cum / total) * 100).toFixed(1);
      s += '<rect x="' + (L + (b / bands) * pw).toFixed(1) + '" y="' + T + '" width="' +
        (pw / bands).toFixed(2) + '" height="' + ph + '" fill="transparent" tabindex="0" ' +
        'data-tip="Top <b>' + (idx + 1) + '</b> of ' + sorted.length +
        ' rows = <span class=\'tip-num\'>' + pct + '%</span> of value"/>';
    }

    s += "</svg>";
    host.innerHTML = s;
    bindTips(host);

    var head = marks.length
      ? marks.map(function (m) { return m.rows + " rows hold " + m.pct + "%"; }).join(" · ")
      : "";
    el("conc-caption").textContent = head || "Cumulative share of value, richest card first.";

    el("chart-conc-table").innerHTML = dataTable(
      ["Share of value", "Rows", "Share of rows"],
      marks.map(function (m) { return [m.pct + "%", m.rows, m.rowPct.toFixed(1) + "%"]; })
    );
  }

  // --- chart: tier bars ---------------------------------------------------

  var TIER_SERIES = [
    { key: "marketCents", label: "Market", color: "var(--series-1)" },
    { key: "cashCents", label: "Est. cash", color: "var(--series-2)" },
    { key: "creditCents", label: "Est. credit", color: "var(--series-3)" },
  ];

  function tierRowsFor(cards) {
    var byTier = {};
    DATA.tiers.forEach(function (t) {
      byTier[t.tier] = { tier: t.tier, label: t.label, qty: 0, marketCents: 0 };
    });
    cards.forEach(function (c) {
      var row = byTier[c.tier];
      if (!row) return;
      row.qty += c.qty;
      row.marketCents += c.totalCents;
    });
    return DATA.tiers.map(function (t) {
      var row = byTier[t.tier];
      var rate = RATES[t.tier];
      row.cashCents = Math.round((row.marketCents * rate.cash) / 100);
      row.creditCents = Math.round((row.marketCents * rate.credit) / 100);
      row.cashPct = t.cashPct;
      row.creditPct = t.creditPct;
      return row;
    });
  }

  function renderTiers(cards) {
    var rows = tierRowsFor(cards);
    var host = el("chart-tiers");

    el("tiers-legend").innerHTML = TIER_SERIES.map(function (s) {
      return '<span><i class="swatch" style="background:' + s.color + '"></i>' + esc(s.label) + "</span>";
    }).join("");

    var max = niceMax(Math.max.apply(null, rows.map(function (r) { return r.marketCents; }).concat([1])));
    var W = 460, H = 230, L = 44, R = 10, T = 14, B = 42;
    var pw = W - L - R, ph = H - T - B;
    var band = pw / rows.length;
    var GAP = 2;                                    // the surface gap
    var barW = Math.min(24, (band - 24 - GAP * 2) / 3);

    var s = svgOpen(W, H);
    s += "<title>Market value against estimated cash and credit, by price band</title>";

    [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
      var y = T + ph - f * ph;
      s += '<line class="gridline" x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '"/>';
      s += '<text class="tick" x="' + (L - 6) + '" y="' + (y + 3) + '" text-anchor="end">' +
        shortMoney(max * f) + "</text>";
    });

    rows.forEach(function (row, gi) {
      var groupW = barW * 3 + GAP * 2;
      var x0 = L + gi * band + (band - groupW) / 2;
      TIER_SERIES.forEach(function (ser, si) {
        var v = row[ser.key];
        var h = max > 0 ? (v / max) * ph : 0;
        var x = x0 + si * (barW + GAP);
        var y = T + ph - h;
        s += '<path d="' + barUp(x, y, barW, h, 4) + '" fill="' + ser.color + '" tabindex="0" ' +
          'data-tip="<b>' + esc(row.label) + '</b><br>' + esc(ser.label) +
          ': <span class=\'tip-num\'>' + money(v) + '</span>"/>';
        // Every bar is labelled: on the light surface the aqua series sits at
        // 2.74:1, and the palette's relief rule requires visible labels.
        if (h > 0) {
          s += '<text class="mark-label" x="' + (x + barW / 2).toFixed(1) + '" y="' +
            (y - 4).toFixed(1) + '" text-anchor="middle">' + shortMoney(v) + "</text>";
        }
      });
      s += '<text class="tick" x="' + (L + gi * band + band / 2).toFixed(1) + '" y="' + (T + ph + 14) +
        '" text-anchor="middle">' + esc(row.label.replace(/ \(.*\)$/, "")) + "</text>";
      s += '<text class="tick" x="' + (L + gi * band + band / 2).toFixed(1) + '" y="' + (T + ph + 27) +
        '" text-anchor="middle">' + row.qty + " cards</text>";
    });

    s += '<line class="axisline" x1="' + L + '" y1="' + (T + ph) + '" x2="' + (W - R) + '" y2="' + (T + ph) + '"/>';
    s += "</svg>";
    host.innerHTML = s;
    bindTips(host);

    el("chart-tiers-table").innerHTML = dataTable(
      ["Band", "Cards", "Market", "Cash", "Credit"],
      rows.map(function (r) {
        return [r.label, r.qty, money(r.marketCents), money(r.cashCents), money(r.creditCents)];
      })
    );
  }

  // --- charts: binder and set magnitude (single series, no legend) ---------

  function renderBars(hostId, tableId, items, opts) {
    var host = el(hostId);
    if (!items.length) {
      host.innerHTML = "";
      el(tableId).innerHTML = "";
      return;
    }
    var rowH = 24;
    var W = 460, L = opts.labelWidth, R = 58, T = 6;
    var H = T + items.length * rowH + 22;
    var pw = W - L - R;
    var max = Math.max.apply(null, items.map(function (i) { return i.cents; }).concat([1]));

    var s = svgOpen(W, H);
    s += "<title>" + esc(opts.title) + "</title>";

    items.forEach(function (item, i) {
      var y = T + i * rowH;
      var barH = Math.min(24, rowH - 8);
      var w = (item.cents / max) * pw;
      var muted = item.isOther;
      s += '<text class="tick" x="' + (L - 8) + '" y="' + (y + barH / 2 + 3).toFixed(1) +
        '" text-anchor="end">' + esc(opts.label(item)) + "</text>";
      s += '<path d="' + barRight(L, y + 2, w, barH, 4) + '" fill="' +
        (muted ? "var(--axis)" : "var(--series-1)") + '" tabindex="0" data-tip="<b>' +
        esc(item.name) + "</b><br><span class='tip-num'>" + money(item.cents) + "</span> · " +
        item.qty + ' cards"/>';
      s += '<text class="mark-label" x="' + (L + w + 6).toFixed(1) + '" y="' +
        (y + barH / 2 + 3).toFixed(1) + '">' + shortMoney(item.cents) + "</text>";
    });

    s += '<line class="axisline" x1="' + L + '" y1="' + (T + items.length * rowH + 2) +
      '" x2="' + (W - R) + '" y2="' + (T + items.length * rowH + 2) + '"/>';
    s += "</svg>";
    host.innerHTML = s;
    bindTips(host);

    el(tableId).innerHTML = dataTable(
      [opts.nameHeader, "Cards", "Value"],
      items.map(function (i) { return [i.name, i.qty, money(i.cents)]; })
    );
  }

  function renderSources(cards) {
    // Per-binder figures are pre-merge, from the payload, so a card owned in two
    // binders is not double counted. They intentionally ignore the filters.
    renderBars("chart-sources", "chart-sources-table", DATA.sources, {
      title: "Value by binder, as scanned",
      labelWidth: 92,
      nameHeader: "Binder",
      label: function (i) { return i.name.slice(0, 12); },
    });
  }

  function renderSets(cards) {
    var byName = {};
    cards.forEach(function (c) {
      var row = byName[c.setName] || (byName[c.setName] = { name: c.setName, qty: 0, cents: 0 });
      row.qty += c.qty;
      row.cents += c.totalCents;
    });
    var all = Object.keys(byName).map(function (k) { return byName[k]; })
      .sort(function (a, b) { return b.cents - a.cents; });

    // Past the top 15 the tail folds into one bucket rather than growing bars
    // nobody reads.
    var top = all.slice(0, 15);
    var tail = all.slice(15);
    if (tail.length) {
      top.push({
        name: "Other (" + tail.length + " sets)",
        qty: tail.reduce(function (s, r) { return s + r.qty; }, 0),
        cents: tail.reduce(function (s, r) { return s + r.cents; }, 0),
        isOther: true,
      });
    }

    el("sets-caption").textContent = all.length + " sets in scope" +
      (tail.length ? "; the tail beyond the top 15 is grouped." : ".");

    renderBars("chart-sets", "chart-sets-table", top, {
      title: "Top sets by value",
      labelWidth: 132,
      nameHeader: "Set",
      label: function (i) { return i.name.length > 21 ? i.name.slice(0, 20) + "…" : i.name; },
    });
  }

  // --- triage table -------------------------------------------------------

  var sortKey = "totalCents";
  var sortDir = -1;

  function renderTable(cards) {
    var body = el("rows");
    var sorted = cards.slice().sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (typeof x === "string") return x.localeCompare(y) * sortDir;
      return (x - y) * sortDir;
    });

    body.textContent = "";
    el("empty").hidden = sorted.length > 0;

    var frag = document.createDocumentFragment();
    sorted.forEach(function (card) {
      // Built with DOM + textContent, not innerHTML: card names are arbitrary
      // text and this is the highest-volume path for them.
      var tr = document.createElement("tr");
      tr.dataset.id = card.id;
      tr.dataset.verdict = verdictOf(card);

      var nameCell = document.createElement("td");
      var strong = document.createElement("div");
      strong.className = "name";
      strong.textContent = card.display;
      var sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = card.setName + " · " + card.number;
      nameCell.append(strong, sub);
      tr.append(nameCell);

      tr.append(cell(card.setCode, "set"));
      tr.append(cell(card.rarity, "rarity"));
      tr.append(cell("×" + card.qty, "num"));
      tr.append(cell(money(card.cents), "num"));
      tr.append(cell(money(card.totalCents), "num"));

      var flagCell = document.createElement("td");
      if (card.flags.length) {
        var box = document.createElement("span");
        box.className = "flags";
        card.flags.forEach(function (f) {
          var mark = document.createElement("span");
          mark.className = "flag";
          mark.textContent = "⚑";
          mark.title = DATA.flagLabels[f] || f;
          box.append(mark);
        });
        flagCell.append(box);
      }
      tr.append(flagCell);

      var vCell = document.createElement("td");
      var group = document.createElement("span");
      group.className = "verdict";
      [["keep", "Keep"], ["sell", "Sell"], ["undecided", "?"]].forEach(function (pair) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.v = pair[0];
        btn.textContent = pair[1];
        btn.setAttribute("aria-pressed", verdictOf(card) === pair[0] ? "true" : "false");
        btn.setAttribute("aria-label", pair[1] + " " + card.display);
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
    return DATA.cards.filter(function (c) { return verdictOf(c) === "sell"; });
  }

  function renderTotals() {
    var pile = sellPile();
    var rows = tierRowsFor(pile);
    var market = rows.reduce(function (s, r) { return s + r.marketCents; }, 0);
    var cash = rows.reduce(function (s, r) { return s + r.cashCents; }, 0);
    var credit = rows.reduce(function (s, r) { return s + r.creditCents; }, 0);
    var qty = pile.reduce(function (s, c) { return s + c.qty; }, 0);

    el("sell-total").textContent = money(market);
    el("tile-cash").textContent = money(cash);
    el("tile-credit").textContent = money(credit);
    el("export").disabled = pile.length === 0;

    if (!pile.length) {
      el("sell-sub").textContent = "Nothing marked yet — start with the top rows.";
    } else {
      var share = DATA.meta.totalCents ? Math.round((market / DATA.meta.totalCents) * 100) : 0;
      el("sell-sub").innerHTML = "<b>" + qty + "</b> cards across <b>" + pile.length +
        "</b> rows · " + share + "% of the collection";
    }
  }

  // --- export -------------------------------------------------------------

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv() {
    var head = ["Name", "Set name", "Set code", "Collector number", "Foil", "Quantity",
      "Market each", "Market total", "Est. cash", "Est. credit", "Language", "Condition"];
    var lines = [head.join(",")];
    sellPile().slice().sort(function (a, b) { return b.totalCents - a.totalCents; })
      .forEach(function (c) {
        var rate = RATES[c.tier];
        lines.push([
          c.name, c.setName, c.setCode, c.number, c.foil ? "foil" : "", c.qty,
          (c.cents / 100).toFixed(2), (c.totalCents / 100).toFixed(2),
          (Math.round((c.totalCents * rate.cash) / 100) / 100).toFixed(2),
          (Math.round((c.totalCents * rate.credit) / 100) / 100).toFixed(2),
          c.language, c.condition,
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
    var name = "sell-list.csv";
    var host = window.claude && window.claude.downloads;

    if (!host) {
      localDownload(name, text);
      note("Downloaded " + name + " — " + sellPile().length + " rows.");
      return;
    }

    try {
      await host.save({ filename: name, data: text });
      note("Saved " + name + ".");
    } catch (err) {
      var code = err && err.code;
      if (code === "extension_not_enabled") {
        // CSV is in the extended set and may be off for this view. The same
        // bytes as .txt are still importable.
        try {
          await host.save({ filename: "sell-list.txt", data: text });
          note("CSV downloads aren't enabled here, so it saved as sell-list.txt — the contents are identical CSV.");
        } catch (inner) {
          reportSaveError(inner);
        }
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
      note("The sell list is too large to download. Narrow it with filters first.");
    } else if (code === "bad_request" || code === "transform_error") {
      note("Couldn't build the file. This is a bug worth reporting.");
    } else {
      el("export").hidden = true;
      note("Downloads aren't available in this view. Copy the numbers from the table instead.");
    }
  }

  // --- wiring -------------------------------------------------------------

  function rerender() {
    var cards = scoped();
    var n = DATA.cards.length;
    var scope = el("scope");
    scope.textContent = cards.length === n
      ? n + " rows"
      : "showing " + cards.length + " of " + n + " rows";
    scope.classList.toggle("is-filtered", cards.length !== n);

    renderConcentration(cards);
    renderTiers(cards);
    renderSources(cards);
    renderSets(cards);
    renderTable(cards);
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
    el("tile-total").textContent = DATA.meta.totalValue;
    el("tile-cards").textContent = DATA.meta.quantity.toLocaleString("en-US");
    el("files").textContent = DATA.meta.files.join(", ") || "—";

    el("storage-note").textContent = storage
      ? "Verdicts are saved in this browser."
      : "Storage is blocked here — verdicts last until you reload.";
    if (!storage) {
      note("This view can't save to browser storage, so verdicts will be lost on reload. Export the sell list before leaving.");
    }

    var rarities = [], sets = [], sources = [];
    DATA.cards.forEach(function (c) {
      if (c.rarity && rarities.indexOf(c.rarity) === -1) rarities.push(c.rarity);
      if (c.setName && sets.indexOf(c.setName) === -1) sets.push(c.setName);
      c.sources.forEach(function (s) { if (sources.indexOf(s) === -1) sources.push(s); });
    });
    fillSelect("f-rarity", rarities);
    fillSelect("f-set", sets.sort());
    fillSelect("f-source", sources.sort());

    var bind = [
      ["f-price", "input", function (e) { filters.price = parseFloat(e.target.value) || 0; }],
      ["f-rarity", "change", function (e) { filters.rarity = e.target.value; }],
      ["f-set", "change", function (e) { filters.set = e.target.value; }],
      ["f-source", "change", function (e) { filters.source = e.target.value; }],
      ["f-verdict", "change", function (e) { filters.verdict = e.target.value; }],
      ["f-foil", "change", function (e) { filters.foil = e.target.checked; }],
      ["f-flagged", "change", function (e) { filters.flagged = e.target.checked; }],
      ["f-name", "input", function (e) { filters.name = e.target.value.trim(); }],
    ];
    bind.forEach(function (b) {
      el(b[0]).addEventListener(b[1], function (e) { b[2](e); rerender(); });
    });

    el("clear-filters").addEventListener("click", function () {
      filters = { price: 0, rarity: "", set: "", source: "", verdict: "", foil: false, flagged: false, name: "" };
      ["f-price", "f-name"].forEach(function (i) { el(i).value = ""; });
      ["f-rarity", "f-set", "f-source", "f-verdict"].forEach(function (i) { el(i).value = ""; });
      ["f-foil", "f-flagged"].forEach(function (i) { el(i).checked = false; });
      rerender();
    });

    el("rows").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-v]");
      if (!btn) return;
      var tr = btn.closest("tr");
      var id = tr.dataset.id;
      var next = btn.dataset.v;
      if (next === "undecided") delete verdicts[id];
      else verdicts[id] = next;
      persist();

      tr.dataset.verdict = next;
      tr.querySelectorAll("button[data-v]").forEach(function (b) {
        b.setAttribute("aria-pressed", b.dataset.v === next ? "true" : "false");
      });
      renderTotals();
      // Only a verdict filter changes which rows belong on screen.
      if (filters.verdict) rerender();
    });

    document.querySelectorAll("th.sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.dataset.sort;
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = key === "display" || key === "setCode" ? 1 : -1; }
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
      var dark = document.documentElement.getAttribute("data-theme") === "dark" ||
        (!document.documentElement.getAttribute("data-theme") &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
      themeBtn.textContent = dark ? "Light" : "Dark";
    }
    syncThemeLabel();
    themeBtn.addEventListener("click", function () {
      var dark = themeBtn.textContent === "Light";
      var next = dark ? "light" : "dark";
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
