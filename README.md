# PoE Trade Price Watcher

Every five minutes, an external cron-job.org job triggers GitHub Actions. The workflow checks the first 10 online listings from the configured Taiwanese PoE trade search and sends a Discord message when the price of the same listing ID changes.

## Secrets to configure

In **Settings → Secrets and variables → Actions**, add this repository secret:

- `DISCORD_WEBHOOK`: the Discord channel webhook URL

The workflow never prints the secret. Do not put it in source files or the cron request.

## cron-job.org trigger

Create an HTTP job with a 5-minute schedule:

- Method: `POST`
- URL: `https://api.github.com/repos/kinecat413112-BOT/POE-bot/dispatches`
- Headers:
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer <FINE_GRAINED_GITHUB_TOKEN>`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `Content-Type: application/json`
- Body: `{"event_type":"poe_price_check"}`

Create a fine-grained Personal Access Token restricted to this repository, with **Contents: Read and write** permission. Store it only in cron-job.org as a header value; never commit it to this repository. GitHub documents that repository_dispatch requires Contents write permission.

You can first run the workflow manually from **Actions → PoE 前十筆物品價格檢查 → Run workflow**. The first successful run only saves the baseline and does not send a price-change alert. Later runs compare listing IDs and notify only when an existing listing's amount or currency changes. New listings and listings that disappear from the top 10 do not trigger alerts. If the active league changes, the baseline is reset and a season-change notice is sent.

## Scope and request volume

The check fetches the current challenge league, performs one search, then fetches up to 10 listing details in a single request. It monitors only the 10 cheapest online results. The trade API's rate limits can change dynamically; repeated 429 responses should be handled by slowing the cron schedule.

The search URL is configured in `poe-tracker/check.mjs`. The tracked state is stored in `poe-tracker/state.json`; GitHub Actions commits it only when the prices or listings have changed.

This project is not affiliated with or endorsed by Grinding Gear Games.
