# Home Camera Vault: Technical Documentation

A home security camera app in which **authority over footage emerges only when the household agrees**. The camera vendor (CamCo) operates every server, including TideCloak, and still cannot watch, release, or grant itself access to any clip.

This document covers the architecture, every workflow (with diagrams), the security model, the API, operations, and the problems hit while building it. For the short version and the demo click path, see the [README](../README.md).

> Diagrams are written in Mermaid. They render on GitHub, in the VS Code Markdown preview (built in), and in most Markdown viewers.

---

## Contents
1. [Concepts in one page](#1-concepts-in-one-page)
2. [System architecture](#2-system-architecture)
3. [Who can do what](#3-who-can-do-what)
4. [Roles and the vault policy](#4-roles-and-the-vault-policy)
5. [Workflow: encrypted capture](#5-workflow-encrypted-capture)
6. [Workflow: viewing a clip](#6-workflow-viewing-a-clip)
7. [Workflow: the vendor tries to look](#7-workflow-the-vendor-tries-to-look)
8. [Workflow: the vendor tries to grant itself access](#8-workflow-the-vendor-tries-to-grant-itself-access)
9. [Workflow: quorum adds a member](#9-workflow-quorum-adds-a-member)
10. [Workflow: someone leaves (revocation)](#10-workflow-someone-leaves-revocation)
11. [Change-request lifecycle](#11-change-request-lifecycle)
12. [Live camera and motion detection](#12-live-camera-and-motion-detection)
13. [Bootstrap and first-time setup](#13-bootstrap-and-first-time-setup)
14. [Data model](#14-data-model)
15. [API reference](#15-api-reference)
16. [Code map](#16-code-map)
17. [Operations: scripts and commands](#17-operations-scripts-and-commands)
18. [Troubleshooting](#18-troubleshooting)
19. [Known limits and design trade-offs](#19-known-limits-and-design-trade-offs)
20. [Glossary](#20-glossary)

---

## 1. Concepts in one page

| Idea | What it means here |
|---|---|
| **No master key** | Each clip has its own AES-256-GCM key. That key is wrapped by the **Tide network**: 20 independent ORK servers, any 14 of which must cooperate. The key that can unwrap it is never assembled anywhere: not at CamCo, not in TideCloak, not in the browser. |
| **The network enforces the rule** | Wrapping uses a signed policy (`RelationshipAttestation:1`). On every unwrap, each ORK checks the caller's credential: *do they hold the `household-viewer` role and `_tide_decryptor`?* If not, every ORK refuses. |
| **Quorum governance (IGA)** | TideCloak's Identity Governance turns every admin change (grant a role, remove a user, add an owner) into a **change request**. It applies only when enough owners (`tide-realm-admin`) sign it in their own **Tide enclave**. With 3 owners the threshold is **2**. |
| **Root is just a requester** | CamCo holds TideCloak's master-admin password. On this realm that lets it *file* requests (HTTP 202/204, "captured") but not approve or commit them: approving needs an owner's enclave signature, and root has no Tide key. |
| **Ciphertext-only storage** | CamCo's backend stores the clip ciphertext, the IV and the wrapped key. Nothing it stores can be opened with anything it holds. |

---

## 2. System architecture

```mermaid
flowchart LR
  subgraph Browser["Browser (one window per character)"]
    HA["Household App<br/>Alex · Sam · Riley · Jordan"]
    VC["Vendor Console<br/>CamCo Support"]
    WC["WebCrypto<br/>AES-256-GCM"]
    EN["Tide enclave<br/>(pop-up: approvals,<br/>policy signing)"]
  end

  subgraph CamCo["Operated by CamCo (the vendor)"]
    VITE["Vite dev server :5173<br/>serves app + DPoP relay page<br/>proxies /api"]
    API["Express backend :4000<br/>verifies JWT + DPoP<br/>stores ciphertext"]
    DB[("server/data/db.json<br/>ciphertext · IVs · wrapped keys<br/>vault policy · audit log")]
    TC["TideCloak :8080<br/>realm camera-vault<br/>IGA on, multi-admin"]
  end

  ORK["Tide network<br/>20 ORKs, threshold 14<br/>ork1…ork20.tideprotocol.com"]

  HA -- "login (OIDC + DPoP)" --> TC
  VC -- "login (OIDC + DPoP)" --> TC
  HA --> WC
  HA -- "/api (DPoP-signed)" --> VITE --> API --> DB
  VC -- "/api (DPoP-signed)" --> VITE
  HA -- "approve change requests<br/>(own token, never proxied)" --> TC
  API -- "master admin (root):<br/>files change requests only" --> TC
  HA -- "wrap / unwrap clip keys<br/>(policy checked on every ORK)" --> ORK
  VC -. "unwrap attempt: refused" .-> ORK
  EN -- "threshold signatures" --> ORK
  TC -- "token signing, IGA ceremonies" --> ORK
```

**Trust boundaries**
- Everything in the **CamCo** box is assumed hostile or compromised: the server, the database, TideCloak and its root account.
- **Tide network:** no single ORK can decrypt or sign alone.
- **Browser:** the only place plaintext exists, briefly, for the person allowed to see it.

---

## 3. Who can do what

| Action | Alex / Sam / Riley (owners) | Jordan (before approval) | Jordan (after approval) | CamCo Support | CamCo root admin |
|---|---|---|---|---|---|
| Record + upload an encrypted clip | ✅ | ❌ (API 403) | ✅ | ❌ | ❌ |
| Read raw stored rows | — | — | — | ✅ (it's their DB) | ✅ |
| Decrypt / play a clip | ✅ | ❌ | ✅ | ❌ **network refuses** | ❌ no Tide identity |
| File a role change | ✅ (via app) | ❌ | ❌ | ✅ (as root) | ✅ |
| **Approve** a role change | ✅ (enclave signature) | ❌ | ❌ | ❌ | ❌ **409 / refused** |
| Make a change apply alone | ❌ needs 2 of 3 | ❌ | ❌ | ❌ | ❌ **412 / quorum not met** |
| Remove their own access | ❌ (server 403) | — | ❌ | — | — |

---

## 4. Roles and the vault policy

```mermaid
flowchart TB
  HV["household-viewer<br/>(realm role, composite)"]
  DEC["_tide_decryptor<br/>(realm role)"]
  ENC["_tide_encryptor<br/>(realm role)"]
  TRA["tide-realm-admin<br/>(client role on realm-management)"]
  POL["Vault policy<br/>RelationshipAttestation:1<br/>subjectType = Role<br/>subjectId = household-viewer<br/>assignmentId = household-vault<br/>roles = [_tide_encryptor, _tide_decryptor]"]

  HV -- contains --> DEC
  HV -- contains --> ENC
  POL -- "subject" --> HV
  TRA -. "approves grants of" .-> HV

  A["Alex · Sam · Riley"] --> HV
  A --> TRA
  J["Jordan"] -. "only after 2-of-3 approval" .-> HV
  C["CamCo Support"] -. "never" .-> HV
```

| Role | Kind | Purpose |
|---|---|---|
| `household-viewer` | realm role, **composite** | Membership. The vault policy's subject. Carries `_tide_decryptor` + `_tide_encryptor`, so joining is **one** governed grant. |
| `_tide_decryptor` / `_tide_encryptor` | realm roles (names fixed by the ORK contract) | Capability checks the contract makes on every decrypt / encrypt. |
| `tide-realm-admin` | client role on `realm-management` | Owner / approver. Who can sign change requests. Threshold = `max(1, floor(0.7 × owners))`, encoded in the signed admin policy: 3 owners → **2**. |

**The vault policy** is signed **once**, by an owner, in the Tide enclave ("Create vault"). Because its subject is a **role**, adding or removing people never needs a new policy: it's just a governed role change. One record id (`household-vault`) is the only tag on every wrapped key.

---

## 5. Workflow: encrypted capture

```mermaid
sequenceDiagram
  autonumber
  actor A as Alex (browser)
  participant Cam as Camera source<br/>(synthetic / webcam / DroidCam)
  participant WC as WebCrypto
  participant API as CamCo backend
  participant ORK as Tide network (20 ORKs)

  A->>Cam: Snapshot / 3s clip / motion trigger
  Cam-->>A: PNG, JPEG or WebM bytes (plaintext, in memory only)
  A->>WC: generate fresh AES-256-GCM key + 12-byte IV
  WC-->>A: ciphertext, iv, rawKey
  A->>API: GET /api/vault/policy (JWT + DPoP)
  API-->>A: signed vault policy (public, holds no key)
  A->>ORK: doEncrypt(rawKey, tag="household-vault", policy)
  Note over ORK: Each ORK checks: caller holds household-viewer<br/>and _tide_encryptor? tag = assignmentId?
  ORK-->>A: wrappedKey
  A->>API: POST /api/clips {ciphertext, iv, wrappedKey, camera, label, mime}
  API-->>A: 201 (stored: ciphertext only)
  Note over A: rawKey and plaintext are discarded.<br/>Nothing reversible ever left the browser.
```

**Why wrap a key instead of encrypting the video with Tide directly?** Videos are large, and Tide's per-call encryption is meant for small payloads. Wrapping only the 32-byte key keeps calls fast. Tide itself uses the same hybrid pattern (AES-GCM + threshold ElGamal) for data ≥ 32 bytes.

---

## 6. Workflow: viewing a clip

```mermaid
sequenceDiagram
  autonumber
  actor A as Alex (browser)
  participant API as CamCo backend
  participant ORK as Tide network
  participant WC as WebCrypto

  A->>API: GET /api/clips/:id (JWT + DPoP, needs household-viewer)
  API-->>A: ciphertext, iv, wrappedKey
  A->>ORK: doDecrypt(wrappedKey, tag="household-vault", policy)
  Note over ORK: Every ORK independently verifies Alex's credential<br/>against the policy. 14 of 20 must agree.
  ORK-->>A: rawKey (reassembled only in Alex's browser)
  A->>WC: AES-GCM decrypt(ciphertext, iv, rawKey)
  WC-->>A: plaintext clip → shown in the page
```

The backend's own role check (403 for non-members) is a **convenience**. The **real** gate is the network: even someone holding a copy of the ciphertext and wrapped key cannot get the key without the role.

---

## 7. Workflow: the vendor tries to look

```mermaid
sequenceDiagram
  autonumber
  actor C as CamCo Support (browser)
  participant API as CamCo backend
  participant ORK as Tide network

  C->>API: GET /api/vendor/records
  API-->>C: every raw row (CamCo owns the DB)
  Note over C: Ciphertext rendered as a hex dump: noise.
  C->>ORK: doDecrypt(wrappedKey, policy)
  ORK-->>C: ✕ refused by all 20 ORKs<br/>"'_tide_decryptor' role not found"
  Note over C: Surfaces as TIDE-TIDEJS-NET-THRESHOLD_FAILURE.<br/>It's not an outage: every ORK answered "no".
```

---

## 8. Workflow: the vendor tries to grant itself access

This is the key demo moment.

```mermaid
sequenceDiagram
  autonumber
  actor C as CamCo Support
  participant API as CamCo backend
  participant TC as TideCloak (IGA on)
  actor O as Owners (Alex / Sam / Riley)

  C->>API: POST /api/vendor/self-grant
  API->>TC: POST /users/camco-support/role-mappings/realm [household-viewer]<br/>(as master admin = root)
  TC-->>API: 204 captured → change request GRANT_ROLES (PENDING, 0 of 2)
  API-->>C: "Not applied. Pending household approval: 0 of 2"

  C->>API: POST /api/vendor/cr/:id/force
  API->>TC: POST …/approve
  TC-->>API: refused / "needs-approval" (an enclave signature is required)
  API->>TC: POST …/authorize
  TC-->>API: 409 MULTIADMIN_REQUIRES_APPROVAL_ENCLAVE
  API->>TC: POST …/commit
  TC-->>API: 412 quorum not met
  API-->>C: every route refused, still PENDING

  TC-->>O: request appears: "CamCo is asking to watch your cameras"
  O->>TC: Deny (from an owner's own browser)
  TC-->>O: DENIED: never applied
```

The status codes on the `approve`/`authorize`/`commit` steps are the answers documented for TideCloak's IGA API. The Vendor Console shows whatever TideCloak actually returns, verbatim. The captured `204` and the `0 of 2` pending state were observed on this realm.

Root can **file** but never **approve**: approval is a threshold signature that needs an owner's Tide key, which only exists split across the ORK network and is unlocked by that owner's own login.

---

## 9. Workflow: quorum adds a member

```mermaid
sequenceDiagram
  autonumber
  actor Al as Alex (owner)
  actor Sa as Sam (owner)
  actor Jo as Jordan
  participant API as CamCo backend
  participant TC as TideCloak (IGA)
  participant EN as Tide enclave + ORKs

  Jo->>API: GET /api/clips
  API-->>Jo: 403: no household-viewer
  Al->>API: POST /api/household/request-viewer {jordan}
  API->>TC: file GRANT_ROLES household-viewer → jordan (root files it)
  TC-->>Al: pending: 0 of 2

  Al->>TC: POST /iga/change-requests/:id/approve {}  (Alex's own token)
  TC-->>Al: mode "needs-approval" + requestModel
  Al->>EN: sign requestModel (Tide pop-up)
  EN-->>Al: signed request
  Al->>TC: POST …/approve {requestModel}
  TC-->>Al: recorded: 1 of 2, not applied
  Note over Jo: Still locked out: one owner isn't enough.

  Sa->>TC: approve → enclave → approve {requestModel}
  TC->>TC: quorum met → commit (signed by the network)
  TC-->>Sa: APPROVED: applied (2 of 2)

  Jo->>TC: sign out / sign in (new credential carries household-viewer)
  Jo->>API: GET /api/clips → 200
  Jo->>EN: unwrap clip keys → ✓
```

Approvals go **browser → TideCloak directly** with each owner's own DPoP-bound token. Proxying them through a server would credit every signature to one account, and the tally would stick at 1.

---

## 10. Workflow: someone leaves (revocation)

```mermaid
sequenceDiagram
  autonumber
  actor Al as Alex (owner)
  actor Ri as Riley (owner)
  actor Jo as Jordan
  participant API as CamCo backend
  participant TC as TideCloak (IGA)
  participant ORK as Tide network

  Al->>API: POST /api/household/revoke-viewer {jordan}
  Note over API: Refuses (403) if the username is the caller's own.
  API->>TC: file REVOKE_ROLES household-viewer ← jordan
  Al->>TC: approve (enclave): 1 of 2
  Ri->>TC: approve (enclave): 2 of 2 → applied
  Jo->>TC: next sign-in / token refresh (≤ 10 min)
  Jo->>ORK: unwrap any clip key (old or new)
  ORK-->>Jo: ✕ refused: role not found
```

No re-encryption is needed: the policy names the **role**, so removing the role closes every clip at once.

---

## 11. Change-request lifecycle

```mermaid
stateDiagram-v2
  [*] --> PENDING: governed admin write<br/>(answers 202 / 204, "captured")
  PENDING --> PENDING: owner approves<br/>(authorizationCount + 1)
  PENDING --> APPROVED: approvals reach threshold<br/>→ auto-commit, network-signed
  PENDING --> DENIED: any owner denies
  APPROVED --> [*]: change is applied
  DENIED --> [*]: never applied
  note right of PENDING
    One pending request per user (409 PENDING_CHANGE_REQUEST_CONFLICT).
    Root's authorize → 409, commit → 412.
    If quorum is met but auto-commit didn't run,
    a signer clicks "Apply now", which re-runs the commit gates.
  end note
```

| Status | Meaning |
|---|---|
| `PENDING` | Waiting for approvals. `authorizationCount` of `threshold`. |
| `APPROVED` | **Committed and applied.** |
| `DENIED` | Rejected; never applied. |

---

## 12. Live camera and motion detection

A real camera (DroidCam's virtual webcam, or the laptop webcam) is an optional source that feeds **the same encrypt pipeline** as the synthetic scenes.

```mermaid
stateDiagram-v2
  [*] --> Warming: tick "Motion detection"
  Warming --> Watching: after 1.5 s (camera exposure settles)
  Watching --> Recording: changed pixels ≥ threshold
  Recording --> Recording: motion continues
  Recording --> Saving: 2 s without motion OR 15 s max
  Saving --> Cooldown: clip ≥ 1.5 s → queued for encrypt + upload
  Cooldown --> Watching: after 3 s
  Watching --> [*]: untick (a recording in progress is still saved)
```

**How motion is measured.** About 5 times a second, the frame is drawn onto a 64×36 canvas and converted to greyscale. The *motion level* is the share of pixels whose brightness changed by more than 28 (on a 0–255 scale). The trigger threshold comes from the sensitivity slider: `(101 − sensitivity) / 1000`, so the default of 60 means 4.1% of pixels. This all runs in the browser; no frame is ever uploaded unencrypted.

**Recording.** Frames are letterboxed into 640×360, stamped with "● LIVE camera + UTC time", and recorded at 15 fps, about 600 kbps WebM. Uploads are serialised so overlapping events don't clash.

---

## 13. Bootstrap and first-time setup

```mermaid
flowchart TD
  A["npm run bootstrap"] --> B{"Licence email +<br/>Terms accepted in .env?"}
  B -- no --> X["Stop, exit 2: nothing created"]
  B -- yes --> C["Start TideCloak container<br/>tidecloak-camvault :8080"]
  C --> D["Import realm template<br/>(roles incl. composite household-viewer)"]
  D --> E["Disable profile-review page<br/>(before IGA)"]
  E --> F["setUpTideRealm: licence + keys"]
  F --> G["iga.attestor = tide, toggle IGA on"]
  G --> H["Create 5 users, grant owners household-viewer<br/>(FirstAdmin mode: script can approve)"]
  H --> I["Print invite links → you create 5 Tide accounts"]
  I --> J["Sign IdP settings, export adapter<br/>web/public/tidecloak.json"]
  J --> K["Grant tide-realm-admin to Alex LAST<br/>→ realm flips to multi-admin"]
  K --> L["In the app: Alex creates the vault (enclave)"]
  L --> M["Make Sam + Riley owners (approved in-app)<br/>→ threshold becomes 2"]
```

**Why the order matters.** Until the first `tide-realm-admin` grant commits, the realm is in *FirstAdmin* mode and the script can approve its own changes. After the flip, **every** change needs a human enclave signature. That's the property the demo relies on, so the script does everything it needs before the flip and stops there.

---

## 14. Data model

`server/data/db.json` (gitignored):

```mermaid
erDiagram
  CLIP {
    string id "uuid"
    string camera "e.g. Front Door, Phone cam"
    string label "e.g. Motion detected (4.2s)"
    string mime "image/png, image/jpeg, video/webm"
    number capturedAt
    string uploadedBy
    number bytes "ciphertext size"
    string iv "base64, 12 bytes"
    string ciphertext "base64, AES-256-GCM"
    string wrappedKey "Tide-wrapped AES key"
  }
  VAULT_POLICY {
    string policy "base64 signed RelationshipAttestation:1"
    string recordId "household-vault"
    string signedBy
    number signedAt
  }
  AUDIT {
    number at
    string who
    string what
    string detail
  }
```

| What CamCo can read | What it can't |
|---|---|
| Camera name, label, time, size, uploader, IV, ciphertext, wrapped key, the (public) vault policy | The clip, the AES key, anything that unwraps the key |

---

## 15. API reference

Every route except `/api/health` verifies the **Tide JWT** (embedded JWKS, issuer, `azp`) **and** the **DPoP proof** (RFC 9449: key thumbprint, `ath`, `htm`, `htu`, `iat`, one-time `jti`). Role checks use the verified token, never anything from the browser.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/health` | anyone | liveness |
| GET | `/api/me` | signed in | username, roles, owner / household / vendor flags |
| GET | `/api/vault/status` | signed in | has the vault been created, by whom |
| GET | `/api/vault/policy` | household | the signed vault policy |
| PUT | `/api/vault/policy` | owner | store the policy after enclave signing |
| GET | `/api/admin-policy` | owner | realm admin policy, needed to sign the vault policy |
| POST | `/api/clips` | household | upload ciphertext + wrapped key |
| GET | `/api/clips` | household | list event metadata |
| GET | `/api/clips/:id` | household | one clip's ciphertext + wrapped key |
| GET | `/api/directory` | signed in | user-id → name and role-id → name, for readable approvals |
| GET | `/api/household/members` | owner | live member status from TideCloak |
| POST | `/api/household/request-viewer` | owner | **file** a `household-viewer` grant |
| POST | `/api/household/revoke-viewer` | owner (not self) | **file** a `household-viewer` removal |
| POST | `/api/household/request-owner` | owner | **file** a `tide-realm-admin` grant |
| GET | `/api/audit` | household / vendor | recent events |
| GET | `/api/vendor/records` | CamCo staff | raw DB rows |
| GET | `/api/vendor/change-requests` | CamCo staff | pending requests as root sees them |
| POST | `/api/vendor/self-grant` | CamCo staff | root tries to grant itself `household-viewer` |
| POST | `/api/vendor/cr/:id/force` | CamCo staff | root tries `approve`, `authorize`, `commit` |

**Browser → TideCloak, never via the backend:** `GET /iga/change-requests?status=PENDING`, and `POST /iga/change-requests/:id/approve` (two calls with the enclave signature in between) and `…/deny`, each with the owner's own DPoP token.

---

## 16. Code map

```
scripts/
  bootstrap.mjs          Full setup (ported from Tide's bootstrap-tidecloak.sh to Node, cross-platform)
  cast.mjs               After setup: status | add | remove | grant | composite | invite
  realm.json.template    Realm, client, mappers, roles (household-viewer composite)
server/src/
  index.ts               All API routes
  auth/tide.ts           JWT verification + requireAuth (JWT + DPoP on every route)
  auth/verifyDpop.ts     Tide pack's RFC 9449 verifier (unchanged copy)
  tidecloakAdmin.ts      Root (master admin) client: files change requests, reads members
  db.ts, paths.ts        JSON store and paths
web/src/
  Home.tsx               Signed-out home page
  App.tsx                Auth callback, routing by identity (Household vs Vendor)
  household/Household.tsx  Vault setup, cameras, gallery/viewer, approvals, members
  vendor/VendorConsole.tsx Raw storage, refused decrypt, self-grant + force attempts
  camera/scenes.ts       Synthetic CCTV scenes (PNG snapshot, WebM clip)
  camera/live.ts         Real camera: open, snapshot, recorder
  camera/motion.ts       Frame-differencing motion detector
  lib/crypto.ts          AES-256-GCM (WebCrypto)
  lib/vault.ts           Vault policy signing, key wrap/unwrap, refusal parsing
  lib/tide/relationship.ts Tide pack's RelationshipAttestation helper (unchanged copy)
  lib/iga.ts             Change requests: list, two-phase approve, deny, labels
  lib/api.ts             secureFetch wrappers (DPoP on every call)
web/vite.config.ts       SDK DPoP relay plugin, frame-src CSP, /api proxy
```

---

## 17. Operations: scripts and commands

| Task | Command |
|---|---|
| Install | `npm run setup` |
| First-time setup | `npm run bootstrap` |
| Finish setup with fewer linked accounts | `RESUME_FROM=finish npm run bootstrap` |
| Start over (deletes the realm + container) | `FORCE_WIPE=1 npm run bootstrap` |
| Run | `npm run server` and `npm run web` |
| After reboot | `docker start tidecloak-camvault`, then run both |
| Who's in the realm, what's pending | `node scripts/cast.mjs status` |
| Add a person (files CREATE_USER) | `node scripts/cast.mjs add riley owner` |
| Give an owner the vault role (files GRANT_ROLES) | `node scripts/cast.mjs grant riley owner` |
| New invite link | `node scripts/cast.mjs invite riley` |
| Remove a person (files DELETE_USER) | `node scripts/cast.mjs remove riley` |
| Typecheck everything | `npm run typecheck` |
| TideCloak admin console | <http://localhost:8080/admin/master/console/> (user `admin`, password from `.env`), realm `camera-vault` |

Every `cast.mjs` command only **files** a request; an owner approves it in the app under **Pending household approvals**.

---

## 18. Troubleshooting

Problems met while building this, and their fixes.

| Symptom | Cause | Fix |
|---|---|---|
| TideCloak exits: `Could not open file …keycloakdb.mv.db` | A named Docker volume is root-owned; the container runs as uid 1000 | The script uses no volume; data lives in the container (survives `docker stop/start`) |
| `error-user-attribute-required: email` | The user profile requires an email | Characters get `…@household.invalid` (a reserved, undeliverable TLD) |
| `Could not reach enough NEW ORKs (… 18 of 20 failed)` / `NET-FETCH_FAILED` at sign-up | The browser couldn't reach the ORKs: ad-blocker, privacy shields, VPN, or a stale tab | Fresh private window, extensions off, one account at a time, unique username |
| `hit its user limit` at sign-up | Free-tier licence account cap | Ask Tide to raise it, or `RESUME_FROM=finish` |
| Invite page: *Invalid username or password* | The link belongs to a deleted user | `node scripts/cast.mjs invite <user>` for a fresh link |
| `'_tide_encryptor' role not found` from all ORKs | Role missing from the credential | Grant it; the user signs out and in |
| Granting 3 roles only gave 1 | IGA records only the **first** role of a multi-role POST | One role per request (now everywhere) |
| Second grant → `409` | One pending change request per user | Make `household-viewer` a composite, so membership is one grant |
| Approved "1 of 1" but not applied | Auto-commit didn't run | **Apply now (quorum reached)** re-runs the commit gates |
| Server prints "running" but old code serves | Express 5 calls the listen callback even on `EADDRINUSE` | The callback now exits on error; stop the old process first |
| Vite: `Cannot read properties of undefined (reading 'url')` | A `configureServer` hook returned a function (Vite runs it as a post hook) | Block body in the plugin |
| Live camera black / nothing happens | Wrong device, client not connected, or no frames | Pick **DroidCam Source**; read the status line (*receiving frames* vs *no picture*) |
| A refused decrypt looks like an outage | Contract refusals arrive as `THRESHOLD_FAILURE` | The app reads the ORKs' reasons and says "refused", without retrying |

---

## 19. Known limits and design trade-offs

- **Metadata isn't hidden.** CamCo sees camera names, times, sizes and who uploaded. Hiding these would need encrypted metadata and padding.
- **Revocation is eventual.** It applies at the next sign-in or token refresh (access tokens last 10 minutes). Anything already decrypted and saved can't be recalled.
- **The vault is one record.** All clips share `household-vault`, so access is all-or-nothing per household. Per-camera or per-clip sharing (e.g. releasing one clip to police) would add records and policies.
- **The server can still deny service** (delete ciphertext, go offline). TideCloak's hosting is an availability trust, not a confidentiality one.
- **Vendor staff are identified by username** (`VENDOR_STAFF`, default `camco-support`) for the demo console. Their *lack* of access is enforced by Tide, not by that list.
- **Development setup.** HTTP on localhost, an H2 database inside the container, and an in-memory DPoP replay store (single process).

---

## 20. Glossary

| Term | Meaning |
|---|---|
| **TideCloak** | Keycloak-based identity server whose keys and signatures are threshold-split across the Tide network |
| **ORK** | One of the Tide network's independent key servers; each holds only a fragment |
| **Threshold (14 of 20)** | How many ORKs must cooperate for any key operation |
| **Enclave** | Tide's isolated pop-up where a user approves and signs, separate from the app's page |
| **IGA / change request** | Identity Governance: admin changes are captured as requests and applied only at quorum |
| **Quorum / threshold (2 of 3)** | How many owners must sign a change request |
| **`tide-realm-admin`** | The owner/approver role |
| **RelationshipAttestation:1** | Built-in ORK contract: "holders of role X may encrypt/decrypt data tagged Y" |
| **Wrapped key** | The clip's AES key, encrypted by the Tide network under the vault policy |
| **DPoP** | Proof-of-possession: each API call is signed by a key bound to the token, so a stolen token can't be replayed |
| **Root / master admin** | TideCloak's `admin` account in the `master` realm, held by CamCo |
