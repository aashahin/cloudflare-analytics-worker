// ─── Bot Detection (Free Tier) ───────────────────────────────────────────────
// Lightweight User-Agent–based bot filtering. No Enterprise plan required.
// Catches the vast majority of known bots, crawlers, and automated tools.

/**
 * Single compiled regex matching known bot/crawler/tool UA strings.
 * Covers: search engines, social media crawlers, monitoring tools,
 * headless browsers, HTTP libraries, and SEO crawlers.
 */
const BOT_REGEX =
  /bot\b|crawl|spider|headless|phantom|selenium|puppeteer|playwright|lighthouse|pagespeed|pingdom|uptimerobot|statuscake|slurp|mediapartners|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|bingpreview|yandex|baidu|duckduckbot|sogou|exabot|ia_archiver|archive\.org|wget\b|curl\/|httpie|python-requests|python-urllib|aiohttp|scrapy|axios\/|node-fetch|undici|go-http-client|java\/|libwww|ahrefsbot|semrushbot|dotbot|mj12bot|rogerbot|screaming frog|gtmetrix|webpagetest|petalbot|bytespider|gptbot|claudebot|amazonbot|applebot|perplexitybot|cohere-ai|youbot|ccbot|meta-externalagent/i;

/**
 * Returns `true` if the request appears to be from a bot.
 * Uses UA string matching + missing/empty UA heuristic.
 */
export function isBot(userAgent: string): boolean {
  // Empty or very short UA is almost always a bot or automated tool
  if (!userAgent || userAgent.length < 10) return true;
  return BOT_REGEX.test(userAgent);
}
