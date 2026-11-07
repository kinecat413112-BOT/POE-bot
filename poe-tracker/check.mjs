import { gunzipSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";

const SEARCH_URL = "https://pathofexile.tw/trade/search/%E4%BA%A1%E7%84%B0%E5%92%92%E6%B5%B7/H4sIAAAAAAAAClWOQQrCMBRE7zLrbNzmKlLkS74YqElJfkUJ_wDi1l2h6M4DCO68Te01pIJQd_PmwTAFWUjaDFsQG_ExwIL25Gta1ww1CLRjWIzXx7s7wUCOzcTD8z705-F2GbsXzHclwy7Lz1NwMNj4WjhNotJqhgWSyPFqVsyiD44P7P4-LbaxTVA1cD5P3xyspJZV9QMpuA01xAAAAA";
const LIMIT = 10;
const STATE_PATH = "poe-tracker/state.json";
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const IS_MANUAL_TEST = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK secret");

function displayCurrency(currency) {
  const normalized = String(currency || "?").trim().toLowerCase();
  const names = {
    chaos: "混沌石",
    "chaos orb": "混沌石",
    divine: "神聖石",
    "divine orb": "神聖石"
  };
  return names[normalized] || currency || "?";
}

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
  const excluded = /standard|hardcore|ruthless|殘暴|solo.?self.?found|\bssf\b|標準|專家|自力更生/i;
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
// Preserve the exact filters encoded in the saved search URL.
const league = await currentLeague(origin);
const search = await tradeJson(`${origin}/api/trade/search/${encodeURIComponent(league)}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query, sort: { price: "asc" } })
});
const ids = (search.result || []).slice(0, LIMIT);
if (!search.id) throw new Error("Trade search returned no query ID");
if (Number(search.total || 0) > 0 && !ids.length) throw new Error("Trade search reported matches but returned no listing IDs");

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

const url = new URL(SEARCH_URL);
url.pathname = url.pathname.replace(/(\/trade\/search\/)[^/]+/, `$1${encodeURIComponent(league)}`);

if (previous.league && previous.league !== league) {
  await postDiscord(`**PoE 價格追蹤：新賽季**\n已切換至 ${league}，已重設前 ${LIMIT} 筆掛單的比價基準。\n${url}`);
} else if (IS_MANUAL_TEST) {
  const result = changes.length
    ? `發現 ${changes.length} 筆價格變動：\n${changes.map(({ old, current }) => `• ${current.item}：${old.amount} ${displayCurrency(old.currency)} → **${current.amount} ${displayCurrency(current.currency)}**`).join("\n")}`
    : baseline
      ? "本次成功取得搜尋結果並建立價格基準，目前沒有可比較的前次價格。"
      : "本次檢查成功，前十筆掛單價格沒有變動。";
  await postDiscord(`**PoE 價格追蹤手動測試**（${league}）\n已檢查前 ${Object.keys(listings).length} 筆掛單。\n${result}\n[開啟交易搜尋](${url})`);
} else if (changes.length) {
  const lines = changes.map(({ old, current }) => `• ${current.item}：${old.amount} ${displayCurrency(old.currency)} → **${current.amount} ${displayCurrency(current.currency)}**`);
  await postDiscord(`**PoE 掛單價格變動通知**（${league}）\n前 ${LIMIT} 筆「即刻購買以及面對面交易」搜尋結果中，${changes.length} 筆既有掛單改價：\n${lines.join("\n")}\n[開啟交易搜尋](${url})`);
} else if (!baseline) {
  console.log("No price change in the first 10 listings.");
} else {
  console.log("Saved initial price baseline; no notification sent.");
}

await writeFile(STATE_PATH, JSON.stringify({ league, listings }, null, 2) + "\n", "utf8");
console.log(`Checked ${Object.keys(listings).length}/${ids.length} listings in ${league}.`);
