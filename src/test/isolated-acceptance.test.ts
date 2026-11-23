import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unsafeArchiveName } from "@/core/isolated-archive";

describe("isolated acceptance", () => {
  it("rejects archive paths that leave the work directory", () => {
    expect(unsafeArchiveName("src/server.js")).toBe(false);
    expect(unsafeArchiveName("../etc/passwd")).toBe(true);
    expect(unsafeArchiveName("/etc/passwd")).toBe(true);
    expect(unsafeArchiveName("C:/Windows/system.ini")).toBe(true);
  });

  it("keeps the test container off the network", () => {
    const script = readFileSync("deploy/vm9/acceptance-loop.sh", "utf8");
    expect(script).toContain("--network none");
    expect(script).not.toContain("--network host");
    expect(script).toContain("docker.m.daocloud.io/library/node:22-alpine");
  });
});
