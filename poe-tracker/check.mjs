import { gunzipSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";

const TRACKED_SEARCHES = [
  {
    id: "dawn-tower-shield",
    name: "破曉（巨型塔盾）",
    url: "https://pathofexile.tw/trade/search/%E4%BA%A1%E7%84%B0%E5%92%92%E6%B5%B7/H4sIAAAAAAAAClWOQQrCMBRE7zLrbNzmKlLkS74YqElJfkUJ_wDi1l2h6M4DCO68Te01pIJQd_PmwTAFWUjaDFsQG_ExwIL25Gta1ww1CLRjWIzXx7s7wUCOzcTD8z705-F2GbsXzHclwy7Lz1NwMNj4WjhNotJqhgWSyPFqVsyiD44P7P4-LbaxTVA1cD5P3xyspJZV9QMpuA01xAAAAA"
  },
  {
    id: "headhunter-leather-belt",
    name: "獵首（皮革腰帶）",
    url: "https://pathofexile.tw/trade/search/%E4%BA%A1%E7%84%B0%E5%92%92%E6%B5%B7/H4sIAAAAAAAACqtWKi5JLCktVrKqVsovKMnMz1OyUkosS8zMSUzKSVWq1VHKS8xNVbJSet679eWyaUo6SiWVBWD-rHUv56580brh6Y5tSjpgU4qVrKKrYfKJeSlKOkppmTklqUUgidja2FoAc30u520AAAA"
  }
];
const LIMIT = 10;
const SEARCH_GAP_MS = 60_000;
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

function leagueSearchUrl(raw, league) {
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/(\/trade\/search\/)[^/]+/, `$1${encodeURIComponent(league)}`);
  return url.toString();
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

let previous = { league: "", targets: {} };
try { previous = JSON.parse(await readFile(STATE_PATH, "utf8")); } catch {}
// Migrate the original single-search state without losing its price history.
const previousTargets = previous.targets || {
  "dawn-tower-shield": previous.listings || {}
};

const decodedSearches = TRACKED_SEARCHES.map(target => ({
  ...target,
  ...decodeTradeUrl(target.url)
}));
const league = await currentLeague(decodedSearches[0].origin);
const sameLeague = previous.league === league;
const currentTargets = {};
const currentCheapest = {};
const changes = [];
const newBaselines = [];

for (const [index, target] of decodedSearches.entries()) {
  // Space out separate trade searches to avoid sending them as a burst.
  if (index > 0) await new Promise(resolve => setTimeout(resolve, SEARCH_GAP_MS));

  const search = await tradeJson(`${target.origin}/api/trade/search/${encodeURIComponent(league)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: target.query, sort: { price: "asc" } })
  });
  const ids = (search.result || []).slice(0, LIMIT);
  if (!search.id) throw new Error(`Trade search returned no query ID for ${target.name}`);
  if (Number(search.total || 0) > 0 && !ids.length) throw new Error(`Trade search reported matches but returned no listing IDs for ${target.name}`);

  const listings = {};
  let cheapest = null;
  if (ids.length) {
    const data = await tradeJson(`${target.origin}/api/trade/fetch/${ids.join(",")}?query=${encodeURIComponent(search.id)}`);
    for (const entry of data.result || []) {
      const price = entry.listing?.price;
      if (entry.id && price && Number.isFinite(Number(price.amount))) {
        const listing = {
          amount: Number(price.amount),
          currency: price.currency || "?",
          item: entry.item?.typeLine || entry.item?.name || "物品"
        };
        listings[entry.id] = listing;
        if (!cheapest) cheapest = listing;
      }
    }
  }
  if (ids.length && !Object.keys(listings).length) throw new Error(`Could not fetch prices for ${target.name}; keeping previous state`);

  currentTargets[target.id] = listings;
  currentCheapest[target.id] = { target: target.name, listing: cheapest };
  const oldListings = sameLeague ? previousTargets[target.id] : null;
  if (oldListings && Object.keys(oldListings).length) {
    for (const [id, current] of Object.entries(listings)) {
      const old = oldListings[id];
      if (old && (old.amount !== current.amount || old.currency !== current.currency)) {
        changes.push({ target: target.name, old, current });
      }
    }
  } else {
    newBaselines.push(target.name);
  }
}

const cheapestLines = decodedSearches.map(target => {
  const current = currentCheapest[target.id]?.listing;
  return current
    ? `• ${target.name}：**${current.amount} ${displayCurrency(current.currency)}**`
    : `• ${target.name}：目前沒有掛單`;
});
const cheapestText = ["目前最低掛單：", ...cheapestLines].join("\n");
const links = decodedSearches.map(target => `[ ${target.name} ](${leagueSearchUrl(target.url, league)})`).join("\n");

if (previous.league && previous.league !== league) {
  await postDiscord([
    `**PoE 價格追蹤：新賽季**（${league}）`,
    "已重設追蹤搜尋的比價基準。",
    cheapestText,
    links
  ].join("\n"));
} else if (IS_MANUAL_TEST) {
  const totalListings = Object.values(currentTargets).reduce((sum, listings) => sum + Object.keys(listings).length, 0);
  const changeText = changes.length
    ? `發現 ${changes.length} 筆價格變動：`
    : "目前價格沒有變動。";
  const changeLines = changes.map(({ target, old, current }) => `• ${target}／${current.item}：${old.amount} ${displayCurrency(old.currency)} → **${current.amount} ${displayCurrency(current.currency)}**`);
  const baselineText = newBaselines.length ? `首次建立基準：${newBaselines.join("、")}。` : "";
  await postDiscord([
    `**PoE 價格追蹤手動測試**（${league}）`,
    `已檢查 ${decodedSearches.length} 個搜尋、共 ${totalListings} 筆掛單。`,
    changeText,
    ...changeLines,
    baselineText,
    cheapestText,
    links
  ].filter(Boolean).join("\n"));
} else {
  const changeText = changes.length
    ? `追蹤的搜尋結果前 ${LIMIT} 筆中，${changes.length} 筆既有掛單改價：`
    : "本次檢查沒有價格變動。";
  const changeLines = changes.map(({ target, old, current }) => `• ${target}／${current.item}：${old.amount} ${displayCurrency(old.currency)} → **${current.amount} ${displayCurrency(current.currency)}**`);
  await postDiscord([
    `**PoE 價格追蹤通知**（${league}）`,
    changeText,
    ...changeLines,
    cheapestText,
    links
  ].join("\n"));
}

await writeFile(STATE_PATH, JSON.stringify({ league, targets: currentTargets }, null, 2) + "\n", "utf8");
const totalListings = Object.values(currentTargets).reduce((sum, listings) => sum + Object.keys(listings).length, 0);
console.log(`Checked ${decodedSearches.length} searches and ${totalListings} listings in ${league}.`);
