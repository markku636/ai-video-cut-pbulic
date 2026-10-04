# AI Video Cut

**Pick something in a video and the app follows it everywhere. You can then blur it, recolor it, put a label on it, or replace it with something else.**

AI Video Cut is free to use. It runs entirely on your own computer, so your videos are never uploaded anywhere.

[繁體中文](README.md)

![Start screen](docs/screenshots/start.png)

---

## What can it do for you?

| You want to… | How |
|---|---|
| Blur the faces of people passing by | Click **Privacy blur**. The app finds every face; untick the ones you want to keep and you're done |
| Hide license plates, logos or personal info on a screen | Type "license plate" or "logo", then add a mosaic or blur |
| Put different footage on a phone or TV screen | Mark the screen's four corners and choose an image or video. It stays in place as the camera moves |
| Recolor something, make it glow, or outline it | Select the object and pick an effect |
| Add text or a sticker that follows a person or object | Choose the **Text** or **Sticker** effect |
| Remove something from the shot | Use **Remove object**. The app fills the gap with background filmed at other moments of the same video |
| Turn a landscape video into a vertical one | Type "follow the person" and the crop moves with them |

## Screenshots

| Find by typing | Objects and effects |
|---|---|
| ![Find](docs/screenshots/find.png) | ![Objects](docs/screenshots/objects.png) |
| **Privacy blur (before / after)** | **Screen replacement** |
| ![Privacy](docs/screenshots/privacy.png) | ![Replace](docs/screenshots/replace.png) |

## Three steps

### 1. Pick something

There are three ways; use whichever is easiest:

- **Type it.** Enter "face", "license plate" or "phone screen". The app lists everything it found; tick the ones you want.
- **Click it.** Click the thing on the video. Hold `Alt` and click to remove a part you didn't want, or drag a box around it instead.
- **Ask an AI.** When it's hard to describe ("the cup in the left person's hand"), let Claude Code or Codex look at the video and pick it for you.

### 2. Let it track

Click **Track this object**. The app follows it frame by frame, even when it moves, turns, or is briefly covered by a hand.

If tracking goes wrong at some point, go to that frame and click once to correct it. The app recomputes from there onward and leaves the earlier frames as they were.

### 3. Add effects and export

Add effects such as mosaic, blur, color, outline, glow, text or sticker. You can stack several. When the preview looks right, click **Export**.

> **Nothing else changes.** Effects only touch the area you selected; the rest of the picture stays exactly as it was.

## More features

- **Editing:** split, delete and reorder clips, remove silent parts, add music, fade in and out.
- **Auto captions:** speech is turned into subtitles on your computer. Export them as a subtitle file or burn them into the video.
- **AI assistant:** give it one sentence, such as "cut 2s to 4s", "blur the faces" or "make it vertical". It shows you the steps first and only runs them after you confirm.
- **Auto-update:** the app tells you when a new version is out, and you can update with one click.

## Install

Download the installer for your computer from [Releases](../../releases):

| Your computer | Download | Notes |
|---|---|---|
| Windows 10 / 11 | `*_x64-setup.exe` | Run it; no admin rights needed |
| Mac with Apple silicon (M1 or later) | `*_aarch64.dmg` | Drag the app to Applications. If the first launch is blocked, go to System Settings → Privacy & Security and click "Open Anyway" |
| Linux | `*_amd64.deb` | `sudo apt install ./file.deb` |

**The first launch** walks you through downloading the AI engine and models: about 6–7 GB. You'll need an internet connection and at least 15 GB of free disk space. After that, the app works fully offline.

### What your computer needs

- **Windows / Linux:** an NVIDIA graphics card, ideally with 12 GB of video memory or more, and an up-to-date driver.
- **Mac:** Apple silicon (M1 or later), ideally with 16 GB of memory or more. Older Intel Macs are not supported.
- **Without a suitable graphics card, the app won't run.** On the CPU alone it would be far too slow to use, so the app tells you upfront instead of leaving you waiting.

## FAQ

**Are my videos uploaded?**
No. All processing happens on your computer. The app only goes online to download models the first time and to check for updates.

**Does it cost anything?**
No. It's completely free.

**It says "using OWLv2 + SAM 2.1". What does that mean?**
The app can use two different AIs to find things. The best one, SAM 3, needs you to request access on [Hugging Face](https://huggingface.co/facebook/sam3) and enter your token in Settings. Without that, the app automatically uses the other one, which needs no sign-up. It works too, but it loses track more easily when the shot changes.

**Tracking lost the object. What now?**
Go to the frame where it went wrong, click the object once, and choose **Recompute from this frame on**.

**Can I use the tracking in other software?**
Yes. You can export it as JSON, CSV or PNG masks, or as After Effects or Nuke data. The format is described in [`docs/tracking-api.md`](docs/tracking-api.md).

---

## For developers

### Command line

Every feature in the app is also a command, so you can script it:

```powershell
$py = "$env:LOCALAPPDATA\net.markkulab.aivideocut\pyenv\Scripts\python.exe"
& $py -m aivc find   video.mp4 --text "face" --out found\
& $py -m aivc fx     video.mp4 --masks found\obj1\masks.aivm --effects '[{"type":"mosaic"}]' -o blurred.mp4
& $py -m aivc track-export video.mp4 --masks found\obj1\masks.aivm --format csv --out face.csv
& $py -m aivc --help
```

### Build from source

```powershell
.\scripts\bootstrap-engine.ps1   # install the AI engine (macOS/Linux: sh scripts/bootstrap-engine.sh)
npm install
npm run tauri dev                # run in development mode
npm run check                    # all checks and tests
```

### Docs

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Tracking data format: [`docs/tracking-api.md`](docs/tracking-api.md)
- Auto-update and releases: [`docs/updater.md`](docs/updater.md)

## License

See [`LICENSE`](LICENSE) for the license terms. Third-party licenses are listed in [`THIRD-PARTY-NOTICES.txt`](THIRD-PARTY-NOTICES.txt).
