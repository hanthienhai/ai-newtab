import { defineConfig } from "wxt";
import extensionKey from "../native-host/extension-key.json";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "AI Homepage",
    description: "A new-tab page an agent rebuilds daily from what you've actually been browsing.",
    // Pins the extension ID, which the native host manifest allow-lists.
    key: extensionKey.key,
    permissions: [
      "history", //       getHistory tool
      "tabs", //          getPageHtml: open pages and watch them load
      "scripting", //     getPageHtml: inject the scraper into loaded pages
      "storage", //       API key, settings, the built homepage
      "alarms", //        heartbeat: scheduled rebuilds + reattach after a worker kill
      "notifications", // surface a failed headless rebuild when no tab is open
      "nativeMessaging", // reach Claude Code through apps/native-host
    ],
    // Needed to scrape arbitrary pages.
    host_permissions: ["<all_urls>"],
  },
});
