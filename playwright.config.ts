import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    channel: process.env.TRIGGERBASE_CHROME || undefined,
    viewport: { width: 1040, height: 670 },
  },
  reporter: "list",
});
