// Cheap SEO for search engines: per-route <title>, meta description and
// canonical link. The pure helpers are tested; applySeo touches the DOM.

export function pageTitle(parts, storeName) {
  const list = (Array.isArray(parts) ? parts : [parts]).filter(Boolean);
  if (storeName) list.push(storeName);
  return list.length ? list.join(" · ") : "Card shop";
}

// Canonical URL: the path plus only the params that change what the page
// is about (q and mode on search), never paging, sort or facets.
export function canonicalHref(origin, pathname, search = "", keep = []) {
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const k of keep) {
    const v = params.get(k);
    if (v) out.set(k, v);
  }
  const qs = out.toString();
  return `${origin}${pathname}${qs ? `?${qs}` : ""}`;
}

function upsert(doc, selector, create) {
  let el = doc.head.querySelector(selector);
  if (!el) {
    el = create();
    doc.head.appendChild(el);
  }
  return el;
}

export function applySeo({ title, description, canonical, noindex = false }, doc = document) {
  if (title) doc.title = title;
  if (description !== undefined) {
    const meta = upsert(doc, 'meta[name="description"]', () => {
      const m = doc.createElement("meta");
      m.setAttribute("name", "description");
      return m;
    });
    meta.setAttribute("content", description || "");
  }
  if (canonical) {
    const link = upsert(doc, 'link[rel="canonical"]', () => {
      const l = doc.createElement("link");
      l.setAttribute("rel", "canonical");
      return l;
    });
    link.setAttribute("href", canonical);
  }
  const robots = doc.head.querySelector('meta[name="robots"]');
  if (noindex && !robots) {
    const m = doc.createElement("meta");
    m.setAttribute("name", "robots");
    m.setAttribute("content", "noindex");
    doc.head.appendChild(m);
  } else if (!noindex && robots) {
    robots.remove();
  }
}
