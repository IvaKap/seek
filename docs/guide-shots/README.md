# Screenshots for the PDF guide

Save PNGs here using these exact names, then rebuild:

    pip install fpdf2
    python3 docs/make-guide.py

Any file that is missing becomes a labelled placeholder, so the guide always
builds and always reads — it never silently drops a step.

| File | What to capture | |
|---|---|---|
| `01-warning.png` | The "could not verify" dialog macOS shows on first open | have |
| `02-settings.png` | System Settings → Privacy & Security, with **Open Anyway** visible | have |
| `03-app.png` | The app on a search, or a pasted Bandcamp/Discogs link | have |
| `04-compare.png` | The copies comparison open, showing several people with the same album | **missing** |
| `05-catalogue.png` | A label's catalogue, e.g. Flexout Audio | have |
| `06-link.png` | A single album link resolved — artist, release, track count | have |
| `07-quality.png` | The spectrogram, ending on "this is not proof" | have |

**Taking one:** Shift-Cmd-4, then Space, then click the window. That captures
just the window, with its shadow, on a transparent background.

**Before you save one, check it for:** your Soulseek username, other people's
usernames in a results list, and anything in a file path you would rather not
publish. This guide is meant to be handed to other people.
