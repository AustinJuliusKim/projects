// Shareable reveal card (growth plan §8, channel #1: users generate the
// marketing). Pure canvas drawing — zero infra, only the two players' own
// text. 1080×1350 (4:5 portrait, the friendliest size for iMessage and
// Instagram-shaped surfaces).

const W = 1080;
const H = 1350;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export async function drawRevealCard(canvas, { winner, losers }) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0f172a");
  bg.addColorStop(0.55, "#1e1b4b");
  bg.addColorStop(1, "#312e81");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";

  // Headline
  ctx.fillStyle = "#a5b4fc";
  ctx.font = `600 52px ${FONT}`;
  ctx.fillText("Nobody picked this.", W / 2, 170);
  ctx.fillText("Everybody picked this.", W / 2, 240);

  // The three cuts, struck through
  ctx.font = `600 56px ${FONT}`;
  let y = 420;
  for (const label of losers) {
    const text = fit(ctx, label, `600 56px ${FONT}`, W - 240);
    ctx.fillStyle = "#64748b";
    ctx.fillText(text, W / 2, y);
    const w = ctx.measureText(text).width;
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(W / 2 - w / 2 - 16, y - 20);
    ctx.lineTo(W / 2 + w / 2 + 16, y - 20);
    ctx.stroke();
    y += 130;
  }

  // Winner chip
  const winnerText = fit(ctx, winner, `800 84px ${FONT}`, W - 280);
  ctx.font = `800 84px ${FONT}`;
  const chipW = ctx.measureText(winnerText).width + 160;
  const chipY = y + 20;
  ctx.strokeStyle = "#22c55e";
  ctx.lineWidth = 8;
  ctx.fillStyle = "rgba(34, 197, 94, 0.15)";
  ctx.beginPath();
  ctx.roundRect((W - chipW) / 2, chipY - 90, chipW, 150, 75);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#f1f5f9";
  ctx.fillText(winnerText, W / 2, chipY + 8);

  ctx.fillStyle = "#22c55e";
  ctx.font = `600 46px ${FONT}`;
  ctx.fillText("🏆 survived", W / 2, chipY + 130);

  // App logo above the footer. Best-effort: a failed load must never block
  // the share, the card just renders without it.
  try {
    const logo = new Image();
    logo.src = "/icon-192.png";
    await logo.decode();
    const size = 96;
    ctx.drawImage(logo, (W - size) / 2, H - 300, size, size);
  } catch {
    /* card ships logo-less */
  }

  // Footer
  ctx.fillStyle = "#94a3b8";
  ctx.font = `600 40px ${FONT}`;
  ctx.fillText("Dinner's served.", W / 2, H - 160);
  ctx.fillStyle = "#a5b4fc";
  ctx.font = `700 40px ${FONT}`;
  ctx.fillText("choices.austinjuliuskim.com", W / 2, H - 90);
}

// Ellipsize a label to fit maxWidth at the given font.
function fit(ctx, text, font, maxWidth) {
  ctx.font = font;
  let t = String(text ?? "");
  if (ctx.measureText(t).width <= maxWidth) return t;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}…`;
}
