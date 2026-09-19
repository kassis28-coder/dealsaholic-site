export function resolve101SavingsDeal(deal) {
  return {
    ...deal,
    title: deal?.title || deal?.productTitle || "",
    url: deal?.url || deal?.productUrl || "",
    image: deal?.image || deal?.imageUrl || deal?.photoUrl || "",
    price: deal?.price || deal?.currentPrice || "",
    originalPrice: deal?.originalPrice || deal?.wasPrice || "",
    discount: deal?.discount ?? deal?.discountPercent ?? "",
    promoCode: deal?.promoCode || deal?.discountCode || "",
  };
}
