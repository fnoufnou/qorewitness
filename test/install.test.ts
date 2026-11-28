import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

/** Runs install.sh with a fake docker that records its calls. No network, no daemon. */
function run(home: string, args: string[] = [], pairOut = "token=TESTTOKEN_abcdefghijklmnopqrstuv\ncode=123456\n", piped = false) {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/bin/sh
echo "$*" >> "${home}/docker.log"
case "$*" in
  "compose run --rm -T ui pair"*) printf '${pairOut.replace(/\n/g, "\\n")}' ;;
  # The real docker compose reads stdin. With "curl | bash" that is the script itself.
  "compose up"*) cat > /dev/null ;;
esac
exit 0
`);
  chmodSync(join(bin, "docker"), 0o755);
  // Fake chown: the test may not run as root.
  writeFileSync(join(bin, "chown"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "chown"), 0o755);
  writeFileSync(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n');
  chmodSync(join(bin, "sudo"), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, QW_RAW: `file://${resolve(".")}`, QW_VERSION: "0.6.0-alpha.1" };
  // piped: as "curl -fsSL .../install.sh | bash -s -- --yes"
  if (piped) return spawnSync("bash", ["-s", "--", ...args], { env, encoding: "utf8", input: readFileSync("install.sh", "utf8") });
  return spawnSync("bash", [resolve("install.sh"), ...args], { env, encoding: "utf8", input: "" });
}

describe("install.sh (fake docker)", () => {
  it("pulls the pinned image, starts the box and prints the setup link and code", () => {
    const home = mkdtempSync(join(tmpdir(), "qw-inst-"));
    const r = run(home);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const dir = join(home, "qorewitness");
    const log = readFileSync(join(home, "docker.log"), "utf8");
    assert.match(log, /compose pull -q/);
    assert.match(log, /compose up -d/);
    assert.doesNotMatch(log, /compose build/);
    assert.match(r.stdout, /\/setup\?token=TESTTOKEN_abcdefghijklmnopqrstuv/);
    assert.match(r.stdout, /123 456/);
    const env = readFileSync(join(dir, ".env"), "utf8");
    assert.match(env, /^QW_VERSION=0\.6\.0-alpha\.1$/m);
    assert.match(env, /^QW_UI_BIND=(0\.0\.0\.0|127\.0\.0\.1):\d+$/m);
    assert.equal(statSync(join(dir, "SETUP-LINK.txt")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "data")).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(dir, "docker-compose.yml"), "utf8"), readFileSync("docker-compose.yml", "utf8"));
  });

  it("a second run keeps the port and shows the dashboard when the box is claimed", () => {
    const home = mkdtempSync(join(tmpdir(), "qw-inst-"));
    assert.equal(run(home).status, 0);
    const bind1 = /QW_UI_BIND=(.*)/.exec(readFileSync(join(home, "qorewitness", ".env"), "utf8"))![1];
    const r = run(home, [], "claimed\n");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Open your dashboard/);
    assert.equal(/QW_UI_BIND=(.*)/.exec(readFileSync(join(home, "qorewitness", ".env"), "utf8"))![1], bind1);
  });

  it("--local-only binds to 127.0.0.1, --new-password asks for a new code", () => {
    const home = mkdtempSync(join(tmpdir(), "qw-inst-"));
    const r = run(home, ["--local-only", "--new-password"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(home, "qorewitness", ".env"), "utf8"), /^QW_UI_BIND=127\.0\.0\.1:\d+$/m);
    assert.match(readFileSync(join(home, "docker.log"), "utf8"), /ui pair --new-password/);
  });

  it("curl | bash: prints the address and the code even when docker reads stdin (e2e 23 Nov)", () => {
    const home = mkdtempSync(join(tmpdir(), "qw-inst-"));
    const r = run(home, ["--yes"], undefined, true);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Pairing code: {2}123 456/);
    assert.match(readFileSync(join(home, "docker.log"), "utf8"), /ui pair/);
  });

  it("writes the home network with its prefix (QW_LAN_CIDR) for Find my camera (run 1, 28 Nov)", () => {
    const home = mkdtempSync(join(tmpdir(), "qw-inst-"));
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ip"), `#!/bin/sh
case "$*" in
  *"route get"*) echo "1.1.1.1 via 192.168.0.1 dev eth0 src 192.168.1.229 uid 0" ;;
  *"addr show"*) echo "2: eth0    inet 192.168.1.229/21 brd 192.168.7.255 scope global eth0\\       valid_lft forever preferred_lft forever" ;;
esac
`);
    chmodSync(join(bin, "ip"), 0o755);
    const r = run(home);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const env = readFileSync(join(home, "qorewitness", ".env"), "utf8");
    assert.match(env, /^QW_LAN_CIDR=192\.168\.1\.229\/21$/m);
    assert.match(env, /^QW_UI_PUBLIC_URL=http:\/\/192\.168\.1\.229:\d+$/m);
    assert.match(readFileSync("docker-compose.yml", "utf8"), /QW_LAN_CIDR: \$\{QW_LAN_CIDR:-\}/, "the ui container gets it");
  });

  it("refuses unknown options", () => {
    const home = mkdtempSync(join(tmpdir(), "qw-inst-"));
    assert.equal(run(home, ["--frobnicate"]).status, 2);
  });
});
