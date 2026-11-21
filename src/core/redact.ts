/**
 * One shared rule to hide credentials in text that goes to a log, a page or an
 * error message. A stream URL such as rtsp://user:pass@192.168.1.20:554/stream1
 * becomes rtsp://***@192.168.1.20:554/stream1.
 *
 * scripts/record.sh applies the same rule to ffmpeg output with sed (keep both in step):
 *   sed -E 's#([A-Za-z][A-Za-z0-9+.-]*://)[^[:space:]/]*@#\1***@#g'
 */
const USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/]*@/g;

export function redactSecrets(text: string): string {
  return text.replace(USERINFO, "$1***@");
}

/** Message of an unknown thrown value, first line only, with credentials hidden. */
export function safeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return redactSecrets(msg.split("\n")[0] ?? "");
}
