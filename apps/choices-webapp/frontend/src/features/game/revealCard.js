// Shareable reveal "cut card" (growth plan §8, channel #1: users generate the
// marketing; brand book "Final Cut" signature asset). Pure canvas drawing —
// zero infra, only the two players' own text. Wordle-style result grid:
// three struck rows, one green trophy row. 1080×1350 (4:5 portrait, the
// friendliest size for iMessage and Instagram-shaped surfaces).

const W = 1080;
const H = 1350;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export async function drawRevealCard(canvas, { winner, losers }) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0b1020";
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";

  // Headline (locked brand voice)
  ctx.fillStyle = "#b3b3fc";
  ctx.font = `600 48px ${FONT}`;
  ctx.fillText("Nobody picked this.", W / 2, 150);
  ctx.fillText("Everybody picked this.", W / 2, 215);

  // Result grid: losers struck in red, winner trophied in green.
  const tileX = 120;
  const tileW = W - tileX * 2;
  const tileH = 140;
  const gap = 24;
  let y = 300;
  for (const label of losers) {
    ctx.fillStyle = "rgba(244, 244, 240, 0.05)";
    ctx.strokeStyle = "rgba(244, 244, 240, 0.1)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(tileX, y, tileW, tileH, 24);
    ctx.fill();
    ctx.stroke();

    const text = fit(ctx, label, `600 54px ${FONT}`, tileW - 80);
    const midY = y + tileH / 2;
    ctx.fillStyle = "#8b93a8";
    ctx.fillText(text, W / 2, midY + 19);
    const w = ctx.measureText(text).width;
    ctx.strokeStyle = "#ff4d5e";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(W / 2 - w / 2 - 16, midY);
    ctx.lineTo(W / 2 + w / 2 + 16, midY);
    ctx.stroke();

    y += tileH + gap;
  }

  ctx.fillStyle = "rgba(34, 197, 94, 0.15)";
  ctx.strokeStyle = "#22c55e";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(tileX, y, tileW, tileH, 24);
  ctx.fill();
  ctx.stroke();
  const winnerText = fit(ctx, `🏆 ${winner}`, `800 64px ${FONT}`, tileW - 80);
  ctx.fillStyle = "#f4f4f0";
  ctx.fillText(winnerText, W / 2, y + tileH / 2 + 22);

  // Verdict line (locked brand voice)
  ctx.fillStyle = "#22c55e";
  ctx.font = `600 46px ${FONT}`;
  const verdict = fit(ctx, `${winner} survived · nobody's fault`, `600 46px ${FONT}`, W - 160);
  ctx.fillText(verdict, W / 2, 1010);

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
  ctx.fillStyle = "#b3b3fc";
  ctx.font = `700 40px ${FONT}`;
  ctx.fillText("choices.austinjuliuskim.com", W / 2, H - 100);
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
