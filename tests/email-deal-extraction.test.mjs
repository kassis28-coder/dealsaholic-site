import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAllProducts, validateDraft } from '../netlify/functions/submit-email-deal.mjs';

test('a Cindy-style coded deal produces one complete draft despite a repeated URL in HTML', async () => {
  const text = `#1
50% off WIHOLL Two Piece Sets
50% off Code: ZAAKHX4C
13.99(Reg.27.99)
https://www.amazon.com/dp/B0H1WCH79Q
End Date: 2026-09-30

#2
50% off CASLY LAMIIT 2 Piece Skirt Sets
50% off Code: BN798UF4
16.99-19.49(Reg.33.99-38.99)
https://www.amazon.com/dp/B0GXFQ19DV?th=1&psc=1
End Date: 2026-09-30`;
  const html = '<a href="https://www.amazon.com/dp/B0H1WCH79Q?tag=sample">WIHOLL</a>';
  const { drafts } = await extractAllProducts(html, text, '');

  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts.map(d => [d.asin, d.dealPrice, d.discountCode]), [
    ['B0H1WCH79Q', '$13.99', 'ZAAKHX4C'],
    ['B0GXFQ19DV', '$16.99', 'BN798UF4'],
  ]);
  assert.equal(drafts[0].expirationDate, '2026-09-30T00:00:00.000Z');
});

test('a URL absent from structured cards still reaches fallback once', async () => {
  const text = `#1
50% off WIHOLL Two Piece Sets
50% off Code: ZAAKHX4C
13.99(Reg.27.99)
https://www.amazon.com/dp/B0H1WCH79Q`;
  const html = '<a href="https://www.amazon.com/dp/B0GXFQ19DV">Another product</a>';
  const { drafts } = await extractAllProducts(html, text, '');

  assert.equal(drafts.length, 2);
  assert.equal(drafts[1].asin, 'B0GXFQ19DV');
  assert.equal(drafts[1].discountCode, null);
  assert.equal(validateDraft(drafts[1], 1).valid, false);
  assert.equal(validateDraft(drafts[0], 0).valid, true);
});

test('expired email offers are not reimported during replay', () => {
  const draft = { amazonUrl: 'https://www.amazon.com/dp/B0H1WCH79Q', asin: 'B0H1WCH79Q',
    dealPrice: '$13.99', discountCode: 'ZAAKHX4C', expirationDate: '2020-09-30T23:59:00Z' };
  assert.deepEqual(validateDraft(draft, 0).issues, ['deal has expired']);
});
