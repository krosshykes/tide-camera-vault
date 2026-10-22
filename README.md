# Home Camera Vault

**A home security camera app where only the household decides who sees the footage.** The camera company runs the cloud, but it can't watch your clips, can't hand them over, and can't give itself access, even with root on its own servers.

Built for **UNLOCKED** (RMIT × Tide, Challenge 2) with **TideCloak**. Cameras and footage are synthetic.

> Detailed architecture, workflow diagrams, API and troubleshooting: [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md)

---

## Project overview

**Vision & originality.** Security cameras put the most private data anyone owns, video from inside their home, in a vendor's cloud. Home Camera Vault flips who's in charge: the household holds authority over footage, and the vendor becomes an operator that holds nothing it can open.

**Trust constraint insight.** Today the vendor holds the keys. Support staff, a rogue employee, an attacker who breaches the vendor, or a quiet data request can all reach the video. Login doesn't help, because the vendor's admin sits above every customer account and can grant itself anything.

**Value & impact.** Families get cameras without surrendering their privacy. Vendors stop being a breach target and a subpoena point for footage they never needed to see. The same pattern fits baby monitors, doorbells and eldercare cameras.

**Why TideCloak matters.** Each clip is AES-encrypted in the browser; its key is wrapped by the Tide network under a `RelationshipAttestation` policy, so roughly 20 independent servers check the viewer's role on every unlock and no master key exists. Every access change is an IGA change request that needs 2 of 3 owners to sign in their own Tide enclave. CamCo's root admin gets *HTTP 202 Accepted, not applied*, and its force-approve attempts are refused. With ordinary login and backend permissions, the vendor's admin could simply grant itself access, and this app would be impossible.

**Prototype & storytelling.** A camera simulator (synthetic scenes, or a real webcam/DroidCam with motion detection) records encrypted events. Alex plays them; CamCo's Vendor Console shows raw ciphertext, a refused decrypt, and a self-grant stuck at "Pending household approval: 0 of 2". Jordan joins only after two owners approve, and leaves the same way.

---

## Setup

### Prerequisites
- **Node.js 20+** and npm
- **Docker Desktop** (running)
- A Chromium-based browser or Firefox, with pop-ups allowed for `localhost`
- A Tide licence: a real email address you control, and agreement to Tide's Terms at <https://tide.org/legal>

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

`.env` is gitignored. Never commit it.

### 3. Bootstrap TideCloak and the household
```bash
npm run bootstrap
```
This starts TideCloak in Docker (`tidecloak-camvault` on port 8080), creates and licenses the `camera-vault` realm, turns on IGA (quorum governance), and creates the five characters. It then **prints one invite link per character** (also saved to `server/data/invite-links.txt`).

Open **each link in its own private window** and create a Tide account. Use unique usernames such as `camvault-alex-2026`, and note the passwords. The script continues by itself once all five are linked, makes Alex the first owner, and writes `web/public/tidecloak.json`.

> **Free-tier limit.** A new Tide licence may allow only 3 accounts. If account 4 fails with *"hit its user limit"*, ask Tide to raise it, then link the rest. To finish setup with the accounts linked so far: `RESUME_FROM=finish npm run bootstrap`. Later additions go through `node scripts/cast.mjs` (see the docs).

### 4. Run
In two terminals:
```bash
npm run server                # CamCo backend   → http://localhost:4000
npm run web                   # the app         → http://localhost:5173
```

### 5. One-time household setup (in the app)
1. Sign in as **Alex** → **Create vault** → approve in the Tide pop-up. This signs the vault policy once.
2. **Household members** → **Make owner** for Sam, then for Riley. Approve each request under **Pending household approvals**.
   With three owners, every later change needs **2 of 3**.

### After a reboot
```bash
docker start tidecloak-camvault
npm run server
npm run web
```
Don't re-run `npm run bootstrap`: it refuses to touch an existing realm. `FORCE_WIPE=1 npm run bootstrap` starts over from scratch.

---

## Demo walkthrough

Use one private browser window per character, all at <http://localhost:5173>.

### 1. Encrypted capture
1. Sign in as **Alex**.
2. **Cameras** → **Snapshot** or **3s clip** on any synthetic camera. Alternatively, **Live camera → Start camera** (webcam or DroidCam) and tick **Motion detection**.
3. Watch the four steps go green: captured → AES-256-GCM encrypted in the browser → key wrapped by the Tide network → ciphertext uploaded.

### 2. Household viewing
1. As **Alex**, click the new tile in **Motion events**.
2. It downloads ciphertext, the Tide network releases the key after checking Alex's role, and the clip decrypts and plays in the browser.

### 3. Vendor sees nothing
1. Sign in as **CamCo Support**. You land in the amber **Vendor Console**.
2. The `clips` table shows raw rows: `stored as ciphertext`.
3. Click **View clip**. The hex dump is noise, and the Tide network refuses to unwrap the key. The refusal from all ORKs is shown verbatim.

### 4. Vendor can't self-grant (key moment)
1. Still as **CamCo**, click **Grant myself access (as root)**.
   TideCloak answers *captured as a change request, not applied*, and the screen shows **"⏳ Not applied. Pending household approval: 0 of 2"**.
2. Click **Force-approve it as root**. The `approve`, `authorize` and `commit` routes are all refused, because root has no Tide key to sign with.
3. As **Alex**, the request appears flagged *"CamCo is asking to watch your cameras"*. Click **Deny**.

### 5. Quorum adds a member
1. Sign in as **Jordan**: *"You can't view this household's cameras yet."*
2. As **Alex** → **Household members** → **Request viewing access** next to Jordan.
3. Under **Pending household approvals**: **Approve** → **1 of 2**. It's still not applied, and Jordan still can't view.
4. As **Sam** → **Approve** → **2 of 2**: *"Quorum reached: change applied."*
5. **Jordan** signs out and back in. **Motion events** appears, and his clips decrypt.

### Bonus: someone moves out
1. As **Alex** → **Remove access** next to Jordan. You can't remove yourself.
2. Two owners approve, and at his next sign-in Jordan is locked out of every clip, old and new, with no re-encryption needed.

---

## Repository layout
```
scripts/   bootstrap.mjs (setup), cast.mjs (add/remove people later), realm.json.template
server/    Express backend: verifies Tide JWT + DPoP on every route, stores ciphertext in server/data/db.json
web/       React + Vite app: Home page, Household App, Vendor Console, camera simulator, live camera
docs/      DOCUMENTATION.md: architecture, workflows, API, troubleshooting
branding/  generated Tide sign-in branding
```

## Honest limits
- **Metadata is visible to CamCo:** camera name, time and size are visible, but not the footage or keys.
- **Revocation isn't instant:** it applies at the person's next sign-in or token refresh (≤ 10 min). Anything already seen can't be clawed back.
- **Prototype only:** local development setup (HTTP on localhost) with synthetic data. Not hardened for production.
