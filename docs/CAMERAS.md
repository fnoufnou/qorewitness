# Cameras: what works with QoreWitness

QoreWitness works with any camera that sends a video stream on your home network: an RTSP stream, which most ONVIF cameras have. The setup searches your network for cameras, you pick yours and its brand, and you type the camera account. For brands that are not in the list, you paste the camera's full rtsp:// link.

The brand data (ports, links, where to switch the stream on) lives in `src/web/cameras.ts`. The setup, these docs and the site use the same data.

## Compatibility

| Camera | Status | Link that QoreWitness uses | Notes |
|---|---|---|---|
| LSC Smart Connect indoor camera (Action) | Tested by us | `rtsp://IP:8554/main` | Our live camera since 9 Nov 2026. Needs firmware with RTSP (see the [research notes](research/2026-11-09-camera-notes.md)). Pick "Other camera" and paste the link. |
| Stand-in RTSP camera (mediamtx with an ffmpeg test pattern) | Tested by us | `rtsp://NAME:PASSWORD@IP:554/stream1` | End-to-end run of 22 Nov 2026: setup, sealing, camera off and on, evidence file. |
| TP-Link Tapo (wired models, for example C100, C200, C210) | Works with RTSP | `rtsp://NAME:PASSWORD@IP:554/stream1` (standard quality: `/stream2`) | Documented by TP-Link (FAQ 2680). Make a Camera Account in the Tapo app. Test with a C210 by us planned. Tapo Care, microSD and a recorder: only two of the three at a time. |
| Reolink (wired and Wi-Fi models with RTSP) | Works with RTSP | `rtsp://NAME:PASSWORD@IP:554/h264Preview_01_main` (`_sub` for standard quality) | Documented by Reolink. Newer firmware has RTSP switched off: switch it on in the network or port settings. H.265 models: `h265Preview_01_main`. |
| Hikvision, Annke | Works with RTSP | `rtsp://NAME:PASSWORD@IP:554/Streaming/Channels/101` (`102` for standard quality) | Documented by Hikvision. Annke uses Hikvision firmware on most models: check your manual. |
| Dahua, Amcrest | Works with RTSP | `rtsp://NAME:PASSWORD@IP:554/cam/realmonitor?channel=1&subtype=0` (`subtype=1` for standard quality) | Documented by Dahua and Amcrest. |
| Ubiquiti UniFi Protect | Works with RTSP | the `rtsps://...:7441/...` link that Protect shows | Switch on an RTSP stream per camera in Protect (Settings, Advanced). Paste the link. |
| Axis | Works with RTSP | `rtsp://NAME:PASSWORD@IP:554/axis-media/media.amp` | Documented by Axis (VAPIX). Standard quality depends on the model: check your manual. |
| Other ONVIF or RTSP cameras | Works with RTSP, check first | the rtsp:// link from your manual | Check the link with VLC first (below). |
| Battery cameras and cloud-only cameras (for example Ring, Blink, Google Nest, most Arlo, Tapo and Reolink battery models) | Not supported | none | They send no local stream, or only for a short time after motion. QoreWitness needs a stream that runs all the time. |

Sound: when the camera sends sound, QoreWitness keeps it in the clips (converted to AAC, 32 kbit/s mono, because MP4 cannot hold the G.711 sound of many cameras). Switch the microphone off in the camera's app to keep only the picture, or set `QW_AUDIO=0` in `~/qorewitness/data/camera.env`. The fingerprint covers picture and sound together.

Video formats: H.264 and H.265 are supported. The recorder copies the stream without re-encoding (tested with ffmpeg 6 for both). The setup refuses other formats, such as MJPEG, with a clear message: choose H.264 or H.265 in the camera settings. H.265 clips may not play in every player (QuickTime on older Macs). VLC plays them.

## Check your camera with VLC

Before the setup, or when the setup says that no camera answered, check the stream yourself:

1. Install VLC from videolan.org (Windows, Mac or Linux) on a computer in the same home network.
2. Find the camera's address (IP) in the camera's app or in your router's app.
3. Write the link with the table above, for example `rtsp://admin:yourpassword@192.168.1.20:554/Streaming/Channels/101`.
4. In VLC choose Media > Open Network Stream (Mac: File > Open Network), paste the link and press Play.
5. You see the camera picture: QoreWitness can use this camera with the same link. Pick the brand in the setup, or pick "Other camera" and paste the link.
6. No picture: check the name and password, check that RTSP is switched on in the camera's app, and close other live views (many cameras send only a few streams at a time).

## How "Find my camera" works

The setup checks the ports 554, 8554 (RTSP) and 2020 (ONVIF on Tapo) on every address of your home network (/24), and asks the cameras it finds for their ONVIF name (WS-Discovery Probe on port 3702). It takes a few seconds and never changes a camera. The ui container runs on Docker's bridge network, which does not pass multicast. The search therefore sends the ONVIF question directly to each address (unicast), which Docker passes. Tested on the test computer of 22 Nov 2026: both cameras on the network were found from the bridge network. When a camera does not show up, type its address.

## Research notes

Our notes from 9 Nov 2026 on the LSC camera and a Tapo doorbell (firmware, RTSP, fallbacks): [research/2026-11-09-camera-notes.md](research/2026-11-09-camera-notes.md). Treat them as background only.
