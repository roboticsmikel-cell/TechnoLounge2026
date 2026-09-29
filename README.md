# TechnoLounge 2026

Booth timer and income tracker for the TechnoLounge. It runs on one computer, and any phone or laptop on the same Wi-Fi can open it.

## Features
- New entry form: name, date, time enter, and package
  - **KB Pass**: 15 min, ₱20
  - **MB Pass**: 30 min, ₱30
  - **GB Pass**: 1 hour, ₱40
  - **VR Roller Coaster add-on**: ₱15 per ride (multiple rides allowed)
- Live countdowns, plus a time's-up pop-up with a beep and vibration on every connected device
- When time is up, staff choose **Extend** (add another pass) or **Leaving**, then confirm whether the hand band was returned
- Income summary per booth day (Day 1: Sep 29, Day 2: Sep 30, Day 3: Oct 1), showing pass income and pass + add-on, plus a separate VR total across all days
- History with missing-band tracking and CSV export

## How to run
1. Install [Node.js](https://nodejs.org) (LTS). No other packages are needed.
2. Double-click `start.bat`, or run `node server.js`.
3. On other devices, open the address shown in the window (for example `http://192.168.x.x:3000`). They must be on the same Wi-Fi or hotspot.
4. If Windows asks about the firewall, allow access.

Records are saved in `data.json` next to `server.js`. This file is not uploaded to GitHub.

To change prices, pass durations, or booth dates, edit `PASSES`/`PRICES` in `server.js` and `PRICE`/`BOOTH_DAYS` in `public/index.html`.
