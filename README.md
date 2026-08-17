# optimal

Small OPML/RSS launcher: stores feeds in local SQLite, detects new items, and can open them as browser tabs.

## Install / run

```bash
bun install
bun run src/optimal.ts init
bun run src/optimal.ts import-opml feeds.opml --mark-current-seen
bun run src/optimal.ts check --dry-run
bun run src/optimal.ts check --open
bun run src/optimal.ts daemon
```

## Build single executable

```bash
bun run build
./optimal --help
```

## Commands

```text
optimal init
optimal import-opml <file.opml> [--mark-current-seen]
optimal export-opml [file.opml]
optimal add-feed <url> [title]
optimal remove-feed <id|url>
optimal list-feeds
optimal check [--open] [--dry-run]
optimal daemon [--dry-run]
```

`--mark-current-seen` imports feeds and records their current items as already launched, so the first daemon/check cycle only opens genuinely newer items.

## Config

`optimal init` creates `${XDG_CONFIG_HOME:-~/.config}/optimal/config.json`.

By default, the SQLite database lives at `${XDG_DATA_HOME:-~/.local/share}/optimal/optimal.sqlite`, so the binary works from any current directory.


```json
{
  "browserCommand": "xdg-open {url}",
  "intervalSeconds": 1800,
  "maxPerCycle": 80,
  "maxPerFeed": 10,
  "openOnCheck": false,
  "cookieFile": "~/.config/cookies.txt",
  "curlImpersonateCommand": "curl_chrome146",
  "curlImpersonateTimeoutSeconds": 30
}
```

You normally do not need to set `dbPath`; if omitted, optimal uses the XDG data path above.

If `cookieFile` points to a Netscape-format cookie jar, optimal sends matching cookies when fetching feeds. Set it to `null` to disable cookie usage.

If a feed returns a non-2xx HTTP status, optimal falls back to `curlImpersonateCommand` with the feed URL as argument. If that command exits with code 0 and writes stdout, optimal parses stdout as the feed body. Set `curlImpersonateCommand` to `null` to disable this fallback.

optimal stores every feed item, but tab launching is deduplicated globally by URL. If HN, Lobsters, and Reddit publish the same link, only the first occurrence is opened; later occurrences are marked as launched and logged as `duplicate-url`.

When `add-feed` is called without a title, optimal tries to read the feed title from the feed itself.

Examples:

```json
{ "browserCommand": "brave-browser --new-tab {url}" }
```

```json
{ "browserCommand": "firefox --new-tab {url}" }
```

Environment overrides:

```bash
OPTIMAL_CONFIG=/path/to/config.json optimal list-feeds
OPTIMAL_DATA_DIR=/path/to/data optimal init
OPTIMAL_DB=/path/to/optimal.sqlite optimal check
```

## systemd user service sketch

After building `./optimal`, install it somewhere stable, for example `~/.local/bin/optimal`:

```ini
[Unit]
Description=optimal RSS launcher

[Service]
ExecStart=%h/.local/bin/optimal daemon
Restart=on-failure

[Install]
WantedBy=default.target
```
