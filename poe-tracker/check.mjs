import { gunzipSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";

const SEARCH_URL = "https://pathofexile.tw/trade/search/%E4%BA%A1%E7%84%B0%E5%92%92%E6%B5%B7/H4sIAAAAAAAACqtWKi5JLCktVrKqVsovKMnMz1OyUkrMq1Sq1VHKS8xNVbJSerl2youFDUo6SiWVBWB-e-_LuStftG54umObkg5Yf7GSVXQ1TD4xL0VJRyktM6cktQgkEVsbWwsAi7vrE2cAAAA";
const LIMIT = 10;
const STATE_PATH = "poe-tracker/state.json";
const WEBHOOK = process.env.DISCORD_WEBHOOK;
if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK secret");

function decodeTradeUrl(raw) {
  const u = new URL(raw);
  if (!["pathofexile.tw", "www.pathofexile.com", "pathofexile.com"].includes(u.hostname)) throw new Error("Unsupported trade URL host");
  const match = u.pathname.match(/\/trade\/search\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error("Invalid trade search URL");
  const packed = match[2].replace(/-/g, "+").replace(/_/g, "/");
  const query = JSON.parse(gunzipSync(Buffer.from(packed, "base64")).toString("utf8"));
  return { query, origin: u.hostname === "pathofexile.tw" ? "https://pathofexile.tw" : "https://www.pathofexile.com" };
}

async function tradeJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { "user-agent": "POE-bot/1.0 (personal price tracking)", accept: "application/json", ...(init.headers || {}) }
  });
  if (response.status === 429) throw new Error("PoE trade API rate limited the request (429)");
  if (!response.ok) throw new Error(`PoE trade request failed (${response.status})`);
  return response.json();
}

async function currentLeague(origin) {
  const data = await tradeJson(`${origin}/api/trade/data/leagues`);
  const entries = data.result || data;
  const excluded = /standard|hardcore|ruthless|solo.?self.?found|\bssf\b|標準|專家|自力更生/i;
  const candidates = entries.filter(x => x?.id && !excluded.test(`${x.id} ${x.text || ""}`));
  if (candidates.length !== 1) throw new Error(`Cannot safely identify current softcore challenge league (${candidates.length} candidates)`);
  return candidates[0].id;
}

async function postDiscord(content) {
  const response = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
  });
  if (!response.ok) throw new Error(`Discord webhook failed (${response.status})`);
}

const { query, origin } = decodeTradeUrl(SEARCH_URL);
query.status = { option: "online" };
const league = await currentLeague(origin);
const search = await tradeJson(`${origin}/api/trade/search/${encodeURIComponent(league)}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query, sort: { price: "asc" } })
});
const ids = (search.result || []).slice(0, LIMIT);
if (!search.id) throw new Error("Trade search returned no query ID");

const listings = {};
if (ids.length) {
  const data = await tradeJson(`${origin}/api/trade/fetch/${ids.join(",")}?query=${encodeURIComponent(search.id)}`);
  for (const entry of data.result || []) {
    const price = entry.listing?.price;
    if (entry.id && price && Number.isFinite(Number(price.amount))) {
      listings[entry.id] = {
        amount: Number(price.amount),
        currency: price.currency || "?",
        item: entry.item?.typeLine || entry.item?.name || "物品"
      };
    }
  }
}
if (ids.length && !Object.keys(listings).length) throw new Error("Could not fetch prices for the current top 10; keeping previous state");

let previous = { league: "", listings: {} };
try { previous = JSON.parse(await readFile(STATE_PATH, "utf8")); } catch {}
const baseline = previous.league !== league || !previous.listings || !Object.keys(previous.listings).length;
const changes = [];
if (!baseline) {
  for (const [id, current] of Object.entries(listings)) {
    const old = previous.listings[id];
    if (old && (old.amount !== current.amount || old.currency !== current.currency)) changes.push({ old, current });
  }
}
if (previous.league && previous.league !== league) {
  const url = new URL(SEARCH_URL);
  url.pathname = url.pathname.replace(/(\/trade\/search\/)[^/]+/, `$1${encodeURIComponent(league)}`);
  await postDiscord(`**PoE 價格追蹤：新賽季**\n已切換至 ${league}，已重設前 ${LIMIT} 筆掛單的比價基準。\n${url}`);
} else if (changes.length) {
  const lines = changes.map(({ old, current }) => `• ${current.item}：${old.amount} ${old.currency} → **${current.amount} ${current.currency}**`);
  const url = new URL(SEARCH_URL);
  url.pathname = url.pathname.replace(/(\/trade\/search\/)[^/]+/, `$1${encodeURIComponent(league)}`);
  await postDiscord(`**PoE 掛單價格變動通知**（${league}）\n前 ${LIMIT} 筆在線結果中，${changes.length} 筆既有掛單改價：\n${lines.join("\n")}\n[開啟交易搜尋](${url})`);
} else if (!baseline) {
  console.log("No price change in the first 10 listings.");
} else {
  console.log("Saved initial price baseline; no notification sent.");
}

await writeFile(STATE_PATH, JSON.stringify({ league, listings }, null, 2) + "\n", "utf8");
console.log(`Checked ${Object.keys(listings).length}/${ids.length} listings in ${league}.`);
