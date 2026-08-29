# Signing, and the permission prompt that keeps coming back

## The problem

Every time Seek updates, macOS asks again for permission to read the Downloads
folder.

**This is not a permissions bug. It is a signing consequence**, and it is a
different mechanism from the quarantine / "unidentified developer" dance that
`lib.rs` already solves — which is why that fix does nothing for it.

`app/src-tauri/tauri.conf.json` sets:

```json
"macOS": { "signingIdentity": "-" }
```

`-` means **ad-hoc**: signed, but with no certificate behind it. Verified
against a real build:

```
$ codesign -dvvv Seek.app
flags=0x10002(adhoc,runtime)
Signature=adhoc
TeamIdentifier=not set
Internal requirements count=0
```

`TeamIdentifier=not set` and `Internal requirements count=0` mean macOS has no
certificate-anchored identity for this app. The only thing identifying it is the
**CDHash** — a hash of the code itself. Every release is new code, so a new
hash, so TCC concludes it is different software and asks again.

The process that actually touches the folder is the **Python sidecar**
(`Contents/Resources/sidecar/seek-sidecar`), which runs pynicotine's
`downloads.py`. The prompt is attributed to Seek.app because the sidecar is a
bare executable with no bundle identity of its own.

## The fix being attempted, and its honest status

**One self-signed certificate, created once and reused forever.**

The theory: a certificate gives `codesign` something stable to anchor a
designated requirement to, instead of falling back to a raw content hash — which
should be enough for TCC to match successive builds.

**This is unverified.** It is plausible and free; it is not established. The only
thing that settles it is the two-build test at the bottom of this file. A green
build proves nothing here.

The certain fix is a paid Apple Developer ID ($99/year), which also removes the
`xattr` dance on first install. The roadmap for that is already written at the
foot of `.github/workflows/release.yml`.

---

## 1. Create the certificate — once, ever

Keychain Access → **Certificate Assistant** → *Create a Certificate…*

| Field | Value |
| --- | --- |
| Name | `Seek Self Signed` |
| Identity Type | Self Signed Root |
| Certificate Type | **Code Signing** |

Leave *Let me override defaults* unchecked. Give it a long expiry if offered.

> **Never regenerate it.** A new certificate is a new identity, and every user is
> back to being prompted on their next update — the exact problem this exists to
> fix. If it is ever lost, that is a real cost, so export a backup now and keep
> it somewhere you will still have in two years.

## 2. Export it

Keychain Access → **My Certificates** → right-click *Seek Self Signed* →
*Export…* → `.p12`, with a password.

Then, in a terminal:

```bash
base64 -i ~/Desktop/seek-signing.p12 | pbcopy
```

That is now on your clipboard. **Do not paste it into a chat, an issue, or a
commit** — it is the private key.

## 3. Add three repository secrets

GitHub → the repo → Settings → Secrets and variables → **Actions** → *New
repository secret*:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | the base64 blob from step 2 |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set on the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Seek Self Signed` |

Tauri's CLI reads all three natively — confirmed in the shipped binary — and
imports the certificate into a temporary keychain itself. No manual `security`
commands are needed.

**The workflow already handles this.** `.github/workflows/release.yml` has a
conditional step that exports these only when they are present, so builds keep
working ad-hoc until the secrets exist. Nothing needs changing to turn it on.

## 4. Release as usual

```bash
git tag v0.2.8 && git push origin v0.2.8
```

Confirm the signature actually changed, on the downloaded app:

```bash
codesign -dvvv /Applications/Seek.app 2>&1 | grep -E "Signature|Authority|TeamIdentifier"
```

Ad-hoc says `Signature=adhoc`. Signed says `Authority=Seek Self Signed`. If it
still says `adhoc`, the secrets are not reaching the build — check the workflow
log for `no certificate configured`.

---

## 5. The test that actually settles it

**TCC cannot be faked or simulated. This has to be done on a real Mac, with two
real builds.**

1. Install the **first** signed build (call it A).
2. Point Settings → Folders → Downloads at your real `~/Downloads`.
3. Start a download. macOS prompts. **Allow it.**
4. Cut a second release (B) — any trivial change, so the code hash differs.
5. Update to B, either through the in-app updater or by replacing the app.
6. Start another download.

| What happens | What it means |
| --- | --- |
| **No prompt** | It worked. A stable self-signed identity is enough for TCC. |
| **Prompted again** | It did not. The certificate is not enough, and only a Developer ID will fix it. |

There is no partial result and no interpreting required.

### If it fails

Say so plainly and stop — do not ship further changes pretending it helped. The
remaining options, in order:

1. **Apple Developer ID.** The only certain fix. Also removes the quarantine
   dance. $99/year plus notarisation in CI.
2. **Steer the folder away from protected locations.** pynicotine already
   defaults to `~/.local/share/nicotine/downloads`, which is not TCC-protected.
   Helps new users only; useless once someone has chosen their real Downloads.
3. **Accept and document it.** Costs nothing, changes nothing.

## Two things to expect either way

- **Existing users get ONE more prompt** on the upgrade from ad-hoc to signed.
  The identity changes at that moment, which is the whole point. It should be the
  last one.
- **Gatekeeper is untouched.** A self-signed certificate is not a trusted one, so
  the `xattr -dr com.apple.quarantine` instructions for fresh installs stay
  exactly as they are. Only a Developer ID removes those.

## Dead ends, already ruled out

- **`upstream/build-aux/macos/codesign-entitlements.plist`** — wrong domain
  entirely (hardened-runtime JIT exceptions, not the privacy service), and dead
  submodule baggage referenced only from a Windows setup script.
- **Full Disk Access** — keyed to the same unstable identity, so it would face
  the identical re-prompt while granting far broader access.
- **App Sandbox with security-scoped bookmarks** — Apple's real "never prompt
  again" mechanism, but it would need `startAccessingSecurityScopedResource`
  around every file operation inside a frozen Python binary with no ObjC
  bindings, while the Soulseek core does raw sockets and arbitrary folder
  scanning. Legitimate long-term direction; not a near-term fix.
