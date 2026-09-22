// Rotate these prompts so Deal-Aholic posts invite a genuine response instead
// of repeating the same generic CTA on every post.
export const engagementPrompts = [
  "Which color or version would you pick first? Tell us below 👇",
  "Would you add this to your cart? Yes or no?",
  "Tag the friend who would love this find.",
  "Save this post for your next shopping list.",
  "Rate this deal from 1–10 in the comments.",
  "What would you pair this with? We want your ideas.",
  "Would you wear it now or save it for a future season?",
  "Comment ‘LINK’ if this one is going on your wish list.",
  "Share this with someone who always finds the best deals.",
  "Which detail sold you: the price, color, or style?",
  "Would you keep it or gift it? Let us know below.",
  "What is the best deal you have found this week?",
  "Pick one: treat yourself or gift it to someone special?",
  "Drop a 🛍️ if you love an affordable find like this.",
  "Which size, color, or version would you choose?",
  "Save this for later before the price changes.",
  "Do you want more finds like this? Tell us in the comments.",
  "Tag your shopping bestie who needs to see this.",
  "Would this make your everyday lineup? Why or why not?",
  "What should we hunt for next: fashion, home, beauty, or tech?",
];

export function engagementPrompt(index = 0) {
  return engagementPrompts[Math.abs(Number(index) || 0) % engagementPrompts.length];
}
