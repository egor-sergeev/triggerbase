import { spawn } from "node:child_process";

export async function execute(
  argv: string[],
  cwd: string,
  input: string,
  timeout = 60_000,
  onLine?: (s: string) => void,
  env = process.env,
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      stdio: "pipe",
      detached: true,
    });
    let stdout = "",
      stderr = "",
      pending = "",
      failure: Error | undefined;
    function kill(reason: string) {
      failure = Error(reason);
      if (proc.pid)
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {}
    }
    const timer = setTimeout(() => kill("Process timed out"), timeout);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      if (failure) return;
      stdout += chunk;
      if (stdout.length > 8_000_000) {
        kill("Process output limit exceeded");
        return;
      }
      if (onLine) {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop()!;
        try {
          for (const line of lines) onLine(line);
        } catch {
          kill("Invalid host event");
        }
      }
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0)
        reject(
          failure ||
            Error("Process exited " + code + ": " + stderr.slice(-1000)),
        );
      else resolve({ stdout, stderr });
    });
  });
}
