# LifeOS iOS App — Setup & Distribution Guide

The Capacitor scaffolding is done. This guide walks you through:
1. One-time Apple + Xcode setup (~1 hour, mostly waiting)
2. Building your first .ipa
3. Distributing to Trina + Natasha via TestFlight
4. The ongoing 90-day refresh cycle

---

## 1. Prerequisites — install once

### Xcode (free, ~10GB, from Mac App Store)
1. Open the Mac App Store
2. Search "Xcode" → Install
3. Once installed, open it once to accept the license + install components (~5 min)
4. In Terminal: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`

> CocoaPods is NOT required — Capacitor 8 uses Swift Package Manager.

### Apple Developer Program ($99/yr)
1. Go to <https://developer.apple.com/programs/enroll/>
2. Sign in with your Apple ID (use the same one you'll use on your iPhone)
3. Choose **Individual** enrollment (faster than Organization)
4. Pay $99 USD
5. Apple verifies your identity — usually 24-48 hours
6. Once approved, sign in to <https://appstoreconnect.apple.com>

---

## 2. First-time Xcode setup

Open the project:
```bash
cd "/Users/gretchencawthon/Desktop/LRL/App Dev/LifeOS"
npx cap open ios
```

Xcode opens the LifeOS workspace. Steps inside Xcode:

### A. Configure signing
1. Click **App** in the left sidebar (top of the file tree, the blue icon)
2. Select the **App** target → **Signing & Capabilities** tab
3. Check **Automatically manage signing**
4. **Team**: select your Apple Developer team (appears after Apple approves you)
5. Bundle Identifier should already be `com.leftrightlabs.lifeos`

### B. Set app version (first time only)
1. Still in **App** target → **General** tab
2. **Version**: `1.0.0`
3. **Build**: `1` (increment this every TestFlight upload)
4. **Deployment Info → iOS**: set minimum to `15.0` or higher

### C. Add the app icon
Drag your 1024×1024 master icon into:
- `ios/App/App/Assets.xcassets/AppIcon.appiconset` (use Xcode's AppIcon asset, drag onto the "All Sizes" slot)

> Tip: If you only have `public/icon-512.png`, upscale once to 1024×1024 in any image editor — Xcode will auto-generate the smaller sizes.

### D. Configure capabilities (for push later)
1. **Signing & Capabilities** → **+ Capability** button
2. Add: **Push Notifications**
3. Add: **Background Modes** → check **Remote notifications**

---

## 3. Build & upload to TestFlight

### A. Test on your own iPhone first (optional but recommended)
1. Plug your iPhone into your Mac with a cable
2. Top of Xcode → select your iPhone from the device dropdown (next to the play button)
3. Press **▶ Run** (Cmd+R)
4. First time: iOS will refuse to launch the app. On your iPhone go to:
   **Settings → General → VPN & Device Management → [your developer cert] → Trust**
5. Re-run from Xcode — the app should launch and load lifeos.gretchencawthon.com

### B. Build for TestFlight
1. Top of Xcode → select **Any iOS Device (arm64)** from device dropdown
2. Menu: **Product → Archive** (this takes 3-5 min)
3. When done, the **Organizer** window opens automatically
4. Select the new archive → **Distribute App**
5. Choose **TestFlight & App Store** → **Next**
6. Choose **Upload** → **Next**
7. Leave all signing options as default → **Next**
8. **Upload** (this takes another 5-10 min)
9. When it says "Upload Successful", you're done in Xcode

### C. Enable in TestFlight
1. Go to <https://appstoreconnect.apple.com>
2. **Apps** → **+ button** → **New App**
3. Fill in:
   - Platforms: **iOS**
   - Name: **LifeOS** (must be unique on App Store, even for internal use — try "LifeOS LRL" if taken)
   - Primary Language: **English (U.S.)**
   - Bundle ID: **com.leftrightlabs.lifeos** (should appear in the dropdown)
   - SKU: `lifeos-lrl` (anything unique to you)
   - User Access: **Full Access**
4. Click **Create**
5. Inside the new app → **TestFlight** tab
6. Wait ~10 min for Apple to finish processing your uploaded build (you'll see it in "iOS Builds")
7. When the build is ready, click on it
8. Apple may ask for **Export Compliance** info — answer:
   - "Does your app use encryption?" → **Yes**
   - "Does your app qualify for any exemptions?" → **Yes** (HTTPS only, standard iOS encryption)
   - Save

---

## 4. Invite Trina + Natasha (Internal Testing)

1. App Store Connect → your app → **TestFlight** tab
2. Left sidebar: **Internal Testing** → **+ Create New Group** (or use the default group)
3. Name it: **LRL Team**
4. **+ Testers** → add their App Store Connect email addresses
   - If they're not in your team yet:
     - Go to **Users and Access** (top nav) → **+** → enter their Apple ID email, role: **Developer**
     - They get an email, accept the invite
     - Come back to TestFlight, add them to the LRL Team group
5. Once added, select your build → enable it for the LRL Team group
6. They'll get an email + push notification from TestFlight
7. They install the free TestFlight app from the App Store, accept the invite, and tap **Install**

That's it. They're now running the app on their phones.

---

## 5. Ongoing workflow

### When you push to Railway
- The app updates **instantly**. No Xcode involvement.
- Both browser users (lifeos.gretchencawthon.com) and app users get the change at the same time.

### When you want to update the native shell
This is only needed when you:
- Add/remove a Capacitor plugin
- Change the app icon, splash, or `capacitor.config.json`
- Update Capacitor itself (`npm update @capacitor/*`)

Steps:
```bash
npx cap sync ios          # copy any changes into the iOS project
npx cap open ios          # open Xcode
```
Then in Xcode:
1. Bump the **Build** number (General tab) — must be higher than the last upload
2. **Product → Archive**
3. **Distribute App → TestFlight & App Store → Upload**
4. In App Store Connect → TestFlight → enable the new build for the LRL Team group
5. Team gets a push to update

### Every 90 days
TestFlight builds expire. You'll get an email reminder. Just repeat the upload steps above — no code changes needed unless you want to ship updates. 5-10 min total.

---

## 6. Common gotchas

**"Signing identity not found"**
→ Your Apple Developer membership hasn't been approved yet, or you're not signed into Xcode with the right Apple ID.
Fix: **Xcode → Settings → Accounts** → add your Apple ID → Download Manual Profiles.

**Build uploads but doesn't appear in TestFlight**
→ Apple's processing can take up to 30 min. Refresh App Store Connect. If it fails, you'll get an email with the reason.

**App launches but shows a white screen**
→ Network issue or Railway is down. The app loads `lifeos.gretchencawthon.com` — if that URL doesn't respond, you see white. Test on cellular vs WiFi to isolate.

**Push notifications not arriving**
→ You'll need to set up an APNs key in Apple Developer + configure server.js to send push payloads via APNs. This is a separate task; ping me when you're ready to wire it up.

**Build number conflicts**
→ Apple requires each upload to have a **higher** build number than the last. If you ever get "Build already exists", increment Build to the next integer and re-archive.

---

## 7. What's already done in code

You don't need to touch any of this — it's wired up:

- `capacitor.config.json` — points the app at `https://lifeos.gretchencawthon.com`, configures status bar + keyboard behavior
- `public/index.html` — Capacitor bootstrap detects native runtime, adds `.capacitor-native` class to `<html>` for any native-only CSS, sets status bar style, listens for OAuth deep link returns
- `public/index.html` — `window.lrl.haptic()` auto-detects Capacitor and uses real Taptic Engine on iOS; falls back to web vibration on Android; silent on iOS Safari
- `public/index.html` — `.app` container uses `env(safe-area-inset-*)` to respect notch / Dynamic Island / home indicator
- 9 plugins installed: haptics, push, local-notifications, preferences, status-bar, keyboard, share, browser, app

Plugin docs (for when you want to use them in JS):
- Haptics: <https://capacitorjs.com/docs/apis/haptics>
- Push: <https://capacitorjs.com/docs/apis/push-notifications>
- Local Notifications: <https://capacitorjs.com/docs/apis/local-notifications>
- Preferences: <https://capacitorjs.com/docs/apis/preferences>
- Share: <https://capacitorjs.com/docs/apis/share>
- Browser: <https://capacitorjs.com/docs/apis/browser>

---

## Quick reference

| Task | Command / Action |
|---|---|
| Open Xcode project | `npx cap open ios` |
| Sync web changes (rarely needed since we use remote URL) | `npx cap sync ios` |
| Update a plugin | `npm update @capacitor/<plugin>` then `npx cap sync ios` |
| Add a new plugin | `npm install @capacitor/<name>` then `npx cap sync ios` |
| Increment for new TestFlight build | Bump **Build** number in Xcode → Archive → Upload |

---

Questions? Ping me and I'll help you through whichever step you're stuck on.
