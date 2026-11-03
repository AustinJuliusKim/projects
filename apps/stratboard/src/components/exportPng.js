// Renders the board SVG to a PNG download. Remote images are inlined as data
// URLs first; valorant-api's media host allows CORS, so the canvas isn't
// tainted. UI-only elements (data-ui) are dropped from the copy.

async function toDataUrl(url) {
  // The <image> tags already cached these without CORS headers; reusing that
  // cache entry fails the CORS check, so go back to the network.
  const res = await fetch(url, { mode: "cors", cache: "reload" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function exportPng(svg, filename, scale = 2) {
  const clone = svg.cloneNode(true);
  clone.querySelectorAll("[data-ui]").forEach((el) => el.remove());
  const cache = new Map();
  await Promise.all([...clone.querySelectorAll("image")].map(async (img) => {
    const href = img.getAttribute("href");
    if (!href || href.startsWith("data:")) return;
    if (!cache.has(href)) cache.set(href, toDataUrl(href));
    img.setAttribute("href", await cache.get(href));
  }));

  const [, , w, h] = svg.getAttribute("viewBox").split(" ").map(Number);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w * scale));
  clone.setAttribute("height", String(h * scale));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));

  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(png);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } finally {
    URL.revokeObjectURL(url);
  }
}
