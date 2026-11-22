import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { brandStreamUrl, CAMERA_ERRORS, codecSupported, snapshot } from "../src/web/camera.js";
import { CAMERA_BRANDS, brandById, brandFromOnvif } from "../src/web/cameras.js";
import { cameraLabel, discoverCameras, lanPrefix, parseProbeMatch, probeXml, wsDiscovery, xaddrHost } from "../src/web/discover.js";

describe("camera brands (src/web/cameras.ts)", () => {
  it("every brand is complete and has a unique id", () => {
    const ids = new Set<string>();
    for (const b of CAMERA_BRANDS) {
      assert.ok(!ids.has(b.id), b.id);
      ids.add(b.id);
      assert.ok(b.name && b.enableRtsp && b.port > 0 && b.port < 65536, b.id);
      if (!b.fullLink) assert.ok(b.mainPath && !b.mainPath.startsWith("/"), `${b.id} needs a main path`);
      if (b.pathStatus === "vendor" && !b.fullLink) assert.ok(b.source, `${b.id} needs a vendor source`);
    }
    assert.equal(CAMERA_BRANDS.at(-1)!.id, "other");
    assert.equal(brandById("nope").id, "other");
    assert.ok(JSON.parse(JSON.stringify(CAMERA_BRANDS)).length === CAMERA_BRANDS.length, "plain data for docs and site");
  });

  it("builds the documented links", () => {
    const v = { host: "192.168.1.20", user: "admin", password: "pw" };
    assert.equal(brandStreamUrl(brandById("tapo"), v), "rtsp://admin:pw@192.168.1.20:554/stream1");
    assert.equal(brandStreamUrl(brandById("tapo"), { ...v, quality: "sub" }), "rtsp://admin:pw@192.168.1.20:554/stream2");
    assert.equal(brandStreamUrl(brandById("reolink"), v), "rtsp://admin:pw@192.168.1.20:554/h264Preview_01_main");
    assert.equal(brandStreamUrl(brandById("hikvision"), { ...v, quality: "sub" }), "rtsp://admin:pw@192.168.1.20:554/Streaming/Channels/102");
    assert.equal(brandStreamUrl(brandById("dahua"), v), "rtsp://admin:pw@192.168.1.20:554/cam/realmonitor?channel=1&subtype=0");
    assert.equal(brandStreamUrl(brandById("axis"), { ...v, quality: "sub" }), "rtsp://admin:pw@192.168.1.20:554/axis-media/media.amp", "no sub path: main");
  });

  it("full links: rtsp only, the typed name and password go in when the link has none", () => {
    assert.equal(brandStreamUrl(brandById("unifi"), { link: "rtsps://192.168.1.1:7441/AbCdEf?enableSrtp" }), "rtsps://192.168.1.1:7441/AbCdEf?enableSrtp");
    assert.equal(brandStreamUrl(brandById("other"), { link: "rtsp://cam.local/ch0", user: "a b", password: "c@d" }), "rtsp://a%20b:c%40d@cam.local/ch0");
    assert.equal(brandStreamUrl(brandById("other"), { link: "rtsp://x:y@cam.local/ch0", user: "u", password: "p" }), "rtsp://x:y@cam.local/ch0");
    for (const link of ["", "http://cam/x", "file:///etc/passwd", "rtsp://"]) assert.throws(() => brandStreamUrl(brandById("other"), { link }), link);
    assert.throws(() => brandStreamUrl(brandById("tapo"), { host: "1.2.3.4/x", user: "u", password: "p" }));
    assert.throws(() => brandStreamUrl(brandById("tapo"), { host: "1.2.3.4", user: "", password: "p" }));
  });

  it("finds the brand in ONVIF words", () => {
    assert.equal(brandFromOnvif(["TP-IPC", "C210"]), "tapo");
    assert.equal(brandFromOnvif(["HIKVISION DS-2CD2143G2"]), "hikvision");
    assert.equal(brandFromOnvif([undefined, "IPC-HDW2431T", "Dahua"]), "dahua");
    assert.equal(brandFromOnvif(["Generic IPC"]), undefined);
  });
});

describe("video formats", () => {
  it("H.264 and H.265 are supported, MJPEG is not", () => {
    assert.ok(codecSupported("h264") && codecSupported("hevc") && codecSupported(undefined));
    assert.equal(codecSupported("mjpeg"), false);
  });

  it("the camera test refuses an MJPEG stream with plain words", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qw-ff-"));
    const ff = join(dir, "ffmpeg");
    writeFileSync(ff, `#!/bin/sh\necho "  Stream #0:0: Video: mjpeg (Baseline), yuvj420p, 1280x720, 10 fps" >&2\nprintf '\\377\\330'; head -c 200 /dev/zero\n`);
    chmodSync(ff, 0o755);
    const r = await snapshot("rtsp://u:p@10.0.0.2/x", { ffmpeg: ff });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, "unsupported");
      assert.equal(r.message, CAMERA_ERRORS.unsupported);
    }
  });

  it("no error text names one brand", () => {
    for (const t of Object.values(CAMERA_ERRORS)) assert.doesNotMatch(t, /Tapo|TP-Link|C210/);
  });
});

const TAPO_MATCH = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsdd="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<SOAP-ENV:Header><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action></SOAP-ENV:Header>
<SOAP-ENV:Body><wsdd:ProbeMatches><wsdd:ProbeMatch>
<wsa:EndpointReference><wsa:Address>uuid:3fa1fe68-b915-4053-a3e1-c006c3afec0e</wsa:Address></wsa:EndpointReference>
<wsdd:Types>dn:NetworkVideoTransmitter</wsdd:Types>
<wsdd:Scopes>onvif://www.onvif.org/name/TP-IPC onvif://www.onvif.org/hardware/C210 onvif://www.onvif.org/Profile/Streaming onvif://www.onvif.org/location/ShenZhen</wsdd:Scopes>
<wsdd:XAddrs>http://192.168.1.20:2020/onvif/device_service</wsdd:XAddrs>
<wsdd:MetadataVersion>1</wsdd:MetadataVersion>
</wsdd:ProbeMatch></wsdd:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

const HIK_MATCH = `<?xml version="1.0"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><d:ProbeMatches xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><d:ProbeMatch>
<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/HIKVISION%20DS-2CD2143G2-I onvif://www.onvif.org/hardware/DS-2CD2143G2-I</d:Scopes>
<d:XAddrs>http://192.168.1.64/onvif/device_service http://[fe80::1]/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></env:Body></env:Envelope>`;

describe("find my camera (src/web/discover.ts)", () => {
  it("parses WS-Discovery ProbeMatch answers", () => {
    const t = parseProbeMatch(TAPO_MATCH)!;
    assert.equal(t.name, "TP-IPC");
    assert.equal(t.hardware, "C210");
    assert.equal(xaddrHost(t), "192.168.1.20");
    const h = parseProbeMatch(HIK_MATCH)!;
    assert.equal(h.name, "HIKVISION DS-2CD2143G2-I");
    assert.equal(xaddrHost(h), "192.168.1.64");
    assert.equal(parseProbeMatch(probeXml()), undefined, "a Probe is no answer");
    assert.equal(parseProbeMatch("<html>"), undefined);
  });

  it("the Probe asks for video transmitters", () => {
    const x = probeXml("uuid:1");
    assert.match(x, /<d:Probe><d:Types>dn:NetworkVideoTransmitter<\/d:Types><\/d:Probe>/);
    assert.match(x, /uuid:1/);
  });

  it("takes the home /24 and skips Docker bridge addresses", () => {
    assert.equal(lanPrefix([undefined, "http://192.168.1.228:8080", "http://172.17.0.1:8080"]), "192.168.1");
    assert.equal(lanPrefix(["http://172.18.0.3:8080", "http://10.0.5.7:8080"]), "10.0.5");
    assert.equal(lanPrefix(["10.1.2.0/24"]), "10.1.2");
    assert.equal(lanPrefix(["http://localhost:8080", "http://8.8.8.8"]), undefined);
  });

  it("merges the TCP check and ONVIF answers, guesses Tapo from port 2020", async () => {
    const open = new Set(["192.168.1.20:554", "192.168.1.20:2020", "192.168.1.31:8554", "192.168.1.40:2020"]);
    const asked: string[][] = [];
    const found = await discoverCameras({
      prefix: "192.168.1",
      connect: async (ip, port) => open.has(`${ip}:${port}`),
      wsd: async (targets) => {
        asked.push(targets);
        return [
          { from: "192.168.1.64", match: parseProbeMatch(HIK_MATCH)! },
          { from: "10.9.9.9", match: { ...parseProbeMatch(TAPO_MATCH)!, xaddrs: ["http://10.9.9.9/onvif"] } },
        ];
      },
    });
    assert.deepEqual(asked[0].sort(), ["192.168.1.20", "192.168.1.31", "192.168.1.40"]);
    assert.deepEqual(found.map((f) => f.ip), ["192.168.1.20", "192.168.1.31", "192.168.1.40", "192.168.1.64"], "other subnets left out, sorted");
    assert.equal(found[0].brand, "tapo");
    assert.equal(found[3].brand, "hikvision");
    assert.equal(cameraLabel(found[3]), "Camera at 192.168.1.64 · HIKVISION DS-2CD2143G2-I DS-2CD2143G2-I");
    assert.equal(cameraLabel(found[1]), "Camera at 192.168.1.31");
  });

  it("sends a directed Probe and reads the answer (real UDP on localhost)", async (t) => {
    const cam = createSocket("udp4");
    const ok = await new Promise<boolean>((done) => {
      cam.once("error", () => done(false));
      cam.bind(3702, "127.0.0.1", () => done(true));
    });
    if (!ok) return t.skip("port 3702 is in use here");
    cam.on("message", (msg, r) => {
      if (/discovery\/Probe</.test(msg.toString())) cam.send(TAPO_MATCH, r.port, r.address);
    });
    try {
      const answers = await wsDiscovery(["127.0.0.1"], 300);
      assert.equal(answers.length, 1);
      assert.equal(answers[0].match.hardware, "C210");
    } finally {
      cam.close();
    }
  });
});
