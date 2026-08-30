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

**Do tick *Let me override defaults*.** The defaults are wrong in two ways that
are cheap to fix now and expensive later — a **365-day validity** (see below)
and an **email address pre-filled from your Apple ID**, which is then embedded
in the certificate and readable by anyone who runs `codesign -dvvv` on a
shipped build. Clear the email field; set the validity to several thousand days.

Keep the keychain as **login** while overriding — that is the one default worth
keeping.

**Login, never System.** The login keychain is unlocked when you log in, so
`codesign` running as you can reach the private key without prompting. System is
machine-wide, needs admin, and would make the key usable by every admin account
on the Mac for no benefit. It makes no difference to CI either way: Tauri
imports the `.p12` into a temporary keychain on the runner, so the local copy
only matters if you also build locally with `release.sh`.

**A fresh certificate is untrusted, and this WILL look like failure.** Right
after creating it:

```
$ security find-identity -v -p codesigning
     0 valid identities found
```

Drop the `-v` — which filters to *valid* identities — and the truth appears:

```
$ security find-identity -p codesigning
  1) 0F29EF42… "Seek Self Signed" (CSSMERR_TP_NOT_TRUSTED)
```

The certificate is fine; nothing is trusted until you say so. Keychain Access →
*My Certificates* → double-click *Seek Self Signed* → Trust → **Code Signing:
Always Trust**. Then `-v` lists it.

Two things this does **not** mean. It is a local keychain setting, so it says
nothing about whether TCC matching works — only the two-build test settles that.
And it is not needed on CI: importing the `.p12` into a fresh keychain yields a
*valid* identity with no trust step, verified by the round-trip in step 2.

Also use `-p codesigning`. Without it the default X.509 Basic policy reports
`0 valid identities found` for a perfectly good code-signing certificate.

> **It expires — check the date.** Certificate Assistant defaults to **365
> days**; the one in use runs to **2027-08-30**. `codesign` refuses an expired
> certificate, and replacing it is a new identity, which is the one thing this
> file says never to do. The free moment to widen it is **before the first
> signed release** — after that, every user pays a re-prompt for the change.
> Recreate it with *Let me override defaults* and a validity of several
> thousand days, or accept a dated reset and write the date down.

> **Never regenerate it.** A new certificate is a new identity, and every user is
> back to being prompted on their next update — the exact problem this exists to
> fix. If it is ever lost, that is a real cost, so export a backup now and keep
> it somewhere you will still have in two years.

## 2. Export it

Keychain Access → **My Certificates** → right-click *Seek Self Signed* →
*Export…* → `.p12`, with a password. Or from a terminal, which is what was done:

```bash
security export -k ~/Library/Keychains/login.keychain-db \
  -t identities -f pkcs12 -P "$PASS" -o ~/Desktop/seek-signing.p12
```

`-t identities` exports **every** identity in the keychain, so confirm there is
only the one first — `security find-identity -p codesigning` — or the bundle
carries unrelated private keys into a repository secret.

Verify it before trusting it, because a bad `.p12` fails on CI with nothing
useful in the log:

```bash
openssl pkcs12 -legacy -in ~/Desktop/seek-signing.p12 -passin pass:"$PASS" \
  -nokeys | openssl x509 -noout -subject -dates -purpose
```

**`-legacy` is not optional.** `security export` writes PKCS#12 encrypted with
`RC2-40-CBC`, which OpenSSL 3 refuses by default:

```
error:0308010C:digital envelope routines:…:unsupported,
Algorithm (RC2-40-CBC : 0)
```

That is the algorithm, not a corrupt file. Apple's own `security import` reads
it without complaint, which is what Tauri calls on the runner — so the faithful
check is the round-trip:

```bash
security create-keychain -p "$KCPASS" "$KC"
security unlock-keychain -p "$KCPASS" "$KC"
security import ~/Desktop/seek-signing.p12 -k "$KC" -P "$PASS" -T /usr/bin/codesign -f pkcs12
security find-identity -p codesigning "$KC"   # expect 1 VALID identity
security delete-keychain "$KC"
```

Then base64 it:

```bash
base64 -i ~/Desktop/seek-signing.p12 | tr -d '\n' | pbcopy
```

**`tr -d '\n'` matters** — the Rust base64 decoder on the other end rejects
embedded newlines.

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

Set the password with no trailing newline — `printf '%s' "$PASS" | gh secret
set APPLE_CERTIFICATE_PASSWORD` — rather than relying on whatever the tool
trims. A password with a stray `\n` fails the import on CI and says only that
the import failed.

Tauri's CLI reads all three natively — confirmed in the shipped binary — and
imports the certificate into a temporary keychain itself. No manual `security`
commands are needed.

**`tauri.conf.json` still says `"signingIdentity": "-"`, and that is correct.**
The environment variable wins; the config is the fallback. From the CLI source
at the pinned version, `crates/tauri-cli/src/interface/rust.rs:1467`:

```rust
let signing_identity = match std::env::var_os("APPLE_SIGNING_IDENTITY") {
  Some(signing_identity) => Some(…),
  None => config.macos.signing_identity,
};
```

So the secrets alone flip the build to signed, and a checkout with no secrets —
anyone building locally — stays ad-hoc exactly as before. Do not "fix" the `-`
to the certificate name: that would sign every local build with an identity the
machine does not have, and break the build for everyone else.

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
