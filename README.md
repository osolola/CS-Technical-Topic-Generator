# Daily Speaking Practice

A local app for getting better at explaining technical topics out loud. Each day it gives you a new CS topic. You research it for 10 minutes, record yourself teaching it for 10 minutes, then watch it back and score yourself. The Progress page charts how you improve.

## Run it

```bash
npm start
```

Then open **http://localhost:3000** in Chrome or Safari. There's nothing to install (Node only).

## The daily routine (~30 min)

1. **Topic**: read today's topic and the questions your talk should answer. Reroll only if you truly need to.
2. **Research (10 min)**: start the timer, dig in, and write short bullet notes *in your own words*.
3. **Record (10 min)**: enable the camera and talk without stopping. Look only at your notes, look at the lens, and pause instead of saying "um".
4. **Review**: watch the whole video. Rate the five rubric items honestly, count your filler words, and write **one** thing to fix. That note shows up at the top of tomorrow's session.

## Your data

Everything stays on your machine and is git-ignored:

- `recordings/Day N - YYYY-MM-DD.webm` (or `.mp4` in Safari): your videos, numbered by day
- `notes/Day N - YYYY-MM-DD.md`: each day's topic, your notes, your review, and what to improve (readable in any editor)
- `data/sessions.json`: everything the app uses (notes, scores, metrics)

The optional live transcript uses the browser's speech recognition. In Chrome, that sends the audio to Google for recognition. Leave it off if you'd rather not. Speech recognition often drops "um"/"uh", so your own count while watching is the more reliable number.
