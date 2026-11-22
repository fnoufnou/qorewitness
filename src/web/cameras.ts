/**
 * Camera brands and their RTSP links, in one place for the setup wizard, the
 * docs (docs/CAMERAS.md) and the site. Plain data: no functions, no RegExp.
 *
 * Rule: a path is "vendor" only when the camera maker documents it. Everything
 * else is "check-manual". Never guess a path for a brand that is not listed:
 * the user picks "Other" and pastes the full link instead.
 */

export type BrandId = "tapo" | "reolink" | "hikvision" | "dahua" | "unifi" | "axis" | "other";

export interface CameraBrand {
  id: BrandId;
  /** Name in the picker. */
  name: string;
  /** RTSP port. */
  port: number;
  /** Path of the main (high quality) stream, without the leading slash. Missing: the user pastes the full link. */
  mainPath?: string;
  /** Path of the sub (standard quality) stream. Missing: no standard quality choice. */
  subPath?: string;
  /** "vendor": documented by the maker. "check-manual": varies per model or firmware. */
  pathStatus: "vendor" | "check-manual";
  /** The user pastes the full rtsp:// link (UniFi Protect, Other). */
  fullLink: boolean;
  /** Where to switch on the stream or make the camera account, in the brand's own app. */
  enableRtsp: string;
  /** Short facts for the owner. */
  notes: string[];
  /** Words in the ONVIF name or hardware scope that point to this brand (lower case). */
  onvifWords: string[];
  /** Vendor source for the path, for the docs. */
  source?: string;
}

export const CAMERA_BRANDS: readonly CameraBrand[] = [
  {
    id: "tapo",
    name: "TP-Link Tapo",
    port: 554,
    mainPath: "stream1",
    subPath: "stream2",
    pathStatus: "vendor",
    fullLink: false,
    enableRtsp: "In the Tapo app: tap the camera, then the gear, then Advanced Settings > Camera Account. Make a name and a password of 6 to 32 letters and digits. Use a new password, not the one of your TP-Link account.",
    notes: [
      "Tapo Care, the microSD card and a recorder such as QoreWitness: only two of the three work at a time. If all three are on, turn one off.",
      "The camera sends at most two streams at a time. The live view in the Tapo app counts as one.",
    ],
    onvifWords: ["tapo", "tp-link", "tplink", "tp-ipc"],
    source: "TP-Link FAQ 2680",
  },
  {
    id: "reolink",
    name: "Reolink",
    port: 554,
    mainPath: "h264Preview_01_main",
    subPath: "h264Preview_01_sub",
    pathStatus: "vendor",
    fullLink: false,
    enableRtsp: "Newer Reolink cameras have RTSP switched off. In the Reolink app or client, open the network or port settings of the camera and switch on RTSP. Use the camera's own login (often admin).",
    notes: ["Cameras that record in H.265 use h265Preview_01_main. If the test finds no video, pick Other and paste that link."],
    onvifWords: ["reolink"],
    source: "Reolink support: How to access Reolink cameras via RTSP",
  },
  {
    id: "hikvision",
    name: "Hikvision or Annke",
    port: 554,
    mainPath: "Streaming/Channels/101",
    subPath: "Streaming/Channels/102",
    pathStatus: "vendor",
    fullLink: false,
    enableRtsp: "Use the camera's own login (often admin). RTSP is on by default on most models.",
    notes: ["Annke cameras are built on Hikvision firmware. Most use the same link. Check your manual if the test finds no video."],
    onvifWords: ["hikvision", "annke"],
    source: "Hikvision RTSP URL guide",
  },
  {
    id: "dahua",
    name: "Dahua or Amcrest",
    port: 554,
    mainPath: "cam/realmonitor?channel=1&subtype=0",
    subPath: "cam/realmonitor?channel=1&subtype=1",
    pathStatus: "vendor",
    fullLink: false,
    enableRtsp: "Use the camera's own login (often admin). RTSP is on by default on most models.",
    notes: [],
    onvifWords: ["dahua", "amcrest"],
    source: "Dahua and Amcrest RTSP guides",
  },
  {
    id: "unifi",
    name: "Ubiquiti UniFi Protect",
    port: 7441,
    pathStatus: "vendor",
    fullLink: true,
    enableRtsp: "In UniFi Protect: open the camera, then Settings > Advanced, and switch on an RTSP stream (High or Medium). Copy the link that Protect shows and paste it below.",
    notes: ["The link holds its own access code. You need no name or password."],
    onvifWords: ["ubiquiti", "unifi", "ubnt"],
    source: "Ubiquiti help: UniFi Protect RTSP",
  },
  {
    id: "axis",
    name: "Axis",
    port: 554,
    mainPath: "axis-media/media.amp",
    pathStatus: "vendor",
    fullLink: false,
    enableRtsp: "Use a camera user with viewer rights. You make it in the web page of the camera.",
    notes: ["Standard quality depends on the model: check your manual."],
    onvifWords: ["axis"],
    source: "Axis VAPIX RTSP API",
  },
  {
    id: "other",
    name: "Other camera (ONVIF or RTSP)",
    port: 554,
    pathStatus: "check-manual",
    fullLink: true,
    enableRtsp: "Find the RTSP link in the manual or the app of your camera. It starts with rtsp://. Check it first with VLC (Media > Open Network Stream).",
    notes: ["Battery cameras and cloud-only cameras often have no RTSP stream. They cannot be used."],
    onvifWords: [],
  },
];

export const brandById = (id: string | undefined): CameraBrand =>
  CAMERA_BRANDS.find((b) => b.id === id) ?? CAMERA_BRANDS.find((b) => b.id === "other")!;

/** Brand from ONVIF scopes (name, hardware, manufacturer). Undefined when no word matches. */
export function brandFromOnvif(words: (string | undefined)[]): BrandId | undefined {
  const text = words.filter(Boolean).join(" ").toLowerCase();
  if (!text) return undefined;
  return CAMERA_BRANDS.find((b) => b.onvifWords.some((w) => text.includes(w)))?.id;
}
