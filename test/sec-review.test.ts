/** Regression tests for the findings in security review 1 (box code). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { dataPaths, ensureDirs } from "../src/setup/steps.js";
import { ensurePairing } from "../src/web/auth.js";
import { createHandler } from "../src/web/server.js";
import type { Wizard } from "../src/web/wizard.js";

function call(port: number, method: string, path: string, form?: Record<string, string>): Promise<number> {
  const host = "192.168.1.50:8080";
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const headers: Record<string, string> = { host };
  if (body !== undefined) Object.assign(headers, { "content-type": "application/x-www-form-urlencoded", origin: `http://${host}` });
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode ?? 0));
    });
    req.on("error", fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("security review 1: pairing lockout", () => {
  const paths = dataPaths(mkdtempSync(join(tmpdir(), "qw-sec-")));
  let server: Server;
  let port = 0;
  let code = "";

  before(async () => {
    ensureDirs(paths);
    code = ensurePairing(paths.uiDir).pairing!.code;
    // The claim screens never touch the wizard.
    server = createServer(createHandler({ paths, wizard: {} as unknown as Wizard, appDir: process.cwd() }));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as AddressInfo).port;
  });
  after(() => server.close());

  it("wrong setup links (GET, no Origin needed) do not lock the pairing code", async () => {
    for (let i = 0; i < 15; i++) assert.equal(await call(port, "GET", "/setup?token=guess" + i), 403);
    assert.equal(await call(port, "POST", "/setup/pair", { code }), 303);
  });

  it("wrong codes still lock the code entry after 10 tries", async () => {
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 10; i++) assert.equal(await call(port, "POST", "/setup/pair", { code: wrong }), 403);
    assert.equal(await call(port, "POST", "/setup/pair", { code }), 429);
  });
});

describe("security review 1: file modes of older installs", () => {
  it("the entrypoint makes camera.env and qorewitness.env 600 and the folders 700", () => {
    const data = mkdtempSync(join(tmpdir(), "qw-sec-modes-"));
    mkdirSync(join(data, "keys"));
    chmodSync(data, 0o755);
    chmodSync(join(data, "keys"), 0o755);
    writeFileSync(join(data, "camera.env"), "QW_DEVICE=cam\nQW_STREAM_URL=rtsp://u:secret1@192.168.1.20:554/stream1\n", { mode: 0o644 });
    writeFileSync(join(data, "qorewitness.env"), "QORE_NETWORK=testnet\n", { mode: 0o644 });
    const r = spawnSync("bash", [resolve("deploy/docker-entrypoint.sh"), "true"], {
      env: { PATH: process.env.PATH, QW_APP: resolve("."), QW_DATA: data }, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(statSync(join(data, "camera.env")).mode & 0o777, 0o600);
    assert.equal(statSync(join(data, "qorewitness.env")).mode & 0o777, 0o600);
    assert.equal(statSync(data).mode & 0o777, 0o700);
    assert.equal(statSync(join(data, "keys")).mode & 0o777, 0o700);
  });
});
