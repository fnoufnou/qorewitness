# Install QoreWitness on a Linux box (with a Tapo C210)

Pilot on the QoreChain test network (qorechain-diana). No money is collected. Test tokens have no value.

This guide takes you from a new camera to "Sealing started" in about one hour. You type one command in a terminal. Everything else happens in your browser.

## What you need

| Part | Advice |
|---|---|
| Camera | TP-Link Tapo C210, set up in the Tapo app |
| Recorder box | Raspberry Pi 5 (4 GB) with Raspberry Pi OS Lite (64-bit). Any 64-bit Debian or Ubuntu machine with Docker also works, for example a mini PC or a Proxmox VM. |
| Storage | 128 GB or more. A USB SSD lasts longer than an SD card. High quality video likely needs 15 to 20 GB a day (to be measured). |
| Network | Camera and box on the same home network. The box needs internet access. |
| Phone or laptop | For the setup in the browser, on the same home network |

The box must stay on. When it is off, it records nothing and seals nothing.

## Step 1. Make a camera account in the Tapo app

QoreWitness reads the video from the camera over your home network (RTSP). The camera needs its own account for this.

1. Open the Tapo app and tap your camera.
2. Tap the gear (settings), then **Advanced Settings** > **Camera Account**. Agree to the notice.
3. Make a user name and a password. Use 6 to 32 characters each, letters and digits only. Special characters can stop the stream.
4. Use a new password. Do not use the password of your TP-Link account.
5. Go back to the settings and open **Device Info**. Write down the **IP address**, for example 192.168.1.20.

Recommended:
- In your router, give the camera a fixed IP address (often called "DHCP reservation"). If the address changes, the box loses the camera.
- Tapo Care (cloud), the microSD card and a recorder such as QoreWitness: only two of the three work at the same time. If all three are on, turn one off.
- Point the camera at your own property. See "Privacy" below.

## Step 2. Prepare the box

Raspberry Pi:

1. Install Raspberry Pi Imager on your computer.
2. Choose **Raspberry Pi OS Lite (64-bit)**.
3. In the settings of the Imager: host name `qorewitness`, a user name and password, your Wi-Fi (or use a cable), and **Enable SSH**.
4. Write the card, put it in the Pi and start it. Wait two minutes.
5. On your computer, open a terminal and connect: `ssh <your user>@qorewitness.local`.

Debian or Ubuntu: any 64-bit install with internet access and a user with `sudo`.

## Step 3. Run the installer

Paste this line in the terminal of the box:

```bash
curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/main/install.sh | bash
```

The installer:
- checks the system (64-bit Linux),
- offers to install Docker if it is missing (it asks first),
- downloads the published QoreWitness image for your processor (amd64 or arm64),
- makes the folder `~/qorewitness` with the folder `data` for keys and video,
- starts QoreWitness,
- shows a **setup link** and a **pairing code** in large text.

The link and the code are also in `~/qorewitness/SETUP-LINK.txt`. Only your user can read that file. Do not share the code: anyone with it can set up the box until you choose a password.

Options:

| Option | Use |
|---|---|
| `--yes` | Install Docker without the question |
| `--local-only` | The dashboard opens on the box itself only (127.0.0.1) |
| `--new-password` | You forgot the dashboard password. Shows a new pairing code. Camera, keys and account stay. |
| `--terminal` | The older setup with questions in the terminal, no browser |
| `--build` | Build the image from source (slow on a Pi) |
| `QW_VERSION=...` | Install another published version |

To pass an option through the pipe: `curl -fsSL .../install.sh | bash -s -- --new-password`.

You can run the installer again at any time. It keeps your camera, keys, account and video.

## Step 4. Set up in the browser

Open the link on your phone or laptop. Or open `http://<IP of the box>:8080/setup` and type the pairing code. On a Raspberry Pi with the host name `qorewitness`, `http://qorewitness.local:8080` often works too.

1. **Password.** Choose a password for the dashboard (10 characters or more).
2. **Camera.** Type the IP address, the user name and the password of the camera account from step 1. Tick the box that the camera films your own property. Press **Test camera**. Within 15 seconds you see a picture from your camera. Press **Looks right**, or **Use standard quality** for a smaller disk or weak Wi-Fi.
3. **Plan.**
   - **Fees included (pilot):** we pay the network fees for this camera. You need a pilot code from the website.
   - **Self-managed:** you hold the account and add free test tokens yourself, about once a week.
   Both plans make the same proof. Both are free in the pilot.
4. **Keys.** Press **Create keys**. The box makes an account key and a camera key. Read the backup note, then confirm.
5. **Network fees.** With Fees included, you need no faucet. The pilot checks your code and the camera signature, sends a free start of 3 test QOR to your account, and the page moves on by itself. Later it refills what the camera uses. With Self-managed, copy the address, claim test QOR at the QoreChain dashboard (Faucet), and wait. You need at least 2 test QOR to start.
6. **Connect.** Press **Start**. A progress bar shows four steps. This takes 1 to 3 minutes.
7. **Done.** "Sealing started". The first seal comes in about 10 to 15 minutes.

You can close the browser at any time. Open the link again and the setup continues at the right step.

## Daily use

Keep using the Tapo app for live view and alerts. QoreWitness works in the background.

Open the dashboard (`http://<IP of the box>:8080`) once in a while. It shows one line in a colour and one thing to do:

| Colour | Example | What to do |
|---|---|---|
| Green | Sealing OK. Last seal 4 minutes ago. | Nothing |
| Orange | Waiting for the first seal. | Nothing. It comes 10 to 15 minutes after setup. |
| Orange | Network fees low: about 2 days left. | Self-managed: add test QOR to the address shown. |
| Orange | The disk is almost full. | Keep video for fewer days, or connect a bigger disk. |
| Red | No video from the camera. | Check the power and Wi-Fi of the camera. Check its IP address. |
| Red | Sealing stopped 40 minutes ago. | Check the internet connection of the box. Restart the box if this stays. |
| Red | Sealing stops: the network fees ran out. | Self-managed: add test QOR. Fees included: the pilot tops up. If this stays for a day, the pilot may be paused. |

Video older than the retention time (proposed from the free disk, 14 days by default) is deleted. The receipts stay. Download the clips you need before then.

To prove a clip today: copy the clip from `~/qorewitness/data/<camera>/segments` and download its receipt from the dashboard. The receiver checks both at https://qorewitness.fnoufnou.com/verifier.html. Nobody needs to trust you or us. A one-click evidence export in the dashboard is planned for the next version.

## Update

```bash
cd ~/qorewitness
# set the new version in .env, for example QW_VERSION=0.6.0-alpha.2
docker compose pull && docker compose up -d
```

The image version is pinned on purpose. QoreWitness never updates itself.

## Something went wrong

| Message | Cause and fix |
|---|---|
| The camera refused the password. | The user name or password of the Camera Account is wrong. Make it again in the Tapo app with letters and digits only. |
| No camera answers at this address. | Wrong IP address, or the camera is off or out of Wi-Fi range. Check Device Info in the Tapo app. |
| The camera is busy. | The C210 sends at most two streams at once. Close the live view in the Tapo app and test again. |
| The camera sends no picture. | Tapo Care, microSD and a recorder: only two of three work. Turn one off. |
| Unknown host name. | Open the box by its IP address, as the installer showed. For your own name, set `QW_UI_HOSTNAME` in `~/qorewitness/.env`. |
| The page does not open at all. | The box and your phone must be on the same network. Guest Wi-Fi often blocks this. Run the installer again to see the link. |

Logs: `cd ~/qorewitness && docker compose logs --tail 50 recorder agent ui`. Camera passwords are masked in the logs.

## What is on the box

| File in `~/qorewitness/data` | Holds | Mode |
|---|---|---|
| `camera.env` | camera name, stream address with the camera password, retention | 600 |
| `qorewitness.env` | the recovery phrase of the test account | 600 |
| `keys/<camera>.key` | the camera key (ML-DSA-87) | 600 |
| `ui/auth.json` | a hash of the dashboard password and the session key | 600 |
| `account.json` | public facts: addresses, camera id, plan | 644 |
| `<camera>/segments`, `<camera>/receipts` | video clips and receipts | |

Back up the `data` folder (at least `qorewitness.env` and `keys`). Anyone with these files or with the box can use your test account. QoreWitness never asks for them.

Security notes:
- The setup and the dashboard use plain HTTP on your home network. Someone on the same Wi-Fi could read the dashboard password. Use a home network you trust.
- Never forward port 8080 on your router. The box refuses requests from public addresses and unknown host names, but it is made for the home network only.
- The box holds the recovery phrase of the test account. A stolen box gives access to that test account.

## Privacy

If the camera films the street or a neighbour's property, privacy law (GDPR) likely applies to you as the owner. Point the camera at your own property, put up a sign, and read the guidance of your data protection authority (in the Netherlands: Autoriteit Persoonsgegevens). Your video stays on the box. Only fingerprints (hashes) and times go on chain, and these cannot be deleted.

## Remove QoreWitness

```bash
cd ~/qorewitness && docker compose down
```

Then delete `~/qorewitness` when you no longer need the video, the receipts or the keys.

## Tapo C210 reference

| Fact | Value |
|---|---|
| Stream, high quality | `rtsp://USER:PASS@CAMERA_IP:554/stream1` |
| Stream, standard quality | `rtsp://USER:PASS@CAMERA_IP:554/stream2` |
| ONVIF port | 2020 |
| Camera account | Tapo app > camera > gear > Advanced Settings > Camera Account. 6 to 32 characters. |
| Streams at once | Two. The Tapo app live view counts as one. |
| Storage rule | Tapo Care, microSD and NVR (recorder): two of three at a time |
| Codec and size | Likely H.264. Size and bit rate differ per hardware version. To be confirmed with a real camera. |

Sources: TP-Link FAQ 2680 and 4465. QoreWitness builds the address for you and encodes special characters. With a full stream address ("Another camera brand" in the setup) you can try other cameras. See `docs/CAMERAS.md` for community notes.
