import sharp from "sharp";

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrap(value, maxCharacters = 24, maxLines = 4) {
  const words = String(value || "Deal available now").trim().split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxCharacters && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    } else {
      line = candidate;
    }
  }

  if (line) lines.push(line);
  const consumed = lines.join(" ").split(/\s+/).length;
  if (consumed < words.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:\s]+$/, "")}…`;
  }
  return lines.slice(0, maxLines);
}

/**
 * Produces a neutral, branded image when a retailer blocks or removes its
 * product photo. It deliberately does not invent a replacement product image.
 */
export async function createFacebookFallbackImage(title, options = {}) {
  const width = options.width || 1080;
  const height = options.height || 1080;
  const brand = options.brand || "DEALS-AHOLIC";
  const lines = wrap(title);
  const lineHeight = 76;
  const firstLineY = height / 2 - ((lines.length - 1) * lineHeight) / 2;
  const titleSvg = lines
    .map((line, index) => (
      `<text x="${width / 2}" y="${firstLineY + index * lineHeight}" ` +
      `font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="700" ` +
      `fill="#202020" text-anchor="middle">${escapeXml(line)}</text>`
    ))
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fff8f4"/>
        <stop offset="1" stop-color="#f6d8df"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#background)"/>
    <rect x="34" y="34" width="${width - 68}" height="${height - 68}" rx="34" fill="#ffffff" stroke="#d81336" stroke-width="8"/>
    <text x="${width / 2}" y="170" font-family="Arial, Helvetica, sans-serif" font-size="76" font-weight="800" fill="#d81336" text-anchor="middle">${escapeXml(brand)}</text>
    <text x="${width / 2}" y="245" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#555555" text-anchor="middle">NEW DEAL ALERT</text>
    ${titleSvg}
    <rect x="190" y="${height - 220}" width="${width - 380}" height="92" rx="46" fill="#d81336"/>
    <text x="${width / 2}" y="${height - 158}" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#ffffff" text-anchor="middle">VIEW DEAL FOR DETAILS</text>
    <text x="${width / 2}" y="${height - 78}" font-family="Arial, Helvetica, sans-serif" font-size="27" fill="#666666" text-anchor="middle">Product image temporarily unavailable</text>
  </svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}
