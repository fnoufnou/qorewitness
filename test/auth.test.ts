import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  FailureLimiter, checkPassword, clearPairing, csrfOk, csrfToken, ensurePairing, hasPassword, hostAllowed, issueSession, originOk,
  passwordProblem, privateAddress, readPairing, sessionSecret, sessionValid, setPassword,
} from "../src/web/auth.js";

const uiDir = () => mkdtempSync(join(tmpdir(), "qw-auth-"));

describe("auth: Host allowlist (DNS rebinding)", () => {
  it("accepts private IP literals, localhost, .local and configured names", () => {
    for (const h of ["192.168.1.10:8080", "10.0.0.5", "172.20.1.1:8080", "127.0.0.1:8080", "localhost:8080", "qorewitness.local:8080", "[::1]:8080", "[fd12::1]:8080", "[fe80::1]"]) {
      assert.ok(hostAllowed(h), h);
    }
    assert.ok(hostAllowed("box.home.arpa:8080", ["box.home.arpa"]));
  });

  it("refuses public names, public IPs and malformed hosts", () => {
    for (const h of [undefined, "", "evil.example.com", "evil.example.com:8080", "8.8.8.8", "172.32.0.1", "[2001:db8::1]:8080", "192.168.1.10@evil.com", "local", "x/y", "qorewitness.local.evil.com"]) {
      assert.equal(hostAllowed(h), false, String(h));
    }
    assert.equal(hostAllowed("box.home.arpa", []), false);
  });
});

describe("auth: Origin check", () => {
  it("needs the same host and scheme http(s)", () => {
    assert.ok(originOk("http://192.168.1.10:8080", "192.168.1.10:8080"));
    assert.equal(originOk("http://192.168.1.10:8081", "192.168.1.10:8080"), false);
    assert.equal(originOk("http://evil.com", "192.168.1.10:8080"), false);
    assert.equal(originOk("null", "192.168.1.10:8080"), false);
    assert.equal(originOk(undefined, "192.168.1.10:8080"), false);
    assert.equal(originOk("file://x", "x"), false);
  });
});

describe("auth: client address", () => {
  it("allows private ranges only", () => {
    for (const ip of ["192.168.0.2", "10.1.2.3", "172.17.0.1", "127.0.0.1", "::1", "::ffff:192.168.1.4", "fd00::2"]) assert.ok(privateAddress(ip), ip);
    for (const ip of [undefined, "8.8.8.8", "::ffff:8.8.8.8", "2001:db8::1", "100.64.0.1", "nonsense"]) assert.equal(privateAddress(ip), false, String(ip));
  });
});

describe("auth: pairing, password, session, CSRF", () => {
  it("creates a pairing token once, mode 600, with a 6-digit code", () => {
    const d = uiDir();
    const a = ensurePairing(d);
    assert.equal(a.created, true);
    assert.match(a.pairing!.code, /^\d{6}$/);
    assert.ok(a.pairing!.token.length >= 32);
    assert.equal(statSync(join(d, "setup-token")).mode & 0o777, 0o600);
    const b = ensurePairing(d);
    assert.equal(b.created, false);
    assert.equal(b.pairing!.token, a.pairing!.token);
    clearPairing(d);
    assert.equal(readPairing(d), undefined);
  });

  it("no pairing token once a password exists", () => {
    const d = uiDir();
    setPassword(d, "correct horse battery");
    assert.equal(ensurePairing(d).pairing, undefined);
    assert.ok(!existsSync(join(d, "setup-token")));
  });

  it("stores only a scrypt hash, mode 600, and checks it", () => {
    const d = uiDir();
    assert.equal(hasPassword(d), false);
    assert.throws(() => setPassword(d, "short"));
    setPassword(d, "correct horse battery");
    assert.equal(statSync(join(d, "auth.json")).mode & 0o777, 0o600);
    assert.ok(checkPassword(d, "correct horse battery"));
    assert.equal(checkPassword(d, "correct horse batterY"), false);
    assert.equal(passwordProblem("a".repeat(10), "b".repeat(10)), "The two passwords are not the same.");
  });

  it("sessions are signed, expire, and end when the password changes", () => {
    const d = uiDir();
    setPassword(d, "correct horse battery");
    const secret = sessionSecret(d)!;
    const now = Date.parse("2026-11-21T12:00:00Z");
    const s = issueSession(secret, now);
    assert.ok(sessionValid(secret, s, now));
    assert.equal(sessionValid(secret, s, now + 31 * 86_400_000), false);
    assert.equal(sessionValid(secret, s.slice(0, -1) + (s.endsWith("A") ? "B" : "A"), now), false);
    assert.equal(sessionValid(secret, "9999999999.AAAAAAAAAAAA.forged", now), false);
    setPassword(d, "another long password");
    assert.equal(sessionValid(sessionSecret(d), s, now), false);
  });

  it("CSRF tokens are bound to the session", () => {
    const secret = "s".repeat(43);
    const t = csrfToken(secret, "session-a");
    assert.ok(csrfOk(secret, "session-a", t));
    assert.equal(csrfOk(secret, "session-b", t), false);
    assert.equal(csrfOk(secret, "session-a", undefined), false);
    assert.equal(csrfOk(undefined, "session-a", t), false);
  });

  it("limits failures per key in a time window", () => {
    const l = new FailureLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) l.fail("ip", 1000 + i);
    assert.ok(l.blocked("ip", 2000));
    assert.equal(l.blocked("other", 2000), false);
    assert.equal(l.blocked("ip", 70_000), false);
  });
});
