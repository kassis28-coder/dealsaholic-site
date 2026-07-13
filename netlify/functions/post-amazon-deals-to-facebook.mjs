import { getStore } from "@netlify/blobs";

const LOCK_STALE_MS = 30 * 60 * 1000;

function buildCaption(deal, style = 0) {
  const headlines = [
    "🔥 Amazon Deal Alert",
    "⚡ Limited Time Deal",
    "🛒 Amazon Savings Alert",
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
        msg.includes(deal.title) ||
        msg.includes(deal.asin)
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

  const TAG = "[post-amazon-facebook]";

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


  let data;

  try {

    data = await dealStore.get(
      "latest",
      {type:"json"}
    );

  } catch(err){

    return new Response(
      JSON.stringify({
        success:false,
        error:err.message
      }),
      {
        status:500,
        headers:{
          "Content-Type":"application/json"
        }
      }
    );
  }


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


  let posted = [];

  try {
    posted =
      await store.get(
        "posted",
        {type:"json"}
      ) || [];

  } catch {}



  let target = null;


  for (const deal of data.deals) {


    if (!validateDeal(deal))
      continue;


    const key =
      deal.asin ||
      deal.url;


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


    target = deal;
    break;

  }



  if (!target) {

    await store.setJSON(
      "posted",
      posted
    );


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

  }



  const result =
    await postToFacebook(
      target,
      pageId,
      token
    );


  posted.push(
    target.asin || target.url
  );


  await store.setJSON(
    "posted",
    posted
  );


  return new Response(
    JSON.stringify({
      success:true,
      title:target.title,
      facebookId:result.id
    }),
    {
      headers:{
        "Content-Type":"application/json"
      }
    }
  );

};



export const config = {
  schedule:"*/0 * * * *"
};
