# Flipout

Frame-by-frame flipbook animation for iPad and Apple Pencil, with adjustable onion skinning. No watermark.

**Open it:** https://hclovecraft00.github.io/flipout/ — on an iPad, tap Share › Add to Home Screen so it opens full-screen like an app.

- Draw with the Pencil: pen, fuzzy, eraser and paint bucket. Hold a pen to see a sample line.
- Onion skin: choose how many frames back (pink) and forward (blue) to show, and how faint.
- Layers (each frame has its own drawing on every layer), 12 colours plus any colour you pick.
- Duplicate, add, copy/paste, move and delete frames. Drag along the bead string to flip through frames.
- Zoom into the paper with the felt console (bottom-left): the big shirt button zooms in, the small one zooms out, the D-pad moves around, Fit puts it back. Trays and bars stay put.
- Fingers never draw: two-finger tap to undo, three-finger tap to redo.
- Export GIF, MP4 or PNG frames, or save a backup file of the whole project.
- Everything is saved in the browser on your device. Nothing is uploaded.

Keyboard (if one is attached): ← → frames, space play, P pen, F fuzzy, E eraser, G bucket, O onion skin, + / − zoom, 0 fit, N new frame, D duplicate, ⌘Z undo, ⇧⌘Z redo.

## Files

`index.html`, `style.css`, `js/` (the app; pens in `js/brushes.js`), `sw.js` (works offline).

Third-party, bundled so the app works offline:
- `vendor/`: [gifenc](https://github.com/mattdesl/gifenc) 1.0.3, [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.2.2, [fflate](https://github.com/101arrowz/fflate) 0.8.2 (all MIT licence).
- `fonts/`: [Mochiy Pop One](https://fonts.google.com/specimen/Mochiy+Pop+One) and [M PLUS Rounded 1c](https://fonts.google.com/specimen/M+PLUS+Rounded+1c), Latin subsets, SIL Open Font Licence (texts in `fonts/`).

To run locally: `python3 -m http.server` in this folder, then open http://localhost:8000.
