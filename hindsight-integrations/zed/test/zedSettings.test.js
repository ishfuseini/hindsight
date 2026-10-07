import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SERVER_NAME,
  mcpEndpointUrl,
  buildContextServer,
  applyToSettings,
  removeFromSettings,
  isInstalled,
} from "../src/zedSettings.js";

function tmpPath(name = "settings.json") {
  return join(mkdtempSync(join(tmpdir(), "hz-settings-")), name);
}

test("mcpEndpointUrl builds a bank-scoped MCP path", () => {
  assert.equal(
    mcpEndpointUrl("https://api.hindsight.vectorize.io", "zed"),
    "https://api.hindsight.vectorize.io/mcp/zed/"
  );
  // Trailing slash on the base URL is normalized.
  assert.equal(mcpEndpointUrl("http://localhost:8888/", "proj"), "http://localhost:8888/mcp/proj/");
});

test("buildContextServer uses native HTTP with a header only when a token is set", () => {
  assert.deepEqual(buildContextServer("https://api.hindsight.vectorize.io", "secret", "zed"), {
    url: "https://api.hindsight.vectorize.io/mcp/zed/",
    headers: { Authorization: "Bearer secret" },
  });
  for (const apiUrl of ["http://localhost:8888", "http://memory.example.test"]) {
    assert.deepEqual(buildContextServer(apiUrl, null, "zed"), {
      url: `${apiUrl}/mcp/zed/`,
    });
  }
});

test("apply creates, then reports unchanged, then merges", () => {
  const p = tmpPath();
  try {
    const server = buildContextServer("https://api.hindsight.vectorize.io", "tok", "zed");

    const created = applyToSettings(p, server);
    assert.equal(created.action, "created");
    assert.ok(isInstalled(p));

    const again = applyToSettings(p, server);
    assert.equal(again.action, "unchanged");

    const server2 = buildContextServer("https://api.hindsight.vectorize.io", "tok", "other-bank");
    const merged = applyToSettings(p, server2);
    assert.equal(merged.action, "merged");
    const data = JSON.parse(readFileSync(p, "utf-8"));
    assert.equal(
      data.context_servers[SERVER_NAME].url,
      "https://api.hindsight.vectorize.io/mcp/other-bank/"
    );
  } finally {
    rmSync(join(p, ".."), { recursive: true, force: true });
  }
});

test("apply merges into existing settings without clobbering other keys", () => {
  const p = tmpPath();
  try {
    writeFileSync(
      p,
      JSON.stringify({ theme: "dark", context_servers: { other: { command: "x" } } }, null, 2)
    );
    const server = buildContextServer("https://api.hindsight.vectorize.io", "tok", "zed");
    const res = applyToSettings(p, server);
    assert.equal(res.action, "merged");
    const data = JSON.parse(readFileSync(p, "utf-8"));
    assert.equal(data.theme, "dark");
    assert.ok(data.context_servers.other);
    assert.ok(data.context_servers[SERVER_NAME]);
  } finally {
    rmSync(join(p, ".."), { recursive: true, force: true });
  }
});

test("JSONC (comments) settings are never rewritten — manual snippet returned", () => {
  const p = tmpPath();
  try {
    writeFileSync(p, '{\n  // user comment\n  "theme": "dark",\n}\n');
    const server = buildContextServer("https://api.hindsight.vectorize.io", "tok", "zed");
    const res = applyToSettings(p, server);
    assert.equal(res.action, "manual");
    assert.ok(res.snippet.includes("https://api.hindsight.vectorize.io/mcp/zed/"));
    // File is untouched.
    assert.ok(readFileSync(p, "utf-8").includes("// user comment"));
  } finally {
    rmSync(join(p, ".."), { recursive: true, force: true });
  }
});

test("remove deletes our entry and drops an empty context_servers", () => {
  const p = tmpPath();
  try {
    const server = buildContextServer("https://api.hindsight.vectorize.io", "tok", "zed");
    applyToSettings(p, server);
    const res = removeFromSettings(p);
    assert.equal(res.action, "removed");
    const data = JSON.parse(readFileSync(p, "utf-8"));
    assert.ok(!("context_servers" in data));
    assert.equal(isInstalled(p), false);
  } finally {
    rmSync(join(p, ".."), { recursive: true, force: true });
  }
});

test("apply replaces an existing stdio bridge while preserving other servers", () => {
  const p = tmpPath();
  try {
    writeFileSync(
      p,
      JSON.stringify({
        theme: "dark",
        context_servers: {
          hindsight: {
            command: "npx",
            args: ["-y", "mcp-remote", "http://memory.example.test/mcp/zed/"],
          },
          other: { command: "other-server" },
        },
      })
    );
    const server = buildContextServer("http://memory.example.test", "tok", "zed");
    assert.equal(applyToSettings(p, server).action, "merged");
    const settings = JSON.parse(readFileSync(p, "utf-8"));
    assert.deepEqual(settings.context_servers.hindsight, server);
    assert.deepEqual(settings.context_servers.other, { command: "other-server" });
    assert.equal(settings.theme, "dark");
    assert.equal(applyToSettings(p, server).action, "unchanged");
  } finally {
    rmSync(join(p, ".."), { recursive: true, force: true });
  }
});
