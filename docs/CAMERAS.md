# Camera stream research for the evidence-anchoring tool

Date: 2026-11-09. Scope: PoC / home use. Not production grade.
Method: web search and page fetch only. Nothing was tested on real devices.
Many sources are forum posts. Treat them as hints, not facts.

## Summary

| Camera | Best path | Confidence |
|---|---|---|
| LSC Smart Connect (x3) | Step 1: try the Tuya app ONVIF toggle, or go2rtc with a Tuya Smart account. Step 2: SD card "guino" hack (no flash write). | Medium |
| Tapo doorbell | Find the exact model first. Wired D225/D235/TD25 can give RTSP. D230S1 and D210 probably cannot. | Medium for D225, low for others |

## Important corrections to the assumptions

- The LAN name "Tuya camera (dgiot)" and the default root password `dgiot010` in the LSC hack repo match. So the LSC cameras likely use the same firmware family. Source: https://github.com/guino/LSC1080P
- One LSC camera reported its SoC as ANYKA AK39XXEV330, not Ingenic. Source: https://forum.hacf.fr/t/recuperer-rtsp-flasher-le-firmware-dune-camera-lsc-smart-outdoor-ip-camera/64962
- So "Ingenic" may be wrong for some models. The SoC likely differs per model. Check each one.
- OUI E0:CB:56 is registered to Shenzhen iComm Semiconductor. That is a Wi-Fi chip maker, not a camera brand. Source: https://maclookup.app/macaddress/e0cb56
- The thingino site lists Ingenic SoCs only (T-series plus A1N). Anyka is not listed. Source: https://thingino.com
- The thingino wiki camera list does include "LSC 3215672". Source: https://github.com/themactep/thingino-firmware/wiki/Cameras
- 3215672 is an Action "LSC Smart Connect indoor IP camera". Source: https://www.action.com/nl-be/p/3215672/lsc-smart-connect-smart-indoor-ip-camera/
- I could not confirm which SoC 3215672 uses. Open that wiki entry before you trust it.

## 1. LSC Smart Connect cameras

### Model list and identification

Models I could confirm from Action pages (titles only, specs not readable):
- 3215672: smart indoor IP camera. https://www.action.com/nl-be/p/3215672/lsc-smart-connect-smart-indoor-ip-camera/
- 3202092: outdoor IP camera. https://www.action.com/de-de/p/3202092/lsc-smart-connect-ip-aussenkamera/
- 3007325: pan/tilt ("pivotante") camera. https://www.action.com/fr-ch/p/3007325/camera-de-surveillance-pivotante-lsc-smart-connect/
- Outdoor IP camera, EAN 8712879154617, 1080p. https://shop.action.com/en-nl/p/8712879154617/lsc-smart-connect-outdoor-ip-camera
- Outdoor camera, EAN 8712879156918. https://shop.action.com/en-nl/p/8712879156918/lsc-smart-connect-outdoor-camera
- Outdoor wireless camera, EAN 8712879163534. https://shop.action.com/en-nl/p/8712879163534/lsc-smart-connect-outdoor-wireless-camera

Not confirmed: 3202087, 3202088, 3203409. I found no source for them. Do not rely on them.

Other variants named by users:
- "LSC Outdoor 1080P" and "LSC Rotating 1080P" (360 degree). https://relatedrepos.com/gh/guino/LSCOutdoor1080P
- "Dual Band" rotating camera from late 2024, needs a different patch. https://community.gladysassistant.com/t/tuto-integrer-une-camera-lsc-dans-gladys-via-rtsp/9250?tl=en
- Pan-tilt 1296p camera, firmware 3.2863.93, reported working. Same Gladys thread.
- Solar IP camera 1296p and the LSC doorbell: no working method reported. Same Gladys thread.

How to identify each unit (suggested, my own advice):
- Look at the sticker on the camera. It shows the article number and often the MAC.
- Check the firmware version in the LSC or Tuya app. Firmware strings like 3.286.81 appear in reports. Source: https://forum.hacf.fr/t/flux-rtsp-camera-lsc-tuya-et-integration-frigate/49350
- Scan open ports from the LAN. Port 8554 and 23/24 hints at the known firmware. Sources: https://github.com/guino/LSC1080P and https://community.gladysassistant.com/t/tuto-integrer-une-camera-lsc-dans-gladys-via-rtsp/9250?tl=en
- Firmware version matters. One unit on 3.2863.105 did not work with the hack. Same Gladys thread.

### Native RTSP / ONVIF on stock firmware

- One user reported an ONVIF toggle in the Tuya app. After enabling it they reached the camera on port 8554. Path: `rtsp://<ip>:8554/Streaming/Channels/101`. Reported Jan 2026, single report. Source: https://forum.hacf.fr/t/flux-rtsp-camera-lsc-tuya-et-integration-frigate/49350
- Another post lists the same doorbell-style path and `/main`, `/live/ch0` for other types. Source: https://forum.hacf.fr/t/cameras-lsc-smart-action-indisponibles-mais-visible-sur-tuya/46755/18
- Gladys docs say many LSC cameras are cloud-only and have no local RTSP. Some models need RTSP/ONVIF enabled in the app. Source: https://gladysassistant.com/docs/integrations/lsc/
- So: availability depends on model and firmware. Test per camera.

### SD card hack (no flash write)

- Repo: guino/LSCOutdoor1080P. It targets LSC Outdoor 1080P and Rotating 1080P. Last update May 2024. Source: https://relatedrepos.com/gh/guino/LSCOutdoor1080P
- Related repo guino/LSC1080P (indoor). Source: https://github.com/guino/LSC1080P
- Method for the indoor repo: put `product.cof` with `[DEFAULT_SETTING]` and `telnet=1` on the SD card. Boot. Telnet opens on port 23. Source: https://github.com/guino/LSC1080P
- RTSP URLs from that repo: `rtsp://IP:8554/main` and `rtsp://IP:8554/sub`. RTSP audio may not work. Source: https://github.com/guino/LSC1080P
- Option 1 changes nothing in flash. Remove the card and it reverts. Source: https://github.com/guino/LSC1080P
- The tools must be started again after each reboot (`initcheck.sh`). Source: https://github.com/guino/LSC1080P
- Rotating cameras: copy the repo `mmc` folder and `busybox` to the card, boot, wait 2 to 3 minutes, then add `anyka_ipc_rtsp`. Stream is `rtsp://IP/main_ch`. Default login `user` / `password`. Source: https://community.gladysassistant.com/t/tuto-integrer-une-camera-lsc-dans-gladys-via-rtsp/9250?tl=en
- A Home Assistant integration for rooted LSC cameras exists. It uses FFmpeg for RTSP and telnet on port 24 for time sync. Source: https://community.home-assistant.io/t/integration-lsc-camera/932974
- An older repo claims to enable ONVIF and RTSP on the indoor camera. Last update Aug 2021. README not read. Source: https://relatedrepos.com/gh/n3odym3/LSC_Smart-Connect_Indoor_Camera_Hack

### Risks

- Telnet with a known default root password. Isolate the cameras on a VLAN. Source: https://github.com/guino/LSC1080P
- Flash writes (options 2 and 3 in the indoor repo) required desoldering and bricked the author's device. Avoid them. Source: https://github.com/guino/LSC1080P
- The author says UART is not worth trying on that camera. Source: https://github.com/guino/LSC1080P
- Blocking internet access stopped the stream for one user. Source: https://forum.hacf.fr/t/flux-rtsp-camera-lsc-tuya-et-integration-frigate/49350
- Another user blocks internet on purpose and says all works locally. Source: https://community.home-assistant.io/t/integration-lsc-camera/932974
- Hack may affect the Action security update promise. No answer found. Same HA thread.
- Warranty effect: no source found. Assume it is at risk.
- Some posts share a root password hash. Do not reuse it. Source: https://forum.hacf.fr/t/flux-rtsp-camera-lsc-tuya-et-integration-frigate/49350

### Open firmware (OpenIPC, thingino, openmiko)

- thingino: Ingenic only. Anyka not listed. Source: https://thingino.com
- One LSC model (3215672) is in the thingino list. Verify the SoC first. Source: https://github.com/themactep/thingino-firmware/wiki/Cameras
- Flashing needs a web flasher or USB cloner. An unbrick guide exists, which hints at risk. Source: https://thingino.com
- I found no OpenIPC or openmiko evidence for the LSC models. I did not check those projects directly. Treat as unknown.
- Recommendation: do not flash. The SD card hack is safer.

### Home Assistant, go2rtc, Frigate

- go2rtc has a Tuya source. Smart Life accounts are NOT supported. Use the Tuya Smart app. Source: https://github.com/AlexxIT/go2rtc/blob/master/internal/tuya/README.md
- Smart API URL: `tuya://protect-us.ismartlife.me?device_id=XXX&email=XXX&password=XXX`. `resolution=hd` or `sd`. Same source.
- The Tuya Cloud API route needs a Tuya developer project and the IoT Video Live Stream service (free trial). Same source.
- Not all cameras give HD over WebRTC. Same source.
- Users report this works for LSC cameras and feeds Frigate. Sources: https://forum.hacf.fr/t/flux-rtsp-camera-lsc-tuya-et-integration-frigate/49350 and https://community.home-assistant.io/t/integration-lsc-camera/932974
- It depends on Tuya cloud signaling, so it is not fully local. Likely for evidence use this is a weak point. Source for bridge caveat: https://community.home-assistant.io/t/cheap-tuya-smart-life-cameras-local-rtsp-for-frigate-no-onvif-no-firmware-flash/1022333
- Alternative bridge: tuya-rtsp-bridge. No firmware flash. Serves `rtsp://<bridge>:8554/<Name>/hd`. Community project, no model list. Do not run it together with the `tuya://` path on the same camera. Same source.
- Frigate: add the stream in go2rtc, name it like the camera, then use the restream as input. Source: https://docs.frigate.video/configuration/go2rtc
- LocalTuya and Tuya local integrations: I did not find a source that they give video for these cameras. Unknown.

### SD card recording fallback

- I found no source for how to export clips from LSC SD cards. Not verified.
- Suggestion (unverified): the card likely holds proprietary recordings. Test by reading a card on a PC. Expect that the Tuya app is the main way to view and download clips.
- The indoor repo mentions `cleanup.cgi` and that some firmware may delete SD card files. Source: https://github.com/guino/LSC1080P

### Recommended steps for LSC

1. Put the cameras on an isolated VLAN or guest network.
2. Note the model and firmware from the app and sticker.
3. In the Tuya/LSC app, look for an ONVIF toggle. If found, enable it and test `rtsp://IP:8554/Streaming/Channels/101` and `rtsp://IP:8554/main` in VLC.
4. If that fails, try the SD card hack from guino/LSCOutdoor1080P (match the repo to your model). Test `rtsp://IP:8554/main`.
5. If you want no root, use go2rtc with a Tuya Smart account. Accept the cloud dependency.
6. Add the stream to Frigate or record with ffmpeg in segments.
7. Block internet only after you confirm the stream still works.
8. Skip flash writes and open firmware.

Example ffmpeg segment recording (my own example, not from a source):
`ffmpeg -rtsp_transport tcp -i rtsp://IP:8554/main -c copy -f segment -segment_time 300 -strftime 1 cam1_%Y%m%d_%H%M%S.mp4`

## 2. Tapo doorbell ("Tapu")

### Which model?

Confirm the exact model in the Tapo app (Device Info). The answer changes the path.

### RTSP / ONVIF per model

- Tapo says battery doorbells generally do not support RTSP. Source: https://www.tapo.com/uk/faq/34
- Exceptions: D235, D225 and TD25 support RTSP only when hardwired with a jumper cable and always-on mode enabled. Sources: https://www.tapo.com/uk/faq/34 and https://www.vigi.com/nl/support/faq/2680/
- D225: users say firmware 1.1.14 added RTSP and ONVIF, wired only. Source: https://community.tp-link.com/us/smart-home/forum/topic/695118
- A TP-Link staff post in Aug 2024 said ONVIF was not yet added. Later posts disagree. Source: https://community.tp-link.com/us/smart-home/forum/topic/691826
- Known bug: D225, D235, TD25 lose ring notifications in Always-On mode with RTSP/ONVIF. Fixed in firmware 1.1.16 Build 250118 Rel.48497n. Source: https://community.tp-link.com/en/smart-home/forum/topic/750718
- D230S1: needs an H200 hub. Page says the hub temporarily does not support RTSP/ONVIF. No 24h recording because of the battery. Source: https://www.tapo.com/us/faq/397
- D230 is listed as working in Tapo Control (direct stream). Source: https://github.com/JurajNyiri/HomeAssistant-Tapo-Control
- D210: no RTSP or ONVIF source found. Users report auth problems and no video in HA. Source: https://community.home-assistant.io/t/tapo-d210-video-doorbell/779835
- Check firmware on the D210 and D230S1 yourself. Support may change. Not verified for 2026.

### Enable the camera account

1. Tapo app, open Live View.
2. Settings icon, Advanced Settings, Camera Account.
3. Accept the notice. Create a username and password (6 to 32 characters, different from your Tapo password).
Source: https://www.tapo.com/uk/faq/34

Stream URLs (wired models that support it):
- `rtsp://user:pass@IP/stream1` (high quality)
- `rtsp://user:pass@IP/stream2` (standard)
- Port 554. ONVIF port 2020. Sources: https://www.tapo.com/uk/faq/34 and https://www.vigi.com/nl/support/faq/2680/

Notes:
- Tapo Care cloud, local storage and NAS/NVR/ONVIF recording cannot all run together. If all are on, NVR recording turns off. Source: https://www.vigi.com/nl/support/faq/2680/
- Each camera supports up to 2 simultaneous streams in Tapo Control. Source: https://github.com/JurajNyiri/HomeAssistant-Tapo-Control

### Home Assistant, go2rtc, Frigate

- Tapo Control (JurajNyiri) needs Third-Party Compatibility on in the app. It uses RTSP where available, otherwise a direct proprietary stream (TCP 8800). Source: https://github.com/JurajNyiri/HomeAssistant-Tapo-Control
- Direct streams cannot be used with go2rtc or the WebRTC card. Same source.
- D225 and D210 are not on its tested list. Same source.
- go2rtc has its own Tapo source (private protocol). Details not read. Source: https://github.com/AlexxIT/go2rtc
- Third-Party Compatibility drained a doorbell battery faster. Source: https://community.home-assistant.io/t/tapo-d210-video-doorbell/779835

### Fallback: local recordings

- D230S1 stores clips on the doorbell, encrypted with the account. No SD card mentioned. No export path found. Source: https://www.tapo.com/us/faq/397
- Other Tapo models support microSD. Export route not researched. Unknown.

### Recommended steps for the doorbell

1. Identify the model.
2. If D225, D235 or TD25: wire it with a jumper cable to a transformer. Update firmware to 1.1.16 or later. Enable always-on mode. Create the camera account. Test `rtsp://user:pass@IP/stream1` in VLC. Then add to Frigate or ffmpeg.
3. If D230S1 or D210 (battery): expect no RTSP. Try Tapo Control (direct stream) as a PoC. Otherwise rely on app clips. Or replace the doorbell with a wired model.
4. Keep the doorbell on a trusted VLAN. Do not expose ports 554 or 2020 to the internet. Source: https://www.vigi.com/nl/support/faq/2680/

## Open questions

- Exact LSC models and SoCs. Unknown.
- Whether the Tuya ONVIF toggle exists on your units. One report only.
- How to export SD card clips from LSC cameras. No source.
- Current firmware status for D230S1 and D210 in 2026. Not checked.
