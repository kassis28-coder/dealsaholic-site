# Deals-aholic mobile app

Cross-platform Expo application for iPhone and Android. The live website remains the source of truth; the app reads `https://deals-aholic.com/api/deals` and does not scrape retailer pages.

## Included in the MVP

- Live approved-deal feed with pull-to-refresh
- Amazon, Walmart, and Other retailer filters
- Search by product or retailer
- Retailer directory that automatically includes newly approved stores
- Persistent on-device favorites
- Product details, prices, discounts, and promo-code copying
- Compact `/d/<deal-id>` social sharing links
- JoyInLink-first Amazon navigation with the existing affiliate URL as fallback
- Direct affiliate navigation for Walmart and other retailers

## Test on a phone

1. Install **Expo Go** from the iPhone App Store or Google Play.
2. In this `mobile` directory, run `pnpm start` (or `npx expo start`).
3. Scan the displayed QR code with the phone.

This project intentionally uses Expo SDK 54 so it can be tested with the current Expo Go transition build.

## Validate locally

```sh
pnpm exec tsc --noEmit
pnpm exec eslint app components constants context services types
pnpm exec expo config --type public
```

## Store builds

After creating an Expo account and installing EAS CLI:

```sh
eas login
eas build:configure
eas build --platform ios --profile production
eas build --platform android --profile production
```

The configured identifiers are `com.dealsaholic.app` on iOS and Android. Before store submission, replace the template files in `assets/images/` with final Deals-aholic icons and splash artwork, then add store screenshots, privacy disclosures, support contact details, and push-notification credentials if notifications are enabled.

## Retailer behavior

The app derives retailers from each approved deal's `storeType` or destination hostname. This means new retailers entered through the website's existing admin workflow appear automatically without an app release.
