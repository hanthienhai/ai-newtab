import type { BrowserBridge, ScrapedPage } from "@homepage/agent-core";
import sanitizeHtml from "sanitize-html";

type ScrapeReport = Awaited<ReturnType<BrowserBridge["getPageHtml"]>>;

/** What entrypoints/scraper.content.ts returns from inside the page. */
interface ScraperResult {
  title: string;
  html: string;
}

interface ScrapeOptions {
  loadDelay?: number; // Delay in ms after page load completes
  maxRetries?: number; // Maximum number of retry attempts
  retryDelay?: number; // Initial retry delay in ms
  timeout?: number; // Maximum time to wait for a page in ms
  concurrentTabs?: number; // Number of tabs to process concurrently
}

const DEFAULT_OPTIONS: Required<ScrapeOptions> = {
  loadDelay: 8000, // 8 seconds default delay after load
  maxRetries: 3,
  retryDelay: 1000, // 1 second initial retry delay
  timeout: 30000, // 30 seconds timeout
  concurrentTabs: 3, // Process up to 3 tabs at once
};

/** Keep content and links; drop scripts, styles, attributes and empty wrappers. */
function cleanHtmlForLLM(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      // Text content
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "a",
      "em",
      "strong",
      "b",
      "i",
      "blockquote",
      "code",
      "pre",
      // Lists
      "ul",
      "ol",
      "li",
      // Tables
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      // Media
      "img",
      "figure",
      "figcaption",
      // Structure
      "div",
      "span",
      "br",
      "hr",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    // Remove empty tags
    exclusiveFilter: (frame) => {
      return !frame.text.trim() && !frame.tag.match(/^(img|br|hr)$/);
    },
  });
}

/**
 * The open scraper window's id, kept in session storage (cleared when the
 * browser restarts, so a stale id can never name one of the user's windows).
 * If the worker dies mid-scrape, the next tick closes the window it left behind.
 */
const SCRAPER_WINDOW_KEY = "scraperWindowId";

/** Wait `ms`, or less if the build is cancelled first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Scrape in a separate unfocused window so tabs don't flash in front of the user. */
async function createScraperWindow(): Promise<number> {
  const win = await browser.windows.create({
    focused: false,
    state: "normal",
    width: 1200,
    height: 800,
  });
  if (win?.id === undefined) throw new Error("Could not open the scraper window");
  await browser.storage.session.set({ [SCRAPER_WINDOW_KEY]: win.id }).catch(() => {});
  return win.id;
}

async function closeScraperWindow(windowId: number) {
  await browser.storage.session.remove(SCRAPER_WINDOW_KEY).catch(() => {});
  try {
    await browser.windows.remove(windowId);
  } catch {
    // Already gone (closed by the user, or by an abort).
  }
}

/** Close a scraper window left open by a build the worker didn't live to finish. */
export async function closeOrphanScraperWindow() {
  const stored = await browser.storage.session.get(SCRAPER_WINDOW_KEY).catch(() => ({}));
  const windowId = (stored as Record<string, unknown>)[SCRAPER_WINDOW_KEY];
  if (typeof windowId === "number") await closeScraperWindow(windowId);
}

async function scrapeUrl(
  url: string,
  windowId: number,
  opts: Required<ScrapeOptions>,
  signal?: AbortSignal,
): Promise<ScrapedPage | null> {
  try {
    if (signal?.aborted) return null;
    // Create a new tab in the scraper window
    const tab = await browser.tabs.create({
      url,
      active: false,
      windowId,
    });
    // Autoplaying video or audio shouldn't start playing out of a background build.
    void browser.tabs.update(tab.id!, { muted: true }).catch(() => {});

    // Wait for the tab to load with timeout
    const loadComplete = await waitForTabLoad(tab.id!, opts.timeout, signal);

    if (!loadComplete) {
      if (!signal?.aborted) console.error(`Timeout waiting for ${url} to load`);
      await browser.tabs.remove(tab.id!).catch(() => {});
      return null;
    }

    // Additional delay for dynamic content
    await sleep(opts.loadDelay, signal);

    // Try to extract content with retries
    let result: ScraperResult | null = null;
    let retryCount = 0;
    let currentDelay = opts.retryDelay;

    while (retryCount <= opts.maxRetries && !result && !signal?.aborted) {
      try {
        // Scrolls to trigger lazy content, then returns { title, html }.
        const injectionResults = await browser.scripting.executeScript({
          target: { tabId: tab.id! },
          files: ["/content-scripts/scraper.js"],
        });

        if (
          injectionResults &&
          injectionResults[0] &&
          injectionResults[0].result
        ) {
          result = injectionResults[0].result as ScraperResult;

          // Validate result has content
          if (!result.html || result.html.trim() === "") {
            result = null;
            throw new Error("Empty content extracted");
          }
        }
      } catch (error) {
        console.warn(`Attempt ${retryCount + 1} failed for ${url}:`, error);

        if (retryCount < opts.maxRetries) {
          // Wait before retry with exponential backoff
          await sleep(currentDelay, signal);
          currentDelay *= 2; // Exponential backoff
        }
      }

      retryCount++;
    }

    // Close the tab (it is already gone if the window closed under it)
    await browser.tabs.remove(tab.id!).catch(() => {});

    if (result) {
      return {
        url,
        title: result.title,
        html: cleanHtmlForLLM(result.html),
      };
    } else {
      console.error(
        `Failed to extract content from ${url} after ${opts.maxRetries} retries`
      );
      return null;
    }
  } catch (error) {
    console.error(`Failed to scrape ${url}:`, error);
    return null;
  }
}

/**
 * Load each URL in the user's real (logged-in) browser and return sanitized HTML,
 * reporting failures rather than dropping them — the model needs to know which
 * of the pages it asked for didn't come back.
 */
export async function scrapeUrls(
  urls: string[],
  options?: ScrapeOptions,
  signal?: AbortSignal,
): Promise<ScrapeReport> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const pages: ScrapedPage[] = [];
  const failed: ScrapeReport["failed"] = [];

  // Create a separate window for scraping
  const windowId = await createScraperWindow();
  // Cancelling closes the window at once instead of after the current batch.
  const onAbort = () => void closeScraperWindow(windowId);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // Process URLs in batches
    for (let i = 0; i < urls.length && !signal?.aborted; i += opts.concurrentTabs) {
      const batch = urls.slice(i, i + opts.concurrentTabs);

      const batchResults = await Promise.all(
        batch.map(async (url) => ({ url, page: await scrapeUrl(url, windowId, opts, signal) }))
      );

      for (const { url, page } of batchResults) {
        if (page) pages.push(page);
        else failed.push({ url, reason: "failed to load or extract within timeout" });
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await closeScraperWindow(windowId);
  }

  return { pages, failed };
}

/**
 * Resolve true once the tab has finished loading, false on timeout, when the tab
 * is closed (say, the user shut the scraper window) or when the build is cancelled.
 */
async function waitForTabLoad(
  tabId: number,
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      signal?.removeEventListener("abort", onAbort);
      resolve(loaded);
    };

    const onUpdated = (changedTabId: number, changeInfo: { status?: string }) => {
      if (changedTabId === tabId && changeInfo.status === "complete") finish(true);
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish(false);
    };
    const onAbort = () => finish(false);

    const timeoutId = setTimeout(() => finish(false), timeout);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) finish(false);

    // A fast or cached page can finish loading before the listener above was
    // attached; without this check it would sit out the whole timeout and be lost.
    browser.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish(true);
      })
      .catch(() => finish(false));
  });
}
