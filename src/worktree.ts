import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

const git = promisify(execFile);
export async function worktreeSource(cwd: string) {
  const options = {
    cwd,
    env: { ...process.env, LC_ALL: "C" },
    timeout: 10_000,
  };
  let root: string;
  try {
    const result = await git("git", ["rev-parse", "--show-toplevel"], options);
    root = result.stdout.replace(/\r?\n$/, "");
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT" && statSync(cwd).isDirectory())
      return { cwd, reason: "Git is unavailable" };
    if (
      /fatal: (not a git repository|this operation must be run in a work tree)/i.test(
        e.stderr || "",
      )
    )
      return { cwd, reason: "directory is outside a Git working tree" };
    throw error;
  }
  try {
    await git(
      "git",
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      options,
    );
  } catch (error) {
    if ((error as { code?: number }).code === 1)
      return { cwd, reason: "repository has no commit" };
    throw error;
  }
  return { cwd: root };
}

// A resume must not silently drift to the source or an unrelated repository.
export async function verifyLinkedCheckout(source: string, candidate: string) {
  const checkout = await worktreeSource(candidate);
  const { stdout } = await git(
    "git",
    ["worktree", "list", "--porcelain", "-z"],
    {
      cwd: source,
      timeout: 10_000,
    },
  );
  if (
    checkout.reason ||
    checkout.cwd === source ||
    !stdout.split("\0").includes("worktree " + checkout.cwd)
  ) {
    throw Error(
      "Codex did not report a separate worktree of the source repository",
    );
  }
}
