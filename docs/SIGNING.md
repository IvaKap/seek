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

**The one in use was made with `openssl`, not Certificate Assistant.** The GUI
is fine, but two of its defaults are wrong and one of them cannot be undone
later, so the exact recipe is recorded here instead of a click path:

```bash
cat > req.cnf <<'CNF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_codesign

[dn]
CN = Seek Self Signed
C  = GE

[v3_codesign]
keyUsage             = critical, digitalSignature
extendedKeyUsage     = critical, codeSigning
subjectKeyIdentifier = hash
CNF

openssl req -x509 -newkey rsa:2048 -sha256 -days 7300 -noenc \
  -keyout key.pem -out cert.pem -config req.cnf
```

Those three extensions — and the absence of `basicConstraints` — are exactly
what Certificate Assistant's *Self Signed Root* + *Code Signing* template
produces, confirmed by dumping the certificate it made before replacing it.

**What the defaults get wrong**, if you use the GUI anyway (tick *Let me
override defaults*):

| Default | Why it matters |
| --- | --- |
| **365-day validity** | `codesign` refuses an expired certificate, and replacing it is a NEW IDENTITY — the one thing this file exists to avoid. `-days 7300` is 20 years |
| **Email pre-filled from your Apple ID** | It lands in the certificate subject and ships inside every build, readable by anyone running `codesign -dvvv` on Seek.app |

The current certificate:

```
subject=CN=Seek Self Signed, C=GE          (no email)
notBefore=Aug 30 13:31:13 2026 GMT
notAfter =Aug 25 13:31:13 2046 GMT
sha1     =DA:F5:A5:4F:5E:BD:AD:2F:FC:60:FF:11:B9:C4:1F:8F:20:98:70:D9
```

> **Never regenerate it.** A new certificate is a new identity, and every user is
> back to being prompted on their next update — the exact problem this exists to
> fix. If it is ever lost, that is a real cost, so export a backup now and keep
> it somewhere you will still have in two years.

### Trust: not required, and the check that says otherwise is lying

A self-signed certificate is untrusted until you say so, and every obvious probe
reports that as failure:

```
$ security find-identity -v -p codesigning
     0 valid identities found
```

Drop `-v` — which filters to *valid* identities — and it appears, with the
reason:

```
$ security find-identity -p codesigning
  1) DA:F5:A5… "Seek Self Signed" (CSSMERR_TP_NOT_TRUSTED)
```

**`codesign` signs with it regardless.** Measured, not assumed: a certificate
freshly imported into a keychain with no trust settings anywhere signed a binary
non-interactively, producing `Authority=Seek Self Signed`. Trust gates
*verification*, not the ability to sign — so **CI needs no trust step**, and
neither does `release.sh`.

Trust it locally only if you want `-v` to stop lying to you: Keychain Access →
*My Certificates* → *Seek Self Signed* → Trust → **Code Signing: Always Trust**.
It is a local keychain setting and says nothing about whether TCC matching
works; only the two-build test settles that.

Also always pass `-p codesigning`. Without it the default X.509 Basic policy
reports `0 valid identities found` for a perfectly good code-signing
certificate, for a second unrelated reason.

### Only ever one identity by this name

`APPLE_SIGNING_IDENTITY` is matched **by name**. While the superseded
certificate was still installed, a signing test "succeeded" against the wrong
one and reported a plausible `Authority=Seek Self Signed` — the result looked
like a pass and meant nothing. Delete the old one before testing a new one:

```bash
security delete-identity -Z <sha1> ~/Library/Keychains/login.keychain-db
```

## 2. Package it as a .p12

The certificate has to reach CI as a base64 `.p12` in a repository secret.

```bash
openssl pkcs12 -export -legacy -macalg sha1 \
  -inkey key.pem -in cert.pem -name "Seek Self Signed" \
  -out seek-signing.p12 -passout pass:"$PASS"
```

**`-legacy -macalg sha1` is load-bearing, and getting it wrong wastes an
afternoon.** OpenSSL 3 defaults the PKCS#12 MAC to SHA-256, which Apple's
`security import` cannot read. It fails like this:

```
security: SecKeychainItemImport: MAC verification failed during PKCS12 import
(wrong password?)
```

The password is **not** wrong. It is the MAC algorithm, and the error names the
one thing that is fine. Passing `-f pkcs12` to `security import` masks it —
which is exactly why it has to be right here: **Tauri does not pass `-f`**
(`crates/tauri-macos-sign/src/keychain.rs`), so a p12 that imports by hand can
still fail on CI.

If you exported from Keychain Access instead, you get Apple's own format, which
is fine but encrypted with `RC2-40-CBC` — so plain OpenSSL 3 refuses to read it
back and needs `-legacy` to inspect it. That too is the algorithm, not a corrupt
file.

### Verify before trusting it

A bad `.p12` fails on CI with nothing useful in the log, so prove it locally
first. The faithful check is Tauri's own sequence — note the keychain must be
added to the **search list**, or `codesign` cannot reach the private key and
blocks on a GUI prompt that never comes on a runner:

```bash
KC="$HOME/Library/Keychains/probe.keychain-db"
security create-keychain -p "$KCPASS" "$KC"
security unlock-keychain -p "$KCPASS" "$KC"
security import seek-signing.p12 -P "$PASS" -T /usr/bin/codesign -k "$KC"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPASS" "$KC"
security list-keychain -d user -s ~/Library/Keychains/login.keychain-db "$KC"

cp /bin/echo probe-bin
codesign -f -s "Seek Self Signed" --keychain "$KC" --timestamp=none probe-bin
codesign -d --extract-certificates=xc probe-bin
openssl x509 -inform der -in xc0 -noout -subject -dates -fingerprint -sha1

security list-keychain -d user -s ~/Library/Keychains/login.keychain-db   # RESTORE
security delete-keychain "$KC"
```

**Check the fingerprint, not just that it signed** — see "only ever one identity
by this name" above. And restore the search list unconditionally; leaving a
deleted keychain in it breaks signing on the machine in a way that is hard to
spot.

Then base64 it:

```bash
base64 -i seek-signing.p12 | tr -d '\n' | pbcopy
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
