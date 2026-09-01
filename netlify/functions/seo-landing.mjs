import getDeals from "./get-deals.mjs";

const BASE_URL = "https://deals-aholic.com";

const LANDINGS = {
  amazon: {
    slug: "amazon-deals",
    title: "Amazon Deals Today — Promo Codes & Price Drops | Deals-aholic",
    heading: "Amazon Deals Today",
    kicker: "Amazon savings",
    description: "Browse fresh Amazon price drops, coupon codes, and limited-time offers. Deals are refreshed throughout the day and link directly to the retailer.",
    filter: deal => storeOf(deal) === "amazon",
  },
  walmart: {
    slug: "walmart-deals",
    title: "Walmart Deals Today — Rollbacks & Savings | Deals-aholic",
    heading: "Walmart Deals Today",
    kicker: "Walmart savings",
    description: "Shop current Walmart rollbacks, special buys, and seasonal savings. New offers are added throughout the day.",
    filter: deal => storeOf(deal) === "walmart",
  },
  promo: {
    slug: "promo-codes",
    title: "Promo Codes & Coupon Deals Today | Deals-aholic",
    heading: "Promo Codes Today",
    kicker: "Extra savings",
    description: "Find current promo codes and coupon deals for Amazon and other participating stores. Always verify the code and final price at checkout.",
    filter: deal => validCode(deal.discountCode),
  },
};

const CATEGORIES = {
  electronics: ["headphone", "earbud", "speaker", "tv", "laptop", "tablet", "phone", "camera", "monitor", "keyboard", "mouse", "charger", "gaming", "computer", "printer", "router", "projector"],
  fashion: ["dress", "shirt", "blouse", "pants", "jeans", "skirt", "jacket", "coat", "sweater", "hoodie", "legging", "shorts", "swimsuit", "shoe", "boot", "sandal", "heel", "fashion", "apparel"],
  home: ["comforter", "bedding", "pillow", "mattress", "blanket", "sofa", "table", "dresser", "lamp", "decor", "air fryer", "coffee maker", "blender", "kitchen", "cookware", "vacuum", "storage", "organizer", "patio"],
  beauty: ["skincare", "moisturizer", "serum", "foundation", "mascara", "lipstick", "shampoo", "conditioner", "hair", "perfume", "lotion", "sunscreen", "makeup", "cleanser"],
  toys: ["toy", "lego", "doll", "action figure", "board game", "puzzle", "playset", "kids", "children", "baby", "toddler", "plush", "craft"],
  sports: ["yoga", "gym", "dumbbell", "hiking", "camping", "tent", "fishing", "golf", "tennis", "basketball", "football", "soccer", "cycling", "fitness", "workout"],
  pets: ["dog", "cat", "pet", "puppy", "kitten", "bird", "fish", "aquarium", "collar", "leash", "litter", "pet bed", "grooming"],
  household: ["toilet paper", "paper towel", "laundry", "detergent", "dish soap", "cleaning", "trash bag", "sponge", "disinfect", "tissue", "mop", "broom", "wipes"],
};

const CATEGORY_LABELS = {
  electronics: "Electronics", fashion: "Fashion", home: "Home & Kitchen",
  beauty: "Beauty", toys: "Toys & Games", sports: "Sports & Outdoors",
  pets: "Pet Supplies", household: "Household",
};

function esc(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function xmlSafeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function number(value) {
  const parsed = Number.parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function storeOf(deal) {
  const value = String(deal.storeType || deal.store || "").toLowerCase();
  const url = String(deal.url || deal.productUrl || "").toLowerCase();
  if (value === "walmart" || url.includes("walmart.com") || url.includes("goto.walmart.com")) return "walmart";
  return value && value !== "other" ? value : "amazon";
}

function validCode(value) {
  const code = String(value || "").trim();
  return !!code && !/^(none|null|n\/a|no code)$/i.test(code);
}

function dealId(deal) {
  const id = String(deal.id || deal.asin || "").trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : "";
}

function isSeoEligible(deal) {
  const price = number(deal.price);
  const discount = Number(deal.discountPercent || 0);
  return !!dealId(deal) && !!String(deal.title || "").trim() && !!String(deal.image || "").trim()
    && price !== null && price > 0 && discount >= 0 && discount <= 95;
}

function categoryMatch(deal, category) {
  const words = CATEGORIES[category] || [];
  const title = String(deal.title || "").toLowerCase();
  return words.some(word => title.includes(word));
}

function dealCard(deal) {
  const id = dealId(deal);
  const price = number(deal.price);
  const original = number(deal.originalPrice);
  const discount = Number(deal.discountPercent || 0);
  const code = validCode(deal.discountCode) ? String(deal.discountCode).trim().toUpperCase() : "";
  const store = storeOf(deal);
  return `<article class="deal-card">
    <a class="deal-image" href="/d/${encodeURIComponent(id)}"><img src="${esc(deal.image)}" alt="${esc(deal.title)}" loading="lazy"></a>
    <div class="deal-body"><span class="store">${esc(store)}</span><h2><a href="/d/${encodeURIComponent(id)}">${esc(deal.title)}</a></h2>
    <div class="price">$${price.toFixed(2)}${original && original > price ? ` <s>$${original.toFixed(2)}</s>` : ""}</div>
    ${discount > 0 ? `<span class="discount">${discount}% OFF</span>` : ""}${code ? `<div class="code">Code: ${esc(code)}</div>` : ""}
    <a class="deal-cta" href="/d/${encodeURIComponent(id)}">View deal →</a></div></article>`;
}

function landingFromRequest(req) {
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const landing = url.searchParams.get("landing")
    || (pathname.endsWith("/amazon-deals") ? "amazon" : null)
    || (pathname.endsWith("/walmart-deals") ? "walmart" : null)
    || (pathname.endsWith("/promo-codes") ? "promo" : null);
  const category = url.searchParams.get("category")
    || pathname.match(/\/deals\/([a-z-]+)$/i)?.[1]?.toLowerCase()
    || null;
  if (LANDINGS[landing]) return LANDINGS[landing];
  if (CATEGORIES[category]) {
    const label = CATEGORY_LABELS[category];
    return {
      slug: `deals/${category}`,
      title: `${label} Deals Today — Discounts & Promo Codes | Deals-aholic`,
      heading: `${label} Deals Today`,
      kicker: "Shop by category",
      description: `Browse current ${label.toLowerCase()} deals, discounts, and promo codes from participating stores. New savings are added throughout the day.`,
      filter: deal => categoryMatch(deal, category),
    };
  }
  return null;
}

export default async function handler(req, context) {
  const landing = landingFromRequest(req);
  if (!landing) return new Response("Page not found", { status: 404 });

  const feedResponse = await getDeals(new Request(`${BASE_URL}/api/deals`), context);
  const feed = await feedResponse.json().catch(() => ({ deals: [] }));
  const deals = (feed.deals || []).filter(isSeoEligible).filter(landing.filter).slice(0, 60);
  const canonical = `${BASE_URL}/${landing.slug}`;
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: landing.heading,
    numberOfItems: deals.length,
    itemListElement: deals.slice(0, 30).map((deal, index) => ({
      "@type": "ListItem", position: index + 1,
      url: `${BASE_URL}/d/${encodeURIComponent(dealId(deal))}`,
      name: String(deal.title || ""),
    })),
  };

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(landing.title)}</title><meta name="description" content="${esc(landing.description)}"><meta name="robots" content="index, follow">
  <link rel="canonical" href="${canonical}"><meta property="og:type" content="website"><meta property="og:url" content="${canonical}"><meta property="og:title" content="${esc(landing.title)}"><meta property="og:description" content="${esc(landing.description)}"><meta property="og:image" content="${BASE_URL}/og-image.jpg">
  <script type="application/ld+json">${xmlSafeJson(itemList)}</script>
  <style>:root{--paper:#f6f7fb;--card:#fff;--ink:#111827;--muted:#667085;--line:#e6e9f0;--brand:#ff6b2c;--brand-dark:#e84f12}*{box-sizing:border-box}body{margin:0;background:var(--paper);font-family:Inter,Arial,sans-serif;color:var(--ink)}a{color:inherit}.header{background:#fff;border-bottom:1px solid var(--line)}.header-inner{max-width:1280px;margin:auto;padding:17px 24px;display:flex;align-items:center;gap:24px}.logo{font-size:25px;font-weight:900;text-decoration:none}.logo span{color:var(--brand)}nav{display:flex;gap:18px;margin-left:auto;flex-wrap:wrap}nav a{font-size:13px;font-weight:800;text-decoration:none}.hero{background:linear-gradient(135deg,#ff6b2c,#ed385b);color:#fff}.hero-inner{max-width:1280px;margin:auto;padding:48px 24px}.kicker{text-transform:uppercase;letter-spacing:.1em;font-size:11px;font-weight:900}.hero h1{font-size:clamp(38px,6vw,66px);line-height:1;margin:12px 0}.hero p{max-width:720px;line-height:1.65}.main{max-width:1280px;margin:auto;padding:30px 24px 64px}.intro{line-height:1.7;color:var(--muted);max-width:850px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-top:24px}.deal-card{background:var(--card);border:1px solid var(--line);border-radius:18px;overflow:hidden;display:flex;flex-direction:column}.deal-image{height:210px;background:#fafafa;display:block}.deal-image img{width:100%;height:100%;object-fit:contain;padding:18px}.deal-body{padding:15px;display:flex;flex-direction:column;flex:1}.store{text-transform:uppercase;font-size:10px;font-weight:900;color:var(--brand-dark)}h2{font-size:14px;line-height:1.4;margin:9px 0}h2 a{text-decoration:none}.price{font-size:21px;font-weight:900;margin-top:auto}.price s{font-size:12px;color:#98a0ae;font-weight:500}.discount{display:inline-block;margin-top:9px;color:#d32840;font-size:11px;font-weight:900}.code{margin-top:9px;border:1px dashed #f39a55;background:#fff7ed;border-radius:9px;padding:8px;text-align:center;font-size:11px;font-weight:900}.deal-cta{display:block;margin-top:11px;background:var(--ink);color:#fff;text-align:center;padding:11px;border-radius:10px;text-decoration:none;font-size:12px;font-weight:900}.footer{background:#101827;color:#cbd2dd;padding:32px 24px;text-align:center;font-size:12px;line-height:1.6}@media(max-width:640px){.header-inner{display:block}.logo{display:block;margin-bottom:14px}nav{margin:0;gap:12px}.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.deal-image{height:160px}.main{padding-left:14px;padding-right:14px}}</style></head>
  <body><header class="header"><div class="header-inner"><a class="logo" href="/">Deals-<span>aholic</span></a><nav aria-label="Main navigation"><a href="/amazon-deals">Amazon</a><a href="/walmart-deals">Walmart</a><a href="/promo-codes">Promo Codes</a><a href="/deals/electronics">Electronics</a><a href="/deals/home">Home</a></nav></div></header>
  <section class="hero"><div class="hero-inner"><div class="kicker">${esc(landing.kicker)}</div><h1>${esc(landing.heading)}</h1><p>${esc(landing.description)}</p></div></section>
  <main class="main"><p class="intro">Deals-aholic organizes current offers by store and category to make comparison easier. Prices, promo codes, discounts, and availability may change; verify the final price at the retailer before purchasing.</p>
  <div class="grid">${deals.length ? deals.map(dealCard).join("") : "<p>Fresh deals are being added. Please check back soon.</p>"}</div></main>
  <footer class="footer">As an Amazon Associate, Deals-aholic earns from qualifying purchases. Deals-aholic may also earn commissions from other participating retailers at no additional cost to shoppers.</footer></body></html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300", "Netlify-CDN-Cache-Control": "public, durable, max-age=300, stale-while-revalidate=600" } });
}
