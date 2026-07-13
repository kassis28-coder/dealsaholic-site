import { getStore } from "@netlify/blobs";

const LOCK_STALE_MS = 30 * 60 * 1000;

function buildCaption(deal, style = 0) {
const headlines = [
  "🔥 Amazon Deal Alert",
  "⚡ Limited Time Deal",
  "🛒 Amazon Savings Alert",
  "💥 Today's Hot Deal",
  "🚨 Price Drop Alert",
  "✨ Deal You Don't Want To Miss",
  "🏷️ Big Savings Alert",
  "🔥 Hidden Amazon Deal",
  "💰 Amazing Price Drop",
  "🛍️ Shopper's Pick",
  "⭐ Top Deal Find",
  "🎯 Deal Worth Checking Out",
  "⏰ Hurry Before It’s Gone",
  "🔥 Trending Deal Alert",
  "💎 Great Find Today",
];

  const lines = [];

  lines.push(headlines[style % headlines.length]);
  lines.push("");
  lines.push(`🛍️ ${deal.title}`);
  lines.push(`💰 Price: ${deal.price}`);

  if (deal.originalPrice) {
    lines.push(`🏷️ Was: ${deal.originalPrice}`);
  }

  if (deal.discountPercent) {
    lines.push(`🔥 Save ${deal.discountPercent}%`);
  }

  lines.push("");
  lines.push(`🔗 ${deal.url}`);

const siteCTAs = [
  "🌟 See all current deals:",
  "🔥 More deals updated daily:",
  "🛒 Find more amazing deals:",
  "💎 Discover today's best savings:",
  "🏷️ Browse more discounts:",
  "✨ More deals waiting for you:",
  "🚀 New deals added every day:",
  "👀 Looking for more bargains?",
  "🛍️ Shop more deals here:",
  "⭐ Don't miss today's deals:",
];

lines.push("");

lines.push(siteCTAs[Math.floor(Date.now() / 3600000) % siteCTAs.length]);
lines.push("https://deals-aholic.com");
lines.push("");

lines.push("⚠️ Price valid at the time posted but may change at any time.");
lines.push("#ad");

  return lines.join("\n");
}


function validateDeal(deal) {
  if (!deal.title) return false;
  if (!deal.url) return false;
  if (!deal.image) return false;
  if (!deal.discountPercent || deal.discountPercent < 20) return false;
  if (deal.needsReview) return false;

  return true;
}


async function alreadyPosted(deal, pageId, token) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${pageId}/posts?fields=message&limit=100&access_token=${token}`
    );

    const data = await res.json();

    if (!data.data) return false;

    return data.data.some(post => {
      const msg = post.message || "";

      return (
  (deal.asin && msg.includes(deal.asin)) ||
  (deal.title && msg.includes(deal.title.substring(0,40)))
);
    });

  } catch (err) {
    console.error("Facebook duplicate check failed:", err.message);
    return false;
  }
}


async function postToFacebook(deal, pageId, token) {

  const caption = buildCaption(
    deal,
    Math.floor(Date.now() / 3600000)
  );

  const params = new URLSearchParams({
    url: deal.image,
    caption,
    access_token: token,
    published: "true",
  });


  const res = await fetch(
    `https://graph.facebook.com/${pageId}/photos`,
    {
      method: "POST",
      body: params,
    }
  );


  const data = await res.json();


  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }


  return data;
}



export default async () => {

  const pageId =
    process.env.FB_PAGE_ID ||
    process.env.FACEBOOK_PAGE_ID;

  const token =
    process.env.FB_PAGE_TOKEN ||
    process.env.FACEBOOK_PAGE_TOKEN;


  if (!pageId || !token) {
    return new Response(
      JSON.stringify({
        success:false,
        error:"Missing Facebook credentials"
      }),
      {
        status:500,
        headers:{
          "Content-Type":"application/json"
        }
      }
    );
  }


  const dealStore = getStore("deals");


  const data = await dealStore.get(
    "latest",
    {type:"json"}
  );


  if (!data || !Array.isArray(data.deals)) {

    return new Response(
      JSON.stringify({
        success:true,
        message:"No Amazon deals found"
      }),
      {
        headers:{
          "Content-Type":"application/json"
        }
      }
    );

  }


  const store = getStore("amazon-facebook-posts");


// Prevent multiple Facebook runs posting the same deals
const existingLock = await store.get("posting-lock", { type: "json" });

if (
  existingLock &&
  existingLock.startedAt &&
  Date.now() - new Date(existingLock.startedAt).getTime() < LOCK_STALE_MS
) {
  return new Response(
    JSON.stringify({
      success: true,
      message: "Facebook Amazon posting already running"
    }),
    {
      headers:{
        "Content-Type":"application/json"
      }
    }
  );
}

await store.setJSON("posting-lock", {
  startedAt: new Date().toISOString()
});


let posted = [];

  try {
    posted =
      await store.get(
        "posted",
        {type:"json"}
      ) || [];

  } catch {}



  const targets = [];



  for (const deal of data.deals) {


    if (!validateDeal(deal))
      continue;


    const key =
  deal.asin ||
  deal.url ||
  deal.title;


    if (posted.includes(key))
      continue;


    const exists =
  await alreadyPosted(
    deal,
    pageId,
    token
  );


if (exists) {
  posted.push(key);
  continue;
}


targets.push(deal);


if (targets.length >= 5)
  break;
  }



  if (targets.length === 0) {

 await store.setJSON(
  "posted",
  posted
);

await store.delete("posting-lock");

  await store.delete("posting-lock");

  return new Response(
    JSON.stringify({
      success:true,
      message:"No new Amazon deals to post"
    }),
    {
      headers:{
        "Content-Type":"application/json"
      }
    }
  );

}  // <-- ADD THIS BRACKET HERE


const results = [];


  for (const deal of targets) {

    try {

      const result =
        await postToFacebook(
          deal,
          pageId,
          token
        );


      posted.push(
        deal.asin || deal.url
      );


      results.push({
        title: deal.title,
        facebookId: result.id
      });


    } catch (err) {

      console.error(
        "Failed posting deal:",
        deal.title,
        err.message
      );

    }

  }



  await store.setJSON(
    "posted",
    posted
  );



  return new Response(
    JSON.stringify({
      success:true,
      posted:results
    }),
    {
      headers:{
        "Content-Type":"application/json"
      }
    }
  );

};



export const config = {
  schedule:"0 * * * *"
};
