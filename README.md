[![Built with TideCloak](https://tide.org/badges/built-with-tidecloak.svg)](https://tide.org/tidecloak?utm_source=github&utm_medium=readme&utm_campaign=unlocked)

# Home Camera Vault

## Project overview

_A home security camera app where only the household decides who sees the footage: the camera company runs the cloud, but can't watch, release or grant itself access to a single clip, even with root on its own servers._

Built with [TideCloak](https://tide.org/tidecloak?utm_source=github&utm_medium=readme&utm_campaign=unlocked) for **UNLOCKED** (RMIT × Tide, Challenge 2). Full architecture, workflow diagrams and API: [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md)

### 1. Vision & originality

Security cameras put the most private data anyone owns, video from inside their home, in a vendor's cloud. Home Camera Vault flips who's in charge: the household holds authority over its footage, and the vendor becomes an operator that holds nothing it can open.

### 2. Trust constraint insight

Today the vendor holds the keys. Support staff, a rogue employee, an attacker who breaches the vendor, or a quiet data request can all reach the video. Login doesn't help: the vendor's admin sits above every customer account and can grant itself anything.

### 3. Value & impact

Families get cameras without surrendering privacy. Vendors stop being a breach target for footage they never needed. The same pattern fits baby monitors, doorbells and eldercare cameras.

### 4. Why TideCloak matters

Each clip is AES-encrypted in the browser. Its key is wrapped by the Tide network under a `RelationshipAttestation` policy, so about 20 independent servers check the viewer's role on every unlock; no master key exists. Every access change is an IGA change request needing 2 of 3 owners to sign in their own Tide enclave. CamCo's root admin is answered *captured, not applied*, and its force-approve attempts are refused. With ordinary login and permissions, the vendor's admin would simply grant itself access.

### 5. Prototype & storytelling

Households register several cameras (webcam, or a phone via DroidCam), each with motion detection, and every clip is encrypted before upload. Alex plays clips. CamCo's console shows ciphertext, a refused decrypt, and a self-grant stuck at "Pending household approval: 0 of 2". Jordan joins only after two owners approve. Even if CamCo deletes footage, the household's own copy survives and restores it.

## Setup

### Prerequisites
- **Node.js 20+** and npm
- **Docker Desktop**, running
- **Chrome or Edge** recommended: Tide pop-ups must be allowed for `localhost`, and the optional backup folder needs Chromium. Firefox works for everything else.
- **A camera to record:** a webcam, or a phone through the [DroidCam](https://droidcam.app) client. No footage ships with the repo.
- **A Tide licence:** a real email address you control, and agreement to Tide's Terms at <https://tide.org/legal>.

### 1. Install
```bash
git clone https://github.com/krosshykes/tide-camera-vault.git
cd tide-camera-vault
npm run setup                 # installs server/ and web/
cp .env.example .env
```

### 2. Fill in `.env`
| Variable | Value |
|---|---|
| `KC_BOOTSTRAP_ADMIN_PASSWORD` | a strong password for TideCloak's master admin (the "vendor root" account) |
| `TIDE_LICENSE_EMAIL` | your real email; it manages the Tide licence |
| `TIDE_TERMS_ACCEPTED` | `yes`, only after **you** have read and agreed to <https://tide.org/legal> |
| `STORAGE_QUOTA_MB` | optional; storage allowance per household (default `500`) |
| `PROVISION_STAFF_REALM` | optional; `yes` creates CamCo's separate `camco-staff` realm at start-up (needs a licence that allows another realm) |

`.env` is gitignored. Never commit it.

### 3. Bootstrap TideCloak and the demo household
```bash
npm run bootstrap
```
This starts TideCloak in Docker (`tidecloak-camvault`, port 8080), creates and licenses the `camera-vault` realm, turns on IGA (quorum governance), and creates five characters: owners **Alex, Sam, Riley**, housemate **Jordan** and vendor **CamCo Support**. It **prints one invite link per character**, also saved to `server/data/invite-links.txt`.

Open **each link in its own private window** and create a Tide account. Use unique usernames such as `camvault-alex-2026`, and note the passwords. The script continues by itself once all five are linked, makes Alex the first owner, and writes `web/public/tidecloak.json`.

> **Free-tier limit.** A new Tide licence may allow only 3 accounts. If account 4 fails with *"hit its user limit"*, ask Tide to raise it. To finish with the accounts linked so far: `RESUME_FROM=finish npm run bootstrap`, then add people later with `node scripts/cast.mjs` (see the docs).

### 4. Run
In two terminals:
```bash
npm run server                # CamCo backend   → http://localhost:4000
npm run web                   # the app         → http://localhost:5173
```

### 5. One-time household setup (in the app)
1. Sign in as **Alex** (household code `camera-vault`) → **Create vault** → approve in the Tide pop-up. This signs the vault policy once.
2. **Household members** → **Make owner** for Sam, then for Riley, approving each under **Pending household approvals**. With three owners, every later change needs **2 of 3**.
3. **Cameras** → **Add camera** for each camera, e.g. *Front door / Entrance* and *Desk / Study*.
4. Optional: the top bar's **Set timezone**, and **Storage → Keep clips**.

### After a reboot
```bash
docker start tidecloak-camvault
npm run server
npm run web
```
Don't re-run `npm run bootstrap`: it refuses to touch an existing realm. `FORCE_WIPE=1 npm run bootstrap` deletes everything and starts over.

---

## Demo walkthrough

Use one private browser window per character, all at <http://localhost:5173>. Household members sign in with **Sign in with Tide** and household code `camera-vault`; CamCo staff use **<http://localhost:5173/staff>**.

### 1. Encrypted capture
1. Sign in as **Alex**.
2. **Cameras** → **Start** on a camera tile and pick its **Video device** (a webcam, or **DroidCam** for a phone). Each camera tile runs on its own.
3. **Snapshot**, **Record 3s**, or tick **Motion detection** and move something in view.
4. Watch the five steps go green:
   1. captured,
   2. AES-256-GCM encrypted in the browser,
   3. key wrapped by the Tide network,
   4. household copy kept,
   5. ciphertext uploaded.

### 2. Household viewing
1. As **Alex**, click the new tile in **Motion events**.
2. The app downloads the ciphertext, the Tide network releases the key after checking Alex's role, and the clip decrypts and plays in the browser.

### 3. Vendor sees nothing
1. Go to **<http://localhost:5173/staff>** (also linked from the home page footer) and sign in as **CamCo Support**. You land in the amber **CamCo operations** console.
2. **Run the service** shows CamCo's real work, all from metadata: service health, customers, camera fleet, legal requests.
3. Open **Try to look inside**. The `clips` table shows raw rows marked *stored as ciphertext*.
4. Click **View clip**. The hex dump is noise, and the Tide network refuses to unwrap the key; the refusal from every ORK is shown verbatim.

### 4. Vendor can't self-grant (key moment)
1. Still as **CamCo**, **Try to look inside** → **Grant myself access to The Demo Household (as root)**. To target another household, **Select** it under **Customers** first.
2. TideCloak answers *captured as a change request, not applied*, and the screen shows **"⏳ Not applied. Pending household approval: 0 of 2"**.
3. **Force-approve it as root**: every approval route is refused, because root has no Tide key to sign with.
4. As **Alex**, the request appears flagged *"CamCo is asking to watch your cameras"*. Click **Deny**. It also shows under **CamCo activity on your household**.

### 5. Quorum adds a member
1. Sign in as **Jordan**: *"You can't view this household's cameras yet."*
2. As **Alex** → **Household members** → **Request viewing access** next to Jordan.
3. Under **Pending household approvals**: **Approve** → **1 of 2**. It's still not applied, and Jordan still can't view.
4. As **Sam** → **Approve** → **2 of 2**: *"Quorum reached: change applied."*
5. **Jordan** signs out and back in. **Motion events** appears, and his clips decrypt.

### 6. CamCo deletes footage, and the household still has it
1. As **Alex**, **Household copy** → **Copy N cloud clips to this device**, if earlier clips aren't copied yet.
2. As **CamCo** → **Try to look inside** → **Delete ciphertext** on a clip. CamCo can destroy what's on its own disks.
3. As **Alex**, reload. **Household copy** shows *"⚠ 1 clip is missing from CamCo's cloud: not deleted by your household"*.
4. **View household copy** plays it from Alex's own encrypted copy (Tide still checks her role), and **Restore** uploads it back. **Choose backup folder…** can also mirror every clip to a USB drive or NAS.

### 7. Someone moves out
1. As **Alex** → **Household members** → **Remove access** next to Jordan. Nobody can remove their own access.
2. Two owners approve. At his next sign-in Jordan is locked out of every clip, old and new, with no re-encryption needed.

### 8. Managing footage
- **Motion events:** filter by camera or type → **Select** → **Delete selected**, or **Delete** inside a clip. Owners can delete anything; other members only their own uploads. Deletion removes the household copies too.
- **Storage:** space used against the allowance, with a per-camera breakdown. Owners set **Keep clips** to 7, 30 or 90 days, and older clips are deleted automatically.
- **Timezone** (top bar): owners pick the household timezone. Every time in the app uses it, and so does the stamp burned into new recordings, e.g. `2026-10-23 03:04:05 AEDT`.

### 9. A new household signs up
1. On the home page, click **Set up my household**. Enter a household name, your name and a username → **Create my household**.
2. CamCo's server creates that household's **own realm** (its own keys on the Tide network, licence and quorum) in about 30 seconds.
3. Click **Create my Tide account**. The page finishes on its own: you become the owner, and CamCo is locked out.
4. **Go to my household** → **Create vault** → add cameras. Add family with **Household members → Add a person → Get invite link**.
5. Anyone signs in by entering the **household code** at **Sign in with Tide**.

---

## Repository layout
```
scripts/   bootstrap.mjs (first setup), cast.mjs (add/remove people later), realm.json.template
server/    Express backend: verifies the Tide JWT + DPoP proof on every route; one realm and one
           data folder per household (server/data/, gitignored): ciphertext, cameras, tombstones, settings
web/       React + Vite app: home page, sign-up, staff sign-in, Household App (cameras, motion,
           gallery, storage, household copy, approvals, members), CamCo operations console
docs/      DOCUMENTATION.md: architecture, workflow diagrams, API, troubleshooting
branding/  generated Tide sign-in branding
```

## Honest limits
- **Metadata is visible to CamCo:** camera names, times and sizes, but never the footage or keys.
- **CamCo can still delete ciphertext on its own disks**, a denial of service and never a disclosure. Household copies survive it and restore it. CamCo could forge a deletion record to hide one from the integrity check; signing deletion records with the member's own key would close that. Household copies exist only on devices that recorded or copied the clips.
- **Revocation isn't instant:** it applies at the person's next sign-in or token refresh (≤ 10 min). Anything already seen can't be clawed back.
- **CamCo staff realm:** our free-tier licence refused a third realm, so `/staff` signs in with the demo realm's `camco-support` account until Tide raises the limit.
- **You need a camera to record:** a webcam or a phone via DroidCam. Without one you can still sign in, approve, and view clips others recorded.
- **Prototype only:** local development setup (HTTP on localhost), not hardened for production.
