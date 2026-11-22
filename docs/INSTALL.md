# Install QoreWitness on a Linux box (with a Tapo C210)

Pilot on the QoreChain test network (qorechain-diana). No money is collected. Test tokens have no value.

This guide takes you from a new camera to "Sealing started" in about one hour. You paste one line in a terminal. Everything else happens in your browser: a password, your camera, and one progress bar.

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

Debian or Ubuntu: any 64-bit install with internet access and a user with `sudo`.

## Step 3. Paste one line on your own computer

Open a terminal on your laptop:
- **Mac:** press Cmd and Space, type `Terminal`, press Enter.
- **Windows:** press the Windows key, type `PowerShell`, press Enter.

Paste this line. Use your Pi user name in place of `mark`. Press Enter.

```bash
ssh -t mark@qorewitness.local "curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/v0.6.0-alpha.1/install.sh | bash -s -- --yes"
```

What you will see:
- The first time, a question if you trust the box. Type `yes` and press Enter.
- Your Pi password (from the Imager). You do not see the letters while you type.
- A few minutes of text. The installer installs Docker when it is missing, downloads QoreWitness and starts it.
- At the end, in large text: the address of your box and a pairing code.

```
      http://192.168.1.30:8080
      Pairing code:  123 456
```

Do not share the code. Anyone with it can set up the box until you choose a password.

Already on the box (keyboard and screen, or an SSH session)? Paste the part between the quotes: `curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/v0.6.0-alpha.1/install.sh | bash -s -- --yes`.

You can run the line again at any time. It keeps your camera, keys, account and video.

<details><summary>Options for experts</summary>

| Option | Use |
|---|---|
| `--yes` | Accept the defaults without questions. Without it, the installer asks before it installs Docker (Enter means yes). |
| `--local-only` | The dashboard opens on the box itself only (127.0.0.1) |
| `--new-password` | You forgot the dashboard password. Shows a new pairing code. Camera, keys and account stay. |
| `--terminal` | The older setup with questions in the terminal, no browser |
| `--build` | Build the image from source (slow on a Pi) |
| `QW_VERSION=...` | Install another published version |

</details>

## Step 4. Set up in the browser

Open the address on your phone or laptop and type the pairing code. Or click the long link that the installer showed under the code.

1. **Password.** Choose a password for your dashboard (10 characters or more).
2. **Camera.** Type the camera address and the name and password of the camera account from step 1. Tick "My camera films my own property". Press **Test camera**.
3. **Is this your camera?** Within 15 seconds you see a picture from your camera. Press **Yes, this is my camera**.
4. **Connecting your camera.** One progress bar runs by itself. It takes 2 to 5 minutes. You can close the page.
5. **Sealing started.** The page shows the address of your dashboard. Bookmark it, or add it to your home screen. The first seal comes in about 10 to 15 minutes.

The pilot pays the network fees. You do nothing. The pilot has a limited number of places. If it is full, the progress bar says so and offers **Use my own wallet**.

Your box keeps its keys in the qorewitness folder. Back up that folder once.

<details><summary>Advanced: use my own wallet (Self-managed)</summary>

On the camera screen, open **Advanced** and tick **Use my own wallet**. During the progress bar, the page shows your account address. Claim test QOR for it at the QoreChain dashboard (Faucet). You need at least 2 test QOR to start. One camera uses about 7 test QOR a day, so claim again every few days. The dashboard turns orange when the fees run low.

</details>

## Daily use

Keep using the Tapo app for live view and alerts. QoreWitness works in the background.

Open your dashboard once in a while. It shows one line in a colour and one thing to do:

| Colour | Example | What to do |
|---|---|---|
| Green | Sealing OK. Last seal 4 minutes ago. | Nothing |
| Orange | Waiting for the first seal. | Nothing. It comes 10 to 15 minutes after setup. |
| Orange | Sealing pauses soon: fees are running out. | Fees included: nothing, the pilot tops up. Self-managed: add test tokens (the address is under Details). |
| Orange | The disk is almost full. | Nothing urgent: the box deletes the oldest video first. Connect a bigger disk to keep more. |
| Red | No video from the camera. | Check the power and Wi-Fi of the camera. |
| Red | Sealing stopped 40 minutes ago. | Check the internet connection of the box. Restart the box if this stays. |
| Red | Sealing paused: the fees ran out. | Fees included: the pilot tops up. If this stays for a day, the pilot may be paused. Self-managed: add test tokens. |

Video older than about 2 weeks (the box proposes the days from its free disk) is deleted. Download what you need before then.

### Prove a video

The dashboard lists the latest seals in your own time, for example "Sat 21 Nov, 22:46 to 22:56". Press **Download** next to the time you need. You get one file (ZIP) with the original video of those 10 minutes and its proof. Another time: open **Pick another time** under the list (up to 60 minutes).

Give the file to the receiver, for example an insurer. They open https://qorewitness.fnoufnou.com/verifier.html and drop the file on the page. They see one result: green "Original" with the recording date and time, or red "Changed after sealing". Nobody needs to trust you or us.

Technical facts (block numbers, the registry, the keys) are under **Details** on the dashboard.

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
| The page does not open at all. | The box and your phone must be on the same network. Guest Wi-Fi often blocks this. Run the line again to see the address. |
| `qorewitness.local` not found (step 3) | Your network does not know the name. Open your router app, find the IP address of the box, and use it in place of `qorewitness.local`. |
| `Permission denied` (step 3) | Wrong user name or Pi password. Use the ones you set in the Imager. |

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
