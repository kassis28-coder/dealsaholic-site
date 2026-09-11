export type Deal = {
  id?: string;
  asin?: string | null;
  title: string;
  image?: string | null;
  price?: string | number | null;
  originalPrice?: string | number | null;
  discountPercent?: number | null;
  discountCode?: string | null;
  url: string;
  storeType?: string | null;
  source?: string | null;
  createdAt?: string | null;
  fetchedAt?: string | null;
  expiresOn?: string | null;
};

export const dealKey = (deal: Deal) => deal.id || deal.asin || deal.url;

export function dealCategory(deal: Deal) {
  const title = String(deal.title || '').toLowerCase();
  if (/headphone|earbud|speaker|tv |laptop|tablet|phone|camera|monitor|keyboard|mouse|charger|cable|battery|bluetooth|wireless|gaming|console|playstation|xbox|nintendo|drone|smart watch|smartwatch|airpod|ipad|iphone|android|pixel|samsung|apple mac|computer|printer|router|projector|alexa|echo|fire stick|earphone|usb|hdmi/.test(title)) return 'electronics';
  // Classify explicit play products before fashion. Toy titles often include
  // words such as "girls" or "boys", which previously sent them to Fashion.
  if (/\btoy\b|\btoys\b|lego|doll|action figure|board game|puzzle|playset|stuffed animal|plush|remote control toy|\brc car\b|coloring (?:book|set)|learning toy|building blocks|fidget|squishy|archery toy|bow and arrow toy|pretend play|play kitchen|toy vehicle/.test(title)) return 'toys';
  if (/dress|shirt|blouse|pants|jeans|skirt|jacket|coat|sweater|hoodie|legging|shorts|swimsuit|bikini|sneaker|shoe|boot|sandal|heel|sock|underwear|bra|tank top|tshirt|t-shirt|clothing|fashion|outfit|apparel|womens|mens|ladies|girls|boys|vest|cardigan|romper|jumpsuit|lounge set|two piece set|matching set|palazzo|linen pant/.test(title)) return 'fashion';
  if (/comforter|bedding|bed sheet|pillowcase|pillow sham|duvet|mattress|blanket|quilt|bed set|bed in a bag|satin pillow|microfiber sheet/.test(title)) return 'bedroom';
  if (/bath rug|bath mat|shower caddy|bathroom organizer|bathroom accessories|bathroom set|toilet brush|soap dispenser|qtip holder|cotton swab|towel rack|shower shelf|bathroom storage/.test(title)) return 'bathroom';
  if (/sofa|couch|sectional|recliner|armchair|ottoman|coffee table|dining table|nightstand|dresser|wardrobe|bookcase|bookshelf|bed frame|headboard|floor lamp|end table|side table|floating shelf|corner shelf|coat rack|tv stand|display shelf|storage tower|chest of drawer/.test(title)) return 'furniture';
  if (/air fryer|instant pot|coffee maker|blender|toaster oven|microwave|stand mixer|food processor|electric kettle|rice cooker|slow cooker|pressure cooker|ninja kitchen|cookware|pots and pans|nonstick|cutting board|food storage container|vegetable chopper|mandoline|mixing bowl/.test(title)) return 'kitchen';
  // Storage and organizer products belong with Home, even when the title says
  // makeup, cosmetics, jewelry, or beauty.
  if (/organizer|storage rack|storage bin|storage basket|storage cabinet|drawer divider|closet system|shelf organizer|countertop storage|makeup storage|cosmetic storage|jewelry holder/.test(title)) return 'home';
  if (/skincare|moisturizer|serum|foundation|mascara|lipstick|eyeshadow|concealer|blush|primer|shampoo|conditioner|hair|perfume|cologne|lotion|sunscreen|makeup|nail|eyeliner|bronzer|highlighter|toner|cleanser|face wash|vitamin c|retinol|curling|flat iron|hair dryer/.test(title)) return 'beauty';
  if (/book|novel|hardcover|paperback|kindle|audiobook|memoir|biography|fiction|nonfiction|thriller|mystery|romance|fantasy|science fiction|history|cookbook|guide|workbook/.test(title)) return 'books';
  if (/yoga|gym|dumbbell|weight|protein|supplement|hiking|camping|tent|backpack|fishing|hunting|golf|tennis|basketball|football|soccer|cycling|bike|treadmill|resistance band|jump rope|sports|outdoor|fitness|workout|exercise|weighted vest|sunglasses sport/.test(title)) return 'sports';
  if (/dog|cat|pet|puppy|kitten|bird|fish|aquarium|collar|leash|food bowl|litter|treat|chew|pet bed|crate|cage|grooming|pee pad|dog food|cat food/.test(title)) return 'pets';
  if (/toilet paper|paper towel|laundry|detergent|dish soap|cleaning|trash bag|garbage bag|sponge|bleach|disinfect|household|tissue|aluminum foil|zip lock|storage bag|mop|broom|wipes|fabuloso|lysol|clorox/.test(title)) return 'household';
  if (/candle|wall art|picture frame|vase|figurine|wreath|decorative|faux plant|artificial tree|olive tree|floor mirror|wall mirror|artwork|tapestry|home decor|wall decor/.test(title)) return 'decor';
  if (/kitchen|cookware|pan|pot|knife|lamp|curtain|rug|storage|organizer|mirror|shelf|drawer|vacuum|closet|under cabinet|over door/.test(title)) return 'home';
  return 'other';
}

export function retailerName(deal: Deal) {
  const explicit = String(deal.storeType || '').trim().toLowerCase();
  if (explicit && explicit !== 'other') {
    if (explicit === 'amazon') return 'Amazon';
    if (explicit === 'walmart') return 'Walmart';
    if (explicit === 'target') return 'Target';
    return explicit.replace(/(^|[-_])\w/g, (value) => value.replace(/[-_]/, '').toUpperCase());
  }
  try {
    const host = new URL(deal.url).hostname.replace(/^www\./, '');
    if (host.includes('amazon.')) return 'Amazon';
    if (host.includes('walmart.')) return 'Walmart';
    if (host.includes('target.')) return 'Target';
    return host.split('.')[0].replace(/(^|[-_])\w/g, (value) => value.replace(/[-_]/, '').toUpperCase());
  } catch {
    return 'Other Retailer';
  }
}

export function shareUrl(deal: Deal) {
  const key = deal.id || deal.asin;
  return key
    ? `https://deals-aholic.com/d/${encodeURIComponent(key)}?preview=2`
    : 'https://deals-aholic.com';
}
