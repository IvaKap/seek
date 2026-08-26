Seek — an Apple-native desktop client for the Soulseek network
==============================================================

1. Drag Seek.app into your Applications folder.
2. Do the one-time step below BEFORE double-clicking it.
3. Open it.


The one-time step
-----------------

Seek is not signed with a paid Apple Developer certificate, so macOS
quarantines it and refuses to open it. Clearing that takes one command.

Open Terminal (Spotlight: type "Terminal") and paste this, then press
Return:

    xattr -dr com.apple.quarantine /Applications/Seek.app

Nothing will be printed. That means it worked. Seek now opens normally,
by double-clicking, forever.

If you put Seek somewhere other than Applications, change the path to
match — or type `xattr -dr com.apple.quarantine ` (with the trailing
space) and then drag Seek.app into the Terminal window, which fills in
the path for you.

What that command does: macOS tags anything that arrives from the
internet or AirDrop with a "quarantine" flag. `xattr -dr` removes that
tag. It changes nothing about the app itself.

You may instead see a dialog offering "Open Anyway" under System
Settings > Privacy & Security. That works too. The Terminal command is
here because that button is not always offered.


What it needs from you
----------------------

A Soulseek account. Seek does not create one — sign in with an existing
account under Settings > Account, or import one from Nicotine+ if you
already use it.

Everything Seek stores lives in:

    ~/Library/Application Support/Seek

This app carries nobody else's account details, and deleting that folder
resets it completely.


Please share something back
---------------------------

Soulseek is reciprocal. Peers deprioritise and ban clients that take
without giving, so if your downloads crawl, that is usually why.
Settings > Folders is where you choose what to share, and Statistics
shows your ratio.


Uploads
-------

The Uploads screen shows what other people are taking from you, as it
happens. Nothing to start — a peer asks, and Seek serves them. You can
stop a transfer, which tells the peer rather than just going quiet.

If it says you are not sharing anything, that is the thing to fix, and
Settings > Folders is where.


What does not work yet
----------------------

  - Identifying a track by its sound needs `fpcalc`, which is not
    bundled. Without it that one feature is simply inert.
  - Seek cannot list every open connection, only the peers you are
    actually exchanging files with. The socket count on Settings >
    Network is usually much larger, because most of those connections
    carry other people's searches across the network rather than any
    transfer of yours.

Seek is an unofficial front-end for the Nicotine+ core. GPL-3.0-or-later.
Not affiliated with the Nicotine+ team.
