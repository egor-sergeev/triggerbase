import { test, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";

test("fresh daemon → empty UI → cron job → detail → validation error", async ({
  page,
}, info) => {
  const dir = mkdtempSync(join(tmpdir(), "tb-journal-")),
    env = { ...process.env, TRIGGERBASE_HOME: dir },
    cli = resolve("dist/cli.js");
  const proc = spawn(process.execPath, [cli, "start"], {
    env,
    stdio: "ignore",
  });
  try {
    await expect.poll(() => existsSync(join(dir, "journal.url"))).toBe(true);
    const url = readFileSync(join(dir, "journal.url"), "utf8");
    expect((await page.request.get(new URL("/jobs", url).href)).status()).toBe(
      401,
    );
    await page.goto(url);
    await expect(page.getByText(/No jobs yet/)).toBeVisible();
    await page.screenshot({ path: info.outputPath("empty.png") });
    writeFileSync(
      join(dir, "rules", "triage.trigger.yaml"),
      stringify({
        id: "meeting-notes",
        cron: "* * * * *",
        run: { command: [process.execPath, "-e", "process.stdin.resume()"] },
      }),
    );
    await expect
      .poll(
        () =>
          JSON.parse(
            execFileSync(process.execPath, [cli, "jobs"], {
              env,
              encoding: "utf8",
            }),
          )[0]?.status,
        { timeout: 15000 },
      )
      .toBe("completed");
    await page.reload();
    await expect(page.getByText("meeting-notes")).toBeVisible();
    await page.screenshot({ path: info.outputPath("jobs.png") });
    await page.getByRole("link", { name: "#1" }).click();
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await page.screenshot({ path: info.outputPath("detail.png") });
    writeFileSync(
      join(dir, "rules", "needs-attention.trigger.yaml"),
      "id: wrong\ncron: [invalid\n",
    );
    await page.getByRole("link", { name: "Rules" }).click();
    await expect(page.getByText("error", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("validation.png") });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByRole("link", { name: "Jobs" }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    proc.kill();
    await new Promise((ok) => proc.once("exit", ok));
    rmSync(dir, { recursive: true, force: true });
  }
});
