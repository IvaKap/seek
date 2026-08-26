#!/usr/bin/env python3
"""
Seek — build the PDF guide handed to people testing the app.
SPDX-License-Identifier: GPL-3.0-or-later

Run it:   python3 docs/make-guide.py
Needs:    pip install fpdf2

SCREENSHOTS. Drop PNGs into docs/guide-shots/ and re-run; each slot below picks
its file up automatically. Anything missing is drawn as a labelled placeholder
saying exactly what to capture, so an incomplete guide still prints and still
reads — it never silently omits a step.

    01-warning.png    the "could not verify" dialog
    02-settings.png   Privacy & Security, Open Anyway visible
    03-app.png        the app on a search, or a pasted link
    04-compare.png    the copies comparison open  (needs capturing)
    05-catalogue.png  a label's catalogue, e.g. Flexout Audio
    06-link.png       a single album link resolved
    07-quality.png    the spectrogram

Take one with Shift-Cmd-4 then Space, then click the window.
"""

import re
import subprocess
from pathlib import Path
from fpdf import FPDF
from fpdf.enums import XPos, YPos

# Core PDF fonts are Latin-1 only, so a curly quote crashes the build. These
# ship with macOS, cover Unicode, and read warmer than Helvetica — which suits
# a guide meant for friends rather than engineers.
FONT_DIR = Path("/System/Library/Fonts/Supplemental")
BODY_FONT = "Verdana"
HEAD_FONT = "Georgia"

HERE = Path(__file__).resolve().parent
SHOTS = HERE / "guide-shots"
OUT = HERE / "Seek-guide.pdf"

# What each slot resolved to, filled in by shot(). Reported at the end, because
# globbing the folder instead would credit the guide with any stray PNG sitting
# there and stay silent about the slots that fell back to a placeholder.
EMBEDDED = []
PLACEHELD = []

INK    = (27, 36, 48)
MUTED  = (90, 104, 117)
FAINT  = (150, 162, 173)
ACCENT = (46, 111, 126)
WARN   = (150, 88, 22)
WARNBG = (252, 246, 236)
PANEL  = (238, 243, 245)
RULE   = (222, 229, 234)

PAGE_W, MARGIN = 210, 20
COL = PAGE_W - 2 * MARGIN


class Guide(FPDF):
    def footer(self):
        if self.page_no() == 1:
            return
        self.set_y(-15)
        self.set_font("body", "", 7.5)
        self.set_text_color(*FAINT)
        self.cell(0, 5, f"Seek  ·  page {self.page_no() - 1}", align="C")


def h1(pdf, text):
    pdf.set_font("head", "B", 24)
    pdf.set_text_color(*INK)
    pdf.multi_cell(COL, 10, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(3)


def h2(pdf, text):
    pdf.ln(2)
    pdf.set_font("head", "B", 14)
    pdf.set_text_color(*INK)
    pdf.multi_cell(COL, 7.5, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(1.5)


def body(pdf, text, colour=MUTED, size=11):
    pdf.set_font("body", "", size)
    pdf.set_text_color(*colour)
    pdf.multi_cell(COL, 5.8, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(2)


def step(pdf, number, title, text):
    """A numbered step. Numbers appear only here — installing is the one part
    of this guide that genuinely is a sequence."""
    top = pdf.get_y()
    pdf.set_fill_color(*ACCENT)
    pdf.circle(x=MARGIN + 4, y=top + 4, radius=4, style="F")
    pdf.set_xy(MARGIN, top + 1.2)
    pdf.set_font("body", "B", 10)
    pdf.set_text_color(255, 255, 255)
    pdf.cell(8, 6, str(number), align="C")

    pdf.set_xy(MARGIN + 12, top)
    pdf.set_font("body", "B", 11)
    pdf.set_text_color(*INK)
    pdf.multi_cell(COL - 12, 6, title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    pdf.set_x(MARGIN + 12)
    pdf.set_font("body", "", 9.5)
    pdf.set_text_color(*MUTED)
    pdf.multi_cell(COL - 12, 5.4, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(4)


def quote_box(pdf, text, label=None):
    pdf.ln(1)
    top = pdf.get_y()
    pdf.set_font("body", "", 10)
    lines = pdf.multi_cell(COL - 16, 5.6, text, dry_run=True, output="LINES")
    h = len(lines) * 5.6 + (7 if label else 0) + 10
    pdf.set_fill_color(*WARNBG)
    pdf.set_draw_color(*WARN)
    pdf.set_line_width(0.4)
    pdf.rect(MARGIN, top, COL, h, style="DF")
    pdf.set_xy(MARGIN + 8, top + 5)
    if label:
        pdf.set_font("body", "B", 8)
        pdf.set_text_color(*WARN)
        pdf.cell(0, 4, label.upper(), new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.set_x(MARGIN + 8)
        pdf.ln(1)
    pdf.set_font("body", "", 10)
    pdf.set_text_color(*INK)
    pdf.multi_cell(COL - 16, 5.6, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_y(top + h + 5)


def image_size(path):
    """Pixel dimensions, via sips so PNG and JPEG both work.

    One of the supplied screenshots is a JPEG carrying a .png name, which a
    hand-rolled PNG header reader silently mis-parsed into a 4-billion-pixel
    height. Ask the OS instead of guessing at the bytes.
    """
    out = subprocess.run(
        ["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)],
        capture_output=True, text=True,
    ).stdout
    w = re.search(r"pixelWidth:\s*(\d+)", out)
    h = re.search(r"pixelHeight:\s*(\d+)", out)
    return (int(w.group(1)), int(h.group(1))) if w and h else (16, 9)


PAGE_BOTTOM = 275  # where the auto page break kicks in


def shot(pdf, filename, caption, max_h=95):
    """A screenshot at its true aspect ratio, or a labelled placeholder.

    `pdf.image()` does NOT move the cursor, so the height has to be computed
    and applied by hand. Getting that wrong is what previously drew every
    caption and step straight through the middle of the picture: a 2784x1904
    shot at full column width is 116mm tall, not the ~70mm that was reserved
    for it.
    """
    path = SHOTS / filename
    pdf.set_font("body", "", 8)
    cap_lines = pdf.multi_cell(COL, 4.5, caption, dry_run=True, output="LINES")
    cap_h = len(cap_lines) * 4.5 + 5

    if path.exists():
        w_px, h_px = image_size(path)
        draw_w = COL
        draw_h = draw_w * h_px / w_px
        if draw_h > max_h:                      # tall shots are width-limited
            draw_h = max_h
            draw_w = draw_h * w_px / h_px
    else:
        draw_w, draw_h = COL, 70

    if pdf.get_y() + draw_h + cap_h > PAGE_BOTTOM:
        pdf.add_page()

    top = pdf.get_y()
    x = MARGIN + (COL - draw_w) / 2             # centred when width-limited
    if path.exists():
        pdf.image(str(path), x=x, y=top, w=draw_w, h=draw_h)
        EMBEDDED.append(filename)
    else:
        PLACEHELD.append(filename)
        pdf.set_draw_color(*FAINT)
        pdf.set_line_width(0.3)
        pdf.set_dash_pattern(dash=2, gap=2)
        pdf.rect(x, top, draw_w, draw_h)
        pdf.set_dash_pattern()
        pdf.set_xy(MARGIN, top + draw_h / 2 - 4)
        pdf.set_font("body", "", 8.5)
        pdf.set_text_color(*FAINT)
        pdf.multi_cell(COL, 5, f"[ still to capture: {filename} ]", align="C",
                       new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    pdf.set_y(top + draw_h + 3)
    pdf.set_font("body", "", 8)
    pdf.set_text_color(*FAINT)
    pdf.multi_cell(COL, 4.5, caption, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(6)


def build():
    pdf = Guide(orientation="P", unit="mm", format="A4")
    pdf.add_font("body", "", str(FONT_DIR / f"{BODY_FONT}.ttf"))
    pdf.add_font("body", "B", str(FONT_DIR / f"{BODY_FONT} Bold.ttf"))
    pdf.add_font("head", "B", str(FONT_DIR / f"{HEAD_FONT} Bold.ttf"))
    pdf.set_auto_page_break(auto=True, margin=22)
    pdf.set_margins(MARGIN, MARGIN, MARGIN)

    # ---------------------------------------------------------------- cover
    pdf.add_page()
    pdf.ln(38)
    pdf.set_font("head", "B", 46)
    pdf.set_text_color(*INK)
    pdf.cell(0, 20, "Seek", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(3)
    pdf.set_font("body", "", 13)
    pdf.set_text_color(*ACCENT)
    pdf.multi_cell(COL, 7.5, "A friendlier way to find music on Soulseek.",
                   new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(10)
    pdf.set_font("body", "", 10.5)
    pdf.set_text_color(*MUTED)
    pdf.multi_cell(COL - 20, 6.2,
        "Thanks for trying this. It is an early build, so a few rough edges are "
        "expected and honestly the point.\n\n"
        "The thing to try is label digging: paste a record label's page and Seek "
        "works through its whole catalogue with you. That is what this beta is "
        "for.\n\n"
        "This guide covers opening it the first time - macOS will object, and "
        "that is normal - then signing in, and what would help most to hear back.",
        new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    pdf.ln(12)
    top = pdf.get_y()
    pdf.set_fill_color(*PANEL)
    pdf.rect(MARGIN, top, COL, 30, style="F")
    pdf.set_xy(MARGIN + 8, top + 6)
    pdf.set_font("body", "B", 9.5)
    pdf.set_text_color(*INK)
    pdf.cell(0, 5, "You will need", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_x(MARGIN + 8)
    pdf.set_font("body", "", 9.5)
    pdf.set_text_color(*MUTED)
    pdf.multi_cell(COL - 16, 5.2,
        "A Mac, and a Soulseek account. If you already use Soulseek or "
        "Nicotine+, your usual username and password are fine.",
        new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    # ------------------------------------------------------------- opening
    pdf.add_page()
    h1(pdf, "Opening it the first time")
    body(pdf,
         "Apple charges developers a yearly fee to have apps recognised. This "
         "one has not paid it, so macOS shows a warning the first time. Nothing "
         "is wrong with the app or the download. Here is the way past it.")

    quote_box(pdf, '"Apple could not verify “Seek” is free of malware."',
              label="what you will see")

    step(pdf, 1, "Unzip it and drag Seek into Applications",
         "Same as any other app. Double-click the zip if it has not already unpacked.")
    step(pdf, 2, "Open it, then click Done - NOT Move to Trash",
         "Double-click Seek. The message above appears. The blue button says "
         "Move to Trash, and clicking it deletes the app. Click Done instead. "
         "This first attempt is what tells macOS you want to run it.")

    shot(pdf, "01-warning.png",
         "The blue button DELETES the app. Click Done. Apple's own example is "
         "pictured here; yours will say Seek.", max_h=88)

    step(pdf, 3, "Go to System Settings, then Privacy & Security",
         "Scroll down that page. Near the bottom there is a line saying Seek was "
         "blocked, with a button beside it.")
    step(pdf, 4, "Click Open Anyway, and confirm",
         "You may be asked for your Mac password. That is macOS checking it is "
         "really you, not the app asking for anything.")

    shot(pdf, "02-settings.png",
         "Privacy & Security, scrolled down. Open Anyway is the button to press.",
         max_h=96)

    body(pdf, "That is it. macOS remembers the decision and will not ask again.", INK)

    # -------------------------------------------------------------- signing in
    pdf.add_page()
    h1(pdf, "Signing in")
    body(pdf,
         "Open Seek, click Settings in the bottom-left, and sign in with your "
         "Soulseek username and password. If you have never used Soulseek, "
         "typing a new username signs you up — there is no separate "
         "registration.")
    body(pdf,
         "Everything else is optional. Searching and downloading work straight "
         "away; extras like cover art and playlist import are switched off until "
         "you add your own free keys, and the guide on the website explains those.")

    h2(pdf, "What this beta is really for")
    body(pdf,
         "Paste a record label's page - from Bandcamp or Discogs - into the "
         "search box. Seek reads the whole catalogue, then helps you go through "
         "it looking for the tracks on Soulseek. Anything already in your "
         "library is marked, so what is left is the gap.",
         INK)
    body(pdf,
         "That is the part worth hammering. Try a label you already collect and "
         "see whether it finds things you did not know were there.")

    shot(pdf, "05-catalogue.png",
         "A label's whole catalogue, pulled from one pasted link. The tick "
         "marks a release already in your library.")

    shot(pdf, "06-link.png",
         "A single album link works the same way - artist, release and track "
         "count read straight off the page, ready to search for.")

    pdf.add_page()
    h1(pdf, "Searching")
    body(pdf,
         "Ordinary searches work too. Results arrive gathered into albums "
         "rather than as a heap of loose files, and where several people have "
         "the same record Seek says how many - so you can compare them and "
         "pick, instead of the app deciding for you.")

    shot(pdf, "03-app.png",
         "The count on the right - 95 copies, 24 copies - is how many people "
         "have that same record.")

    shot(pdf, "04-compare.png",
         "Click that count and every copy is listed side by side: tracks, "
         "quality, size, who is free now. Press Get on the one you want.")

    pdf.add_page()
    h1(pdf, "It shows its working")
    body(pdf,
         "A file can claim to be high quality without being it - re-saved from "
         "a smaller one, with detail that never comes back. Seek looks at the "
         "sound itself and shows what it found rather than just stamping a "
         "verdict on it.")

    shot(pdf, "07-quality.png",
         "Loudness across frequency and time. A flat cut-off near the top means "
         "detail was thrown away. Note it ends with \"this is not proof\" - it "
         "tells you what it saw, not what to think.")

    # --------------------------------------------------------------- feedback
    pdf.add_page()
    h1(pdf, "What would help most")
    body(pdf,
         "Anything at all is welcome, but these parts are the least tested and "
         "the most likely to be wrong:")

    for title, text in [
        ("Digging a label", "The main thing. Paste a label you collect and work "
                 "through it. Did it find anything you did not know about? Did it "
                 "miss releases you know exist? Was the catalogue right?"),
        ("Choosing a copy", "When several people have the same record, does seeing "
                 "them side by side help you decide, or is it just more to read?"),
        ("Chat", "Rooms and private messages. Only one real conversation has ever "
                 "happened in it, so it is the least proven part of the app."),
        ("Importing a YouTube playlist", "Paste a playlist link and it should turn "
                 "into a list of things to look for. Odd track titles are where it "
                 "will struggle."),
        ("Anything confusing", "If you could not work out what something meant, "
                 "that is a bug in the app, not in you."),
    ]:
        pdf.set_font("body", "B", 10.5)
        pdf.set_text_color(*INK)
        pdf.multi_cell(COL, 6, title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.set_font("body", "", 9.5)
        pdf.set_text_color(*MUTED)
        pdf.multi_cell(COL, 5.4, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        pdf.ln(3.5)

    pdf.ln(4)
    top = pdf.get_y()
    pdf.set_fill_color(*PANEL)
    pdf.rect(MARGIN, top, COL, 26, style="F")
    pdf.set_xy(MARGIN + 8, top + 6)
    pdf.set_font("body", "B", 9.5)
    pdf.set_text_color(*INK)
    pdf.cell(0, 5, "One thing worth saying", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_x(MARGIN + 8)
    pdf.set_font("body", "", 9.5)
    pdf.set_text_color(*MUTED)
    pdf.multi_cell(COL - 16, 5.2,
        "Seek is just a client, like any other. What you search for and share is "
        "your own business, and your own responsibility.",
        new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    pdf.ln(14)
    pdf.set_font("body", "", 8)
    pdf.set_text_color(*FAINT)
    pdf.multi_cell(COL, 4.6,
        "Seek is unofficial and not connected to Soulseek or Nicotine+. It is "
        "built on Nicotine+ and shares its licence, GPL-3.0-or-later.",
        new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    pdf.output(str(OUT))
    print(f"wrote {OUT}")
    print(f"screenshots embedded: {EMBEDDED if EMBEDDED else 'none'}")
    if PLACEHELD:
        print(f"still to capture:     {PLACEHELD}")
    stray = sorted(p.name for p in SHOTS.glob("*.png")
                   if p.name not in EMBEDDED)
    if stray:
        print(f"in the folder, unused: {stray}")


if __name__ == "__main__":
    build()
