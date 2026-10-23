#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const APP_NAME = "optimal";

type Config = {
  dbPath: string;
  browserCommand: string;
  intervalSeconds: number;
  maxPerCycle: number;
  maxPerFeed: number;
  timeoutSeconds: number;
  cookieFile: string | null;
  curlImpersonateCommand: string | null;
  curlImpersonateTimeoutSeconds: number;
};

type NetscapeCookie = {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
};

type Feed = { id: number; url: string; title: string | null; category: string | null };
type ParsedItem = { guid: string; title: string; url: string; commentsUrl: string | null; publishedAt: string | null };
type ImportFeed = { url: string; title: string | null; category: string | null };

function homeDir() {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set");
  return home;
}

function configPath() {
  if (process.env.OPTIMAL_CONFIG) return resolve(process.env.OPTIMAL_CONFIG);
  const base = process.env.XDG_CONFIG_HOME ?? `${homeDir()}/.config`;
  return `${base}/${APP_NAME}/config.json`;
}

function dataDir() {
  if (process.env.OPTIMAL_DATA_DIR) return resolve(process.env.OPTIMAL_DATA_DIR);
  const base = process.env.XDG_DATA_HOME ?? `${homeDir()}/.local/share`;
  return `${base}/${APP_NAME}`;
}

function defaultConfig(): Config {
  return {
    dbPath: process.env.OPTIMAL_DB ?? `${dataDir()}/optimal.sqlite`,
    browserCommand: "xdg-open {url}",
    intervalSeconds: 30 * 60,
    maxPerCycle: 80,
    maxPerFeed: 10,
    timeoutSeconds: 120,
    cookieFile: `${homeDir()}/.config/cookies.txt`,
    curlImpersonateCommand: "curl_chrome146",
    curlImpersonateTimeoutSeconds: 30,
  };
}

function usage(exitCode = 0): never {
  console.log(`optimal - OPML/RSS tab launcher

Usage:
  optimal init
  optimal import <file.opml> [--mark-current-seen]
  optimal export [file.opml]
  optimal add <url> [title]
  optimal remove <id|url>
  optimal list
  optimal check [--no-open] [--dry-run]
  optimal daemon [--no-open] [--dry-run]

Config: ${configPath()}
Database: ${defaultConfig().dbPath}
Build:  bun run build`);
  process.exit(exitCode);
}

function parseFlags(args: string[]) {
  return {
    noOpen: args.includes("--no-open"),
    dryRun: args.includes("--dry-run"),
    markCurrentSeen: args.includes("--mark-current-seen"),
    positional: args.filter((a) => !a.startsWith("--")),
  };
}

async function readConfig(): Promise<Config> {
  const path = configPath();
  const defaults = defaultConfig();
  if (!existsSync(path)) return defaults;
  const raw = await Bun.file(path).json();
  return { ...defaults, ...raw };
}

async function writeDefaultConfig() {
  const path = configPath();
  if (existsSync(path)) {
    console.log(`${path} already exists`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(defaultConfig(), null, 2) + "\n");
  console.log(`created ${path}`);
}

function openDb(config: Config) {
  const dbPath = resolve(config.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      title TEXT,
      category TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_checked_at TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      published_at TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      launched_at TEXT,
      UNIQUE(feed_id, guid)
    );
    CREATE TABLE IF NOT EXISTS launched_urls (
      url TEXT PRIMARY KEY,
      first_launched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO launched_urls(url, first_launched_at)
      SELECT url, min(launched_at)
      FROM items
      WHERE launched_at IS NOT NULL
      GROUP BY url;
  `);
  try {
    db.exec("ALTER TABLE items ADD COLUMN launch_failed_at TEXT");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE items ADD COLUMN launch_error TEXT");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  return db;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(obj: any, name: string): string | undefined {
  const v = obj?.[`@_${name}`];
  return typeof v === "string" ? v : undefined;
}

function collectOpmlFeeds(node: any, category: string | null = null): Array<{ url: string; title: string | null; category: string | null }> {
  const out: Array<{ url: string; title: string | null; category: string | null }> = [];
  for (const outline of asArray(node?.outline)) {
    const xmlUrl = attr(outline, "xmlUrl");
    const title = attr(outline, "title") ?? attr(outline, "text") ?? null;
    if (xmlUrl) {
      out.push({ url: xmlUrl, title, category });
    }
    const nextCategory = xmlUrl ? category : (title ?? category);
    out.push(...collectOpmlFeeds(outline, nextCategory));
  }
  return out;
}

async function importOpml(db: Database, config: Config, file: string, markCurrentSeen: boolean) {
  const xml = await Bun.file(file).text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const parsed = parser.parse(xml);
  const feeds = collectOpmlFeeds(parsed?.opml?.body);
  const stmt = db.prepare("INSERT INTO feeds(url, title, category) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET title=coalesce(excluded.title, feeds.title), category=coalesce(excluded.category, feeds.category)");
  const tx = db.transaction(() => {
    for (const feed of feeds) stmt.run(feed.url, feed.title, feed.category);
  });
  tx();
  console.log(`imported ${feeds.length} feeds`);
  if (markCurrentSeen) await markCurrentItemsSeen(db, config, feeds);
}

async function exportOpml(db: Database, file?: string) {
  const feeds = db.query("SELECT url, title, category FROM feeds ORDER BY coalesce(category, ''), coalesce(title, url)").all() as Array<{ url: string; title: string | null; category: string | null }>;
  const byCategory = new Map<string, typeof feeds>();
  for (const feed of feeds) {
    const key = feed.category || "Feeds";
    byCategory.set(key, [...(byCategory.get(key) ?? []), feed]);
  }
  const body = {
    outline: [...byCategory.entries()].map(([category, rows]) => ({
      "@_text": category,
      "@_title": category,
      outline: rows.map((f) => ({
        "@_type": "rss",
        "@_text": f.title ?? f.url,
        "@_title": f.title ?? f.url,
        "@_xmlUrl": f.url,
      })),
    })),
  };
  const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_", format: true });
  const xml = builder.build({ opml: { "@_version": "2.0", head: { title: "optimal export" }, body } });
  const output = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
  if (file) {
    await Bun.write(file, output);
    console.log(`exported ${feeds.length} feeds to ${file}`);
  } else {
    console.log(output);
  }
}

async function addFeed(db: Database, config: Config, url: string, title?: string) {
  let resolvedTitle = title;
  if (!resolvedTitle) {
    try {
      resolvedTitle = (await fetchFeedTitle(url, config)) ?? undefined;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`warning\tcould not fetch title for ${url}\t${msg}`);
    }
  }
  db.prepare("INSERT INTO feeds(url, title) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET title=coalesce(excluded.title, feeds.title)").run(url, resolvedTitle ?? null);
  console.log(`added ${resolvedTitle ? `${resolvedTitle} <${url}>` : url}`);
}

async function addMissingTitles(db: Database, config: Config) {
  const feeds = db.query("SELECT id, url, title, category FROM feeds WHERE title IS NULL OR trim(title) = '' ORDER BY id").all() as Feed[];
  const update = db.prepare("UPDATE feeds SET title = ? WHERE id = ?");
  let titled = 0;
  for (const feed of feeds) {
    try {
      const title = await fetchFeedTitle(feed.url, config);
      if (!title) continue;
      update.run(title, feed.id);
      titled++;
      console.log(`titled\t${feed.url}\t${title}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`error\t${feed.url}\t${msg}`);
    }
  }
  const anonymous = db.query("SELECT count(*) AS count FROM feeds WHERE title IS NULL OR trim(title) = ''").get() as { count: number };
  console.log(`titled=${titled} anonymous=${anonymous.count}`);
}

function removeFeed(db: Database, value: string) {
  const result = /^\d+$/.test(value)
    ? db.prepare("DELETE FROM feeds WHERE id = ?").run(Number(value))
    : db.prepare("DELETE FROM feeds WHERE url = ?").run(value);
  console.log(`removed ${result.changes} feed(s)`);
}

function listFeeds(db: Database) {
  const rows = db.query("SELECT id, url, title, category, last_checked_at, last_error FROM feeds ORDER BY id").all() as any[];
  for (const r of rows) {
    const label = r.title ? `${r.title} <${r.url}>` : r.url;
    const suffix = r.last_error ? ` ERROR: ${r.last_error}` : "";
    console.log(`${r.id}\t${r.category ?? "-"}\t${label}${suffix}`);
  }
  console.log(`${rows.length} feed(s)`);
}

function text(value: any): string | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object") return text(value["#text"] ?? value["@_href"]);
  return null;
}

function pickLink(link: any): string | null {
  if (typeof link === "string") return link.trim();
  for (const l of asArray(link)) {
    if (typeof l === "string") return l.trim();
    if (l?.["@_href"] && (!l["@_rel"] || l["@_rel"] === "alternate")) return String(l["@_href"]);
  }
  return null;
}

function pickCommentsLink(link: any): string | null {
  for (const l of asArray(link)) {
    if (l?.["@_href"] && (l["@_rel"] === "replies" || l["@_type"] === "text/html" && l["@_title"] === "Comments")) return String(l["@_href"]);
  }
  return null;
}

function parseFeedTitle(xml: string): string | null {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
  const doc = parser.parse(xml);
  return text(doc?.rss?.channel?.title) ?? text(doc?.feed?.title) ?? text(doc?.RDF?.channel?.title);
}

function parseFeed(xml: string): ParsedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel ?? doc?.RDF?.channel;
  const rssItems = asArray(channel?.item ?? doc?.RDF?.item);
  if (rssItems.length) {
    return rssItems.map((item: any) => {
      const url = pickLink(item.link) ?? text(item.guid) ?? "";
      const title = text(item.title) ?? url;
      const guid = text(item.guid) ?? url ?? `${title}:${text(item.pubDate) ?? ""}`;
      const commentsUrl = text(item.comments);
      return { guid, title, url, commentsUrl: commentsUrl && commentsUrl !== url ? commentsUrl : null, publishedAt: text(item.pubDate) ?? text(item.date) };
    }).filter((i) => i.url);
  }
  const entries = asArray(doc?.feed?.entry);
  return entries.map((entry: any) => {
    const url = pickLink(entry.link) ?? text(entry.id) ?? "";
    const title = text(entry.title) ?? url;
    const guid = text(entry.id) ?? url ?? `${title}:${text(entry.updated) ?? ""}`;
    const commentsUrl = pickCommentsLink(entry.link);
    return { guid, title, url, commentsUrl: commentsUrl && commentsUrl !== url ? commentsUrl : null, publishedAt: text(entry.published) ?? text(entry.updated) };
  }).filter((i) => i.url);
}

function parseNetscapeCookies(text: string): NetscapeCookie[] {
  const cookies: NetscapeCookie[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) continue;
    const normalized = line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line;
    const parts = normalized.split("\t");
    if (parts.length < 7) continue;
    const [domain, includeSubdomains, path, secure, expires, name, ...valueParts] = parts;
    cookies.push({
      domain,
      includeSubdomains: includeSubdomains.toUpperCase() === "TRUE",
      path,
      secure: secure.toUpperCase() === "TRUE",
      expires: Number(expires),
      name,
      value: valueParts.join("\t"),
    });
  }
  return cookies;
}

function cookieMatches(cookie: NetscapeCookie, url: URL, nowSeconds: number) {
  if (cookie.expires && cookie.expires < nowSeconds) return false;
  if (cookie.secure && url.protocol !== "https:") return false;
  if (!url.pathname.startsWith(cookie.path)) return false;
  const host = url.hostname.toLowerCase();
  const domain = cookie.domain.toLowerCase().replace(/^\./, "");
  if (cookie.includeSubdomains || cookie.domain.startsWith(".")) return host === domain || host.endsWith(`.${domain}`);
  return host === domain;
}

function expandHome(path: string) {
  return path.replace(/^~(?=\/)/, homeDir());
}

async function cookieHeaderForUrl(config: Config, urlText: string): Promise<string | null> {
  if (!config.cookieFile) return null;
  const cookiePath = resolve(expandHome(config.cookieFile));
  if (!existsSync(cookiePath)) return null;
  const url = new URL(urlText);
  const cookies = parseNetscapeCookies(await Bun.file(cookiePath).text());
  const now = Math.floor(Date.now() / 1000);
  const pairs = cookies
    .filter((cookie) => cookieMatches(cookie, url, now))
    .map((cookie) => `${cookie.name}=${cookie.value}`);
  return pairs.length ? pairs.join("; ") : null;
}

async function fetchWithCurlImpersonate(config: Config, url: string, originalError: string): Promise<string> {
  if (!config.curlImpersonateCommand) throw new Error(originalError);

  const proc = Bun.spawn([config.curlImpersonateCommand, "-s", "--max-time", String(config.curlImpersonateTimeoutSeconds), url], {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode === 0 && stdout.trim().length > 0) return stdout;
  const detail = stderr.trim() || `exit ${exitCode}`;
  throw new Error(`${originalError}; ${config.curlImpersonateCommand} fallback failed: ${detail}`);
}

async function fetchFeedXml(feed: Pick<Feed, "url">, config: Config): Promise<string> {
  const headers: Record<string, string> = { "user-agent": "optimal/0.1 (+https://local)" };
  const cookie = await cookieHeaderForUrl(config, feed.url);
  if (cookie) headers.cookie = cookie;
  const res = await fetch(feed.url, { headers, signal: AbortSignal.timeout(config.timeoutSeconds * 1000) });
  return res.ok
    ? await res.text()
    : await fetchWithCurlImpersonate(config, feed.url, `HTTP ${res.status}`);
}

async function fetchFeedTitle(url: string, config: Config): Promise<string | null> {
  return parseFeedTitle(await fetchFeedXml({ url }, config));
}

async function fetchFeed(feed: Pick<Feed, "url">, config: Config): Promise<ParsedItem[]> {
  return parseFeed(await fetchFeedXml(feed, config));
}

function shellQuote(s: string) {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

async function launchUrl(config: Config, url: string, dryRun: boolean): Promise<number> {
  const command = config.browserCommand.includes("{url}")
    ? config.browserCommand.replaceAll("{url}", shellQuote(url))
    : `${config.browserCommand} ${shellQuote(url)}`;
  if (dryRun) {
    console.log(`[dry-run] ${command}`);
    return 0;
  }
  const proc = Bun.spawn(["sh", "-lc", command], {
    stdout: "ignore",
    stderr: "inherit",
    signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
  });
  return await proc.exited;
}

async function markCurrentItemsSeen(db: Database, config: Config, feeds: ImportFeed[]) {
  const selectFeed = db.prepare("SELECT id, url, title, category FROM feeds WHERE url = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO items(feed_id, guid, url, title, published_at, launched_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");
  const markUrlLaunched = db.prepare("INSERT OR IGNORE INTO launched_urls(url) VALUES (?)");
  let marked = 0;
  for (const imported of feeds) {
    const feed = selectFeed.get(imported.url) as Feed | null;
    if (!feed) continue;
    try {
      const items = await fetchFeed(feed, config);
      const tx = db.transaction(() => {
        for (const item of items) {
          const result = insert.run(feed.id, item.guid, item.url, item.title, item.publishedAt);
          marked += result.changes;
          markUrlLaunched.run(item.url);
          if (item.commentsUrl) markUrlLaunched.run(item.commentsUrl);
        }
      });
      tx();
      db.prepare("UPDATE feeds SET last_checked_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?").run(feed.id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      db.prepare("UPDATE feeds SET last_checked_at=CURRENT_TIMESTAMP, last_error=? WHERE id=?").run(msg, feed.id);
      console.error(`error\t${feed.url}\t${msg}`);
    }
  }
  console.log(`marked current items as seen: ${marked}`);
}

async function checkFeeds(db: Database, config: Config, opts: { open: boolean; dryRun: boolean }) {
  const feeds = db.query("SELECT id, url, title, category FROM feeds ORDER BY id").all() as Feed[];
  console.log(`checking ${feeds.length} feeds (open=${opts.open} dryRun=${opts.dryRun})`);
  let launched = 0;
  let discovered = 0;
  const insert = db.prepare("INSERT OR IGNORE INTO items(feed_id, guid, url, title, published_at) VALUES (?, ?, ?, ?, ?)");
  const getItemState = db.prepare("SELECT launched_at, launch_failed_at FROM items WHERE feed_id = ? AND guid = ?");
  const markLaunched = db.prepare("UPDATE items SET launched_at = CURRENT_TIMESTAMP, launch_failed_at = NULL, launch_error = NULL WHERE feed_id = ? AND guid = ? AND launched_at IS NULL");
  const markLaunchFailed = db.prepare("UPDATE items SET launch_failed_at = CURRENT_TIMESTAMP, launch_error = ? WHERE feed_id = ? AND guid = ?");
  const hasLaunchedUrl = db.prepare("SELECT 1 FROM launched_urls WHERE url = ?");
  const markUrlLaunched = db.prepare("INSERT OR IGNORE INTO launched_urls(url) VALUES (?)");
  for (const feed of feeds) {
    if (launched >= config.maxPerCycle) break;
    let perFeed = 0;
    try {
      const items = await fetchFeed(feed, config);
      console.log(`fetched ${items.length} items from ${feed.title ?? feed.url}`);
      db.prepare("UPDATE feeds SET last_checked_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?").run(feed.id);
      for (const item of items) {
        const result = insert.run(feed.id, item.guid, item.url, item.title, item.publishedAt);
        if (result.changes !== 0) {
          discovered++;
          console.log(`new\t${feed.title ?? feed.url}\t${item.title}\t${item.url}`);
        } else {
          const state = getItemState.get(feed.id, item.guid) as { launched_at: string | null; launch_failed_at: string | null } | null;
          if (state?.launched_at || !state?.launch_failed_at || !opts.open) continue;
          console.log(`retry-launch\t${feed.title ?? feed.url}\t${item.title}\t${item.url}`);
        }
        if (opts.open && launched < config.maxPerCycle && perFeed < config.maxPerFeed) {
          if (hasLaunchedUrl.get(item.url)) {
            if (!opts.dryRun) markLaunched.run(feed.id, item.guid);
            console.log(`duplicate-url\t${feed.title ?? feed.url}\t${item.title}\t${item.url}`);
            continue;
          }
          try {
            const exitCode = await launchUrl(config, item.url, opts.dryRun);
            if (exitCode !== 0) {
              markLaunchFailed.run(`exit ${exitCode}`, feed.id, item.guid);
              console.error(`launch-error\t${exitCode}\t${feed.title ?? feed.url}\t${item.title}\t${item.url}`);
              continue;
            }
            launched++;
            perFeed++;
            if (!opts.dryRun) {
              markUrlLaunched.run(item.url);
              markLaunched.run(feed.id, item.guid);
            }

            if (item.commentsUrl && launched < config.maxPerCycle && perFeed < config.maxPerFeed) {
              if (hasLaunchedUrl.get(item.commentsUrl)) {
                console.log(`duplicate-comments-url\t${feed.title ?? feed.url}\t${item.title}\t${item.commentsUrl}`);
              } else {
                const commentsExitCode = await launchUrl(config, item.commentsUrl, opts.dryRun);
                if (commentsExitCode === 0) {
                  launched++;
                  perFeed++;
                  if (!opts.dryRun) markUrlLaunched.run(item.commentsUrl);
                  console.log(`comments\t${feed.title ?? feed.url}\t${item.title}\t${item.commentsUrl}`);
                } else {
                  console.error(`comments-launch-error\t${commentsExitCode}\t${feed.title ?? feed.url}\t${item.title}\t${item.commentsUrl}`);
                }
              }
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            markLaunchFailed.run(msg, feed.id, item.guid);
            console.error(`launch-error\t${msg}\t${feed.title ?? feed.url}\t${item.title}\t${item.url}`);
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      db.prepare("UPDATE feeds SET last_checked_at=CURRENT_TIMESTAMP, last_error=? WHERE id=?").run(msg, feed.id);
      console.error(`error\t${feed.url}\t${msg}`);
    }
  }
  console.log(`discovered=${discovered} launched=${launched}`);
}

async function daemon(db: Database, config: Config, noOpen: boolean, dryRun: boolean) {
  console.log(`optimal daemon: interval=${config.intervalSeconds}s browser=${config.browserCommand}`);
  while (true) {
    console.log("checking feeds ");
    await checkFeeds(db, config, { open: !noOpen, dryRun });
    console.log(`sleeping for ${config.intervalSeconds} seconds...`);
    await Bun.sleep(config.intervalSeconds * 1000);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") usage(0);
  const flags = parseFlags(rest);
  const config = await readConfig();

  if (cmd === "init") {
    await writeDefaultConfig();
    openDb(config).close();
    console.log(`created ${config.dbPath}`);
    return;
  }

  const db = openDb(config);
  try {
    if (cmd === "import") {
      if (!flags.positional[0]) usage(1);
      await importOpml(db, config, flags.positional[0], flags.markCurrentSeen);
    } else if (cmd === "export") {
      await exportOpml(db, flags.positional[0]);
    } else if (cmd === "add") {
      if (!flags.positional[0]) usage(1);
      await addFeed(db, config, flags.positional[0], flags.positional.slice(1).join(" ") || undefined);
    } else if (cmd === "add-titles") {
      await addMissingTitles(db, config);
    } else if (cmd === "remove") {
      if (!flags.positional[0]) usage(1);
      removeFeed(db, flags.positional[0]);
    } else if (cmd === "list") {
      listFeeds(db);
    } else if (cmd === "check") {
      await checkFeeds(db, config, { open: !flags.noOpen, dryRun: flags.dryRun });
    } else if (cmd === "daemon") {
      await daemon(db, config, flags.noOpen, flags.dryRun);
    } else {
      usage(1);
    }
  } finally {
    if (cmd !== "daemon") db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
